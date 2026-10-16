import { sha256 } from '@noble/hashes/sha256';
import { web3 } from '@coral-xyz/anchor';

/** Must match `whitelist::WHITELIST_ADMIN` in the casino program. Not the Arcis MXE key. */
export const WHITELIST_ADMIN = new web3.PublicKey('CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3');

export const GAME_ROOM_TYPES = [
  'poker',
  'baccarat',
  'blackjack',
  'war',
  'roulette',
  'craps',
  'keno',
  'slots',
  'bingo',
] as const;
export type GameRoomType = (typeof GAME_ROOM_TYPES)[number];

/** ASCII game name occupies the first 12 bytes of every namespaced room_id. */
export const GAME_ROOM_NAMESPACE_LEN = 12;

/** Default table stakes per game (room `small_blind_default`; reused as min bet). */
export const GAME_ROOM_DEFAULTS: Record<GameRoomType, { smallBlind: bigint }> = {
  poker: { smallBlind: 10n },
  baccarat: { smallBlind: 10n },
  blackjack: { smallBlind: 10n },
  war: { smallBlind: 10n },
  roulette: { smallBlind: 10n },
  craps: { smallBlind: 10n },
  keno: { smallBlind: 10n },
  slots: { smallBlind: 10n },
  bingo: { smallBlind: 10n },
};

/**
 * Derive a 32-byte room_id namespaced by game type.
 * Bytes 0..11: UTF-8 game name (zero-padded). Bytes 12..31: SHA-256(game:seed) suffix.
 */
export function deriveGameRoomId(
  game: GameRoomType,
  instanceSeed: string | Uint8Array = 'default',
): Uint8Array {
  const roomId = new Uint8Array(32);
  const ns = new TextEncoder().encode(game);
  const nsLen = Math.min(ns.length, GAME_ROOM_NAMESPACE_LEN);
  roomId.set(ns.subarray(0, nsLen));

  const seedBuf = typeof instanceSeed === 'string'
    ? new TextEncoder().encode(instanceSeed)
    : instanceSeed instanceof Uint8Array
      ? instanceSeed
      : Uint8Array.from(instanceSeed);
  const gameBytes = new TextEncoder().encode(game);
  const colon = new TextEncoder().encode(':');
  const hashInput = new Uint8Array(gameBytes.length + 1 + seedBuf.length);
  hashInput.set(gameBytes, 0);
  hashInput.set(colon, gameBytes.length);
  hashInput.set(seedBuf, gameBytes.length + 1);
  const suffix = sha256(hashInput).subarray(0, 32 - GAME_ROOM_NAMESPACE_LEN);

  roomId.set(suffix, GAME_ROOM_NAMESPACE_LEN);
  return roomId;
}

export function randomGameRoomInstanceSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function gameRoomNamespace(roomId: Uint8Array): string {
  const raw = new TextDecoder().decode(roomId.subarray(0, GAME_ROOM_NAMESPACE_LEN));
  return raw.replace(/\0+$/, '');
}
