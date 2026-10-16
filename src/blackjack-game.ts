import {
  Blackjack,
  MAX_SEATS,
  MAX_PLAYERS,
  MAX_SHARE_CARDS,
  N_SHARE_CHUNKS,
  SHOE_SIZE,
  MAX_HANDS,
  MAX_SHOWDOWN_CARDS,
  CHUNK_SHARE_CARDS,
  N_OTHERS,
  paddedShareChunk,
  shareChunksForSeats,
  type BlackjackHandLayout,
  type HandOutcome,
  type ShowdownHashInput,
} from './blackjack';
import {
  type SeatPoolConfig,
  type SeatStake,
  defaultBlackjackPools,
  settleBlackjackTable,
} from './seat-pools';
import {
  type DealerPoolState,
  poolFromDealerStakes,
  settleBlackjackHand,
  type HandSettlementResult,
} from './casino-settlement';
import { type Ciphertext, type PublicKey } from './zk-casino';
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

export { MAX_SEATS, MAX_PLAYERS, MAX_SHARE_CARDS, SHOE_SIZE };
export type { SeatPoolConfig, SeatStake };
export const IDENTITY_POINT = [0n, 1n] as PublicKey;
export const DEALER_SEAT_INDEX = MAX_SEATS - 1;

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
  outcomesHash: bigint;
  handLayout: BlackjackHandLayout;
  /** Which of the player's hands this proof covers (0..MAX_HANDS-1). */
  handIndex: number;
  /**
   * When true (default), mark the game Complete after verifying this hand.
   * Set false when more surviving split hands still need showdown proofs.
   */
  complete?: boolean;
}

export class Game {
  #seats: PublicKey[] = [];
  #padding: Ciphertext[] = [];
  #numPlayers = 0;
  #inProgress = false;
  #turnSeatIndex = 0;
  #shuffledDecks: ShuffledDeck[] = [];
  #blackjack: Blackjack;
  #phase: GamePhase = 'Registration';
  #partials: (Ciphertext[][] | undefined)[] = Array.from({ length: MAX_SEATS });
  #partialsChunks: (Ciphertext[][] | undefined)[][] = Array.from({ length: N_SHARE_CHUNKS }, () => new Array(MAX_SEATS));
  #chunkOutputHash: (bigint | undefined)[][] = Array.from({ length: N_SHARE_CHUNKS }, () => new Array(MAX_SEATS));
  #chunkCardHash: (bigint[] | undefined)[][] = Array.from({ length: N_SHARE_CHUNKS }, () => new Array(MAX_SEATS));
  #currentShareChunk = 0;
  // Computed at start() from the actual seat count; players only share the chunks
  // their hands can occupy (1 chunk for a single player + dealer).
  #nShareChunks = N_SHARE_CHUNKS;
  #seatPools: SeatPoolConfig | undefined;
  #dealerStakes: SeatStake[] = [];
  #handStakes = new Map<string, bigint>();
  #fullTableBankroll = 0n;
  #shoeDecks: 1 | 6 | 8;
  #shuffleCircuit: string;
  // Per-hand V2 receipt root. T0 is the constrained encrypted showdown
  // transcript; subsequent hand transitions must consume this receipt.
  #previousRoot: bigint | undefined;

  constructor(shoeDecks: 1 | 6 | 8 = 6) {
    this.#shoeDecks = shoeDecks;
    this.#blackjack = new Blackjack(shoeDecks);
    this.#shuffleCircuit = `shuffle_${shoeDecks}_deck_52_main`;
  }

  get shoeDecks() {
    return this.#shoeDecks;
  }

  async init() {
    await this.#blackjack.init();
  }

  get finalShuffledDeck() {
    if (this.#shuffledDecks.length < this.#numPlayers) {
      throw new Error('Not all players have shuffled');
    }
    return this.#shuffledDecks[this.#shuffledDecks.length - 1]!.deck;
  }

  get shareCiphertextCards() {
    return this.finalShuffledDeck.slice(0, MAX_SHARE_CARDS);
  }

  get deck() {
    return this.#shuffledDecks.length < 1
      ? this.#blackjack.initialDeck
      : this.#shuffledDecks[this.#shuffledDecks.length - 1]!.deck;
  }

  get publicKeys() {
    return [...this.#seats];
  }

  actionHashMaterial(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ) {
    return this.#blackjack.actionHashMaterial(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
    );
  }

  publicKeysShare(seatIndex: number) {
    const keys = this.publicKeys;
    keys.splice(seatIndex, 1);
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
      if (this.#inProgress) throw new Error('Game is already in progress');
      if (this.#phase === 'Complete') throw new Error('Game has been completed');
      throw new Error('Game is not in registration phase');
    }

    if (this.#numPlayers >= MAX_SEATS) {
      throw new Error('Too many seats');
    }

    if (!verify(proof, publicSignals, verifyingKeyPath('register_main'))) {
      throw new Error('Invalid registration proof');
    }

    const signals = publicSignals.map(s => BigInt(s));
    const publicKeyFromProof = signals.slice(0, 2) as PublicKey;
    const paddingFromProof = signals.slice(2, 6) as Ciphertext;

    const foundIndex = this.#seats.findIndex(value =>
      value.every((v, i) => v === publicKeyFromProof[i]),
    );
    if (foundIndex > -1) {
      throw new Error(`Player already registered at ${foundIndex}`);
    }

    this.#seats.push(publicKeyFromProof);
    this.#padding.push(paddingFromProof);
    this.#numPlayers++;
  }

  get nShareChunks() {
    return this.#nShareChunks;
  }

  start(
    seatPools?: SeatPoolConfig,
    dealerStakes?: SeatStake[],
    handStakes?: Map<string, bigint>,
    fullTableBankroll?: bigint,
  ) {
    this.#inProgress = true;
    this.#phase = 'Shuffle';
    this.#nShareChunks = shareChunksForSeats(this.#numPlayers);
    const dealerSeat = this.#numPlayers >= MAX_SEATS ? DEALER_SEAT_INDEX : this.#numPlayers - 1;
    this.#seatPools = seatPools ?? defaultBlackjackPools(this.#numPlayers, dealerSeat);
    this.#dealerStakes = dealerStakes ?? this.#seatPools.dealerSeats.map(seat => ({
      seatIndex: seat,
      stake: 1n,
    }));
    this.#handStakes = handStakes ?? new Map();
    this.#fullTableBankroll = fullTableBankroll ?? BigInt(MAX_PLAYERS);
    if (this.#numPlayers < MAX_SEATS) {
      this.#seats.push(
        ...new Array(MAX_SEATS - this.#numPlayers).fill(IDENTITY_POINT),
      );
    }
    while (this.#padding.length < MAX_SEATS) {
      this.#padding.push(this.#blackjack.getPadding(IDENTITY_POINT));
    }
  }

  get seatPools() {
    return this.#seatPools;
  }

  /** Active betting player seats (excludes dealer seat). */
  get activePlayerSeatCount() {
    return this.#seatPools?.playerSeats.length ?? Math.max(0, this.#numPlayers - 1);
  }

  settleTable(outcomes: HandOutcome[][]) {
    return settleBlackjackTable(
      outcomes,
      this.#handStakes,
      this.#dealerStakes,
      this.activePlayerSeatCount,
      MAX_PLAYERS,
      this.#fullTableBankroll,
    );
  }

  settleTableWithFees(
    outcomes: HandOutcome[][],
    pool?: DealerPoolState,
  ): HandSettlementResult {
    const totalAction = [...this.#handStakes.values()].reduce((a, b) => a + b, 0n);
    const dealerPool = pool ?? poolFromDealerStakes(this.#dealerStakes);
    return settleBlackjackHand(
      outcomes,
      this.#handStakes,
      this.#dealerStakes,
      this.activePlayerSeatCount,
      MAX_PLAYERS,
      this.#fullTableBankroll,
      dealerPool,
      { totalAction },
    );
  }

  shuffle(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShufflePrivateData) {
    if (this.#phase !== 'Shuffle') {
      throw new Error('Game is not in shuffle phase');
    }

    const seatIndex = this.getSeatIndex(privateData.publicKey);
    if (seatIndex !== this.#turnSeatIndex) {
      throw new Error('Not your turn');
    }

    const transientHashExpected = this.#blackjack.shuffleHash(this.deck, this.#seats);
    const { outputDeckHash, permutationHash, inputHash } = readShuffleProof(publicSignals);

    if (inputHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${inputHash}`);
    }
    if (this.#blackjack.deckHash(privateData.deck) !== outputDeckHash) {
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

    if (++this.#turnSeatIndex === this.#numPlayers) {
      this.#phase = 'Share';
      this.#turnSeatIndex = 0;
    }
  }

  getSeatIndex(publicKey: PublicKey) {
    const index = this.#seats.findIndex(value =>
      value.every((v, i) => v === publicKey[i]),
    );
    if (index < 0 || index >= MAX_SEATS) {
      throw new Error('Invalid seat public key');
    }
    return index;
  }

  shareChunk(proof: Groth16Proof, publicSignals: PublicSignals, privateData: SharePrivateData) {
    if (this.#phase !== 'Share') {
      throw new Error('Not in Share phase');
    }

    const seatIndex = this.getSeatIndex(privateData.publicKey);
    const chunkIndex = this.#currentShareChunk;
    const shareDeck = paddedShareChunk(this.shareCiphertextCards, chunkIndex);
    const expectedInputHash = this.#blackjack.shareHash(
      shareDeck,
      privateData.publicKey,
      this.publicKeysShare(seatIndex),
    );

    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${transientHash}`);
    }

    if (!verify(proof, publicSignals, verifyingKeyPath('blackjack_share_hashout_main'))) {
      throw new Error('Invalid share chunk proof');
    }

    const commitment = this.#blackjack.shareCardCommitment(
      privateData.ciphertexts,
      this.#numPlayers,
    );
    if (outputHash !== commitment.finalHash) {
      throw new Error(`Output hash mismatch: circuit has ${outputHash}, got ${commitment.finalHash}`);
    }

    if (this.#partialsChunks[chunkIndex]![seatIndex]) {
      throw new Error(`Partials already shared for seat ${seatIndex} in chunk ${chunkIndex}`);
    }

    this.#partialsChunks[chunkIndex]![seatIndex] = privateData.ciphertexts;
    this.#chunkOutputHash[chunkIndex]![seatIndex] = commitment.finalHash;
    this.#chunkCardHash[chunkIndex]![seatIndex] = commitment.cards;

    const activePartials = this.#partialsChunks[chunkIndex]!.filter((p, i) =>
      i < this.#numPlayers && p,
    ).length;

    if (activePartials === this.#numPlayers) {
      this.#currentShareChunk++;
      this.#turnSeatIndex = 0;
      // Materialize the prefix so play/decrypt can start before later chunks.
      this.materializeSharePrefix();
      if (this.#currentShareChunk === this.#nShareChunks) {
        this.#phase = 'Showdown';
      }
    }
  }

  /**
   * The seat has not shared this chunk, so that bet is forfeit. The dealer seat
   * is a player and forfeits the same way.
   */
  unsharedSeatForfeits(chunkIndex: number, seatIndex: number): boolean {
    return !this.#partialsChunks[chunkIndex]?.[seatIndex];
  }

  /**
   * Card hashes published with the share. The chain folds them into the proof
   * output, then checks one opened card against its stored hash.
   */
  shareTierCommitment(ciphertexts: Ciphertext[][]): { hashes: bigint[]; finalHash: bigint } {
    const commitment = this.#blackjack.shareCardCommitment(ciphertexts, this.#numPlayers);
    return { hashes: commitment.cards, finalHash: commitment.finalHash };
  }

  /**
   * One revealed card: every recipient's partials for that card must match the
   * card hash committed inside the share output. The other card of an initial
   * two-card deal stays sealed.
   */
  assertRevealedCard(
    chunkIndex: number,
    seatIndex: number,
    cardIndex: number,
    column: Ciphertext[],
  ): void {
    if (cardIndex < 0 || cardIndex >= CHUNK_SHARE_CARDS) {
      throw new Error(`Card ${cardIndex} is outside the ${CHUNK_SHARE_CARDS}-card share chunk`);
    }
    const expected = this.#chunkCardHash[chunkIndex]?.[seatIndex]?.[cardIndex];
    if (expected === undefined) throw new Error('Card share hash is not on record');
    if (column.length !== N_OTHERS) {
      throw new Error(`Expected ${N_OTHERS} recipient partials for one card, got ${column.length}`);
    }
    const got = this.#blackjack.cardShareHash(column);
    if (got !== expected) {
      throw new Error(`Revealed card ${cardIndex} does not match the share card hash`);
    }
  }

  /**
   * After every card in a chunk is revealed, the folded card hashes must match
   * the share output hash recorded when that seat shared.
   */
  assertRevealedChunk(chunkIndex: number, seatIndex: number, ciphertexts: Ciphertext[][]): void {
    const expected = this.#chunkOutputHash[chunkIndex]?.[seatIndex];
    if (expected === undefined) throw new Error('Chunk share hash is not on record');
    const got = this.#blackjack.computeChunkShareOutputHash(ciphertexts, this.#numPlayers);
    if (got !== expected) {
      throw new Error('Revealed dealer partials do not match the on-chain chunk hash');
    }
  }

  /**
   * Combine finished share chunks `0..currentShareChunk-1` into `#partials`.
   * Length is exactly `nReady * 16` (no fake pad cards — those fail decrypt).
   */
  materializeSharePrefix(): void {
    const nReady = this.#currentShareChunk;
    if (nReady < 1) {
      throw new Error('No completed share chunks to materialize');
    }
    this.#partials = this.#partials.map((_, i) => {
      const chunks = this.#partialsChunks.slice(0, nReady).map((c) => c[i]);
      if (chunks.some((c) => !c)) return undefined;
      return chunks[0]!.map((_playerPartials, j) => {
        const combined: Ciphertext[] = [];
        for (let ci = 0; ci < nReady; ci++) combined.push(...chunks[ci]![j]!);
        return combined;
      });
    });
  }

  /** Number of fully completed share chunk rounds (all seats). */
  get completedShareChunks(): number {
    return this.#currentShareChunk;
  }

  /**
   * Advance to Showdown after a lazy share prefix (not all planned chunks).
   * Requires at least one completed chunk and materialized `#partials`.
   */
  enterShowdownFromSharePrefix(): void {
    if (this.#phase === 'Showdown') return;
    if (this.#phase !== 'Share') {
      throw new Error(`Cannot enter showdown from phase ${this.#phase}`);
    }
    if (this.#currentShareChunk < 1) {
      throw new Error('No share chunks completed');
    }
    this.materializeSharePrefix();
    this.#phase = 'Showdown';
  }

  getCiphertextPartialsForPlayer(playerIndex: number) {
    const ciphertextPartials: Ciphertext[][] = [];
    const padding = this.#padding[playerIndex]!;

    for (let i = 0; i < MAX_SEATS; i++) {
      if (i === playerIndex) continue;

      if (i >= this.#numPlayers) {
        ciphertextPartials.push(new Array(MAX_SHARE_CARDS).fill(padding));
        continue;
      }

      if (!this.#partials[i]) {
        throw new Error(`Seat ${i} has not shared partials`);
      }

      const index = i > playerIndex ? playerIndex : playerIndex - 1;
      const partials = this.#partials[i]![index];
      if (!partials) {
        throw new Error(`Seat ${i} has not shared partials for player ${playerIndex}`);
      }
      ciphertextPartials.push(partials);
    }

    return ciphertextPartials;
  }

  verifyShowdown(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShowdownPrivateData) {
    if (this.#phase !== 'Showdown') {
      throw new Error('Not in Showdown phase');
    }

    const playerIndex = this.getSeatIndex(privateData.publicKey);
    const handIndex = privateData.handIndex;
    if (handIndex < 0 || handIndex >= MAX_HANDS) {
      throw new Error(`Invalid handIndex ${handIndex}`);
    }
    const sourceIndices = this.#blackjack.oneHandShowdownSourceIndices(
      privateData.handLayout,
      playerIndex,
      handIndex,
    );
    if (sourceIndices.length !== MAX_SHOWDOWN_CARDS) {
      throw new Error('Invalid showdown source index count');
    }
    const allPartials = this.getCiphertextPartialsForPlayer(playerIndex);
    const playerCardCount = privateData.handLayout.playerHandLengths[playerIndex]![handIndex]!;
    const dealerCardCount = privateData.handLayout.dealerCardCount;
    const hashInput: ShowdownHashInput = {
      sealCommitment: privateData.coefficientCommitment,
      publicKeys: this.#seats,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: sourceIndices.map(index => this.shareCiphertextCards[index]!),
      ciphertextPartials: allPartials.map(partials => sourceIndices.map(index => partials[index]!)),
      playerCardCount,
      dealerCardCount,
    };

    const expectedInputHash = this.#blackjack.showdownHash({
      ...hashInput,
      sealCommitment: privateData.coefficientCommitment,
    });
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));

    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }

    if (!verify(proof, publicSignals, verifyingKeyPath('blackjack_showdown_hashout_main'))) {
      throw new Error('Invalid showdown proof');
    }

    if (privateData.complete !== false) {
      this.#phase = 'Complete';
    }
    return outputHash;
  }
}