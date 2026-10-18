/**
 * Native E2E: report ZK / bridge failures to the Bun game server so tests can log them.
 * Active when URL has nativeE2e=1.
 */

import { resolveApiBase } from '../server/runtime';

export interface ZkHandErrorReport {
  seat: number | null;
  phase: string | null;
  source: 'zk.hand' | 'zk.bridge' | 'zk.import';
  message: string;
  stack?: string;
  circuitName?: string;
  detail?: Record<string, unknown>;
  at: string;
}

declare global {
  interface Window {
    __zkE2eLastError?: ZkHandErrorReport;
  }
}

function isNativeE2e(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('nativeE2e') === '1';
}

/** iOS simulator full-game harness owns register/shuffle/share/showdown ZK (see ios-e2e-full-game.ts). */
export function isIosE2eFullGameHarness(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('iosE2eFullGame') === '1';
}

function e2eSeat(): number | null {
  const seat = Number(new URLSearchParams(window.location.search).get('e2eSeat'));
  return Number.isInteger(seat) ? seat : null;
}

/** True when URL explicitly pins showdown to one seat (e2eShowdownSeat=N). */
export function hasExplicitE2eShowdownSeatDesignation(): boolean {
  if (typeof window === 'undefined' || !isNativeE2e()) {
    return false;
  }
  const designated = new URLSearchParams(window.location.search).get('e2eShowdownSeat');
  return designated !== null && designated !== '';
}

/** When set via e2eShowdownSeat=N, only that seat submits native showdown proof. */
export function isE2eDesignatedShowdownSeat(localSeat: number | null): boolean {
  if (!isNativeE2e() || localSeat === null || typeof window === 'undefined') {
    return true;
  }
  const params = new URLSearchParams(window.location.search);
  const designated = params.get('e2eShowdownSeat');
  if (designated === null || designated === '') {
    return true;
  }
  const seat = Number(designated);
  return Number.isInteger(seat) && seat === localSeat;
}

function apiBase(): string {
  return resolveApiBase();
}

function parseErrorMessage(message: string): { message: string; raw?: string } {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) {
    return { message: trimmed };
  }
  try {
    const body = JSON.parse(trimmed) as { error?: unknown };
    if (typeof body.error === 'string') {
      return { message: body.error, raw: trimmed };
    }
  } catch {
    // fall through
  }
  return { message: trimmed };
}

export async function reportZkHandError(partial: Omit<ZkHandErrorReport, 'at' | 'seat'> & { seat?: number | null }): Promise<void> {
  const parsed = parseErrorMessage(partial.message);
  const report: ZkHandErrorReport = {
    seat: partial.seat ?? e2eSeat(),
    phase: partial.phase ?? null,
    source: partial.source,
    message: parsed.message,
    stack: partial.stack,
    circuitName: partial.circuitName,
    detail: {
      ...partial.detail,
      ...(parsed.raw ? { rawError: parsed.raw } : {}),
    },
    at: new Date().toISOString(),
  };

  window.__zkE2eLastError = report;

  console.error('[zk-e2e]', JSON.stringify(report, null, 2));
  if (report.stack) {
    console.error(report.stack);
  }

  if (!isNativeE2e()) {
    return;
  }

  await fetch(`${apiBase()}/api/admin/zk-hand-error?backend=local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  }).catch((err) => {
    console.error('[zk-e2e] failed to POST zk-hand-error:', err);
  });

  // Native dual-player serves static files (POST → 501). Persist via solana.meta
  // so host-side debugging can read `.local/zk-hand-error-seat-N.json`.
  try {
    const { getSharedMetaStore } = await import('../backend/solana-meta-bridge');
    const seatKey = report.seat ?? 'x';
    getSharedMetaStore().write(
      `zk-hand-error-seat-${seatKey}`,
      JSON.stringify(report, null, 2),
    );
  } catch {
    // bridge optional
  }
}
