/**
 * client.ts — typed wrapper around the routing worker.
 *
 * Turns the postMessage protocol into promises so UI code can `await` a result instead of
 * hand-rolling an id-matching switch. Also owns the worker lifecycle: Vite bundles
 * `new Worker(new URL(...), { type: 'module' })` into a separate chunk, and if that fails
 * we fall back to running the same handlers on the main thread so the app degrades rather
 * than dying in a browser without module-worker support.
 */

import type {
  JourneysRequest, ResponseMap, WorkerRequest, WorkerResponse, WORKER_READY,
} from '../lib/protocol';
import type { ResolvedGroup } from '../router/terminals';

interface Pending {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
  timer: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export class RouterClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly readySignal: Promise<void>;
  private readyResolve!: () => void;

  private worker: Worker | null = null;
  private inline: typeof import('../worker/inline') | null = null;

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.readySignal = new Promise<void>((r) => { this.readyResolve = r; });
  }

  /** Start the worker. Safe to call once; later calls are no-ops. */
  async start(): Promise<void> {
    if (this.worker || this.inline) return this.readySignal;

    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('../worker/router.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (ev: MessageEvent<WorkerResponse | typeof WORKER_READY>) => {
          this.onMessage(ev.data);
        };
        this.worker.onerror = (ev) => {
          // A worker that dies on startup should not take the app with it.
          this.rejectAll(new Error(`worker error: ${ev.message || 'unknown'}`));
          this.worker?.terminate();
          this.worker = null;
          void this.startInline();
        };
        return this.readySignal;
      } catch {
        this.worker = null;
      }
    }
    await this.startInline();
    return this.readySignal;
  }

  private async startInline(): Promise<void> {
    const mod = await import('../worker/inline');
    this.inline = mod;
    this.onMessage('ready');
  }

  private onMessage(msg: WorkerResponse | typeof WORKER_READY): void {
    if (msg === 'ready') { this.readyResolve(); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.stage ? `${msg.stage}: ${msg.error}` : msg.error));
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** True once the worker (or its inline fallback) has posted `ready`. */
  get started(): boolean {
    return this.worker !== null || this.inline !== null;
  }

  /**
   * Send a request and await its matching response.
   *
   * Written as explicit overloads rather than one generic signature: TypeScript cannot
   * reliably infer a discriminant key out of an indexed access type like
   * `Omit<Extract<WorkerRequest, { type: K }>, 'id'>`, so the generic version silently
   * widened K to the whole union and callers lost their response type. Adding a request
   * means adding one line here, which is a fair price for exact return types.
   */
  request(req: { type: 'graph:load' }): Promise<ResponseMap['graph:load']>;
  request(req: { type: 'graph:stats' }): Promise<ResponseMap['graph:stats']>;
  request(req: { type: 'train:stops'; train: number }): Promise<ResponseMap['train:stops']>;
  request(req: {
    type: 'station:trains'; station: number; limit?: number;
  }): Promise<ResponseMap['station:trains']>;
  request(req: {
    type: 'router:configure'; groups: ResolvedGroup[];
  }): Promise<ResponseMap['router:configure']>;
  request(req: Omit<JourneysRequest, 'id'>): Promise<ResponseMap['journeys']>;
  request(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse & { ok: true }> {
    const id = this.nextId++;
    return new Promise<WorkerResponse & { ok: true }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker request ${req.type} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs) as unknown as number;

      this.pending.set(id, {
        resolve: (r) => resolve(r as WorkerResponse & { ok: true }),
        reject,
        timer,
      });

      const message = { ...req, id } as WorkerRequest;
      if (this.worker) this.worker.postMessage(message);
      else if (this.inline) void this.inline.dispatch(message).then((r) => this.onMessage(r));
      else reject(new Error('router client was never started'));
    });
  }

  get ready(): Promise<void> {
    return this.readySignal;
  }

  terminate(): void {
    this.rejectAll(new Error('router client terminated'));
    this.worker?.terminate();
    this.worker = null;
    this.inline = null;
  }
}

export const router = new RouterClient();
