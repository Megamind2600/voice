/**
 * inline.ts — main-thread fallback for browsers where the module worker fails to start.
 *
 * Same handlers, no isolation. Slower (parsing blocks the UI) but functional, which beats
 * a blank screen. `client.ts` switches to this automatically on worker error.
 */

import { handle } from './handlers';
import type { WorkerRequest, WorkerResponse } from '../lib/protocol';

export async function dispatch(req: WorkerRequest): Promise<WorkerResponse> {
  return handle(req);
}

export { handle };
