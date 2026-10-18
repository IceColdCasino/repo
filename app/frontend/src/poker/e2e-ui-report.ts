import { resolveApiBase } from '../server/runtime';
import {
  collectTableRenderSnapshot,
  formatTableRenderSnapshot,
} from './e2e-table-render';

export type NativeUiReport = {
  seat: number | null;
  phase: string | null;
  dataPhase: string | null;
  holesAcked: boolean;
  zkBusy: boolean;
  shareComplete: boolean;
  jsAlive: true;
  lifecycleStatus: string | null;
  lastEvent: string | null;
  summary: string;
  at: string;
  kind: 'heartbeat' | 'phase';
};

function isNativeE2e(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('nativeE2e') === '1' || params.get('e2eAutoPlay') === '1';
}

function e2eSeat(): number | null {
  const seat = Number(new URLSearchParams(window.location.search).get('e2eSeat'));
  return Number.isInteger(seat) ? seat : null;
}

function lastEventMessage(): string | null {
  const entries = document.querySelectorAll('[data-testid="hand-event-log"] .event-log-entry');
  const last = entries[entries.length - 1];
  return last?.textContent?.trim() ?? null;
}

export function collectNativeUiReport(
  localSeat: number | null,
  extras: {
    holesAcked?: boolean;
    zkBusy?: boolean;
    shareComplete?: boolean;
    kind?: 'heartbeat' | 'phase';
  } = {},
): NativeUiReport {
  const render = collectTableRenderSnapshot(localSeat);
  const table = document.querySelector('[data-testid="poker-table"]');
  return {
    seat: localSeat ?? e2eSeat(),
    phase: render.phase,
    dataPhase: table?.getAttribute('data-phase') ?? render.phase,
    holesAcked: extras.holesAcked
      ?? table?.getAttribute('data-holes-acked') === 'true',
    zkBusy: extras.zkBusy ?? table?.getAttribute('data-zk-busy') === 'true',
    shareComplete: extras.shareComplete
      ?? table?.getAttribute('data-share-complete') === 'true',
    jsAlive: true,
    lifecycleStatus: render.lifecycleStatus,
    lastEvent: lastEventMessage(),
    summary: formatTableRenderSnapshot(render),
    at: new Date().toISOString(),
    kind: extras.kind ?? 'heartbeat',
  };
}

export function nativeUiMetaKey(seat: number): string {
  return `e2e-ui-seat${seat}`;
}

/** Local Bun :3847 / optional chain-worker :3850 — not the static :5178 preview. */
export function shouldPostUiHeartbeatHttp(apiBase: string): boolean {
  try {
    const port = new URL(apiBase).port;
    return port === '3847' || port === '3850';
  } catch {
    return false;
  }
}

function bytesToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function persistUiReportToDisk(payload: NativeUiReport): Promise<void> {
  const seat = payload.seat;
  if (seat === null || typeof window === 'undefined' || typeof window.zero?.invoke !== 'function') {
    return;
  }
  try {
    await window.zero.invoke('solana.meta', {
      action: 'set',
      key: nativeUiMetaKey(seat),
      value: bytesToBase64(`${JSON.stringify(payload)}\n`),
    });
  } catch {
    // Local Bun e2e has HTTP heartbeats; Solana dual-native needs this file.
  }
}

export async function reportNativeUiState(
  localSeat: number | null,
  extras: {
    holesAcked?: boolean;
    zkBusy?: boolean;
    shareComplete?: boolean;
    kind?: 'heartbeat' | 'phase';
  } = {},
): Promise<void> {
  if (!isNativeE2e()) {
    return;
  }
  const payload = collectNativeUiReport(localSeat, extras);
  if (typeof window !== 'undefined') {
    (window as Window & { __POKER_NATIVE_E2E__?: NativeUiReport }).__POKER_NATIVE_E2E__ = payload;
  }
  console.log(`[e2e-ui] ${payload.kind} phase=${payload.dataPhase} ack=${payload.holesAcked} busy=${payload.zkBusy} ${payload.summary}`);
  await persistUiReportToDisk(payload);
  const apiBase = resolveApiBase();
  if (!shouldPostUiHeartbeatHttp(apiBase)) {
    return;
  }
  await fetch(`${apiBase}/api/admin/e2e-render-snapshot?backend=local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('[e2e-ui] failed to POST UI state:', err);
  });
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPhase: string | null = null;

export function startNativeUiHeartbeat(
  getSeat: () => number | null,
  getExtras: () => {
    holesAcked?: boolean;
    zkBusy?: boolean;
    shareComplete?: boolean;
  } = () => ({}),
): void {
  if (!isNativeE2e() || heartbeatTimer) {
    return;
  }
  const tick = () => {
    const extras = getExtras();
    const table = document.querySelector('[data-testid="poker-table"]');
    const phase = table?.getAttribute('data-phase') ?? null;
    const kind = phase !== lastPhase ? 'phase' : 'heartbeat';
    lastPhase = phase;
    void reportNativeUiState(getSeat(), { ...extras, kind });
  };
  tick();
  heartbeatTimer = setInterval(tick, 2000);
}
