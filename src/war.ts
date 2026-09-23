import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import { hash176Bn254 } from './hash-coeffs';
import {
  type Ciphertext,
  type PublicKey,
} from './zk-casino';
import { hashRowValues } from './poseidon-chunk';
import { ZkCrypto } from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck } from './casino-calc';

export const MAX_PLAYERS = 12;
export const SHOE_SIZE = 6 * 52;
export const TOTAL_CARDS = 4;
export const N_OTHERS = MAX_PLAYERS - 1;

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
}

/// Rank 0..12 (2=0, 3=1, ..., Ace=12) — matches CardToRank in war_card.circom.
export function cardToWarRank(cardIndex: number): number {
  if (cardIndex < 0 || cardIndex >= SHOE_SIZE) {
    throw new Error(`Invalid shoe card index: ${cardIndex}`);
  }
  return cardIndex % 13;
}

/// 0 = player, 1 = dealer, 2 = tie — matches EvaluateHands in war_hand_eval.circom.
export function evaluateWar(cards: number[]): 0 | 1 | 2 {
  if (cards.length !== TOTAL_CARDS) {
    throw new Error(`Expected ${TOTAL_CARDS} cards, got ${cards.length}`);
  }

  const values = cards.map(cardToWarRank);
  const playerRank = values[0]!;
  const dealerRank = values[1]!;

  if (playerRank !== dealerRank) {
    return playerRank > dealerRank ? 0 : 1;
  }

  const warPlayerRank = values[2]!;
  const warDealerRank = values[3]!;

  if (warPlayerRank === warDealerRank) {
    return 2;
  }
  return warPlayerRank > warDealerRank ? 0 : 1;
}

export class War extends ZkCrypto {
  protected override calcKind = GameKind.War;

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, 52, 6);
  }

  override generateShufflePermutation(numCards: number = SHOE_SIZE): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(numCards: number = SHOE_SIZE): bigint[] {
    return super.generateShuffleRandomness(numCards);
  }

  /// Matches HashPublicKeys in circuits/hash.circom (10 or 12 players).
  hashPublicKeys(publicKeys: PublicKey[]): bigint {
    const nPlayers = publicKeys.length;
    assert(nPlayers === 10 || nPlayers === 12, `Expected 10 or 12 public keys, got ${nPlayers}`);

    const split = nPlayers / 2;
    const flat = publicKeys.flat(2);
    const hashChunk1 = this.poseidon(flat.slice(0, split * 2));
    const hashChunk2 = this.poseidon(flat.slice(split * 2, nPlayers * 2));
    return this.poseidon([hashChunk1, hashChunk2]);
  }

  override shareHash(
    ciphertext: Ciphertext[],
    publicKey: PublicKey,
    publicKeys: PublicKey[],
  ) {
    return this.calcFr('shareHash', {
      deck: ciphertext,
      publicKey,
      publicKeys,
    });
  }

  showdownHash(hashInput: ShowdownHashInput) {
    const { publicKeys, playerIndex, ciphertextCards, ciphertextPartials } = hashInput;
    const nPlayers = publicKeys.length;
    const nOthers = nPlayers - 1;

    assert(publicKeys.length === nPlayers);
    assert(ciphertextCards.length === TOTAL_CARDS);
    assert(ciphertextPartials.length === nOthers);
    assert(ciphertextPartials.every(cp => cp.length === TOTAL_CARDS));

    return this.calcFr('showdownHash', {
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
    });
  }

  /// Matches HashPermutationMatrixSixDeck in circuits/shuffle.circom.
  hashPermutationMatrixSixDeck(permutationMatrix: bigint[]): bigint {
    const nCards = SHOE_SIZE;
    const rowValues: bigint[] = [];
    for (let i = 0; i < nCards; i++) {
      const row = permutationMatrix.slice(i * nCards, (i + 1) * nCards);
      rowValues.push(this.bits2num(row));
    }

    const deckHashes: bigint[] = [];
    for (let d = 0; d < 6; d++) {
      deckHashes.push(hashRowValues(rowValues.slice(d * 52, (d + 1) * 52), (inputs) => this.poseidon(inputs)));
    }

    return this.poseidon(deckHashes);
  }

  hashDeck(deck: Ciphertext[]): bigint {
    return this.hashCiphertexts(deck);
  }

  override shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ) {
    const { ciphertexts } = super.shuffle(deck, publicKeys, permutationMatrix, randomness);
    return {
      ciphertexts,
      permutationHash: this.hashPermutationMatrixSixDeck(permutationMatrix),
    };
  }

  computeRegisterOutputHash(publicKey: PublicKey, padding: Ciphertext): bigint {
    return this.poseidon([...publicKey, ...padding]);
  }

  computeShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    const values = this.flattenShareValues(ciphertexts);

    if (values.length !== N_OTHERS * TOTAL_CARDS * 4) {
      throw new Error(
        `Expected ${N_OTHERS * TOTAL_CARDS * 4} BN254 values for share partials hash, got ${values.length}`
      );
    }

    return this.calcFr('shareOutputHash', { ciphertexts, nActualPlayers });
  }

  computeShowdownOutputHash(winner: bigint, coefficient: bigint): bigint {
    return (winner + 1n) * coefficient;
  }

  evaluateOutcome(plaintextCards: bigint[]): 0 | 1 | 2 {
    return evaluateWar(plaintextCards.map(c => Number(c)));
  }
}
