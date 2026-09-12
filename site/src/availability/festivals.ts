/**
 * festivals.ts — the festival calendar behind the model's `festival` feature.
 *
 * Festival demand is the single largest seasonal effect in Indian rail booking: docs/01 puts
 * festival corridors at 5–20× normal demand, and Chhath alone empties Delhi towards Patna. A
 * model that cannot see the calendar cannot see that, so the calendar is here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TABLE AND NOT A CALCULATION
 * ---------------------------------------------------------------------------
 * These dates come from lunisolar and lunar calendars. Computing them needs an ephemeris and a
 * choice of tradition (the same tithi is observed a day apart in different states), and the
 * Islamic dates in particular depend on moon *sighting*, which no calculation can settle in
 * advance — they are published as tentative and then confirmed. A table of published dates is
 * both simpler and more accurate than an approximation, at the cost of needing a refresh once a
 * year. That cost is recorded in `COVERED` below and in the tests that fail when it expires.
 *
 * Dates were cross-checked against several published 2026 calendars (india.gov.in's holiday list
 * via Jagran Josh, the DoPT restricted-holiday notification, News18, Economic Times,
 * festivaldates.in). Where sources disagreed — Ram Navami, Rath Yatra, Onam, Janmashtami, Durga
 * Ashtami, Diwali and Chhath each had one outlier claiming a date a week adrift — the majority
 * reading is used and the outlier ignored. `tentative: true` marks the moon-sighting dates, which
 * move by a day in practice and must not be treated as fixed by anything downstream.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW, AND WHY IT IS ONE-SIDED
 * ---------------------------------------------------------------------------
 * `festivalOf()` answers "is this date in the run-up to a festival", not "is this date a
 * festival". Demand peaks in the days *before*: people travel to reach home, and the return
 * movement happens after. So the window runs from `pre` days before the festival date to the date
 * itself, and the day after is already out of it.
 *
 * That asymmetry is a real limitation, and it is recorded rather than papered over: docs/01's
 * "Directional" feature group wants the *reversal* too (Chhath is Delhi→Patna waitlisted and
 * Patna→Delhi empty, then it flips). The coefficient-table format has no directional festival
 * term, so this module cannot express the flip. What it can do is say "this date is in the Chhath
 * run-up" and let a corridor-aware model learn the direction from the (board, alight) pair, which
 * it already receives. Adding a guessed `festivalDirection` field the model would ignore is worse
 * than leaving the gap documented.
 */

/** One published festival, with the length of its pre-festival demand window. */
export interface FestivalEntry {
  /** The key the model's `festivalMultiplier` table is keyed by. This is the contract. */
  readonly key: string;
  readonly name: string;
  /** ISO date of the festival day itself. */
  readonly dateIso: string;
  /** How many days before it the run-up window opens. Larger for larger movements. */
  readonly pre: number;
  /** True when the date depends on moon sighting and may move by a day. */
  readonly tentative?: boolean;
  /** Where this cluster of demand actually is — the table cannot know a traveller's corridor. */
  readonly note: string;
}

/**
 * Published festival dates for 2026, plus New Year 2027 to cover the year-end movement.
 *
 * `pre` values are judgement about how long the run-up lasts, not published figures: six days for
 * Diwali and Durga Puja (the two longest movements, and both preceded by multi-day observances),
 * five for Chhath, three to four for the rest, two for the minor ones. They are deliberately
 * conservative — a window that is too wide smears a sharp peak, and a peak that is smeared is a
 * peak the model cannot use.
 */
export const FESTIVALS_2026: readonly FestivalEntry[] = [
  { key: 'makarSankranti', name: 'Makar Sankranti / Pongal', dateIso: '2026-01-14', pre: 3,
    note: 'Harvest festival; heavy movement into Tamil Nadu, Assam, Punjab and Gujarat' },
  { key: 'mahaShivaratri', name: 'Maha Shivaratri', dateIso: '2026-02-15', pre: 2,
    note: 'Pilgrim traffic to Jyotirlinga sites; Ujjain, Varanasi, Nashik' },
  { key: 'holi', name: 'Holi', dateIso: '2026-03-04', pre: 3,
    note: 'North and west India; Mathura–Vrindavan and the UP–Bihar–Rajasthan corridors' },
  { key: 'eid', name: 'Eid-ul-Fitr', dateIso: '2026-03-21', pre: 4, tentative: true,
    note: 'Pan-India; moon-sighting dependent, so treat the date as ±1 day' },
  { key: 'ramNavami', name: 'Ram Navami', dateIso: '2026-03-26', pre: 2,
    note: 'Ayodhya and the eastern UP corridor' },
  { key: 'vaisakhi', name: 'Vaisakhi / Baisakhi', dateIso: '2026-04-14', pre: 3,
    note: 'Punjab harvest new year; Amritsar and the NRI return window' },
  { key: 'buddhaPurnima', name: 'Buddha Purnima', dateIso: '2026-05-01', pre: 2,
    note: 'Bodh Gaya, Sarnath, Kushinagar' },
  { key: 'eidAdha', name: 'Eid-ul-Adha (Bakrid)', dateIso: '2026-05-27', pre: 3, tentative: true,
    note: 'Pan-India; moon-sighting dependent' },
  { key: 'muharram', name: 'Muharram / Ashura', dateIso: '2026-06-26', pre: 2, tentative: true,
    note: 'Pan-India; moon-sighting dependent' },
  { key: 'rathYatra', name: 'Rath Yatra', dateIso: '2026-07-16', pre: 3,
    note: 'Puri; the Howrah–Puri–Bhubaneswar corridor saturates' },
  { key: 'onam', name: 'Onam (Thiruvonam)', dateIso: '2026-08-26', pre: 4,
    note: 'Kerala; the largest single movement into the state, including Gulf returnees' },
  { key: 'ganeshChaturthi', name: 'Ganesh Chaturthi', dateIso: '2026-09-14', pre: 4,
    note: 'Maharashtra and Karnataka; Mumbai outflows towards Konkan and the Deccan' },
  { key: 'durgaPuja', name: 'Durga Puja (Maha Ashtami)', dateIso: '2026-10-19', pre: 6,
    note: 'West Bengal, Odisha, Assam, Tripura; Sharad Navratri begins about a week earlier' },
  { key: 'dussehra', name: 'Dussehra / Vijayadashami', dateIso: '2026-10-20', pre: 3,
    note: 'Pan-India; overlaps the tail of the Durga Puja movement' },
  { key: 'diwali', name: 'Diwali', dateIso: '2026-11-08', pre: 6,
    note: 'Pan-India and the largest movement of the year; the five-day cluster runs 6–10 Nov' },
  { key: 'chhath', name: 'Chhath Puja', dateIso: '2026-11-15', pre: 5,
    note: 'Bihar, eastern UP, Jharkhand, Bengal; the sharpest directional peak in the calendar' },
  { key: 'guruNanakJayanti', name: 'Guru Nanak Jayanti', dateIso: '2026-11-24', pre: 3,
    note: 'Punjab; Amritsar and Anandpur Sahib' },
  { key: 'christmas', name: 'Christmas', dateIso: '2026-12-25', pre: 4,
    note: 'Goa, Kerala, the north-east and the metros; overlaps the year-end holiday window' },
  { key: 'newYear', name: "New Year's Day", dateIso: '2027-01-01', pre: 3,
    note: 'Leisure travel into Goa, hill stations and the metros' },
];

/**
 * The span this table actually covers.
 *
 * Outside it, `festivalOf()` returns null. That is the safe direction: a stale calendar means the
 * model sees "no festival" and falls back to its ordinary coefficients, whereas a calendar that
 * kept extrapolating would mean the model saw Diwali on a date that is not Diwali and produced a
 * confident, wrong spike. A test asserts the covered span ends within eighteen months of the
 * build, so the table cannot quietly rot.
 */
export interface CoveredSpan { readonly from: string; readonly to: string }

function spanOf(entries: readonly FestivalEntry[]): CoveredSpan {
  // The lower bound is the earliest RUN-UP day, not the earliest festival day: the window opens
  // `pre` days before the festival, so bounding by festival dates would exclude the days before
  // the year's first festival — three days of Makar Sankranti travel, silently.
  let from = '';
  let to = '';
  for (const e of entries) {
    const start = addDaysStrict(e.dateIso, -e.pre);
    if (from === '' || start < from) from = start;
    if (to === '' || e.dateIso > to) to = e.dateIso;
  }
  return { from, to };
}

/** Whole-day calendar shift on an ISO date, computed in UTC so no timezone can move it. */
function addDaysStrict(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** The span the published table covers. A test fails once this is entirely in the past. */
export const COVERED: CoveredSpan = spanOf(FESTIVALS_2026);

/**
 * Which festival's run-up window `dateIso` falls in, if any.
 *
 * Windows overlap in practice — Durga Puja and Dussehra are a day apart, and Diwali's cluster
 * brushes Chhath's shoulder — so the winner is the festival whose own date is nearest, with the
 * longer run-up breaking ties. Nearest wins rather than "first match", because a date one day
 * before Dussehra is in the Dussehra movement even though it also sits inside Durga Puja's window,
 * and picking by table order would make the answer depend on how the array happened to be sorted.
 */
export function festivalOf(dateIso: string, entries: readonly FestivalEntry[] = FESTIVALS_2026): string | null {
  // The span is taken from the entries in hand, not from the published table, so an injected
  // calendar is judged by its own coverage rather than being silently emptied by someone else's.
  const span = entries === FESTIVALS_2026 ? COVERED : spanOf(entries);
  if (entries.length === 0) return null;
  if (dateIso < span.from || dateIso > span.to) return null;

  let best: FestivalEntry | null = null;
  let bestDays = Number.POSITIVE_INFINITY;
  for (const e of entries) {
    const daysBefore = daysBetweenStrict(dateIso, e.dateIso);
    // Negative means the festival has already passed on this date: out of the run-up window.
    if (daysBefore < 0 || daysBefore > e.pre) continue;
    if (daysBefore < bestDays || (daysBefore === bestDays && best !== null && e.pre > best.pre)) {
      best = e;
      bestDays = daysBefore;
    }
  }
  return best?.key ?? null;
}

/** Whole days from `from` to `to`, negative when `to` is earlier. Pure calendar arithmetic. */
function daysBetweenStrict(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86400000);
}

/** Is this date covered by the published table at all? Useful for saying so honestly in the UI. */
export function isCovered(dateIso: string): boolean {
  return dateIso >= COVERED.from && dateIso <= COVERED.to;
}
