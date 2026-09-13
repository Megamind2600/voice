/**
 * useProfiles.ts — fetch the authored destination notes once, off the critical path.
 *
 * The notes are the one part of this app that is editorial rather than harvested, and they are
 * also the part that grows without bound: every city added is prose, not logic. So they ship as
 * `data/profiles.json` next to the packed timetable and are fetched separately, which buys two
 * things the bundle could not:
 *
 *   1. The planner can render before the notes arrive. Nothing on the search path waits for
 *      them; only the explore cards change when they land.
 *   2. Failure is survivable. If the file is missing or malformed the index stays null and the
 *      UI falls back to what the timetable knows on its own — a junction with 238 trains a day
 *      is still an answer — instead of breaking the screen.
 *
 * The fetch is a plain GET and the browser's HTTP cache does the rest: the file is small, static
 * and hashed by the CDN, and the packed dataset already owns the IndexedDB budget for the one
 * thing large enough to need it.
 */
import { useEffect, useState } from 'preact/hooks';
import { buildProfileIndex, type ProfileIndex } from '../discovery/profiles';
import type { DestinationProfile } from '../discovery/profiles/types';
import { dataBaseUrl } from './cache';

export interface ProfilesState {
  /** Null until the notes have loaded; null forever if they never do. */
  index: ProfileIndex | null;
  loading: boolean;
  error: string | null;
}

const INITIAL: ProfilesState = { index: null, loading: true, error: null };

/**
 * Turn whatever came back into an index, or throw.
 *
 * Deliberately shallow: this is the boundary between a file on a server and the rest of the app,
 * so it checks the shape that would crash a renderer (a list of objects with codes, a name, a
 * why and sights) and leaves the editorial questions — do these codes exist, does the prose say
 * anything — to the validator test, which can afford to be thorough.
 */
export function parseProfiles(raw: unknown): ProfileIndex {
  const list = Array.isArray(raw)
    ? raw
    : (raw as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list)) {
    throw new Error('profiles.json: expected an object with a `profiles` array');
  }
  for (const p of list) {
    const o = p as Partial<DestinationProfile> | null;
    if (!o || typeof o !== 'object' || !Array.isArray(o.codes) || typeof o.name !== 'string') {
      throw new Error('profiles.json: a profile is missing its codes or its name');
    }
    if (typeof o.why !== 'string' || !Array.isArray(o.sights)) {
      throw new Error(`profiles.json: ${o.name} is missing its why or its sights`);
    }
  }
  return buildProfileIndex(list as DestinationProfile[]);
}

/** Fetch and index the notes. Throws if the file is unreachable or does not parse. */
export async function fetchProfiles(url: string, signal?: AbortSignal): Promise<ProfileIndex> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return parseProfiles(await res.json());
}

/**
 * @param url defaults to `data/profiles.json` beside the packed dataset, resolved the same way
 *   the dataset is so the app works from a GitHub Pages subdirectory as well as from `/`.
 */
export function useProfiles(url = `${dataBaseUrl()}profiles.json`): ProfilesState {
  const [state, setState] = useState<ProfilesState>(INITIAL);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const index = await fetchProfiles(url, ac.signal);
        if (ac.signal.aborted) return;
        setState({ index, loading: false, error: null });
      } catch (err) {
        if (ac.signal.aborted) return;
        // Not an error the user needs a banner for: the explore screen simply answers with the
        // timetable alone. The console keeps the reason for whoever is debugging the deploy.
        console.warn('destination notes unavailable:', err);
        setState({
          index: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => ac.abort();
  }, [url]);

  return state;
}
