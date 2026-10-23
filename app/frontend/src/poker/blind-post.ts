import type { GameSnapshot } from '../backend/client';

/** Shared `.local/blind-posts.json` record. Both seat windows merge into it. */
export const BLIND_POSTS_KEY = 'blind-posts';

const AUTO_COLLECT_STORAGE_KEY = 'poker-auto-collect-blinds';

export type BlindRole = 'small' | 'big';

export type BlindOwners = {
  smallSeat: number;
  bigSeat: number;
  smallAmount: string;
  bigAmount: string;
};

export type BlindPostRecord = {
  gameId: string;
  handNumber: number | null;
  /** Seat → timestamp when that player confirmed their blind. */
  posted: Record<string, number>;
  /** Seat → latest checkbox choice. `on` means that seat does not need a prompt. */
  auto: Record<string, { on: boolean; at: number }>;
  /** Earliest claim wins, so only one window sends collect_blinds. */
  claim: { seat: number; at: number } | null;
};

export type BlindPrompt = {
  text: string;
  tone: 'you' | 'seat';
  canPost: boolean;
  role: BlindRole;
  amount: string;
};

export function loadAutoCollectBlinds(): boolean {
  try {
    return localStorage.getItem(AUTO_COLLECT_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveAutoCollectBlinds(on: boolean): void {
  try {
    localStorage.setItem(AUTO_COLLECT_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private mode can reject storage; the in-memory checkbox still works.
  }
}

export function emptyBlindPosts(gameId: string, handNumber: number | null): BlindPostRecord {
  return { gameId, handNumber, posted: {}, auto: {}, claim: null };
}

export function blindAmounts(snapshot: GameSnapshot): { small: bigint; big: bigint } {
  let small = 0n;
  try {
    small = BigInt(snapshot.smallBlind || '0');
  } catch {
    small = 0n;
  }
  if (small <= 0n) small = 10n;
  return { small, big: small * 2n };
}

function seatForPlayerIndex(snapshot: GameSnapshot, playerIndex: number): number | null {
  const entry = Object.entries(snapshot.playerIndexBySeat ?? {}).find(([, index]) => index === playerIndex);
  if (!entry) return null;
  const seat = Number(entry[0]);
  return Number.isInteger(seat) && seat >= 0 ? seat : null;
}

/** Physical seats that post the small and big blinds, plus the chip amounts. */
export function blindOwners(snapshot: GameSnapshot): BlindOwners | null {
  const amounts = blindAmounts(snapshot);
  let smallSeat = snapshot.smallBlindSeat;
  let bigSeat = snapshot.bigBlindSeat;
  if (smallSeat < 0) smallSeat = seatForPlayerIndex(snapshot, 0) ?? -1;
  if (bigSeat < 0) bigSeat = seatForPlayerIndex(snapshot, 1) ?? -1;
  if (smallSeat < 0 || bigSeat < 0 || smallSeat === bigSeat) return null;
  return {
    smallSeat,
    bigSeat,
    smallAmount: amounts.small.toString(),
    bigAmount: amounts.big.toString(),
  };
}

export function blindRoleForSeat(owners: BlindOwners, seat: number): BlindRole | null {
  if (seat === owners.smallSeat) return 'small';
  if (seat === owners.bigSeat) return 'big';
  return null;
}

export function parseBlindPosts(raw: string | null, gameId: string, handNumber: number | null): BlindPostRecord {
  const empty = emptyBlindPosts(gameId, handNumber);
  if (!raw) return empty;
  try {
    return mergeBlindPosts(empty, JSON.parse(raw) as BlindPostRecord);
  } catch {
    return empty;
  }
}

export function mergeBlindPosts(local: BlindPostRecord | null, incoming: BlindPostRecord): BlindPostRecord {
  if (!local || local.gameId !== incoming.gameId || local.handNumber !== incoming.handNumber) {
    return {
      gameId: incoming.gameId,
      handNumber: incoming.handNumber ?? null,
      posted: { ...(incoming.posted ?? {}) },
      auto: { ...(incoming.auto ?? {}) },
      claim: incoming.claim ?? null,
    };
  }
  const posted = { ...local.posted };
  for (const [seat, at] of Object.entries(incoming.posted ?? {})) {
    posted[seat] = Math.max(posted[seat] ?? 0, at);
  }
  const auto = { ...local.auto };
  for (const [seat, stamp] of Object.entries(incoming.auto ?? {})) {
    const prev = auto[seat];
    if (!prev || stamp.at >= prev.at) auto[seat] = stamp;
  }
  let claim = local.claim;
  if (incoming.claim && claimEarlier(incoming.claim, claim)) claim = incoming.claim;
  return {
    gameId: incoming.gameId,
    handNumber: incoming.handNumber,
    posted,
    auto,
    claim,
  };
}

export function mergeBlindPostsJson(local: string | null, incoming: string): string {
  try {
    const next = JSON.parse(incoming) as BlindPostRecord;
    const prev = local ? JSON.parse(local) as BlindPostRecord : null;
    return JSON.stringify(mergeBlindPosts(prev, next));
  } catch {
    return incoming;
  }
}

export function noteAuto(record: BlindPostRecord, seat: number, on: boolean, at: number): BlindPostRecord {
  return {
    ...record,
    auto: { ...record.auto, [String(seat)]: { on, at } },
  };
}

export function notePosted(record: BlindPostRecord, seat: number, at: number): BlindPostRecord {
  return {
    ...record,
    posted: { ...record.posted, [String(seat)]: at },
  };
}

function claimEarlier(
  candidate: { seat: number; at: number },
  current: { seat: number; at: number } | null,
): boolean {
  if (!current) return true;
  if (candidate.at !== current.at) return candidate.at < current.at;
  return candidate.seat < current.seat;
}

export function noteClaim(record: BlindPostRecord, seat: number, at: number): BlindPostRecord {
  const next = { seat, at };
  if (!claimEarlier(next, record.claim)) return record;
  return { ...record, claim: next };
}

export function seatCovered(record: BlindPostRecord, seat: number): boolean {
  if (record.posted[String(seat)] != null) return true;
  return record.auto[String(seat)]?.on === true;
}

export function blindsReady(record: BlindPostRecord, owners: BlindOwners): boolean {
  return seatCovered(record, owners.smallSeat) && seatCovered(record, owners.bigSeat);
}

/** Another window already claimed the collect transaction and the claim is still fresh. */
export function claimHeldByOther(
  record: BlindPostRecord,
  seat: number,
  now: number,
  ttlMs = 20_000,
): boolean {
  if (!record.claim || record.claim.seat === seat) return false;
  return now - record.claim.at < ttlMs;
}

/**
 * Prompt for a manual blind. `null` when blinds are already posted, this seat
 * collects them automatically, or the table has not reached that point.
 */
export function describeBlindPrompt(opts: {
  snapshot: GameSnapshot | null;
  localSeat: number | null;
  autoCollect: boolean;
  record: BlindPostRecord | null;
  /** False until the previous showdown is submitted and that hand is closed. */
  previousHandSettled?: boolean;
}): BlindPrompt | null {
  const { snapshot, localSeat, autoCollect, record } = opts;
  if (opts.previousHandSettled === false) return null;
  if (!snapshot || localSeat === null || snapshot.phase !== 'PreFlop') return null;
  if (autoCollect && !record) return null;
  if (snapshot.bettingRoundOpen) return null;
  let currentBet = 0n;
  try {
    currentBet = BigInt(snapshot.currentBet || '0');
  } catch {
    return null;
  }
  if (currentBet !== 0n) return null;
  if (snapshot.seats.some((seat) => {
    try {
      return BigInt(seat.bet || '0') > 0n;
    } catch {
      return false;
    }
  })) {
    return null;
  }
  const owners = blindOwners(snapshot);
  if (!owners) return null;
  const posts = record ?? emptyBlindPosts(snapshot.gameId, snapshot.handNumber ?? null);
  const role = blindRoleForSeat(owners, localSeat);
  if (role && !autoCollect && !seatCovered(posts, localSeat)) {
    const amount = role === 'small' ? owners.smallAmount : owners.bigAmount;
    return {
      text: `Post the ${role} blind (${amount})`,
      tone: 'you',
      canPost: true,
      role,
      amount,
    };
  }
  const waiting = [owners.smallSeat, owners.bigSeat].filter((seat) => {
    if (seat === localSeat && autoCollect) return false;
    return !seatCovered(posts, seat);
  });
  const seat = waiting[0];
  if (seat === undefined) return null;
  const waitingRole = blindRoleForSeat(owners, seat);
  if (!waitingRole) return null;
  return {
    text: `Waiting on seat ${seat} to post the ${waitingRole} blind`,
    tone: 'seat',
    canPost: false,
    role: waitingRole,
    amount: waitingRole === 'small' ? owners.smallAmount : owners.bigAmount,
  };
}
