import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import { hash44Bn254 } from './hash-coeffs';
import {
  type Ciphertext,
  type PlaintextCard,
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

export type RouletteVariant = 37 | 38;

export const MAX_PLAYERS = 12;
export const MAX_BETS = 12;
export const TOTAL_CARDS = 1;
export const N_OTHERS = MAX_PLAYERS - 1;
export const BET_RECIPIENTS = 2;
/** ShareHashOut(12, 1): public hash + outHash. Bets are a separate 2-key circuit. */
export { SHARE_PUBLIC_SIGNAL_COUNT } from './zk-crypto-base';
export { parseSharePublicSignals } from './zk-crypto-base';
export const BET_ENCRYPTED_LIMBS = BET_RECIPIENTS * MAX_BETS * 4;
export const BET_PUBLIC_SIGNAL_COUNT = 1 + BET_ENCRYPTED_LIMBS;

/** Bet as [type, modifier] matching PackBet / ConstrainBet*. */
export type RouletteBet = readonly [type: number, modifier: number];

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
  ciphertextBets: Ciphertext[];
  nActualBets: number;
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACK = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);

export function packBet(type: number, modifier: number): bigint {
  return BigInt(type) + BigInt(modifier) * 16n;
}

/**
 * Circom `UniqueActualBets`: each (type, modifier) pair must appear at most once.
 * Matches PackBet — packed = type + modifier * 16.
 */
export function assertUniqueBets(bets: RouletteBet[]): void {
  const seen = new Set<bigint>();
  for (const [type, modifier] of bets) {
    const packed = packBet(type, modifier);
    if (seen.has(packed)) {
      throw new Error(
        `Duplicate roulette bet type=${type} modifier=${modifier} (packed=${packed})`,
      );
    }
    seen.add(packed);
  }
}

/**
 * Placement rules matching Circom `ConstrainBetEU` / `ConstrainBetUS`.
 * Row (type 1) is US/38-only.
 */
export function assertValidRouletteBet(
  type: number,
  modifier: number,
  deckSize: RouletteVariant,
): void {
  if (!Number.isInteger(type) || type < 0 || type > 11) {
    throw new Error(`Invalid roulette bet type ${type}`);
  }
  if (!Number.isInteger(modifier) || modifier < 0) {
    throw new Error(`Invalid roulette bet modifier ${modifier}`);
  }
  if (type === 1) {
    if (deckSize !== 38) {
      throw new Error('Row bet (type 1) is only available on US/38 roulette');
    }
    if (modifier !== 0) {
      throw new Error('Row bet requires modifier 0');
    }
    return;
  }
  const maxMod: Record<number, number> = {
    0: deckSize === 38 ? 37 : 36, // straight up inclusive
    2: 56,
    3: 11,
    4: 21,
    5: 0,
    6: 10,
    7: 2,
    8: 2,
    9: 1,
    10: 1,
    11: 1,
  };
  const max = maxMod[type];
  if (max === undefined) {
    throw new Error(`Invalid roulette bet type ${type}`);
  }
  if (modifier > max) {
    throw new Error(
      `Roulette bet type=${type} modifier=${modifier} out of range for deck ${deckSize} (max ${max})`,
    );
  }
}

export function assertValidRouletteBets(
  bets: RouletteBet[],
  deckSize: RouletteVariant,
): void {
  for (const [type, modifier] of bets) {
    assertValidRouletteBet(type, modifier, deckSize);
  }
  assertUniqueBets(bets);
}

/**
 * Pad to MAX_BETS with valid dummy straight-up-0 (required by ConstrainBet*).
 * Uniqueness applies only to the caller-supplied prefix; pad slots may repeat.
 * Idempotent when `bets.length === MAX_BETS` (already padded).
 */
export function padBets(
  bets: RouletteBet[],
  deckSize: RouletteVariant,
): RouletteBet[] {
  if (bets.length === MAX_BETS) {
    for (const [type, modifier] of bets) {
      assertValidRouletteBet(type, modifier, deckSize);
    }
    return bets.map(b => [b[0], b[1]] as const);
  }
  assertValidRouletteBets(bets, deckSize);
  const out: RouletteBet[] = bets.map(b => [b[0], b[1]] as const);
  while (out.length < MAX_BETS) out.push([0, 0]);
  return out.slice(0, MAX_BETS);
}

function splitLow(m: number): number {
  if (m < 24) {
    const j = m % 12;
    const r = (m - j) / 12;
    return 3 * j + 1 + r;
  }
  const t = m - 24;
  const j = t % 11;
  const r = (t - j) / 11;
  return 3 * j + 1 + r;
}

function splitHigh(m: number): number {
  if (m < 24) {
    const j = m % 12;
    const r = (m - j) / 12;
    return 3 * j + 2 + r;
  }
  const t = m - 24;
  const j = t % 11;
  const r = (t - j) / 11;
  return 3 * j + 4 + r;
}

function cornerPockets(m: number): number[] {
  const j = m % 11;
  const r = Math.floor((m - j) / 11);
  return [3 * j + 1 + r, 3 * j + 2 + r, 3 * j + 4 + r, 3 * j + 5 + r];
}

/** Payout multiplier (0 on loss) matching circuits/roulette_eval.circom EvaluateBet. */
export function evaluateBet(
  type: number,
  modifier: number,
  winner: number,
  deckSize: RouletteVariant,
): number {
  const isZero = winner === 0;
  const isDoubleZero = deckSize === 38 && winner === 37;

  switch (type) {
    case 0: // straight up
      return winner === modifier ? 35 : 0;
    case 1: // row US: 0 and 00 (placement forbid is ConstrainBetEU at share)
      if (deckSize !== 38) return 0;
      return isZero || isDoubleZero ? 17 : 0;
    case 2: { // split
      return winner === splitLow(modifier) || winner === splitHigh(modifier) ? 17 : 0;
    }
    case 3: { // street
      const base = 3 * modifier + 1;
      return winner >= base && winner <= base + 2 ? 11 : 0;
    }
    case 4: // corner
      return cornerPockets(modifier).includes(winner) ? 8 : 0;
    case 5: // top line
      if (deckSize === 37) {
        return winner >= 0 && winner <= 3 ? 8 : 0;
      }
      return isZero || isDoubleZero || (winner >= 1 && winner <= 3) ? 6 : 0;
    case 6: { // double street
      const lo = 3 * modifier + 1;
      return winner >= lo && winner <= lo + 5 ? 5 : 0;
    }
    case 7: // column
      if (isZero || isDoubleZero) return 0;
      return (winner - 1) % 3 === modifier ? 2 : 0;
    case 8: { // dozen
      if (isZero || isDoubleZero) return 0;
      const dozen = Math.floor((winner - 1) / 12);
      return dozen === modifier ? 2 : 0;
    }
    case 9: // even/odd
      if (isZero || isDoubleZero) return 0;
      return (winner % 2 === 0 ? 0 : 1) === modifier ? 1 : 0;
    case 10: // red/black
      if (isZero || isDoubleZero) return 0;
      if (modifier === 0) return RED.has(winner) ? 1 : 0;
      return BLACK.has(winner) ? 1 : 0;
    case 11: // half
      if (isZero || isDoubleZero) return 0;
      if (modifier === 0) return winner >= 1 && winner <= 18 ? 1 : 0;
      return winner >= 19 && winner <= 36 ? 1 : 0;
    default:
      return 0;
  }
}

export function evaluateBets(
  bets: RouletteBet[],
  winner: number,
  deckSize: RouletteVariant,
  nActualBets: number,
): number[] {
  const padded = padBets(bets, deckSize);
  return padded.map((bet, i) =>
    i < nActualBets ? evaluateBet(bet[0], bet[1], winner, deckSize) : 0,
  );
}

export function parseBetPublicSignals(publicSignals: string[]) {
  return parseBetPublicSignalsBase(publicSignals, BET_RECIPIENTS, MAX_BETS);
}

export class Roulette extends ZkCrypto {
  readonly deckSize: RouletteVariant;

  constructor(deckSize: RouletteVariant) {
    super();
    assert(deckSize === 37 || deckSize === 38, `Invalid roulette deckSize ${deckSize}`);
    this.deckSize = deckSize;
    this.calcKind = GameKind.Roulette;
    this.calcVariant = deckSize;
  }

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, this.deckSize, 1, this.calcVariant);
  }

  override generateShufflePermutation(numCards: number = this.deckSize): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(numCards: number = this.deckSize): bigint[] {
    return super.generateShuffleRandomness(numCards);
  }

  override shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ) {
    assert(deck.length === this.deckSize, `Expected deck of ${this.deckSize}, got ${deck.length}`);
    return super.shuffle(deck, publicKeys, permutationMatrix, randomness);
  }

  hashPublicKeys(publicKeys: PublicKey[]): bigint {
    const nPlayers = publicKeys.length;
    assert(nPlayers === 12, `Expected 12 public keys, got ${nPlayers}`);
    return hashPublicKeys12(publicKeys, (inputs) => this.poseidon(inputs));
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
    const nPlayers = publicKeys.length;
    const nOthers = nPlayers - 1;

    assert(publicKeys.length === nPlayers);
    assert(ciphertextCards.length === TOTAL_CARDS);
    assert(ciphertextPartials.length === nOthers);
    assert(ciphertextPartials.every(cp => cp.length === TOTAL_CARDS));
    assert(ciphertextBets.length === MAX_BETS);

    return this.calcFr('showdownHash', {
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      bets: ciphertextBets,
      nActualBets,
    });
  }

  /** Encrypt packed bet under publicKey — matches CommitBet. */
  encryptBet(
    type: number,
    modifier: number,
    publicKey: PublicKey,
    randomness: bigint,
  ): Ciphertext {
    const packed = packBet(type, modifier);
    const point = this.babyjub.mulPointEscalar(this.babyjub.Base8, packed + 1n);
    const plaintext = point.map(p => this.babyjub.F.toObject(p)) as PlaintextCard;
    return this.encrypt(plaintext, publicKey, randomness);
  }

  commitBets(
    bets: RouletteBet[],
    publicKeys: PublicKey[],
    randomness: bigint[][],
  ): Ciphertext[][] {
    assert(publicKeys.length === BET_RECIPIENTS);
    const padded = padBets(bets, this.deckSize);
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

  computeShowdownOutputHash(payouts: number[], coefficients: bigint[]): bigint {
    assert(payouts.length === MAX_BETS);
    assert(coefficients.length === MAX_BETS);
    let h = 0n;
    for (let i = 0; i < MAX_BETS; i++) {
      h += (BigInt(payouts[i]!) + 1n) * coefficients[i]!;
    }
    return h;
  }
}
