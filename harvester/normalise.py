#!/usr/bin/env python3
"""
normalise.py — raw CC0 datameet/railways -> canonical schema.

The 2016 community dataset is messy in ways that will silently corrupt a routing graph if
you do not handle them explicitly. Every quirk handled here was found by inspecting the
real data (see the DATA QUALITY REPORT printed at the end).

Quirks handled
--------------
1. stations.json has rows with `geometry: null` and placeholder codes like "XX-BECE".
2. schedules.json uses the STRING "None" (not JSON null) for arrival/departure.
3. `day` is sometimes JSON null (5.4% of rows) -> cannot place the stop on a timeline.
4. There is NO sequence/islno field -> stops must be ordered by (day, time).
5. There is NO per-stop distance -> derived from station coordinates, with the rail
   detour factor CALIBRATED against trains.json's stated origin->destination distance.
6. 443 exact-duplicate stop rows.
7. Some stops have arrival > departure (overnight wrap with a stale `day`).
8. trains.json class flags are 0/1 ints, and `classes` is frequently "".
9. Station codes were renamed after 2016 (MGS->DDU, ALD->PRYJ) -> rename map applied.

Usage:  python normalise.py --raw data/raw --out data/canonical
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

# --------------------------------------------------------------------------- constants

VERSION = "1.0.0"

# Station codes renamed since the 2016 snapshot. Without this the graph silently
# fragments: a train stopping at "MGS" would not connect to a station indexed as "DDU".
STATION_RENAMES = {
    "MGS": "DDU",    # Mughal Sarai -> Pt. Deen Dayal Upadhyaya Jn
    "ALD": "PRYJ",   # Allahabad    -> Prayagraj Jn
}

# trains.json `type` values -> our canonical type codes.
# NOTE: these are the OLD community codes. NTES uses different ones (SUF not SF,
# VNDB for Vande Bharat, etc.) -- see docs/01-data-and-availability.md. The normaliser
# for NTES output must use the NTES table instead.
TYPE_CODES = {
    "Rajdhani": "RAJ", "Shatabdi": "SHT", "Duronto": "DRNT", "Garib Rath": "GBR",
    "Suvidha": "SVD", "Humsafar": "HMS", "Vande Bharat": "VNDB",
    "Sf": "SUF", "SF": "SUF", "Superfast": "SUF",
    "Exp": "MEX", "Express": "MEX", "Mail": "MEX",
    "Pass": "PAX", "Passenger": "PAX", "Special": "SPL", "Antyodaya": "ANT",
    "Jan Shatabdi": "JSB", "Double Decker": "DDE", "Kavi Guru": "MEX",
    "Vivek": "MEX", "Sampark Kranti": "SUF", "Intercity": "INT",
}

# The source `type` column is nearly useless: across all 5,208 trains it takes only three
# values (PAX 2,444 / MEX 2,019 / SUF 711), and 255 of the 256 trains whose NAME carries a
# brand are mistyped by it -- "Dibrugarh Guwahati Rajdhani Express" is labelled MEX. The
# name is the authoritative signal for the brand, so it is checked first and the source
# type is kept only when no brand matches. Order matters: "Jan Shatabdi" contains
# "Shatabdi" but is a different product with different classes.
BRAND_BY_NAME = [
    ("jan shatabdi", "JSB"), ("vande bharat", "VNDB"), ("garib rath", "GBR"),
    ("double decker", "DDE"), ("sampark kranti", "SUF"), ("rajdhani", "RAJ"),
    ("shatabdi", "SHT"), ("duronto", "DRNT"), ("humsafar", "HMS"),
    ("antyodaya", "ANT"), ("suvidha", "SVD"), ("kavi guru", "MEX"),
]


def brand_from_name(name: str) -> str | None:
    low = name.lower()
    for needle, code in BRAND_BY_NAME:
        if needle in low:
            return code
    return None


CLASS_FLAGS = {           # trains.json boolean-ish int columns -> class code
    "first_ac": "1A", "second_ac": "2A", "third_ac": "3A",
    "sleeper": "SL", "chair_car": "CC", "first_class": "FC",
}
CLASS_BIT = {"1A": 1, "2A": 2, "3A": 4, "3E": 8, "SL": 16, "CC": 32,
             "EC": 64, "FC": 128, "2S": 256, "UR": 512}

# Station rank -> minimum transfer time (minutes). Real per-junction minimums are not in
# the CC0 source; these are the documented rank-based defaults from
# docs/02-routing-and-discovery.md, to be refined from NTES dwell data.
MIN_TRANSFER_BY_RANK = {3: 30, 2: 20, 1: 12, 0: 5}
RANK_NAMES = {0: "halt", 1: "intermediate", 2: "junction", 3: "metro"}

# Rank cut points as PERCENTILES of the observed call distribution, plus absolute floors.
#
# Percentiles rather than fixed counts: the busiest station in this 2016 dataset is called
# by 286 trains, so a hand-picked "metro = 400+ trains" threshold matches ZERO stations and
# every major junction silently ranks as ordinary. Percentiles adapt to whatever dataset is
# loaded -- NTES carries roughly twice as many trains, so the same cut points still select
# the same *proportion* of hubs. The floors stop a tiny or partial dataset from labelling
# half its stations as metros.
RANK_CUTS = [
    (3, 99.4, 120),    # metro:        top ~0.6%, at least 120 trains
    (2, 94.0, 40),     # junction:     top ~6%,   at least 40 trains
    (1, 60.0, 8),      # intermediate: top ~40%,  at least 8 trains
]

EARTH_R_KM = 6371.0088


# --------------------------------------------------------------------------- helpers

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def is_none(v) -> bool:
    """The CC0 dataset encodes missing values as the STRING 'None', not JSON null."""
    return v is None or v == "None" or v == ""


def time_to_min(s):
    """'07:55:00' -> 475. Returns None for any missing/malformed value."""
    if is_none(s):
        return None
    try:
        parts = str(s).split(":")
        h, m = int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def haversine_km(a, b) -> float | None:
    if a is None or b is None:
        return None
    lat1, lon1 = a
    lat2, lon2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(min(1.0, math.sqrt(h)))


# --------------------------------------------------------------------------- loaders

def load_stations(raw: Path, stats: Counter) -> dict[str, dict]:
    """stations.json -> {code: {...}}. Drops rows with no geometry and placeholder codes."""
    doc = json.loads((raw / "stations.json").read_text())
    out: dict[str, dict] = {}
    for f in doc["features"]:
        p = f.get("properties") or {}
        code = (p.get("code") or "").strip().upper()
        stats["stations:total"] += 1
        if not code:
            stats["stations:drop_no_code"] += 1
            continue
        if code.startswith("XX-"):          # placeholder rows, e.g. "XX-BECE"
            stats["stations:drop_placeholder"] += 1
            continue
        if len(code) > 5:
            stats["stations:drop_bad_code"] += 1
            continue
        geom = f.get("geometry")
        if not geom or not geom.get("coordinates"):
            stats["stations:drop_no_geom"] += 1
            continue
        lon, lat = geom["coordinates"][0], geom["coordinates"][1]
        # India bounding box -- catches swapped lat/lon and geocoding failures.
        if not (6.5 <= lat <= 37.5 and 68.0 <= lon <= 97.5):
            stats["stations:drop_out_of_bbox"] += 1
            continue
        code = STATION_RENAMES.get(code, code)
        if code in out:
            stats["stations:drop_duplicate_code"] += 1
            continue
        out[code] = {
            "code": code,
            "name": (p.get("name") or code).strip().title(),
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "state": p.get("state"),
            "zone": p.get("zone"),
            "address": p.get("address"),
        }
        stats["stations:kept"] += 1
    return out


def load_trains(raw: Path) -> dict[str, dict]:
    """trains.json -> {number: {...}}. Class flags arrive as 0/1 ints."""
    doc = json.loads((raw / "trains.json").read_text())
    out: dict[str, dict] = {}
    for f in doc["features"]:
        p = f.get("properties") or {}
        num = str(p.get("number") or "").strip()
        if not num:
            continue
        classes = []
        for col, code in CLASS_FLAGS.items():
            if p.get(col) in (1, True, "1", "true"):
                classes.append(code)
        # `classes` is usually "" but occasionally carries free text; parse defensively.
        extra = str(p.get("classes") or "").replace("/", ",").split(",")
        for tok in extra:
            tok = tok.strip().upper()
            if tok in CLASS_BIT and tok not in classes:
                classes.append(tok)
        name = (p.get("name") or "").strip()
        source_type = TYPE_CODES.get(str(p.get("type") or "").strip(), "MEX")
        brand = brand_from_name(name)
        out[num] = {
            "number": num,
            "name": name,
            "type": brand or source_type,
            "typeDerived": brand is not None,
            "sourceType": source_type,
            "rawType": str(p.get("type") or "").strip(),
            "zone": p.get("zone"),
            "origin": STATION_RENAMES.get(str(p.get("from_station_code") or "").upper(),
                                          str(p.get("from_station_code") or "").upper()),
            "destination": STATION_RENAMES.get(str(p.get("to_station_code") or "").upper(),
                                               str(p.get("to_station_code") or "").upper()),
            "originName": p.get("from_station_name"),
            "destinationName": p.get("to_station_name"),
            "distanceKm": int(p.get("distance") or 0),
            "classes": sorted(classes, key=lambda c: CLASS_BIT.get(c, 9999)),
            "returnTrain": str(p.get("return_train") or "") or None,
            "departure": p.get("departure"),
            "arrival": p.get("arrival"),
        }
    return out


# --------------------------------------------------------------------------- stop cleaning

def clean_stops(raw: Path, stations: dict, stats: Counter) -> dict[str, dict]:
    """
    schedules.json -> {train_number: [full ordered stop list]}.

    Two findings from inspecting the real data drive this implementation:

    Returns {train_number: {"stops": [...], "originDepMinOfDay": int}}.

    (a) FILE ORDER IS ROUTE ORDER. Rows for a train appear in the file in the order the
        train visits them: the first is always the true origin, the last the true
        destination, and haversine-from-origin increases monotonically. Sorting by
        (day, time) -- the naive approach -- DESTROYS this, because 5.4% of rows have
        `day: null` and overnight wraps make wall-clock time non-monotonic. So we walk
        the file order and RECONSTRUCT the day from midnight wraparounds instead.

    (b) 75% of rows are PASS-THROUGHS, not scheduled stops. The source lists every
        station on the route, including ones the train never stops at (12301 Howrah
        Rajdhani shows 218 "stops"; it actually stops at ~11). Boarding at a
        pass-through would produce physically impossible itineraries, so they are flagged
        here and filtered out downstream -- but their DISTANCE is retained, because
        cumulative km must integrate the whole route.
    """
    rows = json.loads((raw / "schedules.json").read_text())
    stats["stops:total"] = len(rows)

    by_train: dict[str, list[dict]] = {}
    seen: set[tuple] = set()

    for r in rows:                                  # file order preserved deliberately
        num = str(r.get("train_number") or "").strip()
        code = STATION_RENAMES.get(str(r.get("station_code") or "").strip().upper(),
                                   str(r.get("station_code") or "").strip().upper())
        if not num or not code:
            stats["stops:drop_no_key"] += 1
            continue
        if code not in stations:
            stats["stops:drop_unknown_station"] += 1
            continue

        arr = time_to_min(r.get("arrival"))
        dep = time_to_min(r.get("departure"))
        if arr is None and dep is None:
            # No timing at all -> cannot place on a timeline or form a connection.
            stats["stops:drop_no_timing"] += 1
            continue

        key = (num, code, r.get("day"), r.get("arrival"), r.get("departure"))
        if key in seen:
            stats["stops:drop_duplicate"] += 1
            continue
        seen.add(key)

        by_train.setdefault(num, []).append({
            "code": code,
            "name": (r.get("station_name") or stations[code]["name"]).strip(),
            "arrMin": arr,
            "depMin": dep,
            "rawDay": r.get("day"),                 # 1-based, sometimes null
            "rawDayWasNull": r.get("day") is None,
        })

    out: dict[str, dict] = {}
    for num, stops in by_train.items():
        if len(stops) < 2:
            stats["trains:drop_too_few_stops"] += 1
            continue

        # ---- reconstruct the absolute timeline by walking midnight wraparounds ----
        dayOff = 0
        lastWall: int | None = None
        for s in stops:
            for field, absfield in (("arrMin", "absArr"), ("depMin", "absDep")):
                wall = s[field]
                if wall is None:
                    s[absfield] = None
                    continue
                if lastWall is not None and wall < lastWall:
                    dayOff += 1                     # clock went backwards => new day
                    stats["stops:midnight_wrap"] += 1
                lastWall = wall
                s[absfield] = dayOff * 1440 + wall
                s["dayOff"] = dayOff
            # A stop cannot depart before it arrives; if it does, departure rolls over.
            if (s["absArr"] is not None and s["absDep"] is not None
                    and s["absDep"] < s["absArr"]):
                dayOff += 1
                s["absDep"] = dayOff * 1440 + s["depMin"]
                s["dayOff"] = dayOff
                lastWall = s["depMin"]
                stats["stops:fixed_arr_after_dep"] += 1

        # ---- cross-check derived days against the raw `day` column ----
        agree = disagree = 0
        for s in stops:
            if s["rawDay"] is None:
                continue
            if int(s["rawDay"]) - 1 == s["dayOff"]:
                agree += 1
            else:
                disagree += 1
        stats["daycheck:agree"] += agree
        stats["daycheck:disagree"] += disagree

        # ---- normalise so origin departure == minute 0 ----
        # `base` is kept separately as the origin's WALL-CLOCK departure: the relative
        # timeline is what makes the packed times fit in u16, but the UI needs real clock
        # times, so the origin's minute-of-day is carried on the train record.
        base = stops[0]["absDep"] if stops[0]["absDep"] is not None else stops[0]["absArr"]
        if base is None:
            stats["trains:drop_no_origin_time"] += 1
            continue
        origin_wall = base % 1440
        for s in stops:
            if s["absArr"] is not None:
                s["absArr"] -= base
            if s["absDep"] is not None:
                s["absDep"] -= base
            s["dayOff"] = (s["absDep"] if s["absDep"] is not None else s["absArr"]) // 1440
        # Enforce monotonicity: a train cannot leave a station before it reached the
        # previous one. Residual violations are data noise; clamp and record them.
        prevDep = 0
        for s in stops:
            if s["absArr"] is not None and s["absArr"] < prevDep:
                s["absArr"] = prevDep
                stats["stops:clamped_arr"] += 1
            if s["absDep"] is not None and s["absDep"] < (s["absArr"] or prevDep):
                s["absDep"] = max(s["absArr"] or 0, prevDep)
                stats["stops:clamped_dep"] += 1
            s["haltMin"] = (0 if s["absArr"] is None or s["absDep"] is None
                            else max(0, s["absDep"] - s["absArr"]))
            prevDep = s["absDep"] if s["absDep"] is not None else prevDep

        # ---- mark pass-throughs (interior stations where the train does not halt) ----
        for i, s in enumerate(stops):
            s["passThrough"] = 0 < i < len(stops) - 1 and s["haltMin"] == 0
            s["dayInferred"] = s["rawDayWasNull"]
        stats["stops:pass_through"] += sum(s["passThrough"] for s in stops)
        out[num] = {"stops": stops, "originDepMinOfDay": origin_wall}

    return out


def select_routing_stops(stops: list[dict], stats: Counter) -> list[dict]:
    """
    Reduce a full route listing to the stations where a passenger may actually board or
    alight: the origin, the destination, and every intermediate stop with a real halt.

    Cumulative distance is preserved across dropped pass-throughs, and timings are
    interpolated for the rare case where a genuine stop lost its time data.
    """
    idx = [i for i, s in enumerate(stops) if not s["passThrough"]]
    if len(idx) < 2:
        return []
    kept = [stops[i] for i in idx]
    for n, s in enumerate(kept):
        s["seq"] = n + 1
    stats["stops:routing_kept"] += len(kept)
    stats["stops:routing_dropped_pass_through"] += len(stops) - len(kept)
    return kept


# --------------------------------------------------------------------------- distances

def calibrate_rail_factor(trains: dict, stops_by_train: dict,
                          stations: dict, stats: Counter) -> float:
    """
    schedules.json has NO per-stop distance, so segment distances must be derived from
    station coordinates. Straight-line (haversine) underestimates rail distance because
    tracks are not straight -- so we need a detour factor.

    Rather than guessing 1.25, CALIBRATE it: trains.json states each train's total
    origin->destination distance, so least-squares the factor that best reconciles
    sum(haversine segments) with the stated totals. This makes derived distances
    defensible instead of arbitrary.
    """
    num_sum, den_sum, n = 0.0, 0.0, 0
    ratios = []
    for num, meta in trains.items():
        entry = stops_by_train.get(num)
        stops = entry["stops"] if entry else None
        if not stops or len(stops) < 3:
            continue
        stated = meta.get("distanceKm") or 0
        if stated <= 0:
            continue
        straight = 0.0
        ok = True
        for a, b in zip(stops, stops[1:]):
            pa = (stations[a["code"]]["lat"], stations[a["code"]]["lon"])
            pb = (stations[b["code"]]["lat"], stations[b["code"]]["lon"])
            d = haversine_km(pa, pb)
            if d is None or d > 900:      # implausible hop => bad coordinate
                ok = False
                break
            straight += d
        if not ok or straight <= 10:
            continue
        num_sum += stated
        den_sum += straight
        ratios.append(stated / straight)
        n += 1

    if n < 50:
        stats["distance:calibration_insufficient"] += 1
        return 1.03                        # documented default fallback

    ls = num_sum / den_sum                 # least-squares through the origin
    ratios.sort()
    med = ratios[len(ratios) // 2]
    p25, p75 = ratios[len(ratios) // 4], ratios[3 * len(ratios) // 4]
    stats["distance:calibration_trains"] = n
    stats["distance:factor_least_squares_x1000"] = round(ls * 1000)
    stats["distance:factor_median_x1000"] = round(med * 1000)
    stats["distance:factor_p25_x1000"] = round(p25 * 1000)
    stats["distance:factor_p75_x1000"] = round(p75 * 1000)
    log(f"      least-squares={ls:.4f} median={med:.4f} IQR=[{p25:.4f},{p75:.4f}] n={n}")

    # Guard against a pathological calibration. NOTE the bounds are tight around 1.0,
    # NOT the 1.2-1.4 you would expect for a "rail detour factor": because we sum
    # haversines over CONSECUTIVE STOPS rather than measuring origin->destination in one
    # straight line, the stop sequence already traces the route. Only the curvature
    # between adjacent stations is missing, which is worth ~3%.
    return ls if 0.90 <= ls <= 1.60 else 1.03


# --------------------------------------------------------------------------- classes

# 54% of trains.json rows carry NO class information at all (every flag is 0 and
# `classes` is ""). Rather than leave them unbookable, infer a plausible default from the
# train TYPE and mark it as inferred so the availability layer can downgrade confidence.
DEFAULT_CLASSES_BY_TYPE = {
    "RAJ": ["3A", "2A", "1A"], "DRNT": ["3A", "2A", "1A"], "SHT": ["CC", "EC"],
    "JSB": ["CC", "2S"], "DDE": ["CC"], "GBR": ["3A"], "HMS": ["3A"],
    "VNDB": ["CC", "EC"], "ANT": ["2S"], "SUF": ["SL", "3A", "2A"],
    "MEX": ["SL", "3A", "2A"], "INT": ["CC", "2S"], "SPL": ["SL", "3A", "2A"],
    "PAX": ["2S"], "SVD": ["SL", "3A", "2A"],
}
FALLBACK_CLASSES = ["SL", "2S"]


def infer_classes(t: dict, stats: Counter) -> None:
    if t["classes"]:
        return
    t["classes"] = list(DEFAULT_CLASSES_BY_TYPE.get(t["type"], FALLBACK_CLASSES))
    t["classesInferred"] = True
    stats["classes:inferred"] += 1


# --------------------------------------------------------------------------- station rank

def percentile(sorted_vals: list[int], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * (pct / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def assign_ranks(stations: dict, routing: dict, stats: Counter) -> dict:
    """
    Rank stations by how many trains actually STOP there, and set a rank-based minimum
    transfer time. Only genuine stops count -- a train passing through at 80 km/h does not
    make a station a transfer point.

    Returns the resolved thresholds so meta.json can record them; a rank whose cut point
    is invisible is unauditable.
    """
    calls: Counter = Counter()
    for stops in routing.values():
        for s in stops:
            calls[s["code"]] += 1

    observed = sorted((calls.get(c, 0) for c in stations), reverse=True)
    resolved: dict[int, int] = {}
    for rank, pct, floor in RANK_CUTS:
        resolved[rank] = max(floor, int(round(percentile(observed, pct))))

    for st in stations.values():
        n = calls.get(st["code"], 0)
        st["trainCalls"] = n
        rank = 0
        for r in (3, 2, 1):
            if n >= resolved[r]:
                rank = r
                break
        st["rank"] = rank
        st["rankName"] = RANK_NAMES[rank]
        st["minTransferMin"] = MIN_TRANSFER_BY_RANK[rank]

    for r in (3, 2, 1, 0):
        stats[f"stations:rank{r}_{RANK_NAMES[r]}"] = sum(1 for s in stations.values() if s["rank"] == r)
    return resolved


# --------------------------------------------------------------------------- build routes

MAX_DURATION_MIN = int(130 * 60)      # longest real Indian journey is ~85 h (Vivek Exp)


def build_routes(trains: dict, stops_by_train: dict, stations: dict,
                 factor: float, stats: Counter) -> tuple[dict, dict]:
    """
    Turn full route listings into bookable routes: reduce to genuine stops, attach
    cumulative distance (integrated across the pass-throughs we discard), re-sequence, and
    reject physically impossible results.

    Returns ({train_number: route_record}, {train_number: [genuine stops]}).
    """
    routes: dict[str, dict] = {}
    routing: dict[str, list[dict]] = {}

    for num, t in trains.items():
        entry = stops_by_train.get(num)
        if not entry:
            continue
        stops = entry["stops"]

        # Cumulative distance integrates EVERY station on the route, including the
        # pass-throughs we are about to discard -- otherwise dropping them would shorten
        # the train below its stated distance.
        cum = 0.0
        dists = [0.0]
        for a, b in zip(stops, stops[1:]):
            d = haversine_km((stations[a["code"]]["lat"], stations[a["code"]]["lon"]),
                             (stations[b["code"]]["lat"], stations[b["code"]]["lon"]))
            cum += 0.0 if d is None else d * factor
            dists.append(round(cum, 1))
        for i, st in enumerate(stops):
            st["distKm"] = dists[i]

        route_len = round(cum, 1)
        kept = select_routing_stops(stops, stats)
        if len(kept) < 2:
            stats["trains:drop_no_genuine_stops"] += 1
            continue

        # The origin has no arrival and the terminal no departure. Fill each from its
        # counterpart so the binary container needs no null sentinels: semantically you
        # may only DEPART the origin and only ARRIVE at the terminal, and CSA never reads
        # the other side.
        first, last = kept[0], kept[-1]
        if first["absArr"] is None:
            first["absArr"] = first["absDep"]
        if first["absDep"] is None:
            first["absDep"] = first["absArr"]
        if last["absDep"] is None:
            last["absDep"] = last["absArr"]
        if last["absArr"] is None:
            last["absArr"] = last["absDep"]
        if None in (first["absArr"], first["absDep"], last["absArr"], last["absDep"]):
            stats["trains:drop_incomplete_endpoints"] += 1
            continue

        duration = last["absDep"] - first["absDep"]
        if duration <= 0:
            stats["trains:drop_nonpositive_duration"] += 1
            continue
        if duration > MAX_DURATION_MIN:
            # 21-day "journeys" are day-reconstruction failures, not real services.
            stats["trains:drop_absurd_duration"] += 1
            continue
        if route_len / (duration / 60) > 170:
            stats["trains:drop_absurd_speed"] += 1
            continue

        rec = dict(t)
        rec["stops"] = [
            {"seq": s["seq"], "code": s["code"], "name": s["name"],
             "absArr": s["absArr"], "absDep": s["absDep"], "dayOff": s["dayOff"],
             "haltMin": s["haltMin"], "distKm": s["distKm"],
             "dayInferred": s["dayInferred"]}
            for s in kept
        ]
        rec["routeStations"] = len(stops)
        rec["derivedDistanceKm"] = route_len
        rec["durationMin"] = duration
        rec["originDepMinOfDay"] = entry["originDepMinOfDay"]
        rec["classesInferred"] = False
        if rec.get("typeDerived"):
            stats["type:corrected_from_name"] += 1
        # CC0 has no runs_days: every train is implicitly daily. This is KNOWN WRONG and
        # is the single biggest reason to supersede this bootstrap with NTES data.
        rec["runsDays"] = 127
        rec["runsDaysAssumed"] = True
        infer_classes(rec, stats)
        routes[num] = rec
        routing[num] = kept

    return routes, routing


def daycheck_total(stats: Counter) -> float:
    a, d = stats.get("daycheck:agree", 0), stats.get("daycheck:disagree", 0)
    return a / (a + d) if (a + d) else float("nan")


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=Path,
                    help="directory holding stations.json, trains.json, schedules.json")
    ap.add_argument("--out", required=True, type=Path, help="canonical JSONL output dir")
    ap.add_argument("--source", default="datameet/railways (CC0, 2016)")
    args = ap.parse_args()

    stats: Counter = Counter()
    args.out.mkdir(parents=True, exist_ok=True)
    log(f"normalise.py v{VERSION}  source={args.source}")

    log("[1/6] loading stations")
    stations = load_stations(args.raw, stats)
    log(f"      {len(stations)} usable stations")

    log("[2/6] loading trains")
    trains = load_trains(args.raw)
    log(f"      {len(trains)} train records")

    log("[3/6] cleaning + ordering stops (82 MB, the slow step)")
    stops_by_train = clean_stops(args.raw, stations, stats)
    log(f"      {len(stops_by_train)} trains with a usable route listing")

    log("[4/6] calibrating rail detour factor")
    factor = calibrate_rail_factor(trains, stops_by_train, stations, stats)
    log(f"      factor = {factor:.4f}")

    log("[5/6] building bookable routes (genuine stops + distances)")
    routes, routing = build_routes(trains, stops_by_train, stations, factor, stats)
    log(f"      {len(routes)} routes, {sum(len(v) for v in routing.values()):,} genuine stops")

    # Prune the station index to stations where a train actually STOPS. Keeping the
    # pass-through-only stations would put dead ends in autocomplete: places the user can
    # select as an origin but can never leave.
    used_codes = {s["code"] for stops in routing.values() for s in stops}
    stats["stations:drop_never_stopped"] = len(stations) - len(used_codes)
    stations = {c: st for c, st in stations.items() if c in used_codes}

    rank_thresholds = assign_ranks(stations, routing, stats)
    log(f"      rank cut points: " + ", ".join(
        f"{RANK_NAMES[r]}>={rank_thresholds[r]}" for r in (3, 2, 1)))

    log("[6/6] writing canonical JSONL")
    with (args.out / "stations.jsonl").open("w") as fh:
        for st in stations.values():
            fh.write(json.dumps(st, ensure_ascii=False) + "\n")

    total_stops = 0
    with (args.out / "trains.jsonl").open("w") as fh:
        for rec in routes.values():
            total_stops += len(rec["stops"])
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    meta = {
        "schemaVersion": VERSION,
        "source": args.source,
        "sourceLicence": "CC0",
        "railDetourFactor": round(factor, 6),
        "stationRankThresholds": {RANK_NAMES[r]: rank_thresholds[r] for r in (3, 2, 1)},
        "generatedBy": "harvester/normalise.py",
        "stats": dict(stats),
        "counts": {
            "stations": len(stations),
            "trains": len(routes),
            "stops": total_stops,
            "classesInferred": stats["classes:inferred"],
        },
        "knownLimitations": [
            "2016 snapshot: no Vande Bharat, some pre-rename station names, stale schedules",
            "runsDays assumed daily (127) for EVERY train -- known to be wrong",
            "per-stop distances derived from coordinates x calibrated detour factor, not official",
            f"classes inferred from train type for {stats['classes:inferred']} trains "
            "that carry no class data",
            f"train type taken from the NAME for {stats['type:corrected_from_name']} trains, "
            "because the source's type column only ever holds PAX/MEX/SUF",
            "no platform, quota, rake/composition, or fare data",
            "no multilingual station names",
        ],
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2))

    # ------------------------------------------------------------ data quality report
    dc = daycheck_total(stats)
    print("\n" + "=" * 70)
    print("DATA QUALITY REPORT")
    print("=" * 70)
    for k in sorted(stats):
        print(f"  {k:44} {stats[k]:>10,}")
    print("-" * 70)
    print(f"  {'stations emitted':44} {len(stations):>10,}")
    print(f"  {'trains emitted':44} {len(routes):>10,}")
    print(f"  {'genuine stops emitted':44} {total_stops:>10,}")
    print(f"  {'pass-throughs discarded':44} {stats['stops:pass_through']:>10,}")
    print(f"  {'rail detour factor (calibrated)':44} {factor:>10.4f}")
    print(f"  {'derived-day vs raw-day agreement':44} {dc:>10.2%}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
