export interface Room {
  roomId: Uint8Array;
  authority: string;
  mint: string;
  vault: string;
  tableCount: bigint;
  smallBlindDefault: bigint;
}

export interface TableState {
  roomId: Uint8Array;
  tableId: bigint;
  seats: string[];
  dealerSeat: number;
  handInProgress: boolean;
  currentGameId: Uint8Array;
  handSeatOrder: number[];
  handNumPlayers: number;
  pendingSeatOrder: number[];
  pendingNumPlayers: number;
}

export const MAX_TABLE_SEATS = 10;

/** Port of on-chain seat_order.rs for client-side validation. */
export function sortedOccupiedSeats(seats: string[]): number[] {
  return seats
    .map((pk, idx) => (pk && pk !== '11111111111111111111111111111111' ? idx : -1))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);
}

export function advanceDealer(dealerSeat: number, sorted: number[]): number {
  if (sorted.length === 0) return dealerSeat;
  if (sorted.length === 1) return sorted[0]!;
  const pos = sorted.indexOf(dealerSeat);
  if (pos >= 0) return sorted[(pos + 1) % sorted.length]!;
  return sorted[0]!;
}

export function actionOrderFromDealer(sorted: number[], dealerSeat: number): number[] {
  if (sorted.length === 0) return [];
  const dealerIdx = sorted.indexOf(dealerSeat);
  const dealer = dealerIdx >= 0 ? sorted[dealerIdx]! : sorted[0]!;
  // Heads-up: dealer posts the small blind and is first to act preflop.
  if (sorted.length === 2) {
    const other = sorted.find((seat) => seat !== dealer)!;
    return [dealer, other];
  }
  const start = dealerIdx >= 0 ? (dealerIdx + 1) % sorted.length : 0;
  const order: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    order.push(sorted[(start + i) % sorted.length]!);
  }
  return order;
}

export function recomputePendingOrder(seats: string[], dealerSeat: number) {
  const sorted = sortedOccupiedSeats(seats);
  const newDealer = advanceDealer(dealerSeat, sorted);
  const order = actionOrderFromDealer(sorted, newDealer);
  return { order, newDealer, count: sorted.length };
}

/** Player index (0..handNum-1) for a physical table seat in the current hand. */
export function playerIndexForSeat(
  handSeatOrder: number[],
  handNum: number,
  seat: number,
): number | null {
  for (let index = 0; index < handNum; index += 1) {
    if (handSeatOrder[index] === seat) {
      return index;
    }
  }
  return null;
}

export function playerIndexForPublicKey(
  seats: string[],
  handSeatOrder: number[],
  handNum: number,
  publicKey: string,
): number | null {
  for (let index = 0; index < handNum; index += 1) {
    const physicalSeat = handSeatOrder[index]!;
    if (seats[physicalSeat] === publicKey) {
      return index;
    }
  }
  return null;
}

export function playerIndexBySeatMap(
  handSeatOrder: number[],
  handNum: number,
): Record<number, number> {
  const map: Record<number, number> = {};
  for (let index = 0; index < handNum; index += 1) {
    map[handSeatOrder[index]!] = index;
  }
  return map;
}

/** Build a fixed 10-seat pubkey array for table order helpers. */
export function seatsArrayFromOccupied(
  occupied: Map<number, { publicKey: string }>,
): string[] {
  const seats = Array.from({ length: MAX_TABLE_SEATS }, () => '');
  for (const [seat, player] of occupied.entries()) {
    seats[seat] = player.publicKey;
  }
  return seats;
}

/** Player index of the button. Heads-up: dealer is SB (0). Multiway: dealer is last. */
export function dealerPlayerIndex(handNumPlayers: number): number {
  return handNumPlayers === 2 ? 0 : handNumPlayers - 1;
}

/** Seat that closes action on a street (acts last). Preflop: BB. Postflop HU: SB/dealer. Postflop 3+: dealer. */
export function actionClosingSeat(
  phase: 'PreFlop' | 'Flop' | 'Turn' | 'River',
  handSeatOrder: number[],
  dealerSeat: number,
  bigBlindSeat: number,
): number {
  if (phase === 'PreFlop') {
    return bigBlindSeat;
  }
  if (handSeatOrder.length === 2) {
    return handSeatOrder[0]!;
  }
  return dealerSeat;
}

/**
 * Shuffle turn order: dealer shuffles first, then SB (index 0), BB (1), …
 * Each player shuffles exactly once.
 */
export function shufflePlayerOrder(handNumPlayers: number): number[] {
  if (handNumPlayers <= 0) {
    return [];
  }
  const dealer = dealerPlayerIndex(handNumPlayers);
  const order = [dealer];
  for (let index = 0; index < handNumPlayers; index += 1) {
    if (index !== dealer) {
      order.push(index);
    }
  }
  return order;
}

export function seatForPlayerIndex(handSeatOrder: number[], playerIndex: number): number {
  return handSeatOrder[playerIndex]!;
}

export function shuffleOrderSeats(handSeatOrder: number[], handNumPlayers: number): number[] {
  return shufflePlayerOrder(handNumPlayers).map((index) => handSeatOrder[index]!);
}
