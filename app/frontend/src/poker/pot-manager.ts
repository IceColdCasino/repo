import { Player } from './player.js';
import { Pot } from './pot.js';

export class PotManager {
  readonly #pots: Pot[] = [];
  readonly #activePlayers: Set<Player>;
  readonly #allInPlayers: Set<Player>;
  readonly #smallBlindPlayer?: Player;
  readonly #smallBlindAmount?: number;
  readonly #bigBlindPlayer?: Player;
  readonly #liveBlindPlayers: Player[];
  #blindsCollected: boolean = false;

  constructor(
    players: Readonly<Player>[] = [],
    smallBlindAmount?: number,
    smallBlindPlayer?: Player,
    bigBlindPlayer?: Player,
    liveBlindPlayers: Player[] = [],
  ) {
    if (smallBlindPlayer && smallBlindAmount && bigBlindPlayer) {
      if (players.indexOf(smallBlindPlayer) < 0) {
        throw new Error('Small blind player must be in players array');
      }

      if (players.indexOf(bigBlindPlayer) < 0) {
        throw new Error('Big blind player must be in players array');
      }

      if (smallBlindAmount < 0 && !Number.isInteger(smallBlindAmount)) {
        throw new Error('Small blind amount must be a positive integer');
      }

      this.#smallBlindPlayer = smallBlindPlayer;
      this.#smallBlindAmount = smallBlindAmount;
      this.#bigBlindPlayer = bigBlindPlayer;
    }

    this.#liveBlindPlayers = liveBlindPlayers;

    const pot = new Pot(players.map(player => [player as Player, 0] as const), 0);
    this.#pots.push(pot);

    this.#activePlayers = new Set(players as Player[]);
    this.#allInPlayers = new Set(players.filter(player => player.chips === 0) as Player[]);
  }

  get #bigBlindAmount() {
    return this.#smallBlindAmount ? this.#smallBlindAmount * 2 : undefined;
  }

  collectBlinds() {
    if (this.#blindsCollected) {
      throw new Error('Already collected blinds');
    }

    if (!(this.#smallBlindPlayer && this.#smallBlindAmount && this.#bigBlindPlayer && this.#bigBlindAmount)) {
      return 0;
    }

    if (this.#liveBlindPlayers.includes(this.#smallBlindPlayer)) {
      throw new Error('Small blind player cannot be a live blind player');
    }

    this.pots[0].addBet(this.#smallBlindPlayer, this.#smallBlindAmount);
    this.pots[0].addBet(this.#bigBlindPlayer, this.#bigBlindAmount);
    this.#blindsCollected = true;

    return this.#pots[0].lastBetAmount;
  }

  addBet(player: Player, betAmount: number) {
    if (this.#allInPlayers.has(player)) {
      throw new Error('Cannot bet for an all-in player');
    }

    if (!this.#activePlayers.has(player)) {
      throw new Error('Player is not active in the pot');
    }

    for (let i = 0; i < this.pots.length; i++) {
      const pot = this.pots[i];
      const lastBetAmount = pot.lastBetAmount;

      if (lastBetAmount > 0 && betAmount > lastBetAmount && pot.allInPlayers.length > 0 && i < this.pots.length - 1) {
        pot.addBet(player, lastBetAmount);
        betAmount -= lastBetAmount;
        continue;
      }

      const newPot = pot.addBet(player, betAmount);

      if (newPot) {
        this.#pots.splice(i + 1, 0, newPot);
        break;
      }
    }

    if (player.chips === 0) {
      this.#allInPlayers.add(player);
    }
  }

  foldPlayer(player: Player) {
    if (this.#allInPlayers.has(player)) {
      throw new Error('Cannot fold an all-in player');
    }

    if (!this.#activePlayers.has(player)) {
      throw new Error('Player has already folded');
    }

    if (this.#activePlayers.size === 1) {
      throw new Error('Cannot fold only player in the pot');
    }

    this.pots.forEach((pot) => {
      pot.foldPlayer(player);
    });

    this.#activePlayers.delete(player);
  }

  betForPlayer(player: Player) {
    return this.pots.reduce((acc, pot) => acc + pot.playerAmount(player), 0);
  }

  get currentBet() {
    return this.pots.reduce((acc, pot) => acc + pot.lastBetAmount, 0);
  }

  get pots() {
    return this.#pots as ReadonlyArray<Pot>;
  }

  get activePlayers() {
    return this.#activePlayers as ReadonlySet<Player>;
  }

  get allInPlayers() {
    return this.#allInPlayers as ReadonlySet<Player>;
  }
}
