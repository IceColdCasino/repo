/**
 * Bun FFI for the Zig player bridge (same JSON ops as window.zero `player`).
 * Not imported by the Vite / WebView graph — see player-bridge-ffi-shim.
 */
import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  createPlayerSession,
  type PlayerSession,
} from './player-native-bridge';
import { groth16ProveConcurrency } from './arcium/heap';

function zkcasinoLib(file: string): string {
  const dir = process.env.ZKCASINO_LIB_DIR;
  if (dir && dir.length > 0) return path.join(dir, file);
  return path.join(import.meta.dir, '../libzkcasino/zig-out/lib', file);
}

const libPath = zkcasinoLib(`libzkcasino-player-bridge.${suffix}`);

const SYMBOLS = {
  zkplayer_bridge_create: { args: [], returns: FFIType.ptr },
  zkplayer_bridge_create_ex: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  zkplayer_bridge_free: { args: [FFIType.ptr], returns: FFIType.void },
  zkplayer_bridge_op: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

let lib: ReturnType<typeof dlopen<typeof SYMBOLS>> | undefined;

export function playerBridgeFfiAvailable(): boolean {
  return existsSync(libPath);
}

export function requirePlayerBridge(): void {
  if (!playerBridgeFfiAvailable()) {
    throw new Error(
      `libzkcasino-player-bridge not found at ${libPath}. Build it with: cd libzkcasino && zig build player-bridge-lib`,
    );
  }
}

function getLib() {
  if (!lib) {
    requirePlayerBridge();
    lib = dlopen(libPath, SYMBOLS);
  }
  return lib;
}

const OUT_CAP = 1 << 20;

type BridgePtr = NonNullable<ReturnType<ReturnType<typeof getLib>['symbols']['zkplayer_bridge_create']>>;

function pointerKey(handle: BridgePtr): string {
  return typeof handle === 'bigint' ? handle.toString() : BigInt(handle).toString();
}

type WorkerResponse = { id: number; body?: string; error?: string };

type Inflight = {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
};

/**
 * Prove calls are synchronous FFI. A pool of workers lets two seats run
 * register or share at the same time; the main thread stays free for the
 * chain and Arcis waits. Idle workers are unref'd so the process can exit.
 */
class ProvePool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiters: Array<{ handle: string; json: string; inflight: Inflight }> = [];
  private readonly inflight = new Map<number, { worker: Worker; job: Inflight }>();
  private nextId = 1;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const n = groth16ProveConcurrency();
    const url = new URL('./player-bridge-worker.ts', import.meta.url);
    for (let i = 0; i < n; i++) {
      const worker = new Worker(url);
      worker.on('message', (msg: WorkerResponse) => this.onMessage(worker, msg));
      worker.on('error', (err) => {
        this.onWorkerError(worker, err instanceof Error ? err : new Error(String(err)));
      });
      worker.unref();
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  run(handle: BridgePtr, json: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      const job = { handle: pointerKey(handle), json, inflight: { resolve, reject } };
      const worker = this.idle.pop();
      if (worker) this.dispatch(worker, job);
      else this.waiters.push(job);
    });
  }

  private dispatch(
    worker: Worker,
    job: { handle: string; json: string; inflight: Inflight },
  ): void {
    const id = this.nextId++;
    this.inflight.set(id, { worker, job: job.inflight });
    worker.ref();
    worker.postMessage({ id, handle: job.handle, json: job.json });
  }

  private onMessage(worker: Worker, msg: WorkerResponse): void {
    const pending = this.inflight.get(msg.id);
    this.inflight.delete(msg.id);
    if (pending) {
      if (msg.error) pending.job.reject(new Error(msg.error));
      else pending.job.resolve(msg.body ?? '');
    }
    this.release(worker);
  }

  private onWorkerError(worker: Worker, err: Error): void {
    for (const [id, pending] of this.inflight) {
      if (pending.worker !== worker) continue;
      this.inflight.delete(id);
      pending.job.reject(err);
    }
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleAt = this.idle.indexOf(worker);
    if (idleAt >= 0) this.idle.splice(idleAt, 1);
    worker.unref();
  }

  private release(worker: Worker): void {
    const next = this.waiters.shift();
    if (next) {
      this.dispatch(worker, next);
      return;
    }
    worker.unref();
    this.idle.push(worker);
  }
}

const provePool = new ProvePool();

function opJson(handle: BridgePtr, json: string): string {
  const input = Buffer.from(json, 'utf8');
  const out = new Uint8Array(OUT_CAP);
  const lenSlot = new BigUint64Array(1);
  const rc = getLib().symbols.zkplayer_bridge_op(
    handle,
    ptr(input),
    input.length,
    ptr(out),
    OUT_CAP,
    ptr(lenSlot),
  );
  if (rc === -3) {
    throw new Error('zkplayer_bridge_op output overflow');
  }
  if (rc !== 0) {
    throw new Error(`zkplayer_bridge_op failed (${rc})`);
  }
  return new TextDecoder().decode(out.subarray(0, Number(lenSlot[0]!)));
}

type BridgeHandle = NonNullable<ReturnType<ReturnType<typeof getLib>['symbols']['zkplayer_bridge_create']>>;

const calcHandles = new Map<string, BridgeHandle>();

/** Synchronous JSON call. Handles stay open for the process. */
export function bridgeCall(kind: number, variant: number, payload: Record<string, unknown>): Record<string, unknown> {
  const key = `${kind}:${variant}`;
  let handle = calcHandles.get(key);
  if (!handle) {
    const opened = getLib();
    const created = kind === 0 && variant === 0
      ? opened.symbols.zkplayer_bridge_create()
      : opened.symbols.zkplayer_bridge_create_ex(kind, variant);
    if (!created) {
      throw new Error(`zkplayer_bridge_create failed for kind ${kind} variant ${variant}`);
    }
    handle = created;
    calcHandles.set(key, handle);
  }
  return JSON.parse(opJson(handle, JSON.stringify(payload))) as Record<string, unknown>;
}

export function openSession(opts?: { kind?: number; variant?: number }): PlayerSession {
  const opened = getLib();
  const kind = opts?.kind ?? 0;
  const variant = opts?.variant ?? 0;
  const handle = kind === 0 && variant === 0
    ? opened.symbols.zkplayer_bridge_create()
    : opened.symbols.zkplayer_bridge_create_ex(kind, variant);
  if (!handle) {
    throw new Error('zkplayer_bridge_create failed');
  }
  const invoke = async (payload: Record<string, unknown>) => {
    const body = await provePool.run(handle, JSON.stringify(payload));
    return JSON.parse(body) as Record<string, unknown>;
  };
  return createPlayerSession(invoke, () => {
    opened.symbols.zkplayer_bridge_free(handle);
  });
}
