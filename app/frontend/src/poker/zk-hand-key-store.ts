import type { PlayerKey, PublicKey } from '@poker-src/zk-casino';
import { stableInstanceId } from '../identity/instance-id';

const STORAGE_PREFIX = 'zk-hand-elgamal-key';

function storageKey(handNumber: number, instanceId = stableInstanceId()): string {
  return `${STORAGE_PREFIX}:${instanceId}:${handNumber}`;
}

function seatStorageKey(seat: number, handNumber: number): string {
  return `${STORAGE_PREFIX}:seat-${seat}:${handNumber}`;
}

function parseStored(raw: string | null): PlayerKey | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { privateKey: string; publicKey: [string, string] };
    return {
      privateKey: BigInt(parsed.privateKey),
      publicKey: parsed.publicKey.map((value) => BigInt(value)) as PublicKey,
    };
  } catch {
    return null;
  }
}

function publicKeysEqual(a: PublicKey, b: PublicKey): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function writeKey(storageName: string, key: PlayerKey): void {
  sessionStorage.setItem(
    storageName,
    JSON.stringify({
      privateKey: key.privateKey.toString(),
      publicKey: key.publicKey.map((value) => value.toString()),
    }),
  );
}

export function persistZkHandKey(
  handNumber: number,
  key: PlayerKey,
  seat?: number | null,
): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  writeKey(storageKey(handNumber), key);
  if (seat !== null && seat !== undefined && Number.isInteger(seat) && seat >= 0) {
    writeKey(seatStorageKey(seat, handNumber), key);
    // Session storage dies with the WebView. Disk keeps the seat key across reopen.
    void import('./seat-elgamal-key')
      .then(({ persistSeatElgamalKey }) => persistSeatElgamalKey(seat, handNumber, key))
      .catch(() => undefined);
  }
}

export function loadZkHandKey(
  handNumber: number,
  seat?: number | null,
): PlayerKey | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  if (seat !== null && seat !== undefined && Number.isInteger(seat) && seat >= 0) {
    const bySeat = parseStored(sessionStorage.getItem(seatStorageKey(seat, handNumber)));
    if (bySeat) {
      return bySeat;
    }
  }
  const raw = sessionStorage.getItem(storageKey(handNumber));
  const parsed = parseStored(raw);
  if (!parsed && raw) {
    sessionStorage.removeItem(storageKey(handNumber));
  }
  return parsed;
}

/** Recover a key stored under an older instance id (e.g. before URL seat param). */
export function findZkHandKeyForPublicKey(
  handNumber: number,
  expectedPublicKey: PublicKey,
): PlayerKey | null {
  const direct = loadZkHandKey(handNumber);
  if (direct && publicKeysEqual(direct.publicKey, expectedPublicKey)) {
    return direct;
  }
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  const suffix = `:${handNumber}`;
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith(`${STORAGE_PREFIX}:`) || !key.endsWith(suffix)) {
      continue;
    }
    const candidate = parseStored(sessionStorage.getItem(key));
    if (candidate && publicKeysEqual(candidate.publicKey, expectedPublicKey)) {
      persistZkHandKey(handNumber, candidate);
      return candidate;
    }
  }
  return null;
}

export function clearZkHandKey(handNumber: number, seat?: number | null): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  sessionStorage.removeItem(storageKey(handNumber));
  if (seat !== null && seat !== undefined && Number.isInteger(seat) && seat >= 0) {
    sessionStorage.removeItem(seatStorageKey(seat, handNumber));
  }
}
