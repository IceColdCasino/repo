import type { PublicKey } from './zk-casino';

/**
 * Share and showdown circuits are fixed at 10 player slots (HashPublicKeys(10)).
 * A hand may have as few as 2 registered players; pad the rest with identity [0, 1].
 *
 * Shuffle is separate: use padPublicKeysForShuffle (2→12 slots) in shuffle-common.
 */
export const SHARE_PLAYER_SLOTS = 10;

export const SHARE_IDENTITY_POINT = [0n, 1n] as PublicKey;

export const SHARE_OTHER_SLOTS = SHARE_PLAYER_SLOTS - 1;

/** Pad registered keys to 10 slots with BabyJub identity [0, 1]. */
export function padPublicKeysForShare(
  publicKeys: PublicKey[],
  slots: number = SHARE_PLAYER_SLOTS,
): PublicKey[] {
  if (publicKeys.length > slots) {
    throw new Error(`Cannot pad ${publicKeys.length} keys to ${slots} share slots`);
  }
  if (publicKeys.length === slots) {
    return publicKeys;
  }
  return [
    ...publicKeys,
    ...Array.from({ length: slots - publicKeys.length }, () => SHARE_IDENTITY_POINT),
  ];
}

/** Other recipients for share (9 keys when nPlayers=10). */
export function shareOthersForPlayer(
  registeredKeys: PublicKey[],
  playerIndex: number,
): PublicKey[] {
  const padded = padPublicKeysForShare(registeredKeys);
  if (playerIndex < 0 || playerIndex >= padded.length) {
    throw new Error(`Invalid share player index ${playerIndex}`);
  }
  return padded.filter((_, index) => index !== playerIndex);
}

/** Matches HashPublicKeys(10) in circuits/hash.circom (5+5 split). */
export function hashPublicKeys10(
  publicKeys: PublicKey[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  if (publicKeys.length !== SHARE_PLAYER_SLOTS) {
    throw new Error(`Expected ${SHARE_PLAYER_SLOTS} public keys for share hash, got ${publicKeys.length}`);
  }
  const hashChunk1 = poseidon(publicKeys.slice(0, 5).flat());
  const hashChunk2 = poseidon(publicKeys.slice(5, 10).flat());
  return poseidon([hashChunk1, hashChunk2]);
}
