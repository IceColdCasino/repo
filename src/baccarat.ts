import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import { hash264Bn254 } from './hash-coeffs';
import {
  type Ciphertext,
  type PublicKey,
} from './zk-casino';
import { ZkCrypto } from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck } from './casino-calc';

export const MAX_PLAYERS = 12;
export const TOTAL_CARDS = 6;
export const N_OTHERS = MAX_PLAYERS - 1;

const BACCARAT_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 0, 1] as const;

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
}

export function cardToBaccaratRank(card: number): number {
  if (card < 0 || card > 51) {
    throw new Error(`Invalid card index: ${card}`);
  }
  return BACCARAT_RANKS[card % 13]!;
}

function mod10Sum2(a: number, b: number): number {
  const sum = a + b;
  return sum >= 10 ? sum - 10 : sum;
}

/// 0 = player, 1 = dealer, 2 = tie — matches EvaluateHands in baccarat_hand_eval.circom.
export function evaluateBaccarat(cards: number[]): 0 | 1 | 2 {
  if (cards.length !== TOTAL_CARDS) {
    throw new Error(`Expected ${TOTAL_CARDS} cards, got ${cards.length}`);
  }

  const values = cards.map(cardToBaccaratRank);
  const playerTotal2 = mod10Sum2(values[0]!, values[1]!);
  const dealerTotal2 = mod10Sum2(values[2]!, values[3]!);

  const playerNatural = playerTotal2 > 7;
  const dealerNatural = dealerTotal2 > 7;
  const natural = playerNatural || dealerNatural;

  const playerDraws = !natural && playerTotal2 <= 5;
  const playerStood = !natural && !playerDraws;
  const dealerDrawsWhenPlayerStood = playerStood && dealerTotal2 <= 5;

  const playerThird = values[4]!;
  let dealerDrawsAfterPlayerDraw = false;
  if (!natural && playerDraws) {
    if (dealerTotal2 <= 2) {
      dealerDrawsAfterPlayerDraw = true;
    } else if (dealerTotal2 === 3 && playerThird !== 8) {
      dealerDrawsAfterPlayerDraw = true;
    } else if (dealerTotal2 === 4 && playerThird >= 2 && playerThird <= 7) {
      dealerDrawsAfterPlayerDraw = true;
    } else if (dealerTotal2 === 5 && playerThird >= 4 && playerThird <= 7) {
      dealerDrawsAfterPlayerDraw = true;
    } else if (dealerTotal2 === 6 && playerThird >= 6 && playerThird <= 7) {
      dealerDrawsAfterPlayerDraw = true;
    }
  }

  const dealerDraws = dealerDrawsWhenPlayerStood || dealerDrawsAfterPlayerDraw;
  const dealerThird = playerDraws ? values[5]! : values[4]!;

  let playerFinal = playerDraws ? mod10Sum2(playerTotal2, values[4]!) : playerTotal2;
  let dealerFinal = dealerDraws ? mod10Sum2(dealerTotal2, dealerThird) : dealerTotal2;

  if (natural) {
    playerFinal = playerTotal2;
    dealerFinal = dealerTotal2;
  }

  if (playerFinal === dealerFinal) {
    return 2;
  }
  return dealerFinal > playerFinal ? 1 : 0;
}

export class Baccarat extends ZkCrypto {
  protected override calcKind = GameKind.Baccarat;

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, 52);
  }

  override generateShufflePermutation(numCards: number = 52): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(numCards: number = 52): bigint[] {
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

  override shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ) {
    return super.shuffle(deck, publicKeys, permutationMatrix, randomness, 52);
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
    return evaluateBaccarat(plaintextCards.map(c => Number(c)));
  }
}
