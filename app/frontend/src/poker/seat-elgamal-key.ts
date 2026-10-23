import type { PlayerKey, PublicKey } from '@poker-src/zk-casino';

/**
 * Seat ElGamal keys survive a window reopen.
 * Session storage dies with the WebView process; `.local/elgamal-seatN.json`
 * is the same disk store the seat wallet already uses.
 */
export function seatElgamalMetaKey(seat: number): string {
  return `elgamal-seat${seat}`;
}

function hasMetaBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.zero?.invoke === 'function';
}

function publicKeysEqual(a: PublicKey, b: PublicKey): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function parseSeatElgamalRecord(raw: string): PlayerKey | null {
  try {
    const parsed = JSON.parse(raw) as { privateKey?: string; publicKey?: [string, string] };
    if (!parsed.privateKey || parsed.publicKey?.length !== 2) {
      return null;
    }
    return {
      privateKey: BigInt(parsed.privateKey),
      publicKey: [BigInt(parsed.publicKey[0]), BigInt(parsed.publicKey[1])],
    };
  } catch {
    return null;
  }
}

function serialize(handNumber: number, key: PlayerKey): string {
  return JSON.stringify({
    handNumber,
    privateKey: key.privateKey.toString(),
    publicKey: [key.publicKey[0].toString(), key.publicKey[1].toString()],
  });
}

export async function persistSeatElgamalKey(
  seat: number,
  handNumber: number,
  key: PlayerKey,
): Promise<void> {
  if (!hasMetaBridge() || !Number.isInteger(seat) || seat < 0 || seat > 9) {
    return;
  }
  const { installWebViewMetaStore, flushWebViewMetaWrites } = await import(
    '../backend/solana-meta-bridge'
  );
  const store = installWebViewMetaStore();
  store.write(seatElgamalMetaKey(seat), serialize(handNumber, key));
  await flushWebViewMetaWrites();
}

/**
 * Restore this seat's key from disk.
 * When the hand already registered a public key, a different disk key is ignored.
 */
export async function loadSeatElgamalKey(
  seat: number,
  expectedPublicKey?: PublicKey | null,
): Promise<PlayerKey | null> {
  if (!hasMetaBridge() || !Number.isInteger(seat) || seat < 0 || seat > 9) {
    return null;
  }
  const name = seatElgamalMetaKey(seat);
  const { installWebViewMetaStore } = await import('../backend/solana-meta-bridge');
  const store = installWebViewMetaStore();
  await store.refreshFromDisk?.([name]);
  const raw = store.read(name);
  if (!raw) {
    return null;
  }
  const key = parseSeatElgamalRecord(raw);
  if (!key) {
    return null;
  }
  if (expectedPublicKey && !publicKeysEqual(key.publicKey, expectedPublicKey)) {
    return null;
  }
  return key;
}
