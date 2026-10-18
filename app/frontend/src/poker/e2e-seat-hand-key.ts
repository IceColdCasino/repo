import type { PlayerKey } from './zk-hand-key-store';

function e2eSeatFromUrl(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = new URLSearchParams(window.location.search).get('e2eSeat')
    ?? new URLSearchParams(window.location.search).get('seat');
  if (raw === null || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

export function isNativeE2e(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('nativeE2e') === '1';
}

function keyUrl(seat: number): string {
  if (typeof window === 'undefined') {
    return `http://127.0.0.1:5178/seat${seat}-hand-key.json`;
  }
  return `${window.location.origin}/seat${seat}-hand-key.json`;
}

function parseKeyBody(body: unknown): PlayerKey | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const parsed = body as { privateKey?: string; publicKey?: [string, string] };
  if (!parsed.privateKey || !parsed.publicKey?.length) {
    return null;
  }
  return {
    privateKey: BigInt(parsed.privateKey),
    publicKey: [BigInt(parsed.publicKey[0]), BigInt(parsed.publicKey[1])],
  };
}

/** Persist ElGamal hand key to `.local/e2e-elgamal-seatN.json` for host-zk. */
export async function persistE2eSeatHandKey(seat: number, key: PlayerKey): Promise<void> {
  if (!isNativeE2e() || seat < 0 || seat > 9) {
    return;
  }
  const payload = JSON.stringify({
    privateKey: key.privateKey.toString(),
    publicKey: key.publicKey.map((v) => v.toString()),
  });
  try {
    const { installWebViewMetaStore, flushWebViewMetaWrites } = await import(
      '../backend/solana-meta-bridge'
    );
    const store = installWebViewMetaStore();
    store.write(`e2e-elgamal-seat${seat}`, payload);
    await flushWebViewMetaWrites();
  } catch {
    // Meta bridge optional in browser.
  }
}

async function loadFromMeta(seat: number): Promise<PlayerKey | null> {
  try {
    const { installWebViewMetaStore } = await import('../backend/solana-meta-bridge');
    const store = installWebViewMetaStore();
    await store.refreshFromDisk?.([`e2e-elgamal-seat${seat}`]);
    const raw = store.read(`e2e-elgamal-seat${seat}`);
    if (!raw) {
      return null;
    }
    return parseKeyBody(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadFromHttp(seat: number): Promise<PlayerKey | null> {
  try {
    const res = await fetch(keyUrl(seat), { cache: 'no-store' });
    if (!res.ok) {
      return null;
    }
    return parseKeyBody(await res.json());
  } catch {
    return null;
  }
}

/**
 * Load a host-shared or peer-persisted ElGamal hand key for `seat`.
 * Prefer meta (`.local/`) then vite-preview `seatN-hand-key.json`.
 */
export async function loadE2eSeatHandKey(
  handNumber: number,
  seat: number,
): Promise<PlayerKey | null> {
  // Interactive local/mac play must not load leftover `.local/e2e-elgamal-seatN`
  // from a prior E2E run — that overwrites the key just registered this hand.
  if (!isNativeE2e()) {
    return null;
  }
  if (seat < 0 || seat > 9) {
    return null;
  }
  const key = (await loadFromMeta(seat)) ?? (await loadFromHttp(seat));
  if (!key) {
    return null;
  }
  // Do not persist here. Callers write sessionStorage only after the key
  // matches the server-registered public key (or they are minting).
  return key;
}

/** @deprecated Use loadE2eSeatHandKey(handNumber, 0). */
export async function loadE2eSeat0HandKey(handNumber: number): Promise<PlayerKey | null> {
  return loadE2eSeatHandKey(handNumber, 0);
}

export function nativeE2eSeatOrNull(): number | null {
  return isNativeE2e() ? e2eSeatFromUrl() : null;
}
