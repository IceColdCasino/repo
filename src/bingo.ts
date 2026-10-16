import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import {
  type Ciphertext,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';
import { hashPublicKeys12 } from './shuffle-common';
import { ZkCrypto } from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck, casinoFr, casinoShareBalls } from './casino-calc';
import { showdownTwoCoeffHash } from './showdown-sealed-coeffs';
import {
  BINGO_75_CELLS,
  BINGO_75_SHOE,
  BINGO_90_CELLS,
  BINGO_90_SHOE,
  BINGO_CHUNK_BALLS,
  evaluateBingo75,
  evaluateBingo90,
  packBingo90Prizes,
  type BingoPattern75,
} from './bingo-eval';

export { parseSharePublicSignals } from './zk-crypto-base';

export {
  BINGO_75_CELLS,
  BINGO_75_SHOE,
  BINGO_90_CELLS,
  BINGO_90_SHOE,
  BINGO_CHUNK_BALLS,
  evaluateBingo75,
  evaluateBingo90,
  sampleBingo75Card,
  sampleBingo90Card,
  BingoPattern75,
} from './bingo-eval';

export const MAX_PLAYERS = 12;
export const N_OTHERS = MAX_PLAYERS - 1;
export { SHARE_PUBLIC_SIGNAL_COUNT } from './zk-crypto-base';
// Uncalled shoe slots still run PartialDecrypt, which rejects the identity (c0.x = 0).
// Base8 is a real curve point, so those slots can be padded without a new proving key.
const BABYJUB_BASE8_X = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const BABYJUB_BASE8_Y = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;
export const PAD_CIPHERTEXT = [BABYJUB_BASE8_X, BABYJUB_BASE8_Y, BABYJUB_BASE8_X, BABYJUB_BASE8_Y] as Ciphertext;

export type BingoVariant = 75 | 90;

export function bingoCells(variant: BingoVariant): number {
  return variant === 75 ? BINGO_75_CELLS : BINGO_90_CELLS;
}

export function bingoCardPublicSignalCount(variant: BingoVariant): number {
  return bingoCells(variant) * 4 + 1;
}

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
  ciphertextCardCells: Ciphertext[];
  nCalled: number;
  patternId?: number;
  sealCommitment: bigint;
}

export function parseCardPublicSignals(publicSignals: string[], variant: BingoVariant): {
  encryptedCells: Ciphertext[];
  inputHash: bigint;
} {
  const nCells = bingoCells(variant);
  const expected = bingoCardPublicSignalCount(variant);
  const signals = publicSignals.map(s => BigInt(s));
  if (signals.length !== expected) {
    throw new Error(`Expected ${expected} card public signals, got ${signals.length}`);
  }
  const encryptedCells: Ciphertext[] = [];
  let offset = 0;
  for (let i = 0; i < nCells; i++) {
    encryptedCells.push(signals.slice(offset, offset + 4) as Ciphertext);
    offset += 4;
  }
  return { encryptedCells, inputHash: signals[offset]! };
}

export class Bingo extends ZkCrypto {
  readonly variant: BingoVariant;
  readonly shoeSize: number;
  readonly nCells: number;

  constructor(variant: BingoVariant = 75) {
    super();
    this.variant = variant;
    this.shoeSize = variant === 75 ? BINGO_75_SHOE : BINGO_90_SHOE;
    this.nCells = bingoCells(variant);
    this.calcKind = GameKind.Bingo;
    this.calcVariant = this.shoeSize;
  }

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, this.shoeSize, 1, this.calcVariant);
  }

  override generateShufflePermutation(numCards: number = this.shoeSize): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(numCards: number = this.shoeSize): bigint[] {
    return super.generateShuffleRandomness(numCards);
  }

  override shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ) {
    assert(deck.length === this.shoeSize, `Expected deck of ${this.shoeSize}, got ${deck.length}`);
    return super.shuffle(deck, publicKeys, permutationMatrix, randomness);
  }

  cardHash(publicKey: PublicKey) {
    return this.calcFr('cardHash', { publicKey, nCells: this.nCells });
  }

  override shareHash(
    ciphertext: Ciphertext[],
    publicKey: PublicKey,
    publicKeys: PublicKey[],
  ): bigint {
    return this.calcFr('shareHash', {
      deck: ciphertext,
      publicKey,
      publicKeys,
    });
  }

  showdownHash(hashInput: ShowdownHashInput) {
    const {
      publicKeys,
      playerIndex,
      ciphertextCards,
      ciphertextPartials,
      ciphertextCardCells,
      nCalled,
      patternId,
    } = hashInput;
    assert(publicKeys.length === MAX_PLAYERS);
    assert(ciphertextCards.length === this.shoeSize);
    assert(ciphertextPartials.length === N_OTHERS);
    assert(ciphertextCardCells.length === this.nCells);

    return this.calcFr('showdownHash', {
      sealCommitment: hashInput.sealCommitment,
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      ciphertextCardCells,
      nCalled,
      ...(this.variant === 75 ? { patternId: patternId ?? 0 } : {}),
    });
  }

  commitCard(cells: number[], publicKey: PublicKey, randomness: bigint[]): Ciphertext[] {
    assert(cells.length === this.nCells);
    return cells.map((cell, i) => this.encryptScalar(cell, publicKey, randomness[i]!));
  }

  computeShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    return this.shareBallCommitment(ciphertexts, nActualPlayers).finalHash;
  }

  /**
   * One hash per ball (every recipient's partials for that ball), then Poseidon
   * of the five ball hashes. A called ball can be checked without the rest of
   * the five-ball window.
   */
  shareBallCommitment(ciphertexts: Ciphertext[][], nActualPlayers: number): { finalHash: bigint; balls: bigint[] } {
    const values = this.flattenShareValues(ciphertexts);
    if (values.length !== N_OTHERS * BINGO_CHUNK_BALLS * 4) {
      throw new Error(
        `Expected ${N_OTHERS * BINGO_CHUNK_BALLS * 4} BN254 values for bingo share, got ${values.length}`,
      );
    }
    if (nActualPlayers < 2 || nActualPlayers > MAX_PLAYERS) {
      throw new Error(`nActualPlayers must be 2..${MAX_PLAYERS}, got ${nActualPlayers}`);
    }
    const commitment = casinoShareBalls(this.calcKind, { ciphertexts, nActualPlayers }, this.calcVariant);
    if (commitment.balls.length !== BINGO_CHUNK_BALLS) {
      throw new Error(`Expected ${BINGO_CHUNK_BALLS} ball hashes, got ${commitment.balls.length}`);
    }
    return commitment;
  }

  ballShareHash(column: Ciphertext[]): bigint {
    if (column.length !== N_OTHERS) {
      throw new Error(`Expected ${N_OTHERS} recipient partials for one ball, got ${column.length}`);
    }
    return casinoFr(this.calcKind, 'ballShareHash', { column }, this.calcVariant);
  }

  padShowdownBalls(called: Ciphertext[], nCalled: number): Ciphertext[] {
    const out = called.slice(0, nCalled);
    while (out.length < this.shoeSize) out.push(PAD_CIPHERTEXT);
    return out;
  }

  padShowdownPartials(partials: Ciphertext[][], nCalled: number, padding: Ciphertext): Ciphertext[][] {
    return partials.map((row) => {
      const out = row.slice(0, nCalled);
      while (out.length < this.shoeSize) out.push(padding);
      return out;
    });
  }

  computeShowdownOutputHash75(packed: number, coefficients: readonly bigint[]): bigint {
    return showdownTwoCoeffHash(BigInt(packed), coefficients);
  }

  computeShowdownOutputHash90(packed: number[], coefficients: readonly bigint[]): bigint {
    if (packed.length !== 3) {
      throw new Error(`Expected 3 bingo 90 prizes, got ${packed.length}`);
    }
    const prize = packBingo90Prizes(packed[0]!, packed[1]!, packed[2]!);
    return showdownTwoCoeffHash(BigInt(prize), coefficients);
  }

  override decryptCards(
    privateKey: PrivateKey,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    nCalled: number | string = 'bingo ball',
  ): bigint[] {
    if (typeof nCalled === 'number') {
      return super.decryptCards(
        privateKey,
        ciphertextCards.slice(0, nCalled),
        ciphertextPartials,
        'bingo ball',
      );
    }
    return super.decryptCards(privateKey, ciphertextCards, ciphertextPartials, nCalled);
  }

  evaluate(
    cells: number[],
    balls: number[],
    nCalled: number,
    patternId: BingoPattern75 = 0,
  ) {
    if (this.variant === 75) {
      return evaluateBingo75(cells, balls, nCalled, patternId);
    }
    return evaluateBingo90(cells, balls, nCalled);
  }
}
