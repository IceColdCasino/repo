import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import { hash880Bn254 } from './hash-coeffs';
import {
  type Ciphertext,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';
import { hashPublicKeys12, hashPublicKeys2 } from './shuffle-common';
import {
  parseBetPublicSignals as parseBetPublicSignalsBase,
  ZkCrypto,
} from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck } from './casino-calc';
import {
  KENO_DRAW,
  KENO_SHOE_SIZE,
  MAX_KENO_SPOTS,
  evaluateKeno,
  padKenoSpots,
} from './keno-eval';

export { parseSharePublicSignals } from './zk-crypto-base';

export {
  KENO_DRAW,
  KENO_SHOE_SIZE,
  MAX_KENO_SPOTS,
  evaluateKeno,
  padKenoSpots,
} from './keno-eval';

export const MAX_PLAYERS = 12;
export const TOTAL_CARDS = KENO_DRAW;
export const N_OTHERS = MAX_PLAYERS - 1;
export const BET_RECIPIENTS = 2;
export { SHARE_PUBLIC_SIGNAL_COUNT } from './zk-crypto-base';
export const BET_ENCRYPTED_LIMBS = BET_RECIPIENTS * MAX_KENO_SPOTS * 4;
export const BET_PUBLIC_SIGNAL_COUNT = 1 + BET_ENCRYPTED_LIMBS;

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
  ciphertextBets: Ciphertext[];
  nActualBets: number;
}

export function parseBetPublicSignals(publicSignals: string[]) {
  return parseBetPublicSignalsBase(publicSignals, BET_RECIPIENTS, MAX_KENO_SPOTS);
}

export class Keno extends ZkCrypto {
  protected override calcKind = GameKind.Keno;

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, KENO_SHOE_SIZE);
  }

  override generateShufflePermutation(numCards: number = KENO_SHOE_SIZE): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(numCards: number = KENO_SHOE_SIZE): bigint[] {
    return super.generateShuffleRandomness(numCards);
  }

  override shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ) {
    assert(deck.length === KENO_SHOE_SIZE, `Expected deck of ${KENO_SHOE_SIZE}, got ${deck.length}`);
    return super.shuffle(deck, publicKeys, permutationMatrix, randomness);
  }

  override shareHash(ciphertext: Ciphertext[], publicKey: PublicKey, publicKeys: PublicKey[]) {
    return this.calcFr('shareHash', {
      deck: ciphertext,
      publicKey,
      publicKeys,
    });
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
    } = hashInput;
    assert(publicKeys.length === MAX_PLAYERS);
    assert(ciphertextCards.length === TOTAL_CARDS);
    assert(ciphertextPartials.length === N_OTHERS);
    assert(ciphertextBets.length === MAX_KENO_SPOTS);

    return this.calcFr('showdownHash', {
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      bets: ciphertextBets,
      nActualBets,
    });
  }

  commitSpots(
    spots: number[],
    publicKeys: PublicKey[],
    randomness: bigint[][],
  ): Ciphertext[][] {
    assert(publicKeys.length === BET_RECIPIENTS);
    const padded = padKenoSpots(spots);
    return publicKeys.map((pk, p) =>
      padded.map((spot, b) => this.encryptScalar(spot, pk, randomness[p]![b]!)),
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

  computeShowdownOutputHash(matches: number, coefficient: bigint): bigint {
    return (BigInt(matches) + 1n) * coefficient;
  }

  override decryptCards(
    privateKey: PrivateKey,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): bigint[] {
    return super.decryptCards(privateKey, ciphertextCards, ciphertextPartials, 'keno number');
  }
}
