/**
 * Client-tracked street bets for per-seat Arcium validate_bet_v2 payloads.
 * On-chain player_total_bets accumulate; Rescue encryption needs street-local
 * player_current_bet (seeded by collect_blinds, reset each street).
 */
import { readSharedMeta, writeSharedMeta } from './shared-meta-store';

const STREET_BETS_META_KEY = 'street-bets';

export type StreetBetsMeta = {
  gameIdHex: string;
  bettingPhase: number;
  /** Per hand-order player index. */
  streetBets: string[];
};

export function loadStreetBetsMeta(): StreetBetsMeta | null {
  const raw = readSharedMeta(STREET_BETS_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreetBetsMeta;
  } catch {
    return null;
  }
}

export function saveStreetBetsMeta(meta: StreetBetsMeta): void {
  writeSharedMeta(STREET_BETS_META_KEY, JSON.stringify(meta));
}

export function clearStreetBetsMeta(): void {
  try {
    writeSharedMeta(STREET_BETS_META_KEY, '');
  } catch {
    // ignore
  }
}

/** Seed street bets when a betting round opens (PreFlop blinds or 0 on later streets). */
export function seedStreetBetsMeta(opts: {
  gameIdHex: string;
  bettingPhase: number;
  numPlayers: number;
  smallBlind?: bigint;
  bigBlind?: bigint;
}): StreetBetsMeta {
  const streetBets = Array.from({ length: opts.numPlayers }, () => '0');
  if (opts.bettingPhase === 1) {
    const sb = opts.smallBlind ?? 0n;
    const bb = opts.bigBlind ?? 0n;
    if (opts.numPlayers >= 1) streetBets[0] = sb.toString();
    if (opts.numPlayers >= 2) streetBets[1] = bb.toString();
  }
  const meta: StreetBetsMeta = {
    gameIdHex: opts.gameIdHex,
    bettingPhase: opts.bettingPhase,
    streetBets,
  };
  saveStreetBetsMeta(meta);
  return meta;
}

export function streetBetForPlayer(
  gameIdHex: string,
  bettingPhase: number,
  playerIndex: number,
): bigint {
  const meta = loadStreetBetsMeta();
  if (
    !meta
    || meta.gameIdHex !== gameIdHex
    || meta.bettingPhase !== bettingPhase
  ) {
    // PreFlop fallback when meta was lost: blinds are SB=10 / BB=20.
    if (bettingPhase === 1) {
      if (playerIndex === 0) return 10n;
      if (playerIndex === 1) return 20n;
    }
    return 0n;
  }
  return BigInt(meta.streetBets[playerIndex] ?? '0');
}

export function applyStreetBetAction(opts: {
  gameIdHex: string;
  bettingPhase: number;
  numPlayers: number;
  playerIndex: number;
  action: string;
  actionAmount: bigint;
}): StreetBetsMeta {
  let meta = loadStreetBetsMeta();
  if (
    !meta
    || meta.gameIdHex !== opts.gameIdHex
    || meta.bettingPhase !== opts.bettingPhase
  ) {
    meta = seedStreetBetsMeta({
      gameIdHex: opts.gameIdHex,
      bettingPhase: opts.bettingPhase,
      numPlayers: opts.numPlayers,
      smallBlind: opts.bettingPhase === 1 ? 10n : 0n,
      bigBlind: opts.bettingPhase === 1 ? 20n : 0n,
    });
  }
  const bets = meta.streetBets.map((b) => BigInt(b));
  while (bets.length < opts.numPlayers) bets.push(0n);
  const action = opts.action;
  if (action === 'call' || action === 'bet' || action === 'raise' || action === 'all-in') {
    bets[opts.playerIndex] = (bets[opts.playerIndex] ?? 0n) + opts.actionAmount;
  }
  meta = {
    gameIdHex: opts.gameIdHex,
    bettingPhase: opts.bettingPhase,
    streetBets: bets.map((b) => b.toString()),
  };
  saveStreetBetsMeta(meta);
  return meta;
}
