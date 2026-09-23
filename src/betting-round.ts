import { PotManager } from './pot-manager';

export function identitySeatIndexMap(seats: number[]): Map<number, number> {
  return new Map(seats.map((seat) => [seat, seat]));
}

export class BettingRound {
  #seatOrder: number[] = [];
  #lastAggressorAmount: bigint;
  #lastAggressorSeat?: number;
  #lastAggressorCheckOrRaise: boolean = true;
  #lastRaiseIncrement: bigint;
  #foldedSeats: Set<number> = new Set();
  #allInSeats: Set<number> = new Set();
  #currentPlayerSeat?: number;
  #lastCheckedSeat?: number;
  #lastRaisedSeat?: number;
  #streetBets: Map<number, bigint> = new Map();
  readonly #potManager: PotManager;
  readonly #seatToPlayerIndex: Map<number, number>;
  readonly #bigBlindAmount: bigint;
  #roundStateOpen: boolean = true;

  constructor(
    potManager: PotManager,
    seatOrder: number[],
    seatToPlayerIndex: Map<number, number>,
    lastAggressorSeat?: number,
    lastAggressorAmount?: bigint,
    bigBlindAmount?: bigint,
  ) {
    this.#potManager = potManager;
    this.#lastAggressorAmount = lastAggressorAmount ?? potManager.currentBet;
    this.#bigBlindAmount = bigBlindAmount ?? this.#lastAggressorAmount;
    this.#lastRaiseIncrement = this.#bigBlindAmount;
    this.#seatOrder = [...seatOrder];
    this.#seatToPlayerIndex = seatToPlayerIndex;
    this.#lastAggressorSeat = lastAggressorSeat;
    this.#currentPlayerSeat = lastAggressorSeat;
    this.advanceTurn();
  }

  #playerIndex(seat: number): number {
    const index = this.#seatToPlayerIndex.get(seat);
    if (index === undefined) {
      throw new Error(`Seat ${seat} has no hand player index`);
    }
    return index;
  }

  private closeRound() {
    this.#roundStateOpen = false;
  }

  advanceTurn() {
    if (!this.#roundStateOpen) return;

    const seats = this.#seatOrder;

    if (this.#currentPlayerSeat === undefined) {
      this.#lastAggressorCheckOrRaise = false;
      this.#currentPlayerSeat = seats[0];
      return;
    }

    const currentSeatIndex = seats.indexOf(this.#currentPlayerSeat);
    if (currentSeatIndex < 0) {
      throw new Error(`Current player seat ${this.#currentPlayerSeat} not found`);
    }

    const mergedOutSeats = new Set([...this.#foldedSeats, ...this.#allInSeats]);

    if (
      (this.#foldedSeats.size + this.#allInSeats.size >= seats.length) ||
      (
        this.#currentPlayerSeat === this.#lastAggressorSeat &&
        !this.#lastAggressorCheckOrRaise &&
        (
          this.#lastCheckedSeat === this.#currentPlayerSeat ||
          this.#lastRaisedSeat !== this.#currentPlayerSeat
        )
      )
    ) {
      this.closeRound();
      return;
    }

    let nextSeat: number | undefined;

    for (let i = 1; i <= seats.length; i++) {
      nextSeat = seats[(currentSeatIndex + i) % seats.length];

      if (nextSeat === seats[0] && this.#lastAggressorSeat === undefined) {
        this.closeRound();
        return;
      }

      if (nextSeat === this.#lastAggressorSeat) {
        if (this.#lastAggressorCheckOrRaise) {
          this.#lastAggressorCheckOrRaise = false;
          this.#lastAggressorAmount = 0n;
          this.#currentPlayerSeat = nextSeat;
          return;
        }
        this.closeRound();
        return;
      }

      if (nextSeat === undefined || mergedOutSeats.has(nextSeat)) {
        continue;
      }

      this.#currentPlayerSeat = nextSeat;
      return;
    }

    if (nextSeat === undefined) {
      this.closeRound();
    }
  }

  checkIfSeatValid(seat: number) {
    if (!this.#seatOrder.includes(seat)) {
      throw new Error(`Player at seat ${seat} not found`);
    }
  }

  markAllIn(seat: number): void {
    this.checkIfSeatValid(seat);
    this.#allInSeats.add(seat);
  }

  /** Record blind or prior contribution already posted this street. */
  seedStreetBet(seat: number, amount: bigint): void {
    this.checkIfSeatValid(seat);
    this.#streetBets.set(seat, amount);
  }

  fold(seat: number) {
    this.checkIfSeatValid(seat);

    if (seat !== this.#currentPlayerSeat) {
      throw new Error(`It's not player at seat ${seat}'s turn to fold`);
    }

    if (this.#foldedSeats.has(seat)) {
      throw new Error(`Seat ${seat} has already folded`);
    }

    if (this.#potManager.activePlayers.has(this.#playerIndex(seat))) {
      this.#potManager.foldPlayer(this.#playerIndex(seat));
    }

    this.#foldedSeats.add(seat);
    this.advanceTurn();
  }

  streetBetFor(seat: number): bigint {
    return this.#streetBets.get(seat) ?? 0n;
  }

  bet(seat: number, amount: bigint): bigint {
    this.checkIfSeatValid(seat);

    if (seat !== this.#currentPlayerSeat) {
      throw new Error(`It's not player at seat ${seat}'s turn to bet`);
    }

    if (this.#foldedSeats.has(seat)) {
      throw new Error(`Player at seat ${seat} has already folded`);
    }

    if (this.#allInSeats.has(seat)) {
      throw new Error(`Player at seat ${seat} is all-in and cannot bet`);
    }

    if (this.#potManager.allInPlayers.has(this.#playerIndex(seat))) {
      throw new Error(`Player at seat ${seat} is all-in and cannot bet`);
    }

    const streetBet = this.streetBetFor(seat);
    const streetTotal = streetBet + amount;

    if (streetTotal < this.#lastAggressorAmount && amount !== 0n) {
      throw new Error(`Total bet ${streetTotal} is less than last aggressor ${this.#lastAggressorAmount}`);
    }

    if (streetTotal > this.#lastAggressorAmount) {
      const previousLevel = this.#lastAggressorAmount;
      const minTotal = previousLevel === 0n
        ? this.#bigBlindAmount
        : previousLevel + this.#lastRaiseIncrement;
      if (streetTotal < minTotal) {
        throw new Error(`Raise must be at least ${minTotal}`);
      }
      this.#lastRaiseIncrement = streetTotal - previousLevel;
      this.#lastRaisedSeat = seat;
      this.#lastAggressorSeat = seat;
      this.#lastAggressorAmount = streetTotal;
      // Voluntary raise/bet already acted — when action returns after callers
      // match, close the round (do not reopen a zero-amount check orbit).
      // BB option still uses the initial true flag after a limp.
      this.#lastAggressorCheckOrRaise = false;
    }

    if (amount > 0n) {
      this.#potManager.addBet(this.#playerIndex(seat), amount);
      this.#streetBets.set(seat, streetTotal);
    } else if (amount === 0n) {
      this.#lastCheckedSeat = seat;
      if (seat === this.#lastAggressorSeat && this.#lastAggressorCheckOrRaise) {
        this.#lastAggressorCheckOrRaise = false;
      }
    }

    this.advanceTurn();
    return amount;
  }

  /** Minimum total bet level required to raise (or open bet). */
  minRaiseTo(_seat: number): bigint {
    if (this.#lastAggressorAmount === 0n) {
      return this.#bigBlindAmount;
    }
    return this.#lastAggressorAmount + this.#lastRaiseIncrement;
  }

  /** Additional chips required for a minimum legal raise from this seat. */
  minRaiseAdd(seat: number): bigint {
    const streetBet = this.streetBetFor(seat);
    const minTotal = this.minRaiseTo(seat);
    if (streetBet >= minTotal) {
      return 0n;
    }
    return minTotal - streetBet;
  }

  get foldedSeats(): ReadonlySet<number> {
    return this.#foldedSeats;
  }

  get allInSeats(): ReadonlySet<number> {
    return this.#allInSeats;
  }

  get lastAggressorAmount(): bigint {
    return this.#lastAggressorAmount;
  }

  get lastAggressorSeat(): number | undefined {
    return this.#lastAggressorSeat;
  }

  get lastRaiseIncrement(): bigint {
    return this.#lastRaiseIncrement;
  }

  get currentPlayerSeat(): number | undefined {
    return this.#currentPlayerSeat;
  }

  get isOpen(): boolean {
    return this.#roundStateOpen;
  }
}
