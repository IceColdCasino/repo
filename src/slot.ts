import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import { hash12Bn254, hash20Bn254 } from './hash-coeffs';
import {
  type Ciphertext,
  type PlaintextCard,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';
import { hashPublicKeys2 } from './shuffle-common';
import { ZkCrypto } from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck } from './casino-calc';
import {
  evaluateFiveReelStops,
  evaluateThreeReelStops,
} from './slot-eval';

export type SlotVariant = 3 | 5;

export const MAX_PLAYERS = 2;
export const N_STOPS = 22;
export const N_OTHERS = 1;
export const SHARE_PUBLIC_SIGNAL_COUNT = 10;
/** Fused share circuit requires coinBet ∈ {1,2,3}. House uses 1; it is not a wager. */
export const HOUSE_SHARE_COIN_DUMMY = 1;

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
  ciphertextBet: Ciphertext;
}

export function parseSlotSharePublicSignals(publicSignals: string[]): {
  outHash: bigint;
  encryptedBets: Ciphertext[];
  inputHash: bigint;
} {
  const signals = publicSignals.map(s => BigInt(s));
  if (signals.length !== SHARE_PUBLIC_SIGNAL_COUNT) {
    throw new Error(
      `Expected ${SHARE_PUBLIC_SIGNAL_COUNT} slot share public signals, got ${signals.length}`,
    );
  }
  const outHash = signals[0]!;
  const encryptedBets: Ciphertext[] = [
    signals.slice(1, 5) as Ciphertext,
    signals.slice(5, 9) as Ciphertext,
  ];
  return { outHash, encryptedBets, inputHash: signals[9]! };
}

export class Slot extends ZkCrypto {
  readonly nReels: SlotVariant;
  protected override calcKind = GameKind.Slots;

  constructor(nReels: SlotVariant) {
    super();
    assert(nReels === 3 || nReels === 5, `Invalid slot reel count ${nReels}`);
    this.nReels = nReels;
  }

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, N_STOPS);
  }

  /** Independent identity strips, one per reel. */
  get initialReels(): Ciphertext[][] {
    return Array.from({ length: this.nReels }, () => [...this.initialDeckCards]);
  }

  override get initialDeck(): Ciphertext[] {
    return this.initialReels.flat();
  }

  generateReelPermutation(): bigint[] {
    return this.generateShufflePermutation(N_STOPS);
  }

  generateReelRandomness(): bigint[] {
    return this.generateShuffleRandomness(N_STOPS);
  }

  override shareHash(ciphertext: Ciphertext[], publicKey: PublicKey, publicKeys: PublicKey[]) {
    return this.calcFr('shareHash', {
      deck: ciphertext,
      publicKey,
      publicKeys,
    });
  }

  showdownHash(hashInput: ShowdownHashInput) {
    const { publicKeys, playerIndex, ciphertextCards, ciphertextPartials, ciphertextBet } = hashInput;
    assert(publicKeys.length === MAX_PLAYERS);
    assert(ciphertextCards.length === this.nReels);
    assert(ciphertextPartials.length === N_OTHERS);

    return this.calcFr('showdownHash', {
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      ciphertextBet,
    });
  }

  hashReelPermutation(permutationMatrix: bigint[]): bigint {
    return this.hashPermutationMatrix(permutationMatrix, N_STOPS);
  }

  hashIndependentPermutations(matrices: bigint[][]): bigint {
    return this.poseidon(matrices.map(m => this.hashReelPermutation(m)));
  }

  override shuffleHash(deck: Ciphertext[] | Ciphertext[][], publicKeys: PublicKey[]): bigint {
    assert(publicKeys.length === MAX_PLAYERS);
    const flat = Array.isArray(deck[0]?.[0]) ? (deck as Ciphertext[][]).flat() : deck as Ciphertext[];
    return super.shuffleHash(flat, publicKeys);
  }

  shuffleReel(
    stops: Ciphertext[],
    pkAgg: PublicKey,
    permutationMatrix: bigint[],
    randomness: bigint[],
  ): Ciphertext[] {
    return super.shuffle(stops, [pkAgg], permutationMatrix, randomness).ciphertexts;
  }

  /** BabyPbk(coinBet) — no +1; coinBet ∈ {1,2,3}. */
  encryptCoinBet(coinBet: number, publicKey: PublicKey, randomness: bigint): Ciphertext {
    if (coinBet !== 1 && coinBet !== 2 && coinBet !== 3) {
      throw new Error(`coinBet must be 1, 2, or 3, got ${coinBet}`);
    }
    const point = this.babyjub.mulPointEscalar(this.babyjub.Base8, BigInt(coinBet));
    const plaintext = point.map(p => this.babyjub.F.toObject(p)) as PlaintextCard;
    return this.encrypt(plaintext, publicKey, randomness);
  }

  commitCoinBet(
    coinBet: number,
    publicKeys: PublicKey[],
    randomness: bigint[],
  ): Ciphertext[] {
    assert(publicKeys.length === MAX_PLAYERS);
    return publicKeys.map((pk, p) => this.encryptCoinBet(coinBet, pk, randomness[p]!));
  }

  computeShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    const values = this.flattenShareValues(ciphertexts);
    const expected = N_OTHERS * this.nReels * 4;
    if (values.length !== expected) {
      throw new Error(`Expected ${expected} BN254 values for slot share hash, got ${values.length}`);
    }
    return this.calcFr('shareOutputHash', {
      ciphertexts,
      nActualPlayers,
      nReels: this.nReels,
    });
  }

  computeShowdownOutputHash(payout: number, coefficient: bigint): bigint {
    return (BigInt(payout) + 1n) * coefficient;
  }

  override decryptCards(
    privateKey: PrivateKey,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): bigint[] {
    return super.decryptCards(privateKey, ciphertextCards, ciphertextPartials, 'reel stop');
  }

  evaluatePayout(centers: number[], coinBet: number): number {
    return this.nReels === 3
      ? evaluateThreeReelStops(centers, coinBet)
      : evaluateFiveReelStops(centers, coinBet);
  }
}
