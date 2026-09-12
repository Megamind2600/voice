/**
 * rake.test.ts — Tier 0: the denominator.
 *
 * Two things are being tested here, and the second matters more than the first.
 *
 * The first is the arithmetic: that a Mail/Express sleeper capacity is the coach range times the
 * berth range, that the verified ICF and LHB figures are the ones in the table, and that a
 * Rajdhani is not given a sleeper coach.
 *
 * The second is the refusal. Tier 0 is the only tier that runs with no network and no model, so
 * it is the one under the most pressure to be useful by guessing. Every number it produces is an
 * estimate built from a template, because Indian Railways publishes no rake composition this
 * project may ship. The tests below therefore assert, across the whole cross-product of classes,
 * quotas and train types, that Tier 0 NEVER returns a positive claim: no AVAILABLE, no RAC, no
 * WAITLISTED, no seat count, no LIVE or PREDICTED provenance. It either says an accommodation
 * certainly does not exist, or it says nothing and lets a higher tier answer.
 *
 * Also pinned: that `unknown` is never treated as `no`. Ruling out a quota that might exist
 * deletes a booking option a traveller could have had, which is the same class of harm as
 * inventing availability, just quieter.
 */
import { describe, it, expect } from 'vitest';
import {
  COACH_CAPACITY, BERTH_CLASSES, SEAT_CLASSES, RAKE_TEMPLATES,
  rakeFor, capacityFor, quotaApplies, staticallyImpossible, quotaOptions, tier0Source,
} from '../src/availability/rake';
import type { TrainFacts } from '../src/availability/rake';
import { AvailabilityCascade } from '../src/availability/tier';
import type { AvailabilityQuery } from '../src/availability/tier';
import { TATKAL_CLASSES, hasTatkal } from '../src/availability/rules';

// --- fixtures ---------------------------------------------------------------
// Shaped like the graph's Train records, which is what the worker will actually pass.

const punjabMail: TrainFacts = { type: 'MEX', classes: ['1A', '2A', '3A', 'SL'], classesInferred: false, distanceKm: 1544, runsDays: 127 };
const superfast: TrainFacts = { type: 'SUF', classes: ['2A', '3A', '3E', 'SL', '2S'], runsDays: 127 };
const rajdhani: TrainFacts = { type: 'RAJ', classes: ['1A', '2A', '3A'], runsDays: 127 };
const shatabdi: TrainFacts = { type: 'SHT', classes: ['CC', 'EC'], runsDays: 127 };
const vande: TrainFacts = { type: 'VNDB', classes: ['CC', 'EC'], runsDays: 127 };
const garibRath: TrainFacts = { type: 'GBR', classes: ['3A'], runsDays: 7 };
const duronto: TrainFacts = { type: 'DRNT', classes: ['1A', '2A', '3A', 'SL'], runsDays: 2 };
const suburban: TrainFacts = { type: 'SUB', classes: [], runsDays: 127 };
const passenger: TrainFacts = { type: 'PAX', classes: ['SL'], runsDays: 127 };
const inferredClasses: TrainFacts = { type: 'MEX', classes: ['SL', '3A'], classesInferred: true };
const unknownType: TrainFacts = { type: 'XYZ', classes: ['SL'] };

const ALL_TRAINS: ReadonlyArray<{ name: string; train: TrainFacts }> = [
  { name: 'Mail/Express', train: punjabMail }, { name: 'Superfast', train: superfast },
  { name: 'Rajdhani', train: rajdhani }, { name: 'Shatabdi', train: shatabdi },
  { name: 'Vande Bharat', train: vande }, { name: 'Garib Rath', train: garibRath },
  { name: 'Duronto', train: duronto }, { name: 'Suburban', train: suburban },
  { name: 'Passenger', train: passenger }, { name: 'inferred classes', train: inferredClasses },
  { name: 'unknown type', train: unknownType },
];

const ALL_CLASSES = ['1A', '2A', '3A', '3E', 'SL', 'CC', 'EC', '2S', 'FC'];
const ALL_QUOTAS = ['GN', 'TQ', 'PT', 'LD', 'SS', 'HP', 'DF', 'FT', 'PQ', 'LB', 'XX'];

const q = (trainNumber: string, klass: string, quota: string): AvailabilityQuery => ({
  trainNumber, board: 'NDLS', alight: 'BCT', dateIso: '2026-11-10', klass, quota,
});

describe('the berth table', () => {
  it('pins the verified ICF figures, which every source agrees on', () => {
    // These are corroborated by published berth-numbering lists running 1..72, 1..64 and 1..46.
    expect(COACH_CAPACITY.SL?.ICF?.nominal).toBe(72);
    expect(COACH_CAPACITY['3A']?.ICF?.nominal).toBe(64);
    expect(COACH_CAPACITY['2A']?.ICF?.nominal).toBe(46);
  });

  it('pins the LHB figures as ranges, because sources genuinely disagree', () => {
    // IRFCA gives LHB sleeper as 80 with one berth lost to equipment; other references say 78.
    expect(COACH_CAPACITY.SL?.LHB?.low).toBe(78);
    expect(COACH_CAPACITY.SL?.LHB?.high).toBe(80);
    // LHB 2A is 54 in three sources and 52 in a fourth. Collapsing that to one number would
    // hide the disagreement rather than resolve it.
    expect(COACH_CAPACITY['2A']?.LHB?.low).toBe(52);
    expect(COACH_CAPACITY['2A']?.LHB?.high).toBe(54);
    expect(COACH_CAPACITY['3A']?.LHB?.nominal).toBe(72);
  });

  it('keeps every range ordered, so a low bound can never exceed its own high bound', () => {
    for (const [klass, gens] of Object.entries(COACH_CAPACITY)) {
      for (const [gen, cap] of Object.entries(gens)) {
        if (!cap) continue;
        expect(cap.low, `${klass}/${gen}`).toBeLessThanOrEqual(cap.nominal);
        expect(cap.nominal, `${klass}/${gen}`).toBeLessThanOrEqual(cap.high);
        expect(cap.low, `${klass}/${gen}`).toBeGreaterThan(0);
      }
    }
  });

  it('has no ICF entry for 3E, which is an LHB-era class', () => {
    expect(COACH_CAPACITY['3E']?.ICF).toBeUndefined();
    expect(COACH_CAPACITY['3E']?.LHB).toBeTruthy();
    // Garib Rath runs the higher-density 78-berth 3-tier coach, hence the low bound.
    expect(COACH_CAPACITY['3E']?.LHB?.low).toBe(78);
  });

  it('keeps berth and seat classes disjoint and together covering the table', () => {
    for (const k of BERTH_CLASSES) expect(SEAT_CLASSES, k).not.toContain(k);
    for (const klass of Object.keys(COACH_CAPACITY)) {
      expect(BERTH_CLASSES.includes(klass) || SEAT_CLASSES.includes(klass), `${klass} must be classified`).toBe(true);
    }
  });
});

describe('composition templates', () => {
  it('gives Rajdhani and Garib Rath no sleeper, because both are all-AC by definition', () => {
    const raj = RAKE_TEMPLATES.find((t) => t.type === 'RAJ');
    const gbr = RAKE_TEMPLATES.find((t) => t.type === 'GBR');
    expect(raj?.coaches.SL).toBeUndefined();
    expect(gbr?.coaches.SL).toBeUndefined();
    expect(gbr?.coaches['2A']).toBeUndefined();
  });

  it('gives Shatabdi and Vande Bharat no berth class, because both are daytime chair-car trains', () => {
    for (const type of ['SHT', 'VNDB']) {
      const t = RAKE_TEMPLATES.find((x) => x.type === type);
      expect(t, type).toBeTruthy();
      for (const klass of Object.keys(t!.coaches)) {
        expect(SEAT_CLASSES, `${type} should not run ${klass}`).toContain(klass);
      }
    }
  });

  it('marks suburban stock unbookable — there is no availability question to answer', () => {
    expect(RAKE_TEMPLATES.find((t) => t.type === 'SUB')?.bookable).toBe(false);
    expect(rakeFor(suburban).bookable).toBe(false);
  });

  it('has a berth figure for every class every template offers, in that template generation', () => {
    // This is the consistency check that keeps the two tables from drifting apart. A template
    // offering a class with no capacity figure would silently produce a null denominator.
    for (const t of RAKE_TEMPLATES) {
      for (const klass of Object.keys(t.coaches)) {
        const cap = COACH_CAPACITY[klass]?.[t.gen]
          ?? COACH_CAPACITY[klass]?.LHB ?? COACH_CAPACITY[klass]?.ICF;
        expect(cap, `${t.type} offers ${klass} but no figure exists for ${t.gen}`).toBeTruthy();
      }
    }
  });

  it('stores every coach count as a range, never as a single confident number', () => {
    for (const t of RAKE_TEMPLATES) {
      for (const [klass, range] of Object.entries(t.coaches)) {
        expect(Array.isArray(range), `${t.type}/${klass}`).toBe(true);
        expect(range.length, `${t.type}/${klass}`).toBe(2);
        expect(range[0], `${t.type}/${klass}`).toBeLessThanOrEqual(range[1]);
        expect(range[0], `${t.type}/${klass}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('rakeFor', () => {
  it('restricts a template to the classes the train actually offers', () => {
    // The SUF template allows 1A; this train does not run it, so it must not appear.
    const noFirstAc: TrainFacts = { type: 'SUF', classes: ['SL', '3A'] };
    const rake = rakeFor(noFirstAc);
    expect(Object.keys(rake.coaches).sort()).toEqual(['3A', 'SL']);
  });

  it('keeps a class the train offers but the template does not know, rather than dropping it', () => {
    // A Rajdhani recorded as running Sleeper is a data problem, but silently deleting a class
    // the train demonstrably runs would hide it. It is kept with the weakest possible range.
    const oddRaj: TrainFacts = { type: 'RAJ', classes: ['1A', '2A', '3A', 'SL'] };
    const rake = rakeFor(oddRaj);
    expect(rake.coaches.SL).toEqual([1, 2]);
    expect(rake.coaches['1A']).toEqual([1, 1]);
  });

  it('is most confident about the types whose composition is definitional', () => {
    expect(rakeFor(rajdhani).confidence).toBe('high');
    expect(rakeFor(shatabdi).confidence).toBe('high');
    expect(rakeFor(vande).confidence).toBe('high');
    expect(rakeFor(garibRath).confidence).toBe('high');
    expect(rakeFor(punjabMail).confidence).toBe('medium');
  });

  it('drops to low confidence when the class list itself was inferred', () => {
    // Guessing a rake on top of a guessed class list compounds; the estimate must say so.
    expect(rakeFor(inferredClasses).confidence).toBe('low');
    const sameButKnown: TrainFacts = { type: 'MEX', classes: ['SL', '3A'] };
    expect(rakeFor(sameButKnown).confidence).toBe('medium');
  });

  it('drops to low confidence for an unrecognised type code', () => {
    expect(rakeFor(unknownType).confidence).toBe('low');
    expect(rakeFor(unknownType).basis).toMatch(/not recognised/i);
  });

  it('names the generation it assumed, so the estimate can be argued with', () => {
    expect(rakeFor(punjabMail).gen).toBe('LHB');
    expect(rakeFor(vande).gen).toBe('VB');
    expect(rakeFor(punjabMail).basis).toMatch(/Mail\/Express/);
  });
});

describe('capacityFor', () => {
  it('returns null for a class the train does not run, instead of estimating one anyway', () => {
    expect(capacityFor(shatabdi, 'SL')).toBeNull();
    expect(capacityFor(rajdhani, 'SL')).toBeNull();
    expect(capacityFor(punjabMail, 'CC')).toBeNull();
    expect(capacityFor(suburban, 'SL')).toBeNull();
  });

  it('multiplies the coach range by the berth range, low to low and high to high', () => {
    const cap = capacityFor(punjabMail, 'SL');
    expect(cap).toBeTruthy();
    const rake = rakeFor(punjabMail);
    const [minCoaches, maxCoaches] = rake.coaches.SL!;
    const perCoach = COACH_CAPACITY.SL![rake.gen]!;
    expect(cap!.low).toBe(minCoaches * perCoach.low);
    expect(cap!.high).toBe(maxCoaches * perCoach.high);
    expect(cap!.low).toBeLessThanOrEqual(cap!.nominal);
    expect(cap!.nominal).toBeLessThanOrEqual(cap!.high);
  });

  it('produces a denominator that makes the WL-23 distinction the module exists for', () => {
    // docs/01 §8: 12 sleeper coaches x 72 berths = 864. A Mail/Express must land in the same
    // order of magnitude, so that WL 23 against it reads as nothing like WL 23 against a
    // single-coach passenger train.
    const mail = capacityFor(punjabMail, 'SL')!;
    expect(mail.nominal).toBeGreaterThan(500);
    expect(mail.nominal).toBeLessThan(1400);

    const oneCoach: TrainFacts = { type: 'PAX', classes: ['SL'] };
    const small = capacityFor(oneCoach, 'SL')!;
    expect(small.high).toBeLessThan(mail.low);
  });

  it('is always flagged estimated — nothing in this build observes a real rake', () => {
    for (const { train } of ALL_TRAINS) {
      for (const klass of train.classes) {
        const cap = capacityFor(train, klass);
        if (cap) expect(cap.estimated, `${train.type}/${klass}`).toBe(true);
      }
    }
  });

  it('never lets the number travel without the segment caveat', () => {
    // A rake total shown next to one leg would be read as that leg's pool. IRCTC allots quota
    // per boarding/alighting pair, so the caveat is part of the value, not decoration.
    for (const { train } of ALL_TRAINS) {
      for (const klass of train.classes) {
        const cap = capacityFor(train, klass);
        if (!cap) continue;
        expect(cap.basis, `${train.type}/${klass}`).toMatch(/not your segment/i);
        expect(cap.basis, `${train.type}/${klass}`).toMatch(/not published/i);
        expect(cap.basis, `${train.type}/${klass}`).toMatch(/Estimated from/i);
      }
    }
  });

  it('propagates low confidence from an inferred class list into the capacity', () => {
    expect(capacityFor(inferredClasses, 'SL')?.confidence).toBe('low');
    expect(capacityFor(rajdhani, '3A')?.confidence).toBe('high');
  });

  it('is case-insensitive about the class code', () => {
    expect(capacityFor(punjabMail, 'sl')?.nominal).toBe(capacityFor(punjabMail, 'SL')?.nominal);
  });
});

describe('quotaApplies — the three states', () => {
  it('agrees with rules.ts about Tatkal for every class, so the two cannot drift', () => {
    for (const klass of [...ALL_CLASSES, 'EA']) {
      const applies = quotaApplies(klass, 'TQ');
      if (hasTatkal(klass)) {
        expect(applies, `${klass} is a Tatkal class`).toBe('yes');
        expect(TATKAL_CLASSES).toContain(klass === 'EA' ? 'EA' : klass);
      } else {
        expect(applies, `${klass} must not have Tatkal`).toBe('no');
      }
    }
  });

  it('rules out Tatkal in 1A, which is a published fact', () => {
    expect(quotaApplies('1A', 'TQ')).toBe('no');
    expect(quotaApplies('1A', 'PT')).toBe('no');
    expect(quotaApplies('SL', 'TQ')).toBe('yes');
    expect(quotaApplies('3A', 'TQ')).toBe('yes');
  });

  it('always allows the general quota, which is the default pool', () => {
    for (const klass of ALL_CLASSES) expect(quotaApplies(klass, 'GN'), klass).toBe('yes');
  });

  it('rules out berth-position quotas in seat classes, where there are no berths to reserve', () => {
    for (const klass of ['CC', 'EC', '2S']) {
      expect(quotaApplies(klass, 'HP'), klass).toBe('no');
      expect(quotaApplies(klass, 'SS'), klass).toBe('no');
      expect(quotaApplies(klass, 'LB'), klass).toBe('no');
    }
    // Ladies does exist in Second Sitting, so 2S is the exception.
    expect(quotaApplies('2S', 'LD')).toBe('yes');
    expect(quotaApplies('SL', 'LD')).toBe('yes');
    // Nothing published rules the Ladies quota out of a chair car, so it stays unknown rather
    // than impossible.
    expect(quotaApplies('CC', 'LD')).toBe('unknown');
    expect(quotaApplies('EC', 'LD')).toBe('unknown');
  });

  it('treats genuinely uncertain cases as unknown, never as impossible', () => {
    // Sources conflict on whether the Ladies quota reaches the AC berth classes. One says
    // Sleeper and Second Sitting only, another says it appears in 3A and 2A on most long-distance
    // trains. Deciding either way would delete a real option for someone.
    expect(quotaApplies('3A', 'LD')).toBe('unknown');
    // Sleeper IS documented — six lower berths per coach — so this one is a yes.
    expect(quotaApplies('SL', 'LD')).toBe('yes');
    expect(quotaApplies('SL', 'HP')).toBe('unknown');
    expect(quotaApplies('SL', 'SS')).toBe('unknown');
    for (const quota of ['DF', 'FT', 'PQ', 'PH', 'HO', 'DP']) {
      expect(quotaApplies('SL', quota), quota).toBe('unknown');
    }
  });

  it('rules out a quota code IRCTC does not use', () => {
    expect(quotaApplies('SL', 'ZZ')).toBe('no');
    expect(quotaApplies('SL', '')).toBe('no');
  });
});

describe('staticallyImpossible', () => {
  it('rules out a class the train does not run, and names the classes it does', () => {
    const reason = staticallyImpossible(q('12951', 'SL', 'GN'), rajdhani);
    expect(reason).toMatch(/does not run SL/);
    expect(reason).toMatch(/1A, 2A, 3A/);
  });

  it('rules out Tatkal in 1A with an explanation that offers the way out', () => {
    const reason = staticallyImpossible(q('12951', '1A', 'TQ'), rajdhani);
    expect(reason).toMatch(/1A has no Tatkal quota/);
  });

  it('rules out the Divyangjan quota in a chair car, where there are no berths', () => {
    const reason = staticallyImpossible(q('12001', 'CC', 'HP'), shatabdi);
    expect(reason).toMatch(/seats, not berths/);
  });

  it('says nothing at all when the option might exist', () => {
    expect(staticallyImpossible(q('12138', 'SL', 'GN'), punjabMail)).toBeNull();
    expect(staticallyImpossible(q('12138', 'SL', 'LD'), punjabMail)).toBeNull();
    expect(staticallyImpossible(q('12138', '3A', 'TQ'), punjabMail)).toBeNull();
    expect(staticallyImpossible(q('12001', 'CC', 'LD'), shatabdi)).toBeNull();
  });

  it('says nothing when it cannot resolve the train — unknown is not impossible', () => {
    expect(staticallyImpossible(q('99999', 'SL', 'GN'), null)).toBeNull();
  });

  it('says nothing when the class list is empty, because that is a hole in the data', () => {
    // The CC0 bootstrap leaves `classes` blank often enough that this is common, not rare.
    // Reading an empty list as "runs nothing" would rule out every booking on that train.
    const noClasses: TrainFacts = { type: 'MEX', classes: [] };
    expect(staticallyImpossible(q('12138', 'SL', 'GN'), noClasses)).toBeNull();
    expect(staticallyImpossible(q('12138', 'SL', 'TQ'), noClasses)).toBeNull();
    // A quota code IRCTC does not use is still ruled out: that needs no train data at all.
    expect(staticallyImpossible(q('12138', 'SL', 'QQ'), noClasses)).toMatch(/QQ/);
    expect(capacityFor(noClasses, 'SL')).toBeNull();
    expect(rakeFor(noClasses).confidence).toBe('low');
  });

  it('is case-insensitive about both class and quota', () => {
    expect(staticallyImpossible(q('12951', '1a', 'tq'), rajdhani)).toMatch(/no Tatkal/);
    expect(staticallyImpossible(q('12951', '2a', 'gn'), rajdhani)).toBeNull();
  });
});

describe('quotaOptions', () => {
  it('always offers the general quota first', () => {
    for (const klass of ALL_CLASSES) {
      const opts = quotaOptions(klass);
      expect(opts.length, klass).toBeGreaterThan(0);
      expect(opts[0].code, klass).toBe('GN');
    }
  });

  it('omits Tatkal for 1A and offers it elsewhere', () => {
    expect(quotaOptions('1A').map((o) => o.code)).not.toContain('TQ');
    expect(quotaOptions('1A').map((o) => o.code)).not.toContain('PT');
    expect(quotaOptions('SL').map((o) => o.code)).toContain('TQ');
    expect(quotaOptions('3A').map((o) => o.code)).toContain('PT');
  });

  it('never lists a quota that quotaApplies has already ruled out', () => {
    for (const klass of ALL_CLASSES) {
      for (const opt of quotaOptions(klass)) {
        expect(quotaApplies(klass, opt.code), `${klass}/${opt.code}`).not.toBe('no');
      }
    }
  });

  it('says when a pool size is not published, rather than inventing one', () => {
    const df = quotaOptions('SL').find((o) => o.code === 'DF');
    expect(df?.pool).toMatch(/not published/i);
    const ld = quotaOptions('SL').find((o) => o.code === 'LD');
    expect(ld?.pool).toMatch(/6 lower berths/i);
  });
});

describe('Tier 0 as a cascade source — the refusal', () => {
  const cascade = new AvailabilityCascade([tier0Source((n) =>
    ALL_TRAINS.find((t) => t.name === n)?.train ?? null)]);

  it('reports itself as an active tier, so the UI knows something answered', () => {
    expect(cascade.activeTiers()).toContain('T0');
  });

  it('never produces a positive claim for any class, quota or train type', async () => {
    // This is the load-bearing test. Across the full cross-product, Tier 0 may only ever answer
    // REGRET/STATIC or fall through to UNKNOWN/NONE. Anything else is a fabricated seat.
    //
    // Every lookup is collected rather than returned in-loop: an early `return` inside the first
    // iteration would silently test one combination out of a thousand and still pass.
    const checks: Array<Promise<void>> = [];
    for (const { name } of ALL_TRAINS) {
      for (const klass of ALL_CLASSES) {
        for (const quota of ALL_QUOTAS) {
          checks.push(cascade.lookup(q(name, klass, quota)).then((r) => {
            expect(['REGRET', 'UNKNOWN'], `${name}/${klass}/${quota}`).toContain(r.status.verdict);
            expect(r.status.seats, `${name}/${klass}/${quota}`).toBeUndefined();
            expect(r.status.wlPosition, `${name}/${klass}/${quota}`).toBeUndefined();
            expect(r.status.racPosition, `${name}/${klass}/${quota}`).toBeUndefined();
            if (r.tier === 'T0') {
              expect(r.source, `${name}/${klass}/${quota}`).toBe('STATIC');
              expect(r.status.verdict, `${name}/${klass}/${quota}`).toBe('REGRET');
              expect(r.explanation.length).toBeGreaterThan(20);
            } else {
              expect(r.source, `${name}/${klass}/${quota}`).toBe('NONE');
              expect(r.status.verdict, `${name}/${klass}/${quota}`).toBe('UNKNOWN');
            }
            expect(['STATIC', 'NONE'], `${name}/${klass}/${quota}`).toContain(r.source);
            expect(['LIVE', 'PREDICTED', 'SNAPSHOT']).not.toContain(r.source);
          }));
        }
      }
    }
    await Promise.all(checks);
    // Guards the guard: if the loops ever collapse, this fails instead of passing vacuously.
    expect(checks.length).toBe(ALL_TRAINS.length * ALL_CLASSES.length * ALL_QUOTAS.length);
  });

  it('answers REGRET for an accommodation that certainly does not exist', async () => {
    const r = await cascade.lookup(q('Mail/Express', 'CC', 'GN'));
    expect(r.status.verdict).toBe('REGRET');
    expect(r.tier).toBe('T0');
    expect(r.source).toBe('STATIC');
    expect(r.explanation).toMatch(/does not run CC/);
  });

  it('falls through to UNKNOWN for a plausible query, which it has no opinion about', async () => {
    // A daily Mail/Express, Sleeper, general quota: the most ordinary booking in Indian
    // Railways. Tier 0 must not answer it, because it cannot know whether a berth is free.
    const r = await cascade.lookup(q('Mail/Express', 'SL', 'GN'));
    expect(r.status.verdict).toBe('UNKNOWN');
    expect(r.source).toBe('NONE');
    expect(r.tier).toBeNull();
    // Not "no source is connected" — Tier 0 WAS consulted and declined, which is a different
    // and more useful thing to tell a traveller. It means the question was answerable in
    // principle and simply could not be answered from static data.
    expect(r.explanation).toMatch(/declined this query/i);
  });

  it('falls through when it cannot resolve the train at all', async () => {
    const r = await cascade.lookup(q('not-a-known-train', 'SL', 'GN'));
    expect(r.status.verdict).toBe('UNKNOWN');
    expect(r.source).toBe('NONE');
  });
});
