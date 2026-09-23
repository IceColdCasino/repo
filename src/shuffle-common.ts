import type { PublicKey } from './zk-casino';

/** Fixed player slots in shared shuffle circuits (single-deck and six-deck). */
export const SHUFFLE_PLAYER_SLOTS = 12;

export const SHUFFLE_IDENTITY_POINT = [0n, 1n] as PublicKey;

/** Pad public keys to shuffle circuit width with BabyJub identity [0, 1]. */
export function padPublicKeysForShuffle(
  publicKeys: PublicKey[],
  slots: number = SHUFFLE_PLAYER_SLOTS,
): PublicKey[] {
  if (publicKeys.length > slots) {
    throw new Error(`Cannot pad ${publicKeys.length} keys to ${slots} shuffle slots`);
  }
  if (publicKeys.length === slots) return publicKeys;
  return [
    ...publicKeys,
    ...Array.from({ length: slots - publicKeys.length }, () => SHUFFLE_IDENTITY_POINT),
  ];
}

/** Matches HashPublicKeys(n) in circuits/hash.circom (even n, two Poseidon chunks). */
export function hashPublicKeysN(
  publicKeys: PublicKey[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  const nPlayers = publicKeys.length;
  if (nPlayers < 2 || nPlayers > 12 || nPlayers % 2 !== 0) {
    throw new Error(`HashPublicKeys expects even n in 2..12, got ${nPlayers}`);
  }
  const split = nPlayers / 2;
  const flat = publicKeys.flat(2);
  const hashChunk1 = poseidon(flat.slice(0, split * 2));
  const hashChunk2 = poseidon(flat.slice(split * 2, nPlayers * 2));
  return poseidon([hashChunk1, hashChunk2]);
}

/** Matches HashPublicKeys(12) in circuits/hash.circom (6+6 split). */
export function hashPublicKeys12(
  publicKeys: PublicKey[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  if (publicKeys.length !== 12) {
    throw new Error(`Expected 12 public keys for shuffle hash, got ${publicKeys.length}`);
  }
  return hashPublicKeysN(publicKeys, poseidon);
}

/** Matches HashPublicKeys(2) — player + house betting circuits and 2-seat slots. */
export function hashPublicKeys2(
  publicKeys: PublicKey[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  if (publicKeys.length !== 2) {
    throw new Error(`Expected 2 public keys, got ${publicKeys.length}`);
  }
  return hashPublicKeysN(publicKeys, poseidon);
}
