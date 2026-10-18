import { Player } from './player';

export class Pot {
  #amount: number = 0;
  #playerBets: Map<Player, number> = new Map();
  #foldedBets: Map<Player, number> = new Map();
  #lastBetAmount: number = 0;

  constructor(playerBets?: (readonly [Readonly<Player>, number])[], lastBetAmount?: number) {
    if (playerBets) {
      this.#playerBets = new Map(playerBets as [Player, number][]);
      this.#amount = playerBets.reduce((sum, [, bet]) => sum + bet, 0);
    }

    this.#lastBetAmount = lastBetAmount || Math.max(...this.#playerBets.values(), 0);
  }

  split(amount: number) {
    if (this.#amount === 0) {
      throw new Error('Cannot split an empty pot');
    }

    const betsAboveSplit = [...this.#playerBets.entries()]
      .filter(([, bet]) => bet > amount);

    const playerBets = betsAboveSplit
      .map(([player, bet]) => [player, bet - amount] as const);

    betsAboveSplit.forEach(([player]) => this.#playerBets.set(player, amount));

    this.#amount -= playerBets.reduce((acc, [, bet]) => acc + bet, 0);

    const newPot = new Pot(playerBets);

    return newPot;
  }

  placePlayerBet(player: Player, betAmount: number, currentBet?: number) {
    const newBet = player.placeBet(betAmount) + (currentBet || this.#playerBets.get(player) || 0);
    this.#playerBets.set(player, newBet);
    this.#amount += betAmount;
    return newBet;
  }

  addBet(player: Player, betAmount: number): Pot | undefined {
    if (betAmount < 0 || !Number.isInteger(betAmount)) {
      throw new Error('Bet amount must be a positive integer');
    }

    const currentBet = this.#playerBets.get(player) || 0;

    if (betAmount + currentBet < this.#lastBetAmount) {
      if (betAmount !== player.chips) {
        throw new Error(`Bet amount ${betAmount} is less than the last bet amount ${this.#lastBetAmount}`);
      }

      this.#lastBetAmount = betAmount + currentBet;

      return this.split(this.placePlayerBet(player, betAmount, currentBet));
    }

    if (betAmount + currentBet > this.#lastBetAmount && this.allInPlayers.length > 0) {
      this.placePlayerBet(player, betAmount, currentBet);
      return this.split(this.#lastBetAmount);
    }

    this.#lastBetAmount = this.placePlayerBet(player, betAmount, currentBet);
  }

  foldPlayer(player: Player) {
    const playerBet = this.#playerBets.get(player) || 0;

    if (playerBet > 0) {
      this.#foldedBets.set(player, playerBet);
    }

    return this.#playerBets.delete(player);
  }

  withdrawChips(players: Player[]) {
    const amount = this.#amount;
    const amountPerPlayer = amount / players.length;
    this.#amount = 0;

    players.forEach((player) => {
      player.addChips(amountPerPlayer);
    });

    return amount;
  }

  playerAmount(player: Player) {
    return this.#playerBets.get(player) || 0 as const;
  }

  get amount() {
    return this.#amount;
  }

  get lastBetAmount() {
    return this.#lastBetAmount;
  }

  get allInPlayers() {
    return [
      ...this.#playerBets.entries()
        .filter(([player, bet]) => bet > 0 && player.chips === 0)
        .map(([player]) => player),
    ];
  }
}
