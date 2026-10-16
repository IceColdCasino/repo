import {
  War,
  MAX_PLAYERS,
  SHOE_SIZE,
  TOTAL_CARDS,
  type ShowdownHashInput,
} from './war';
import {
  type HeadToHeadOutcome,
  type SeatPoolConfig,
  type SeatStake,
  defaultHeadToHeadPools,
  settleHeadToHead,
} from './seat-pools';
import {
  type DealerPoolState,
  poolFromDealerStakes,
  settleWarHand,
  totalPlayerAction,
  type HandSettlementResult,
} from './casino-settlement';
import {
  requiredWarShareStake,
  slashUnsharedPlayers,
  type WarShareSlash,
} from './war-share-penalty';
import {
  type Ciphertext,
  type PublicKey,
} from './zk-casino';
import { verify } from './rapidsnark-ffi';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { readShuffleProof } from './shuffle-signals';
import path from 'path';

interface ShuffledDeck {
  transientHash: bigint;
  deck: Ciphertext[];
  permutationHash: bigint;
}

const verifyingKeyPath = (circuitName: string) =>
  path.join(__dirname, `../zkey/${circuitName}_verification_key.json`);

export type GamePhase =
  | 'Registration'
  | 'Shuffle'
  | 'Share'
  | 'Showdown'
  | 'Complete';

export { MAX_PLAYERS, TOTAL_CARDS, SHOE_SIZE };
export type { SeatPoolConfig, SeatStake, HeadToHeadOutcome };
export const IDENTITY_POINT = [0n, 1n] as PublicKey;

export interface ShufflePrivateData {
  publicKey: PublicKey;
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface SharePrivateData {
  publicKey: PublicKey;
  ciphertexts: Ciphertext[][];
}

export interface ShowdownPrivateData {
  publicKey: PublicKey;
  /** Poseidon of the seal rows Arcis revealed for this seat (seal account, not the prover). */
  coefficientCommitment: bigint;
}

export class Game {
  #players: PublicKey[] = [];
  #padding: Ciphertext[] = [];
  #numPlayers = 0;
  #inProgress = false;
  #turnPlayerIndex = 0;
  #shuffledDecks: ShuffledDeck[] = [];
  #war: War;
  #phase: GamePhase = 'Registration';
  #partials: Ciphertext[][][] = new Array(MAX_PLAYERS);
  #shareStakes: Array<bigint | undefined> = new Array(MAX_PLAYERS);
  #shared: boolean[] = new Array(MAX_PLAYERS).fill(false);
  #casinoSharedAt: number | undefined;
  #shareSlash: WarShareSlash | undefined;
  #clock: () => number = Date.now;
  #seatPools: SeatPoolConfig | undefined;
  #playerStakes: SeatStake[] = [];
  #dealerStakes: SeatStake[] = [];
  #shoeDecks: 1 | 6 | 8;
  #shuffleCircuit: string;
  // T0 is the constrained showdown transcript hash. Retaining the accepted
  // receipt prevents a proof from another game from advancing this game.
  #previousRoot: bigint | undefined;

  constructor(shoeDecks: 1 | 6 | 8 = 6) {
    this.#shoeDecks = shoeDecks;
    this.#war = new War(shoeDecks);
    this.#shuffleCircuit = `shuffle_${shoeDecks}_deck_52_main`;
  }

  get shoeDecks() {
    return this.#shoeDecks;
  }

  async init() {
    await this.#war.init();
  }

  get finalShuffledDeck() {
    if (this.#shuffledDecks.length < this.#numPlayers) {
      throw new Error('Not all players have shuffled');
    }
    return this.#shuffledDecks[this.#shuffledDecks.length - 1]!.deck.slice(0, TOTAL_CARDS);
  }

  get deck() {
    return this.#shuffledDecks.length < 1
      ? this.#war.initialDeck
      : this.#shuffledDecks[this.#shuffledDecks.length - 1]!.deck;
  }

  get publicKeys() {
    return [...this.#players];
  }

  publicKeysShare(playerIndex: number) {
    const keys = this.publicKeys;
    keys.splice(playerIndex, 1);
    return keys;
  }

  get nPlayers() {
    return this.#numPlayers;
  }

  get phase() {
    return this.#phase;
  }

  addPlayer(proof: Groth16Proof, publicSignals: PublicSignals) {
    if (this.#phase !== 'Registration') {
      if (this.#inProgress) {
        throw new Error('Game is already in progress');
      } else if (this.#phase === 'Complete') {
        throw new Error('Game has been completed');
      } else {
        throw new Error('Game is not in registration phase');
      }
    }

    if (this.#players.length >= MAX_PLAYERS) {
      throw new Error('Too many players');
    }

    const isValid = verify(proof, publicSignals, verifyingKeyPath('register_main'));
    if (!isValid) {
      throw new Error('Invalid registration proof');
    }

    const signals = publicSignals.map(s => BigInt(s));
    const publicKeyFromProof = signals.slice(0, 2) as PublicKey;
    const paddingFromProof = signals.slice(2, 6) as Ciphertext;

    const foundIndex = this.#players.findIndex(value =>
      value.every((v, i) => v === publicKeyFromProof[i])
    );

    if (foundIndex > -1) {
      throw new Error(`Player already registered at ${foundIndex}`);
    }

    this.#players.push(publicKeyFromProof);
    this.#padding.push(paddingFromProof);
    this.#numPlayers++;
  }

  start(
    seatPools?: SeatPoolConfig,
    playerStakes?: SeatStake[],
    dealerStakes?: SeatStake[],
  ) {
    this.#inProgress = true;
    this.#phase = 'Shuffle';
    this.#seatPools = seatPools ?? defaultHeadToHeadPools(this.#numPlayers);
    this.#playerStakes = playerStakes ?? this.#seatPools.playerSeats.map(seat => ({
      seatIndex: seat,
      stake: 1n,
    }));
    this.#dealerStakes = dealerStakes ?? this.#seatPools.dealerSeats.map(seat => ({
      seatIndex: seat,
      stake: 1n,
    }));
    if (this.#numPlayers < MAX_PLAYERS) {
      this.#players.push(
        ...new Array(MAX_PLAYERS - this.#numPlayers).fill(IDENTITY_POINT)
      );
    }
  }

  get seatPools() {
    return this.#seatPools;
  }

  #wager(seat: number): bigint {
    const posted = [...this.#playerStakes, ...this.#dealerStakes].find(item => item.seatIndex === seat);
    return posted?.stake ?? 1n;
  }

  #casinoSeat(): number {
    const seat = this.#seatPools?.dealerSeats[0];
    if (seat === undefined) throw new Error('the casino seat is not set');
    return seat;
  }

  /** Ten times this seat's wager. Posted before share. */
  requiredShareStake(seat: number): bigint {
    return requiredWarShareStake(this.#wager(seat));
  }

  postShareStake(seat: number, amount: bigint) {
    if (seat < 0 || seat >= this.#numPlayers) throw new Error(`player ${seat} is not in the hand`);
    const need = this.requiredShareStake(seat);
    if (amount !== need) throw new Error(`share stake must be ${need}`);
    this.#shareStakes[seat] = amount;
  }

  get shareSlash(): WarShareSlash | undefined {
    return this.#shareSlash;
  }

  setClock(clock: () => number) {
    this.#clock = clock;
  }

  /**
   * After the casino has shared, slash every player who still has not shared
   * once their deadline has passed.
   */
  slashUnshared(now = this.#clock()): WarShareSlash {
    if (this.#casinoSharedAt === undefined) throw new Error('the casino has not shared');
    const penalty = slashUnsharedPlayers({
      casinoSeat: this.#casinoSeat(),
      casinoSharedAt: this.#casinoSharedAt,
      now,
      shared: this.#shared.slice(0, this.#numPlayers),
      wagers: Array.from({ length: this.#numPlayers }, (_, seat) => this.#wager(seat)),
      stakes: Array.from({ length: this.#numPlayers }, (_, seat) => this.#shareStakes[seat] ?? 0n),
    });
    this.#shareSlash = penalty;
    this.#phase = 'Complete';
    return penalty;
  }

  settleHand(outcome: HeadToHeadOutcome) {
    return settleHeadToHead(outcome, this.#playerStakes, this.#dealerStakes);
  }

  settleHandWithFees(
    outcome: HeadToHeadOutcome,
    pool?: DealerPoolState,
  ): HandSettlementResult {
    const dealerPool = pool ?? poolFromDealerStakes(this.#dealerStakes);
    return settleWarHand(
      outcome,
      this.#playerStakes,
      this.#dealerStakes,
      dealerPool,
      { totalAction: totalPlayerAction(this.#playerStakes) },
    );
  }

  shuffle(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShufflePrivateData) {
    if (this.#phase !== 'Shuffle') {
      throw new Error('Game is not in shuffle phase');
    }

    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    if (playerIndex !== this.#turnPlayerIndex) {
      throw new Error('Not your turn');
    }

    const transientHashExpected = this.#war.shuffleHash(this.deck, this.#players);
    const { outputDeckHash, permutationHash, inputHash } = readShuffleProof(publicSignals);

    if (inputHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${inputHash}`);
    }
    if (this.#war.deckHash(privateData.deck) !== outputDeckHash) {
      throw new Error('Shuffle output hash does not match the shoe');
    }
    if (privateData.permutationHash !== permutationHash) {
      throw new Error('Shuffle permutation hash does not match the proof');
    }

    if (!verify(proof, publicSignals, verifyingKeyPath(this.#shuffleCircuit))) {
      throw new Error('Invalid shuffle proof');
    }

    this.#shuffledDecks.push({
      transientHash: inputHash,
      deck: privateData.deck,
      permutationHash,
    });

    if (++this.#turnPlayerIndex === this.#numPlayers) {
      this.#phase = 'Share';
      this.#turnPlayerIndex = 0;
    }
  }

  getPlayerIndex(publicKey: PublicKey) {
    const index = this.#players.findIndex(value =>
      value.every((v, i) => v === publicKey[i])
    );

    if (index < 0 || index >= this.#numPlayers) {
      throw new Error('Invalid Player Public Key');
    }

    return index;
  }

  share(proof: Groth16Proof, publicSignals: PublicSignals, privateData: SharePrivateData) {
    if (this.#phase !== 'Share') {
      throw new Error('Not in Share phase');
    }

    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    if (this.#shareStakes[playerIndex] !== this.requiredShareStake(playerIndex)) {
      throw new Error(
        `player ${playerIndex} must post ${this.requiredShareStake(playerIndex)} as the share stake before sharing`,
      );
    }
    const expectedInputHash = this.#war.shareHash(
      this.finalShuffledDeck,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );

    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));

    if (transientHash !== expectedInputHash) {
      throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${transientHash}`);
    }

    if (!verify(proof, publicSignals, verifyingKeyPath('war_share_hashout_main'))) {
      throw new Error('Invalid share partials proof');
    }

    const expectedOutputHash = this.#war.computeShareOutputHash(privateData.ciphertexts, this.#numPlayers);
    if (outputHash !== expectedOutputHash) {
      throw new Error(`Output hash mismatch: circuit has ${outputHash}, expected ${expectedOutputHash}`);
    }

    if (this.#partials[playerIndex]?.length) {
      throw new Error('Partials are already shared for this player');
    }

    this.#partials[playerIndex] = privateData.ciphertexts;
    this.#shared[playerIndex] = true;
    if (playerIndex === this.#casinoSeat() && this.#casinoSharedAt === undefined) {
      this.#casinoSharedAt = this.#clock();
    }

    const activePartials = this.#partials.filter((p, i) =>
      i < this.#numPlayers && p && p.length
    ).length;

    if (activePartials === this.#numPlayers) {
      this.#phase = 'Showdown';
    }
  }

  getCiphertextPartialsForPlayer(playerIndex: number) {
    const ciphertextPartials: Ciphertext[][] = [];
    const padding = this.#padding[playerIndex]!;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (i === playerIndex) {
        continue;
      }

      if (i >= this.#numPlayers) {
        ciphertextPartials.push(new Array(TOTAL_CARDS).fill(padding));
        continue;
      }

      if (!this.#partials[i]) {
        throw new Error(`Player ${i} has not shared their partials`);
      }

      const index = i > playerIndex ? playerIndex : playerIndex - 1;
      const partials = this.#partials[i]![index];

      if (!partials) {
        throw new Error(`Player ${i} has not shared partials for player ${playerIndex}`);
      }

      ciphertextPartials.push(partials);
    }

    return ciphertextPartials;
  }

  verifyShowdown(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShowdownPrivateData) {
    if (this.#phase !== 'Showdown') {
      throw new Error('Not in Showdown phase');
    }

    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const hashInput: ShowdownHashInput = {
      sealCommitment: privateData.coefficientCommitment,
      publicKeys: this.#players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.finalShuffledDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
    };

    const expectedInputHash = this.#war.showdownHash({
      ...hashInput,
      sealCommitment: privateData.coefficientCommitment,
    });
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));

    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }

    if (!verify(proof, publicSignals, verifyingKeyPath('war_showdown_hashout_main'))) {
      throw new Error('Invalid showdown proof');
    }

    this.#phase = 'Complete';
    return outputHash;
  }
}