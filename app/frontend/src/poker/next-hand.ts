/** Opt-in next hand, blind gate, and short-stack sit-out. */

const OPT_IN_STORAGE_KEY = 'poker-opt-in-next-hand';

export const NEXT_HAND_SITOUT_KEY = 'next-hand-sitout';
export const NEXT_HAND_DECK_KEY = 'next-hand-deck';

export type NextHandBlindGate = {
  /** A hand has started, so the following blinds must wait on its showdown. */
  needsPreviousSettlement: boolean;
  showdownSubmitted: boolean;
  handClosed: boolean;
};

export function initialNextHandBlindGate(): NextHandBlindGate {
  return {
    needsPreviousSettlement: false,
    showdownSubmitted: false,
    handClosed: false,
  };
}

/**
 * Blinds for a later hand stay locked until this hand's showdown is submitted
 * or an uncontested fold is paid, and the hand is closed.
 * The first hand has nothing to wait on.
 */
export function reduceNextHandBlindGate(
  gate: NextHandBlindGate,
  phase: string,
  showdownSubmitted: boolean,
  foldSettled = false,
): NextHandBlindGate {
  if (phase === 'Showdown') {
    return {
      needsPreviousSettlement: true,
      showdownSubmitted: gate.showdownSubmitted || showdownSubmitted,
      handClosed: false,
    };
  }
  if (
    (phase === 'Complete' || phase === 'lobby')
    && (gate.showdownSubmitted || showdownSubmitted || foldSettled)
  ) {
    return {
      needsPreviousSettlement: true,
      showdownSubmitted: true,
      handClosed: true,
    };
  }
  // A new hand has started. The following hand waits until this one is paid.
  if (
    phase === 'Register'
    || phase === 'Shuffle'
    || phase === 'Share'
    || phase === 'PreFlop'
    || phase === 'Flop'
    || phase === 'Turn'
    || phase === 'River'
  ) {
    if (gate.handClosed && gate.showdownSubmitted) {
      return {
        needsPreviousSettlement: true,
        showdownSubmitted: false,
        handClosed: false,
      };
    }
  }
  return gate;
}

/** Complete snapshot that still needs fold settlement and a chip update. */
export function uncontestedFoldFinish(snapshot: {
  phase: string;
  handResult?: { reason?: string } | null;
  actionOrder?: readonly number[] | null;
  seats?: readonly { seat: number; folded?: boolean }[] | null;
  zkShowdown?: { submittedCount?: number; finalizedOnChain?: boolean } | null;
}): boolean {
  if (snapshot.phase !== 'Complete') return false;
  if (snapshot.handResult?.reason === 'fold') return true;
  if (snapshot.handResult) return false;
  if ((snapshot.zkShowdown?.submittedCount ?? 0) > 0) return false;
  if (snapshot.zkShowdown?.finalizedOnChain) return false;
  const order = snapshot.actionOrder ?? [];
  if (order.length < 2) return false;
  let live = 0;
  for (const seat of order) {
    const row = snapshot.seats?.find((item) => item.seat === seat);
    if (row && !row.folded) live += 1;
  }
  return live === 1;
}

/** First hand, or the previous showdown was submitted and that hand is closed. */
export function nextHandBlindsAllowed(gate: NextHandBlindGate): boolean {
  if (!gate.needsPreviousSettlement) return true;
  return gate.showdownSubmitted && gate.handClosed;
}

/** Previous hand is settled and the opted-in next hand may begin. */
export function nextHandReadyToOpen(gate: NextHandBlindGate): boolean {
  return gate.needsPreviousSettlement && gate.showdownSubmitted && gate.handClosed;
}

export function loadOptInNextHand(): boolean {
  try {
    return localStorage.getItem(OPT_IN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveOptInNextHand(on: boolean): void {
  try {
    localStorage.setItem(OPT_IN_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private mode can reject storage; the checkbox still works in memory.
  }
}

export function handPlayerCount(snapshot: {
  actionOrder?: readonly number[] | null;
  seats?: readonly { publicKey?: string }[] | null;
  zk?: { elGamalPublicKeys?: readonly unknown[] | null } | null;
}): number {
  const order = snapshot.actionOrder?.length ?? 0;
  if (order >= 2) return order;
  const keys = snapshot.zk?.elGamalPublicKeys?.filter((key) => key != null).length ?? 0;
  if (keys >= 2) return keys;
  return snapshot.seats?.filter((seat) => Boolean(seat.publicKey)).length ?? 0;
}

/** Same ElGamal key and the same player count: the register proof can be reused. */
export function canSkipRegister(opts: {
  previousPlayerCount: number | null;
  nextPlayerCount: number;
  previousKey: string | null;
  nextKey: string | null;
}): boolean {
  return opts.previousPlayerCount !== null
    && opts.previousPlayerCount >= 2
    && opts.previousPlayerCount === opts.nextPlayerCount
    && opts.previousKey !== null
    && opts.previousKey === opts.nextKey;
}

/**
 * Sit the next hand out when the stack is below the big blind and this player
 * did not win. A winner stays in even if the pre-payout stack is short.
 */
export function shouldSitOutNextHand(opts: {
  stack: bigint;
  bigBlind: bigint;
  winnersKnown: boolean;
  won: boolean;
}): boolean {
  if (!opts.winnersKnown || opts.won) return false;
  if (opts.bigBlind <= 0n) return false;
  return opts.stack < opts.bigBlind;
}

export type SitOutRecord = {
  gameId: string;
  seats: Record<string, { sittingOut: boolean; at: number }>;
};

export function emptySitOutRecord(gameId: string): SitOutRecord {
  return { gameId, seats: {} };
}

export function noteSitOut(
  record: SitOutRecord,
  seat: number,
  sittingOut: boolean,
  at: number,
): SitOutRecord {
  return {
    ...record,
    seats: {
      ...record.seats,
      [String(seat)]: { sittingOut, at },
    },
  };
}

export function anySeatSittingOut(record: SitOutRecord | null): boolean {
  if (!record) return false;
  return Object.values(record.seats).some((seat) => seat.sittingOut);
}

export function parseSitOutRecord(raw: string | null, gameId: string): SitOutRecord {
  const empty = emptySitOutRecord(gameId);
  if (!raw) return empty;
  try {
    return mergeSitOutRecords(empty, JSON.parse(raw) as SitOutRecord);
  } catch {
    return empty;
  }
}

export function mergeSitOutRecords(local: SitOutRecord | null, incoming: SitOutRecord): SitOutRecord {
  if (!local || local.gameId !== incoming.gameId) {
    return {
      gameId: incoming.gameId,
      seats: { ...(incoming.seats ?? {}) },
    };
  }
  const seats = { ...local.seats };
  for (const [seat, stamp] of Object.entries(incoming.seats ?? {})) {
    const prev = seats[seat];
    if (!prev || stamp.at >= prev.at) seats[seat] = stamp;
  }
  return { gameId: incoming.gameId, seats };
}

export function mergeSitOutJson(local: string | null, incoming: string): string {
  try {
    const next = JSON.parse(incoming) as SitOutRecord;
    const prev = local ? JSON.parse(local) as SitOutRecord : null;
    return JSON.stringify(mergeSitOutRecords(prev, next));
  } catch {
    return incoming;
  }
}

export type StagedDeckRecord = {
  shufflerIndex: number;
  playerCount: number;
  keysMix: string;
  deck: string[][];
};

export function mergeStagedDeckJson(local: string | null, incoming: string): string {
  try {
    const next = JSON.parse(incoming) as StagedDeckRecord;
    if (!local) return incoming;
    const prev = JSON.parse(local) as StagedDeckRecord;
    if (!Number.isInteger(next.shufflerIndex)) return local;
    if (!Number.isInteger(prev.shufflerIndex) || next.shufflerIndex >= prev.shufflerIndex) {
      return incoming;
    }
    return local;
  } catch {
    return incoming;
  }
}
