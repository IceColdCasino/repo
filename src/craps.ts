import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import { hash88Bn254 } from './hash-coeffs';
import {
  type Ciphertext,
  type PlaintextCard,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';
import { hashPublicKeys12, hashPublicKeys2, padPublicKeysForShuffle } from './shuffle-common';
import {
  parseBetPublicSignals as parseBetPublicSignalsBase,
  ZkCrypto,
} from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck } from './casino-calc';
import {
  CRAPS_SHOWDOWN_TERMS,
  MAX_CRAPS_BETS,
  evaluateCrapsShowdown,
  padCrapsBets,
  packCrapsBet,
  type CrapsBet,
} from './craps-eval';

export {
  CRAPS_SHOWDOWN_TERMS,
  MAX_CRAPS_BETS,
  evaluateCrapsShowdown,
  padCrapsBets,
  type CrapsBet,
} from './craps-eval';

export { parseSharePublicSignals } from './zk-crypto-base';

export const MAX_PLAYERS = 12;
export const N_DICE = 2;
export const N_FACES = 6;
export const TOTAL_CARDS = N_DICE;
export const N_OTHERS = MAX_PLAYERS - 1;
export const BET_RECIPIENTS = 2;
export { SHARE_PUBLIC_SIGNAL_COUNT } from './zk-crypto-base';
export const BET_ENCRYPTED_LIMBS = BET_RECIPIENTS * MAX_CRAPS_BETS * 4;
export const BET_PUBLIC_SIGNAL_COUNT = 1 + BET_ENCRYPTED_LIMBS;

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
  ciphertextBets: Ciphertext[];
  nActualBets: number;
  phase: number;
  point: number;
}

export function parseBetPublicSignals(publicSignals: string[]) {
  return parseBetPublicSignalsBase(publicSignals, BET_RECIPIENTS, MAX_CRAPS_BETS);
}

export class Craps extends ZkCrypto {
  protected override calcKind = GameKind.Craps;

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, N_FACES);
  }

  /** Two independent dice, each a 6-face identity shoe. */
  get initialDice(): Ciphertext[][] {
    return [0, 1].map(() => [...this.initialDeckCards]);
  }

  override get initialDeck(): Ciphertext[] {
    return this.initialDice.flat();
  }

  generateDiePermutation(): bigint[] {
    return this.generateShufflePermutation(N_FACES);
  }

  generateDieRandomness(): bigint[] {
    return this.generateShuffleRandomness(N_FACES);
  }

  hashPublicKeys(publicKeys: PublicKey[]): bigint {
    return hashPublicKeys12(publicKeys, (inputs) => this.poseidon(inputs));
  }

  hashHouseKeys(publicKeys: PublicKey[]): bigint {
    return hashPublicKeys2(publicKeys, (inputs) => this.poseidon(inputs));
  }

  betHash(publicKey: PublicKey, houseKey: PublicKey, nActualBets: number) {
    return this.calcFr('betHash', {
      publicKey,
      house: houseKey,
      nActualBets,
    });
  }

  showdownHash(hashInput: ShowdownHashInput) {
    const {
      publicKeys,
      playerIndex,
      ciphertextCards,
      ciphertextPartials,
      ciphertextBets,
      nActualBets,
      phase,
      point,
    } = hashInput;
    assert(publicKeys.length === MAX_PLAYERS);
    assert(ciphertextCards.length === TOTAL_CARDS);
    assert(ciphertextPartials.length === N_OTHERS);
    assert(ciphertextBets.length === MAX_CRAPS_BETS);

    return this.calcFr('showdownHash', {
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      bets: ciphertextBets,
      nActualBets,
      phase,
      point,
    });
  }

  hashDiePermutation(permutationMatrix: bigint[]): bigint {
    return this.hashPermutationMatrix(permutationMatrix, N_FACES);
  }

  override shuffleHash(deck: Ciphertext[] | Ciphertext[][], publicKeys: PublicKey[]): bigint {
    const flat = Array.isArray(deck[0]?.[0]) ? (deck as Ciphertext[][]).flat() : deck as Ciphertext[];
    return super.shuffleHash(flat, publicKeys);
  }

  shuffleDie(
    faces: Ciphertext[],
    pkAgg: PublicKey,
    permutationMatrix: bigint[],
    randomness: bigint[],
  ): Ciphertext[] {
    return super.shuffle(faces, [pkAgg], permutationMatrix, randomness).ciphertexts;
  }

  encryptBet(type: number, modifier: number, publicKey: PublicKey, randomness: bigint): Ciphertext {
    const packed = packCrapsBet(type, modifier);
    const point = this.babyjub.mulPointEscalar(this.babyjub.Base8, packed + 1n);
    const plaintext = point.map(p => this.babyjub.F.toObject(p)) as PlaintextCard;
    return this.encrypt(plaintext, publicKey, randomness);
  }

  commitBets(
    bets: CrapsBet[],
    publicKeys: PublicKey[],
    randomness: bigint[][],
  ): Ciphertext[][] {
    assert(publicKeys.length === BET_RECIPIENTS);
    const padded = padCrapsBets(bets);
    return publicKeys.map((pk, p) =>
      padded.map((bet, b) => this.encryptBet(bet[0], bet[1], pk, randomness[p]![b]!)),
    );
  }

  computeShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    const values = this.flattenShareValues(ciphertexts);
    if (values.length !== N_OTHERS * TOTAL_CARDS * 4) {
      throw new Error(
        `Expected ${N_OTHERS * TOTAL_CARDS * 4} BN254 values for share partials hash, got ${values.length}`,
      );
    }
    return this.calcFr('shareOutputHash', { ciphertexts, nActualPlayers });
  }

  computeShowdownOutputHash(results: number[], coefficients: bigint[]): bigint {
    assert(results.length === CRAPS_SHOWDOWN_TERMS);
    assert(coefficients.length === CRAPS_SHOWDOWN_TERMS);
    let h = 0n;
    for (let i = 0; i < CRAPS_SHOWDOWN_TERMS; i++) {
      h += (BigInt(results[i]!) + 1n) * coefficients[i]!;
    }
    return h;
  }

  override decryptCards(
    privateKey: PrivateKey,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): bigint[] {
    return super.decryptCards(privateKey, ciphertextCards, ciphertextPartials, 'die');
  }

  evaluateShowdown(
    bets: CrapsBet[],
    diceValues: number[],
    phase: number,
    point: number,
    nActualBets: number,
  ): number[] {
    return evaluateCrapsShowdown(bets, diceValues, phase, point, nActualBets);
  }
}
