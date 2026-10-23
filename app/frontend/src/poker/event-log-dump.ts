import type { HandEventLogEntry } from './event-log';
import { formatEventLogTime } from './event-log';

/** Stable path for native E2E: `tail -f /tmp/zk-poker-seat{N}-event-log.txt` */
export function eventLogDumpPath(seat: number | null): string {
  const n = seat === null || !Number.isFinite(seat) ? 'x' : String(seat);
  return `/tmp/zk-poker-seat${n}-event-log.txt`;
}

export function resolveEventLogSeat(explicitSeat: number | null | undefined): number | null {
  if (explicitSeat !== null && explicitSeat !== undefined && Number.isFinite(explicitSeat)) {
    return explicitSeat;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const launch = (window as Window & {
    __ZK_LAUNCH_CONFIG?: { seat?: number };
  }).__ZK_LAUNCH_CONFIG;
  if (typeof launch?.seat === 'number' && Number.isFinite(launch.seat)) {
    return launch.seat;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('e2eSeat') ?? params.get('seat');
  if (raw === null || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function eventLogMetaKey(seat: number | null): string {
  const n = seat === null || !Number.isFinite(seat) ? 'x' : String(seat);
  return `event-log-seat-${n}`;
}

export function formatHandEventLog(entries: readonly HandEventLogEntry[]): string {
  return entries
    .map((ev) => `${formatEventLogTime(ev.at)} [${ev.kind}] ${ev.message}`)
    .join('\n');
}

function dumpUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const launch = (window as Window & {
    __ZK_LAUNCH_CONFIG?: { apiBase?: string; chainWorker?: string };
  }).__ZK_LAUNCH_CONFIG;
  const base = launch?.chainWorker ?? launch?.apiBase;
  if (typeof base === 'string' && base.length > 0) {
    return `${base.replace(/\/$/, '')}/api/debug/event-log`;
  }
  const params = new URLSearchParams(window.location.search);
  const apiBase = params.get('apiBase') ?? params.get('chainWorker');
  if (apiBase) {
    return `${apiBase.replace(/\/$/, '')}/api/debug/event-log`;
  }
  return null;
}

/**
 * Persist the on-screen Event log for development.
 * Native seats write `.local/event-log-seat-N.json` (plain text) through `solana.meta`.
 * A chain worker, when configured, also receives `/api/debug/event-log`.
 */
export function dumpHandEventLog(
  entries: readonly HandEventLogEntry[],
  seat?: number | null,
): void {
  const seatN = resolveEventLogSeat(seat ?? null);
  const contents = formatHandEventLog(entries);
  const url = dumpUrl();
  if (url) {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat: seatN, contents }),
    }).catch(() => {
      // Worker may be down; the native meta file below is the dev copy.
    });
  }
  scheduleMetaDump(eventLogMetaKey(seatN), contents);
}

type PendingDump = { key: string; contents: string };
let pendingDump: PendingDump | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const lastWrittenByKey = new Map<string, string>();

function scheduleMetaDump(key: string, contents: string): void {
  pendingDump = { key, contents };
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const next = pendingDump;
    pendingDump = null;
    if (!next || lastWrittenByKey.get(next.key) === next.contents) return;
    void flushMetaDump(next);
  }, 300);
}

async function flushMetaDump(next: PendingDump): Promise<void> {
  try {
    const { writeNativeMetaFile } = await import('../backend/solana-meta-bridge');
    await writeNativeMetaFile(next.key, next.contents.endsWith('\n') || next.contents.length === 0
      ? next.contents
      : `${next.contents}\n`);
    lastWrittenByKey.set(next.key, next.contents);
  } catch (err) {
    console.error('[event-log] disk dump failed', next.key, err);
  }
}
