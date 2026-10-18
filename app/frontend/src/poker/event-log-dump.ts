import type { HandEventLogEntry } from './event-log';
import { formatEventLogTime } from './event-log';

/** Stable path for native E2E: `tail -f /tmp/zk-poker-seat{N}-event-log.txt` */
export function eventLogDumpPath(seat: number | null): string {
  const n = seat === null || !Number.isFinite(seat) ? 'x' : String(seat);
  return `/tmp/zk-poker-seat${n}-event-log.txt`;
}

function resolveSeatForDump(explicitSeat: number | null | undefined): number | null {
  if (explicitSeat !== null && explicitSeat !== undefined && Number.isFinite(explicitSeat)) {
    return explicitSeat;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('e2eSeat') ?? params.get('seat');
  if (raw === null || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
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
 * Persist Event log for offline debug. Mirrors to console (`[event-log]`) and
 * POSTs to the chain worker (`/api/debug/event-log` → `/tmp/zk-poker-seatN-…`).
 */
export function dumpHandEventLog(
  entries: readonly HandEventLogEntry[],
  seat?: number | null,
): void {
  const seatN = resolveSeatForDump(seat ?? null);
  const body = entries
    .map((ev) => `${formatEventLogTime(ev.at)} [${ev.kind}] ${ev.message}`)
    .join('\n');
  const contents = `${body}${body ? '\n' : ''}`;

  // Native app.log capture (always).
  console.log(`[event-log] seat=${seatN ?? 'x'} n=${entries.length}`);
  for (const line of contents.split('\n')) {
    if (line) {
      console.log(`[event-log] ${line}`);
    }
  }

  const url = dumpUrl();
  if (url) {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat: seatN, contents }),
    }).catch(() => {
      // Worker may be mid-startHand; meta dump below still available.
    });
  }

  // Throttled native dump to `.local/event-log-seat-N.json` (and mirrored text)
  // so E2E can inspect without the :3850 worker.
  void dumpEventLogViaMeta(seatN, contents);
}

let lastMetaDumpAt = 0;
async function dumpEventLogViaMeta(seatN: number | null, contents: string): Promise<void> {
  const now = Date.now();
  if (now - lastMetaDumpAt < 2000) return;
  lastMetaDumpAt = now;
  try {
    const { getSharedMetaStore } = await import('../backend/solana-meta-bridge');
    const key = `event-log-seat-${seatN ?? 'x'}`;
    getSharedMetaStore().write(key, JSON.stringify({
      path: eventLogDumpPath(seatN),
      contents,
      updatedAt: now,
    }));
  } catch {
    // Bridge optional in browser; console dump above still available.
  }
}
