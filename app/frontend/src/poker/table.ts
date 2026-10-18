import { Hand } from './hand';
import { Player } from './player';

export class Table {
  #playerMap: Map<CryptoKey, Player> = new Map<CryptoKey, Player>();
  seats: Map<number, CryptoKey> = new Map<number, CryptoKey>();
  readonly minPlayers: number = 2; // new hands will not be dealt until there are 3 players seated
  readonly maxPlayers: number = 10;
  turnTimeout: number = 1_000 * 60 * 2; // 2 minutes
  smallBlind: number = 1;
  maxInitalChips: number = 1000;
  Hands: Hand[] = [];
  currentDealer: number = -1;

  addPlayer(player: Player, initialChips: number) {
    if (this.#playerMap.size >= this.maxPlayers) {
      throw new Error('Maximum number of players reached');
    }

    if (this.#playerMap.has(player.publicKey!)) {
      throw new Error('Player already exists');
    }

    if (initialChips > this.maxInitalChips) {
      throw new Error(`Initial chips cannot exceed ${this.maxInitalChips}`);
    }
    
    if (initialChips < 0) {
      throw new Error('Initial chips cannot be negative');
    }

    player.addChips(initialChips);
    this.#playerMap.set(player.publicKey!, player);
  }

  get players() {
    return [...this.#playerMap.values()] as Readonly<Player>[];
  }

  sit(seat: number, pubKey: CryptoKey) {
    if (seat >= this.maxPlayers || seat < 0 || !Number.isInteger(seat)) {
      return { msg: 'Invalid seat number' };
    }

    if (this.seats.has(seat)) {
      return { msg: 'Seat is already taken' };
    }

    this.seats.set(seat, pubKey);
  }

  standUp(seat: number) {
    if (seat >= this.maxPlayers || seat < 0 || !Number.isInteger(seat)) {
      return { msg: 'Invalid seat number' };
    }

    this.seats.delete(seat);
  }

  get sortedSeats() {
    return [...this.seats.keys()]
      .toSorted();
  }

  findNextSmallBlind() {
    const sortedSeats = this.sortedSeats;
    const dealerIndex = sortedSeats.indexOf(this.currentDealer);

    for (let i = 1; i < sortedSeats.length; i++) {
      const nextIndex = (dealerIndex + i) % sortedSeats.length;
      const nextSeat = sortedSeats[nextIndex];
      
      if (sortedSeats.length < 3) {
        return nextSeat;
      }
    }
    return ;
  }

  getBlindSeats() {
    const sortedSeats = this.sortedSeats;
    const dealerIndex = sortedSeats.indexOf(this.currentDealer);

    if (dealerIndex < 0 || dealerIndex >= sortedSeats.length) {
      throw new Error('Invalid dealer index');
    }

    if (sortedSeats.length === 2) {
      const other = sortedSeats[dealerIndex === 0 ? 1 : 0]!;
      return {
        dealer: this.currentDealer,
        smallBlindSeat: this.currentDealer,
        bigBlindSeat: other,
      };
    }

    const smallBlindIndex = (dealerIndex + 1) % sortedSeats.length;
    const bigBlindIndex = (dealerIndex + 2) % sortedSeats.length;

    return {
      dealer: this.currentDealer,
      smallBlindSeat: sortedSeats[smallBlindIndex],
      bigBlindSeat: sortedSeats[bigBlindIndex],
    };
  }

  pruneSeats() {
    const seatSize = this.seats.size;

    if (seatSize < this.minPlayers) {
      return;
    }

    for (const [seat, pubKey] of this.seats.entries()) {
      const player = this.#playerMap.get(pubKey)!;

      if (player.chips <= 0) {
        // Player has no chips, remove from seats
        this.standUp(seat);
      }
    }

    if (this.seats.size < seatSize) {
      this.recalculateSeats();
      this.pruneSeats();
    }
    
    const { smallBlindSeat, bigBlindSeat } = this.getBlindSeats();
    const smallBlindKey = this.seats.get(smallBlindSeat)!;
    const smallBlindPlayer = this.#playerMap.get(smallBlindKey)!;

    if (smallBlindPlayer.chips < this.smallBlind) {
      // Small blind player doesn't have enough chips to post the small blind
      this.standUp(smallBlindSeat);
    }

    if (this.seats.size < seatSize) {
      this.recalculateSeats();
      this.pruneSeats();
    }

    const bigBlindKey = this.seats.get(bigBlindSeat)!;
    const bigBlindPlayer = this.#playerMap.get(bigBlindKey)!;

    if (bigBlindPlayer.chips < this.bigBlind) {
      // Big blind player doesn't have enough chips to post the big blind
      this.standUp(smallBlindSeat);
    }
  
    if (this.seats.size < seatSize) {
      this.recalculateSeats();
      this.pruneSeats();
    }
  }

  recalculateSeats() {
    if (this.seats.size < this.minPlayers) {
      return;
    }

    const sortedSeats = this.sortedSeats;
    const dealer = this.currentDealer;
    const dealerIndex = sortedSeats.indexOf(dealer);

    if (dealerIndex < 0 || dealer >= this.maxPlayers || !this.seats.has(dealer)) {
      this.currentDealer = sortedSeats[dealerIndex + 1 % sortedSeats.length];
    }
  }

  get playerMap() {
    return this.#playerMap as ReadonlyMap<CryptoKey, Player>;
  }

  * nextDealer(): Generator<{ dealer: number, order: number[] }, void> {
    while (this.seats.size >= this.minPlayers) {
      const sortedSeats = this.sortedSeats;
      const currentDealer = this.currentDealer;
      const currentIndex = sortedSeats.indexOf(currentDealer);

      if (currentIndex > -1) {
        const nextDealerIndex = (currentIndex + 1) % sortedSeats.length;
        const nextSmallBlindIndex = (currentIndex + 2) % sortedSeats.length;

        yield {
          dealer: this.currentDealer = sortedSeats[nextDealerIndex],
          order: [
            ...sortedSeats.slice(nextSmallBlindIndex),
            ...sortedSeats.slice(0, nextSmallBlindIndex),
          ],
        };
      } else {
        let nextDealerSeat = sortedSeats.find(seat => seat > currentDealer);

        if (nextDealerSeat === undefined) {
          nextDealerSeat = sortedSeats[0];
        }

        this.currentDealer = nextDealerSeat;
        const nextIndex = sortedSeats.indexOf(nextDealerSeat);
        const nextSmallBlindIndex = (nextIndex + 1) % sortedSeats.length;

        yield {
          dealer: nextDealerSeat,
          order: [
            ...sortedSeats.slice(nextSmallBlindIndex),
            ...sortedSeats.slice(0, nextSmallBlindIndex),
          ],
        };
      }
    }
  }

  get bigBlind() {
    return this.smallBlind * 2;
  }

  get seatMap(): Map<number, Player> {
    const map = new Map<number, Player>();

    for (const [seat, pubKey] of this.seats.entries()) {
      const player = this.#playerMap.get(pubKey);

      if (player) {
        map.set(seat, player);
      }
    }

    return map;
  }
}