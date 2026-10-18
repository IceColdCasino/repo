import { Player } from './player';
import { PotManager } from './pot-manager';

export class BettingRound {
  #seatOrder: Map<number, Player> = new Map();
  #lastAggressorAmount: number;
  #lastAggressorSeat?: number;
  #lastAggressorCheckOrRaise: boolean = true;
  #foldedSeats: Set<number> = new Set();
  #allInSeats: Set<number> = new Set();
  #currentPlayerSeat?: number;
  #lastCheckedSeat?: number;
  #lastRaisedSeat?: number;
  readonly #potManager: PotManager;
  #roundStateOpen: boolean = true;

  constructor(
    potManager: PotManager,
    seatOrder: Map<number, Player>,
    lastAggressorSeat?: number,
    lastAggressorAmount?: number,
  ) {
    this.#potManager = potManager;
    this.#lastAggressorAmount = lastAggressorAmount || this.#potManager.currentBet;
    this.#seatOrder = seatOrder;
    this.#lastAggressorSeat = lastAggressorSeat;
    this.#currentPlayerSeat = lastAggressorSeat;
    this.getNextSeat().next();
  }

  private closeRound() {
    this.#roundStateOpen = false;
  }

  * getNextSeat() {
    while (this.#roundStateOpen) {
      const seats = [...this.#seatOrder.keys()];

      if (this.#currentPlayerSeat === undefined) {
        this.#lastAggressorCheckOrRaise = false;
        yield this.#currentPlayerSeat = seats[0];
        continue;
      }

      const currentSeatIndex = seats.indexOf(this.#currentPlayerSeat);
      
      if (currentSeatIndex < 0) {
        throw new Error(`Current player seat ${this.#currentPlayerSeat} not found in seat order`);
      }

      if (
        (this.foldedSeats.size + this.#allInSeats.size >= seats.length) ||
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

      let nextSeat;
      const mergedOutSeats = this.foldedSeats.union(this.#allInSeats);

      seatLoop: for (let i = 1; i <= seats.length; i++) {
        nextSeat = seats[(currentSeatIndex + i) % seats.length];

        if (nextSeat === seats[0] && this.#lastAggressorSeat === undefined) {
          this.closeRound();
          return;
        }

        if (nextSeat === this.#lastAggressorSeat) {
          if (this.#lastAggressorCheckOrRaise) {
            this.#lastAggressorCheckOrRaise = false;
            this.#lastAggressorAmount = 0;
            yield this.#currentPlayerSeat = nextSeat;
            break seatLoop;
          }

          this.closeRound();
          return;
        }

        if (mergedOutSeats.has(nextSeat)) {
          continue seatLoop;
        }

        yield this.#currentPlayerSeat = nextSeat;
        break seatLoop;
      }

      if (nextSeat === undefined) {
        this.closeRound();
        return;
      }
    }
  }

  checkIfSeatValid(seat: number) {
    if (!this.#seatOrder.has(seat)) {
      throw new Error(`Player at seat ${seat} not found`);
    }
  }

  fold(seat: number) {
    this.checkIfSeatValid(seat);

    if (seat !== this.#currentPlayerSeat) {
      throw new Error(`It's not player at seat ${seat}'s turn to fold`);
    }

    if (this.foldedSeats.has(seat)) {
      throw new Error(`Seat ${seat} has already folded`);
    }

    const player = this.#seatOrder.get(seat);

    if (!player) {
      throw new Error(`Player not found at seat ${seat}`);
    }

    if (this.#potManager.activePlayers.has(player)) {
      this.#potManager.foldPlayer(player);
    }

    this.#foldedSeats.add(seat);

    this.getNextSeat().next();
  }

  bet(seat: number, amount: number): number {
    this.checkIfSeatValid(seat);

    if (seat !== this.#currentPlayerSeat) {
      throw new Error(`It's not player at seat ${seat}'s turn to bet`);
    }

    const player = this.#seatOrder.get(seat);

    if (!player) {
      throw new Error(`Player at seat ${seat} not found`);
    }

    if (this.foldedSeats.has(seat)) {
      throw new Error(`Player at seat ${seat} has already folded`);
    }

    if (this.#potManager.allInPlayers.has(player)) {
      throw new Error(`Player at seat ${seat} is all-in and cannot bet`);
    }

    if (amount > player.chips) {
      throw new Error(`Insufficient chips to bet ${amount}, available chips: ${player.chips}`);
    }

    const currentPlayerBet = this.#potManager.betForPlayer(player);
    const totalBet = amount + currentPlayerBet;

    if (totalBet < this.#lastAggressorAmount && amount !== player.chips) {
      throw new Error(`Total bet amount ${totalBet} (Bet amount ${amount} plus current player bet ${currentPlayerBet}) is less than last aggressor amount ${this.#lastAggressorAmount}`);
    }

    if (amount > 0) {
      this.#potManager.addBet(player, amount);
    } else if (amount === 0) {
      this.#lastCheckedSeat = seat;
      if (seat === this.#lastAggressorSeat && this.#lastAggressorCheckOrRaise) {
        this.#lastAggressorCheckOrRaise = false;
      }
    }

    if (totalBet > this.#lastAggressorAmount) {
      this.#lastRaisedSeat = seat;
      this.#lastAggressorSeat = seat;
      this.#lastAggressorAmount = totalBet;
      // Voluntary raise/bet already acted — when action returns after callers
      // match, close the round (do not reopen a zero-amount check orbit).
      this.#lastAggressorCheckOrRaise = false;
    }

    if (player.chips === 0) {
      this.#allInSeats.add(seat);
    }

    this.getNextSeat().next();

    return amount;
  }

  get foldedSeats() {
    return this.#foldedSeats as ReadonlySet<number>;
  }

  get allInSeats() {
    return this.#allInSeats as ReadonlySet<number>;
  }

  get lastAggressorAmount() {
    return this.#lastAggressorAmount as Readonly<number>;
  }

  get lastAggressorSeat() {
    return this.#lastAggressorSeat as Readonly<number>;
  }

  get currentPlayerSeat() {
    return this.#currentPlayerSeat as Readonly<number>;
  }

  get isOpen() {
    return this.#roundStateOpen as Readonly<boolean>;
  }
}
