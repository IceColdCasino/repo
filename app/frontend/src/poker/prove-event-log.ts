/**
 * Bridge from native `zk.prove` (witness + Groth16) into the UI Event log.
 * Poker.svelte registers a listener; runtime.ts emits start/end for every prove.
 */

export type ProveEventPhase = 'start' | 'done' | 'failed';

export interface ProveEventPayload {
  phase: ProveEventPhase;
  circuitName: string;
  seat: number | null;
  ms?: number;
  error?: string;
}

type ProveEventListener = (payload: ProveEventPayload) => void;

let listener: ProveEventListener | null = null;

/** Optional seat override while a zk-hand-flow submit is in progress. */
let proveSeatOverride: number | null = null;

export function setProveEventLogListener(next: ProveEventListener | null): void {
  listener = next;
}

export function setProveSeatOverride(seat: number | null): void {
  proveSeatOverride = seat;
}

export async function withProveSeat<T>(seat: number, fn: () => Promise<T>): Promise<T> {
  const prev = proveSeatOverride;
  proveSeatOverride = seat;
  try {
    return await fn();
  } finally {
    proveSeatOverride = prev;
  }
}

function resolveProveSeat(): number | null {
  if (proveSeatOverride !== null) {
    return proveSeatOverride;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('e2eSeat') ?? params.get('seat');
  if (fromUrl !== null && fromUrl !== '') {
    const n = Number(fromUrl);
    if (Number.isInteger(n) && n >= 0 && n <= 9) {
      return n;
    }
  }
  const cfg = (window as Window & {
    __ZK_LAUNCH_CONFIG?: { seat?: number };
  }).__ZK_LAUNCH_CONFIG;
  if (typeof cfg?.seat === 'number' && Number.isInteger(cfg.seat)) {
    return cfg.seat;
  }
  return null;
}

export function formatProveEventMessage(payload: ProveEventPayload): string {
  const seatLabel = payload.seat !== null ? ` (seat ${payload.seat})` : '';
  if (payload.phase === 'start') {
    return `Witness+prove start: ${payload.circuitName}${seatLabel}`;
  }
  if (payload.phase === 'done') {
    const ms = payload.ms ?? 0;
    return `Witness+prove done: ${payload.circuitName} ${ms}ms${seatLabel}`;
  }
  const err = payload.error ? `: ${payload.error}` : '';
  const ms = payload.ms !== undefined ? ` ${payload.ms}ms` : '';
  return `Witness+prove failed: ${payload.circuitName}${ms}${seatLabel}${err}`;
}

export function emitProveEvent(
  phase: ProveEventPhase,
  circuitName: string,
  opts?: { ms?: number; error?: string; seat?: number | null },
): void {
  const payload: ProveEventPayload = {
    phase,
    circuitName,
    seat: opts?.seat !== undefined ? opts.seat : resolveProveSeat(),
    ms: opts?.ms,
    error: opts?.error,
  };
  const message = formatProveEventMessage(payload);
  if (phase === 'failed') {
    console.warn(`[zk] ${message}`);
  } else {
    console.log(`[zk] ${message}`);
  }
  listener?.(payload);
}
