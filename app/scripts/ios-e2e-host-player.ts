#!/usr/bin/env bun
/**
 * Host seat 0 for iOS simulator full-game E2E.
 * Uses macOS libzkcasino witness; iOS sim runs seat 1 native proves.
 */
import { runHostSeat0Zk } from './e2e-host-seat0-zk.ts';

const BASE = (process.env.E2E_API_BASE ?? 'http://127.0.0.1:3847').replace(/\/$/, '');
const GAME_ID = 'local-table';
const HOST_SEAT = 0;
const HOST_PUBKEY = '11111111111111111111111111111112';
const POLL_MS = 400;

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}?backend=local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function getState() {
  const res = await fetch(`${BASE}/api/games/${GAME_ID}?backend=local`);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  label: string,
  timeoutMs: number,
  predicate: (snapshot: Awaited<ReturnType<typeof getState>>) => boolean,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<typeof getState>> | null = null;
  while (Date.now() < deadline) {
    last = await getState();
    if (predicate(last)) {
      return last;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label} timed out (phase=${last?.phase ?? 'unknown'})`);
}

function seatHasChips(snapshot: Awaited<ReturnType<typeof getState>>, seat: number, minChips: bigint): boolean {
  const entry = snapshot.seats?.find((s: { seat: number }) => s.seat === seat);
  if (!entry) {
    return false;
  }
  return BigInt(entry.chips) >= minChips;
}

async function main(): Promise<void> {
  console.log('[ios-host] resetting table');
  await postJson('/api/admin/reset');

  console.log('[ios-host] joining seat 0');
  await postJson(`/api/games/${GAME_ID}/join`, {
    seat: HOST_SEAT,
    publicKey: HOST_PUBKEY,
    chips: '5000',
  });

  const lobby = await getState();
  const minBlindStack = BigInt(lobby.smallBlind || '25') * 2n;

  console.log('[ios-host] waiting for seat 1 (joined with chips)');
  await pollUntil('seat 1 ready', 120_000, (s) =>
    (s.seats?.length ?? 0) >= 2 && seatHasChips(s, 1, minBlindStack),
  );

  console.log('[ios-host] starting hand');
  await postJson(`/api/games/${GAME_ID}/start`);

  await runHostSeat0Zk();
}

main().catch((err) => {
  console.error('[ios-host] fatal:', err);
  process.exit(1);
});
