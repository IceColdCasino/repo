import { resolveApiBase } from '../server/runtime';
import { shouldPostUiHeartbeatHttp } from './e2e-ui-report';
import {
  collectTableRenderSnapshot,
  formatTableRenderSnapshot,
  type TableRenderSnapshot,
} from './e2e-table-render';

function isNativeE2e(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('nativeE2e') === '1';
}

function e2eSeat(): number | null {
  const seat = Number(new URLSearchParams(window.location.search).get('e2eSeat'));
  return Number.isInteger(seat) ? seat : null;
}

export async function reportE2eRenderSnapshot(localSeat: number | null): Promise<void> {
  if (!isNativeE2e()) {
    return;
  }
  const render = collectTableRenderSnapshot(localSeat);
  const payload = {
    ...render,
    seat: localSeat ?? e2eSeat(),
    at: new Date().toISOString(),
    summary: formatTableRenderSnapshot(render),
  };
  console.log('[e2e-render]', payload.summary);
  const apiBase = resolveApiBase();
  if (!shouldPostUiHeartbeatHttp(apiBase)) {
    return;
  }
  await fetch(`${apiBase}/api/admin/e2e-render-snapshot?backend=local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('[e2e-render] failed to POST render snapshot:', err);
  });
}

export type { TableRenderSnapshot };
