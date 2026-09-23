import { Pot } from './pot';

export class PotManager {
  readonly #pots: Pot[] = [];
  readonly #activePlayers: Set<number>;
  readonly #allInPlayers: Set<number>;
  readonly #smallBlindPlayer?: number;
  readonly #smallBlindAmount?: bigint;
  readonly #bigBlindPlayer?: number;
  #blindsCollected: boolean = false;

  constructor(
    players: number[] = [],
    smallBlindAmount?: bigint,
    smallBlindPlayer?: number,
    bigBlindPlayer?: number,
  ) {
    if (smallBlindPlayer !== undefined && smallBlindAmount !== undefined && bigBlindPlayer !== undefined) {
      if (!players.includes(smallBlindPlayer)) {
        throw new Error('Small blind player must be in players array');
      }
      if (!players.includes(bigBlindPlayer)) {
        throw new Error('Big blind player must be in players array');
      }
      this.#smallBlindPlayer = smallBlindPlayer;
      this.#smallBlindAmount = smallBlindAmount;
      this.#bigBlindPlayer = bigBlindPlayer;
    }

    const pot = new Pot(players.map(p => [p, 0n] as const), 0n);
    this.#pots.push(pot);

    this.#activePlayers = new Set(players);
    this.#allInPlayers = new Set();
  }

  get #bigBlindAmount(): bigint | undefined {
    return this.#smallBlindAmount ? this.#smallBlindAmount * 2n : undefined;
  }

  collectBlinds(): bigint {
    if (this.#blindsCollected) {
      throw new Error('Already collected blinds');
    }

    if (this.#smallBlindPlayer === undefined || this.#smallBlindAmount === undefined || 
        this.#bigBlindPlayer === undefined || this.#bigBlindAmount === undefined) {
      return 0n;
    }

    this.pots[0]!.addBet(this.#smallBlindPlayer, this.#smallBlindAmount);
    this.pots[0]!.addBet(this.#bigBlindPlayer, this.#bigBlindAmount);
    this.#blindsCollected = true;

    return this.#bigBlindAmount;
  }

  addBet(playerIndex: number, betAmount: bigint) {
    if (this.#allInPlayers.has(playerIndex)) {
      throw new Error('Cannot bet for an all-in player');
    }

    if (!this.#activePlayers.has(playerIndex)) {
      throw new Error('Player is not active in the pot');
    }

    for (let i = 0; i < this.pots.length; i++) {
      const pot = this.pots[i]!;
      const lastBetAmount = pot.lastBetAmount;

      if (lastBetAmount > 0n && betAmount > lastBetAmount && this.#allInPlayers.size > 0 && i < this.pots.length - 1) {
        pot.addBet(playerIndex, lastBetAmount);
        betAmount -= lastBetAmount;
        continue;
      }

      const newPot = pot.addBet(playerIndex, betAmount);

      if (newPot) {
        this.#pots.splice(i + 1, 0, newPot);
        break;
      }
    }
  }

  foldPlayer(playerIndex: number) {
    if (this.#allInPlayers.has(playerIndex)) {
      throw new Error('Cannot fold an all-in player');
    }

    if (!this.#activePlayers.has(playerIndex)) {
      throw new Error('Player has already folded');
    }

    if (this.#activePlayers.size === 1) {
      throw new Error('Cannot fold only player in the pot');
    }

    this.pots.forEach((pot) => {
      pot.foldPlayer(playerIndex);
    });

    this.#activePlayers.delete(playerIndex);
  }

  betForPlayer(playerIndex: number): bigint {
    return this.pots.reduce((acc, pot) => acc + pot.playerAmount(playerIndex), 0n);
  }

  get currentBet(): bigint {
    return this.pots.reduce((acc, pot) => acc + pot.lastBetAmount, 0n);
  }

  get pots(): ReadonlyArray<Pot> {
    return this.#pots;
  }

  get activePlayers(): ReadonlySet<number> {
    return this.#activePlayers;
  }

  get allInPlayers(): ReadonlySet<number> {
    return this.#allInPlayers;
  }
}
