import {
  Bingo,
  MAX_PLAYERS,
  BINGO_CHUNK_BALLS,
  parseSharePublicSignals,
  parseCardPublicSignals,
  type BingoVariant,
  type ShowdownHashInput,
} from './bingo';
import { type BingoPattern75 } from './bingo-eval';
import { bingoShareChunks } from './game-config';
import { type Ciphertext, type PublicKey } from './zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { ZkGame, IDENTITY_POINT, type CasinoGamePhase } from './zk-game-base';

export type GamePhase = CasinoGamePhase;
export { IDENTITY_POINT };

export class Game extends ZkGame {
  #bingo: Bingo;
  #partials: Ciphertext[][][][] = [];
  #encryptedCards: (Ciphertext[] | undefined)[] = new Array(MAX_PLAYERS);
  #plaintextCards: (number[] | undefined)[] = new Array(MAX_PLAYERS);
  #nShareChunks = 1;
  #patternId: BingoPattern75;

  constructor(variant: BingoVariant = 75, patternId: BingoPattern75 = 0) {
    super({ maxPlayers: MAX_PLAYERS });
    this.#bingo = new Bingo(variant);
    this.#patternId = patternId;
  }

  get variant() {
    return this.#bingo.variant;
  }

  get patternId() {
    return this.#patternId;
  }

  setPatternId(patternId: BingoPattern75) {
    if (this.variant !== 75) throw new Error('pattern id is 75-ball only');
    if (this.gamePhase === 'Showdown' || this.gamePhase === 'Complete') {
      throw new Error('Cannot change pattern after share');
    }
    if (this.#partials.some(p => p?.some(chunk => chunk?.length))) {
      throw new Error('Cannot change pattern after the first share chunk');
    }
    this.#patternId = patternId;
  }

  get nShareChunks() {
    return this.#nShareChunks;
  }

  get nCalled() {
    return this.#nShareChunks * BINGO_CHUNK_BALLS;
  }

  get maxShareChunks() {
    return bingoShareChunks(this.variant);
  }

  async init() {
    await this.#bingo.init();
  }

  protected override initialDeck(): Ciphertext[] {
    return this.#bingo.initialDeck;
  }

  chunkDeck(chunkIndex: number): Ciphertext[] {
    const start = chunkIndex * BINGO_CHUNK_BALLS;
    return this.finalShuffledDeck.slice(start, start + BINGO_CHUNK_BALLS);
  }

  override start() {
    super.start();
    this.#partials = Array.from({ length: MAX_PLAYERS }, () => []);
  }

  #assertCardWindow(playerIndex: number) {
    if (this.gamePhase === 'Showdown' || this.gamePhase === 'Complete') {
      throw new Error('Card commit is closed');
    }
    if (this.numPlayers < 2) {
      throw new Error('All seats must register before card commit');
    }
    if (this.#partials[playerIndex]?.some(chunk => chunk?.length)) {
      throw new Error('Cannot commit a card after encrypted partials are revealed');
    }
  }

  cardCommit(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; encryptedCells: Ciphertext[]; plaintextCells: number[] },
  ) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.#assertCardWindow(playerIndex);
    const expectedHash = this.#bingo.cardHash(privateData.publicKey);
    const parsed = parseCardPublicSignals(publicSignals.map(String), this.variant);
    if (parsed.inputHash !== expectedHash) {
      throw new Error(`Card hash mismatch: expected ${expectedHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, `bingo_card_${this.variant}_main`, 'Invalid card commit proof');
    for (let b = 0; b < parsed.encryptedCells.length; b++) {
      if (!parsed.encryptedCells[b]!.every((v, i) => v === privateData.encryptedCells[b]![i])) {
        throw new Error(`Encrypted cell ${b} mismatch for player ${playerIndex}`);
      }
    }
    this.#encryptedCards[playerIndex] = privateData.encryptedCells;
    this.#plaintextCards[playerIndex] = privateData.plaintextCells;
  }

  shuffle(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; deck: Ciphertext[]; permutationHash: bigint },
  ) {
    this.assertPhase('Shuffle', 'Game is not in shuffle phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertTurn(playerIndex);
    const signalBigInts = publicSignals.map(s => BigInt(s));
    const transientHashExpected = this.#bingo.shuffleHash(this.deck, this.players);
    const transientHash = signalBigInts.pop()!;
    const permutationHash = signalBigInts.pop()!;
    if (transientHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${transientHash}`);
    }
    this.verifyProof(proof, publicSignals, `shuffle_1_deck_${this.variant}_main`, 'Invalid shuffle proof');
    const deckFromSignals: Ciphertext[] = [];
    for (let i = 0; i < this.#bingo.shoeSize; i++) {
      deckFromSignals.push(signalBigInts.slice(i * 4, i * 4 + 4) as Ciphertext);
    }
    this.shuffledDecks.push({ transientHash, deck: deckFromSignals, permutationHash });
    this.advanceAfterShuffle('Share');
  }

  share(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; ciphertexts: Ciphertext[][] },
    chunkIndex = 0,
  ) {
    this.assertPhase('Share', 'Not in Share phase');
    if (chunkIndex !== this.#nShareChunks - 1) {
      throw new Error(`Share chunk ${chunkIndex} is not open (current ${this.#nShareChunks - 1})`);
    }
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    if (this.#encryptedCards[playerIndex] === undefined) {
      throw new Error(`Player ${playerIndex} must commit a card before sharing partials`);
    }
    const chunk = this.chunkDeck(chunkIndex);
    const expectedInputHash = this.#bingo.shareHash(
      chunk,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );
    const parsed = parseSharePublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedInputHash) {
      throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, 'bingo_share_hashout_main', 'Invalid share partials proof');
    const expectedOutputHash = this.#bingo.computeShareOutputHash(
      privateData.ciphertexts,
      this.numPlayers,
    );
    if (parsed.outHash !== expectedOutputHash) {
      throw new Error(`Output hash mismatch: circuit has ${parsed.outHash}, expected ${expectedOutputHash}`);
    }
    if (this.#partials[playerIndex]![chunkIndex]?.length) {
      throw new Error('Partials are already shared for this player/chunk');
    }
    this.#partials[playerIndex]![chunkIndex] = privateData.ciphertexts;
    const done = this.#partials
      .slice(0, this.numPlayers)
      .every(p => p[chunkIndex]?.length);
    if (done) {
      this.setPhase('Showdown');
    }
  }

  extendShareChunks() {
    if (this.gamePhase !== 'Showdown') {
      throw new Error('Can only extend after the current chunk is fully shared');
    }
    if (this.#nShareChunks >= this.maxShareChunks) {
      throw new Error('No more bingo share chunks');
    }
    this.#nShareChunks += 1;
    this.setPhase('Share');
  }

  getEncryptedCardForPlayer(playerIndex: number): Ciphertext[] {
    const card = this.#encryptedCards[playerIndex];
    if (!card) throw new Error(`Player ${playerIndex} has not committed a card`);
    return card;
  }

  getPlaintextCardForPlayer(playerIndex: number): number[] {
    const card = this.#plaintextCards[playerIndex];
    if (!card) throw new Error(`Player ${playerIndex} has not committed a card`);
    return card;
  }

  getCiphertextPartialsForPlayer(playerIndex: number) {
    const padding = this.padding[playerIndex]!;
    const ciphertextPartials: Ciphertext[][] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (i === playerIndex) continue;
      const row: Ciphertext[] = [];
      for (let chunk = 0; chunk < this.#nShareChunks; chunk++) {
        if (i >= this.numPlayers) {
          row.push(...new Array(BINGO_CHUNK_BALLS).fill(padding));
          continue;
        }
        const index = i > playerIndex ? playerIndex : playerIndex - 1;
        const partials = this.#partials[i]![chunk]?.[index];
        if (!partials) {
          throw new Error(`Player ${i} has not shared chunk ${chunk} for player ${playerIndex}`);
        }
        row.push(...partials);
      }
      while (row.length < this.#bingo.shoeSize) row.push(padding);
      ciphertextPartials.push(row.slice(0, this.#bingo.shoeSize));
    }
    return ciphertextPartials;
  }

  showdownCiphertextCards(): Ciphertext[] {
    const called = this.finalShuffledDeck.slice(0, this.nCalled);
    return this.#bingo.padShowdownBalls(called, this.nCalled);
  }

  verifyShowdown(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey },
  ) {
    if (this.gamePhase !== 'Showdown' && this.gamePhase !== 'Share') {
      throw new Error('Not in Showdown phase');
    }
    if (this.gamePhase === 'Share') {
      throw new Error('Current share chunk is not finished');
    }
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const hashInput: ShowdownHashInput = {
      publicKeys: this.players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.showdownCiphertextCards(),
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
      ciphertextCardCells: this.getEncryptedCardForPlayer(playerIndex),
      nCalled: this.nCalled,
      patternId: this.#patternId,
    };
    const expectedInputHash = this.#bingo.showdownHash(hashInput);
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }
    this.verifyProof(
      proof,
      publicSignals,
      `bingo_showdown_${this.variant}_hashout_main`,
      'Invalid showdown proof',
    );
    this.setPhase('Complete');
    return outputHash;
  }
}
