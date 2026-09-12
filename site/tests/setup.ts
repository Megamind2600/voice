/**
 * Vitest setup.
 *
 * `fake-indexeddb/auto` installs an IndexedDB implementation on globalThis so the cache
 * layer can be tested without a browser. Without it, `indexedDB` is undefined in jsdom and
 * every code path silently takes the "storage unavailable" fallback — the tests would pass
 * while testing nothing.
 *
 * The cleanup hook is required because Vitest does not enable Testing Library's
 * auto-cleanup (that only happens with `globals: true`). Without it every render accumulates
 * in the same document and `getByRole` starts failing with "found multiple elements".
 */
import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

afterEach(() => {
  cleanup();
});

/**
 * jsdom does not implement Element.scrollIntoView. The autocomplete calls it to keep the
 * highlighted option visible; without this stub the call throws INSIDE an effect, which
 * aborts Preact's state flush and makes every subsequent keyboard assertion fail for a
 * reason that has nothing to do with keyboard handling. Polyfilling in test setup is the
 * right fix — guarding the call in production code would distort real behaviour to work
 * around a gap that only exists in jsdom.
 */
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* no-op */ };
}
