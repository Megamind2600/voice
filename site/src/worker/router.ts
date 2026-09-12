/**
 * router.ts — the routing Web Worker entry point.
 *
 * Phase 0 scope: own graph.bin, build the per-station adjacency lists, and answer lookup
 * queries. CSA journey search lands in Phase 1 behind this same protocol, which is why
 * `type` is a discriminated union rather than one generic 'query' message.
 *
 * The worker loads the dataset itself, IndexedDB fast path included, so the main thread is
 * never blocked by a ~770 KB parse. It posts `ready` as soon as the module evaluates so
 * the UI can queue requests instead of racing worker startup.
 *
 * All real logic lives in ./handlers so the inline fallback cannot drift from this file.
 */

import { handle } from './handlers';
import { WORKER_READY, type WorkerRequest, type WorkerResponse } from '../lib/protocol';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (!req || typeof req.id !== 'number' || typeof req.type !== 'string') {
    const msg: WorkerResponse = { id: -1, ok: false, error: 'malformed request' };
    self.postMessage(msg);
    return;
  }
  void handle(req).then((r) => self.postMessage(r));
};

self.postMessage(WORKER_READY);
