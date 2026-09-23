export class Pot {
  #amount: bigint = 0n;
  #playerBets: Map<number, bigint> = new Map();
  #foldedBets: Map<number, bigint> = new Map();
  #lastBetAmount: bigint = 0n;

  constructor(
    playerBets?: (readonly [number, bigint])[],
    lastBetAmount?: bigint
  ) {
    if (playerBets) {
      this.#playerBets = new Map(playerBets as [number, bigint][]);
      this.#amount = playerBets.reduce((sum, [, bet]) => sum + bet, 0n);
    }
    this.#lastBetAmount = lastBetAmount || this.maxBet;
  }

  private get maxBet(): bigint {
    let max = 0n;
    for (const bet of this.#playerBets.values()) {
      if (bet > max) max = bet;
    }
    return max;
  }

  split(amount: bigint): Pot {
    if (this.#amount === 0n) {
      throw new Error('Cannot split an empty pot');
    }

    const betsAboveSplit = [...this.#playerBets.entries()]
      .filter(([, bet]) => bet > amount);

    const newPlayerBets = betsAboveSplit
      .map(([player, bet]) => [player, bet - amount] as const);

    betsAboveSplit.forEach(([player]) => {
      this.#playerBets.set(player, amount);
    });

    this.#amount -= newPlayerBets.reduce((acc, [, bet]) => acc + bet, 0n);

    return new Pot(newPlayerBets, 0n);
  }

  placePlayerBet(playerIndex: number, betAmount: bigint, currentBet?: bigint): bigint {
    const existingBet = currentBet !== undefined ? currentBet : (this.#playerBets.get(playerIndex) || 0n);
    const newBet = betAmount + existingBet;
    this.#playerBets.set(playerIndex, newBet);
    this.#amount += betAmount;
    return newBet;
  }

  addBet(playerIndex: number, betAmount: bigint): Pot | undefined {
    if (betAmount < 0n) {
      throw new Error('Bet amount must be non-negative');
    }

    const currentBet = this.#playerBets.get(playerIndex) || 0n;

    if (betAmount + currentBet < this.#lastBetAmount) {
      // All-in with less than required: create side pot
      this.#lastBetAmount = betAmount + currentBet;
      return this.split(this.placePlayerBet(playerIndex, betAmount, currentBet));
    }

    this.#lastBetAmount = this.placePlayerBet(playerIndex, betAmount, currentBet);
  }

  foldPlayer(playerIndex: number) {
    const playerBet = this.#playerBets.get(playerIndex) || 0n;
    if (playerBet > 0n) {
      this.#foldedBets.set(playerIndex, playerBet);
    }
    this.#playerBets.delete(playerIndex);
  }

  playerAmount(playerIndex: number): bigint {
    return this.#playerBets.get(playerIndex) || 0n;
  }

  get amount(): bigint {
    return this.#amount;
  }

  get lastBetAmount(): bigint {
    return this.#lastBetAmount;
  }

  get allInPlayers(): number[] {
    return [...this.#playerBets.entries()]
      .filter(([, bet]) => bet > 0n)
      .map(([player]) => player);
  }
}
