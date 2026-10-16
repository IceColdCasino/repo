import type { BabyJub } from 'circomlibjs';
import assert from 'node:assert';
import {
  type Ciphertext,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';
import { ZkCrypto } from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck, casinoFr, casinoShareCards } from './casino-calc';
import { showdownTwoCoeffHash } from './showdown-sealed-coeffs';

export const MAX_SEATS = 8;
export const MAX_PLAYERS = 7;
export const SHOE_SIZE = 6 * 52;
export const MAX_SHARE_CARDS = 290;
// Matches circuits/blackjack_share_hashout_main.circom BlackjackShareHashOut(8, 16).
export const CHUNK_SHARE_CARDS = 16;
export const N_SHARE_CHUNKS = Math.ceil(MAX_SHARE_CARDS / CHUNK_SHARE_CARDS);
export const N_OTHERS = MAX_SEATS - 1;
export const CHUNK_SHARE_POLY_TERMS = N_OTHERS * CHUNK_SHARE_CARDS * 4;
export const MAX_HANDS = 4; // max 3 splits → 4 hands (game layout)
export const MAX_CARDS_PER_HAND = 11;
export const MAX_DEALER_CARDS = 13;
export const MAX_PLAYER_CARDS = MAX_HANDS * MAX_CARDS_PER_HAND; // 44 (layout only)
/** Production showdown decrypts one hand + dealer. */
export const MAX_SHOWDOWN_CARDS = MAX_CARDS_PER_HAND + MAX_DEALER_CARDS; // 24
export const SENTINEL_CARD = 312;

export function maxCardsForPlayers(nPlayers: number): number {
  return nPlayers * MAX_HANDS * MAX_CARDS_PER_HAND + MAX_DEALER_CARDS;
}

export function chunksForPlayers(nPlayers: number): number {
  return Math.ceil(maxCardsForPlayers(nPlayers) / CHUNK_SHARE_CARDS);
}

/**
 * Number of share chunks for `nSeats` (players + dealer).
 * Base 2 chunks (32 cards ≥ 24 showdown); scales 1:1 with seats; cap N_SHARE_CHUNKS.
 */
export function shareChunksForSeats(nSeats: number): number {
  return Math.max(2, Math.min(N_SHARE_CHUNKS, nSeats));
}

export function paddedShareChunk(shareDeck: Ciphertext[], chunkIndex: number): Ciphertext[] {
  const offset = chunkIndex * CHUNK_SHARE_CARDS;
  const chunk = shareDeck.slice(offset, offset + CHUNK_SHARE_CARDS);
  const padding = shareDeck[0];
  if (!padding) throw new Error('Cannot pad empty share deck');
  while (chunk.length < CHUNK_SHARE_CARDS) chunk.push(padding);
  return chunk;
}
export const OUTCOME_COUNT = MAX_PLAYERS * MAX_HANDS;

/// Per-hand result vs dealer: 0=lose, 1=push, 2=win, 3=player natural blackjack
export type HandOutcome = 0 | 1 | 2 | 3;

/// Per-action status: 0=can hit, 1=bust (skip showdown), 2=can split, 3=twenty-one (needs showdown)
export type BlackjackActionStatus = 0 | 1 | 2 | 3;

/// Dealer action status: 0=must hit, 1=bust, 2=natural blackjack, 3=must stand
export type BlackjackDealerActionStatus = 0 | 1 | 2 | 3;

export interface ShowdownHashInput {
  publicKeys: PublicKey[];
  playerIndex: bigint;
  ciphertextCards: Ciphertext[];
  ciphertextPartials: Ciphertext[][];
  playerCardCount: number;
  dealerCardCount: number;
  sealCommitment: bigint;
}

export interface BlackjackHandLayout {
  playerHandCards: number[][][];
  playerHandLengths: number[][];
  playerHandSourceIndices: number[][][];
  dealerCards: number[];
  dealerCardCount: number;
  dealerSourceIndices: number[];
}

export function cardToRank(cardIndex: number): number {
  if (cardIndex < 0 || cardIndex >= SHOE_SIZE) {
    throw new Error(`Invalid shoe card index: ${cardIndex}`);
  }
  return cardIndex % 13;
}

export function rankToHardValue(rank: number): { value: number; isAce: boolean } {
  const isAce = rank === 12;
  if (isAce) return { value: 1, isAce: true };
  if (rank >= 8) return { value: 10, isAce: false };
  return { value: rank + 2, isAce: false };
}

export function computeHandValue(cards: number[], cardCount: number) {
  let hardSum = 0;
  let aceCount = 0;

  for (let i = 0; i < cardCount; i++) {
    const { value, isAce } = rankToHardValue(cardToRank(cards[i]!));
    hardSum += value;
    if (isAce) aceCount++;
  }

  const softSum = hardSum + 10;
  const softOk = aceCount > 0 && softSum <= 21;
  const bestValue = softOk ? softSum : hardSum;
  const isBust = bestValue > 21 ? 1 : 0;
  const isBlackjack = cardCount === 2 && bestValue === 21 && !isBust ? 1 : 0;
  const isSoft = softOk ? 1 : 0;

  return { bestValue, isBust, isBlackjack, isSoft };
}

/// 0=lose, 1=push, 2=win, 3=player natural blackjack (dealer non-BJ)
export function compareHandToDealer(
  player: { bestValue: number; isBust: number; isBlackjack: number },
  dealer: { bestValue: number; isBust: number; isBlackjack: number },
): 0 | 1 | 2 | 3 {
  if (player.isBust) return 0;
  if (player.isBlackjack && dealer.isBlackjack) return 1;
  if (player.isBlackjack && !dealer.isBlackjack) return 3;
  // Dealer natural beats any non-BJ hand, including made 21.
  if (dealer.isBlackjack) return 0;
  if (dealer.isBust) return 2;
  if (player.bestValue > dealer.bestValue) return 2;
  if (player.bestValue === dealer.bestValue) return 1;
  return 0;
}

export function isPair(cards: number[], cardCount: number): boolean {
  return cardCount === 2 && cardToRank(cards[0]!) === cardToRank(cards[1]!);
}

export function evaluateBlackjackActionStatus(
  cards: number[],
  cardCount: number,
  canSplit: boolean,
): BlackjackActionStatus {
  const hand = computeHandValue(cards, cardCount);
  if (hand.isBust) return 1;
  if (hand.bestValue === 21) return 3;
  if (canSplit && isPair(cards, cardCount)) return 2;
  return 0;
}

/** True when action status settles the hand without a showdown proof. */
export function actionStatusSkipsShowdown(status: BlackjackActionStatus): boolean {
  return status === 1;
}

/**
 * Dealer house rules. `hitSoft17`: false = S17 (stand soft 17), true = H17.
 * Natural blackjack is reported only on the initial two-card deal.
 */
export function evaluateBlackjackDealerActionStatus(
  cards: number[],
  cardCount: number,
  hitSoft17: boolean,
): BlackjackDealerActionStatus {
  const hand = computeHandValue(cards, cardCount);
  if (hand.isBlackjack) return 2;
  if (hand.isBust) return 1;
  const isSoft17 = hand.isSoft === 1 && hand.bestValue === 17;
  if (hand.bestValue < 17 || (hitSoft17 && isSoft17)) return 0;
  return 3;
}

/** Dealer bust still requires showdown for surviving player hands. */
export function dealerActionStatusTerminal(status: BlackjackDealerActionStatus): boolean {
  return status === 1 || status === 2 || status === 3;
}

export interface BlackjackActionHandLayout {
  sourceIndices: number[];
  stayed: boolean;
}

export class BlackjackActionLayout {
  readonly hands: BlackjackActionHandLayout[] = [];
  activeHandIndex = 0;

  constructor(readonly maxSplits = 3) {}

  startHand(_player: number, sourceIndices: number[]) {
    this.hands.length = 0;
    this.hands.push({ sourceIndices: [...sourceIndices], stayed: false });
    this.activeHandIndex = 0;
  }

  hitHand(handIndex: number, sourceIndex: number) {
    const hand = this.hands[handIndex];
    if (!hand) throw new Error(`Invalid hand index ${handIndex}`);
    hand.sourceIndices.push(sourceIndex);
  }

  stayHand(handIndex: number) {
    const hand = this.hands[handIndex];
    if (!hand) throw new Error(`Invalid hand index ${handIndex}`);
    hand.stayed = true;
    if (this.activeHandIndex === handIndex) this.activeHandIndex++;
  }

  splitHand(handIndex: number, firstDrawSourceIndex: number, secondDrawSourceIndex: number) {
    if (this.hands.length > this.maxSplits) throw new Error('Maximum splits reached');
    const hand = this.hands[handIndex];
    if (!hand) throw new Error(`Invalid hand index ${handIndex}`);
    if (hand.sourceIndices.length !== 2) throw new Error('Only two-card hands can split');

    const [left, right] = hand.sourceIndices;
    const splitHands = [
      { sourceIndices: [left!, firstDrawSourceIndex], stayed: false },
      { sourceIndices: [right!, secondDrawSourceIndex], stayed: false },
    ];
    this.hands.splice(handIndex, 1, ...splitHands);
    this.activeHandIndex = handIndex;
    return splitHands;
  }
}

export function emptyHandLayout(): BlackjackHandLayout {
  const playerHandCards = Array.from({ length: MAX_PLAYERS }, () =>
    Array.from({ length: MAX_HANDS }, () =>
      new Array(MAX_CARDS_PER_HAND).fill(SENTINEL_CARD)));
  const playerHandLengths = Array.from({ length: MAX_PLAYERS }, () =>
    new Array(MAX_HANDS).fill(0));
  const playerHandSourceIndices = Array.from({ length: MAX_PLAYERS }, () =>
    Array.from({ length: MAX_HANDS }, () =>
      new Array(MAX_CARDS_PER_HAND).fill(0)));
  return {
    playerHandCards,
    playerHandLengths,
    playerHandSourceIndices,
    dealerCards: new Array(MAX_DEALER_CARDS).fill(SENTINEL_CARD),
    dealerCardCount: 0,
    dealerSourceIndices: new Array(MAX_DEALER_CARDS).fill(0),
  };
}

export function evaluateBlackjackTable(layout: BlackjackHandLayout): HandOutcome[][] {
  const dealer = computeHandValue(layout.dealerCards, layout.dealerCardCount);
  const outcomes: HandOutcome[][] = [];

  for (let p = 0; p < MAX_PLAYERS; p++) {
    const row: HandOutcome[] = [];
    for (let h = 0; h < MAX_HANDS; h++) {
      const len = layout.playerHandLengths[p]![h]!;
      const handActive = len > 0 ? 1 : 0;
      if (!handActive) {
        row.push(0);
        continue;
      }
      const player = computeHandValue(layout.playerHandCards[p]![h]!, len);
      row.push((compareHandToDealer(player, dealer) * handActive) as HandOutcome);
    }
    outcomes.push(row);
  }

  return outcomes;
}

export function flattenOutcomes(outcomes: HandOutcome[][]): HandOutcome[] {
  const flat = outcomes.flat();
  if (flat.length !== OUTCOME_COUNT) {
    throw new Error(`Expected ${OUTCOME_COUNT} outcomes, got ${flat.length}`);
  }
  return flat;
}

/// h = sum((outcome[i] + 1) * coefficients[i]) — matches ShowdownHashOut in circom.
export function computeOutcomesPolynomialHash(
  outcomes: HandOutcome[],
  coefficients: bigint[],
): bigint {
  if (outcomes.length !== OUTCOME_COUNT) {
    throw new Error(`Expected ${OUTCOME_COUNT} outcomes, got ${outcomes.length}`);
  }
  if (coefficients.length !== OUTCOME_COUNT) {
    throw new Error(`Expected ${OUTCOME_COUNT} coefficients, got ${coefficients.length}`);
  }

  let hash = 0n;
  for (let i = 0; i < OUTCOME_COUNT; i++) {
    hash += (BigInt(outcomes[i]!) + 1n) * coefficients[i]!;
  }
  return hash;
}

export class Blackjack extends ZkCrypto {
  protected override calcKind = GameKind.Blackjack;
  readonly shoeDecks: 1 | 6 | 8;

  constructor(shoeDecks: 1 | 6 | 8 = 6) {
    super();
    this.shoeDecks = shoeDecks;
  }

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, 52, this.shoeDecks);
  }

  override generateShufflePermutation(numCards: number = SHOE_SIZE): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(numCards: number = SHOE_SIZE): bigint[] {
    return super.generateShuffleRandomness(numCards);
  }

  hashPublicKeys(publicKeys: PublicKey[]): bigint {
    const nPlayers = publicKeys.length;
    assert(nPlayers === 8 || nPlayers === 10 || nPlayers === 12,
      `Expected 8, 10, or 12 public keys, got ${nPlayers}`);

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
    const {
      publicKeys,
      playerIndex,
      ciphertextCards,
      ciphertextPartials,
      playerCardCount,
      dealerCardCount,
    } = hashInput;
    const nPlayers = publicKeys.length;
    const nOthers = nPlayers - 1;

    assert(publicKeys.length === nPlayers);
    assert(ciphertextCards.length > 0);
    assert(ciphertextPartials.length === nOthers);
    assert(ciphertextPartials.every(cp => cp.length === ciphertextCards.length));

    return this.calcFr('showdownHash', {
      sealCommitment: hashInput.sealCommitment,
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      playerCardCount,
      dealerCardCount,
    });
  }

  /**
   * Matches BlackjackActionHashMain:
   * Poseidon(h1, h2, upcardHash, cardCount, canSplit, hitSoft17, isDealer,
   * insuranceEligible, sealCommitment).
   * Player: isDealer=0, hitSoft17=0. Dealer: isDealer=1, canSplit=0.
   * insuranceEligible is 1 exactly when the dealer upcard is an Ace.
   * The public output is the sealed polynomial of the action status.
   * Dealer status 2 is a natural blackjack.
   */
  actionHashMaterial(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): { h1: bigint; h2: bigint } {
    assert(ciphertextPartials.length === publicKeys.length - 1);
    const h1 = this.hashPublicKeys(publicKeys);
    const h2 = this.poseidon([
      this.hashCiphertexts(ciphertextCards),
      ...ciphertextPartials.map(cp => this.hashCiphertexts(cp)),
    ]);
    return { h1, h2 };
  }

  /** Poseidon of the dealer upcard ciphertext and each other seat's partial. */
  upcardHash(upcard: Ciphertext, partials: Ciphertext[]): bigint {
    return this.poseidon([
      this.hashCiphertexts([upcard]),
      ...partials.map((partial) => this.hashCiphertexts([partial])),
    ]);
  }

  actionHash(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    cardCount: number,
    opts: {
      canSplit?: boolean;
      hitSoft17?: boolean;
      isDealer?: boolean;
      upcard: Ciphertext;
      upcardPartials: Ciphertext[];
      insuranceEligible: boolean;
      sealCommitment: bigint;
    },
  ) {
    const nPlayers = publicKeys.length;
    const nOthers = nPlayers - 1;
    assert(ciphertextPartials.length === nOthers);
    assert(opts.upcardPartials.length === nOthers);
    const isDealer = opts.isDealer ?? false;
    const canSplit = isDealer ? false : (opts.canSplit ?? false);
    const hitSoft17 = isDealer ? (opts.hitSoft17 ?? false) : false;

    return this.calcFr('actionHash', {
      publicKeys,
      cards: ciphertextCards,
      partials: ciphertextPartials,
      cardCount,
      canSplit,
      hitSoft17,
      isDealer,
      upcard: opts.upcard,
      upcardPartials: opts.upcardPartials,
      insuranceEligible: opts.insuranceEligible,
      sealCommitment: opts.sealCommitment,
    });
  }

  evaluateDealerActionStatus(
    cards: number[],
    cardCount: number,
    hitSoft17: boolean,
  ): BlackjackDealerActionStatus {
    return evaluateBlackjackDealerActionStatus(cards, cardCount, hitSoft17);
  }

  hashDeck(deck: Ciphertext[]): bigint {
    return this.hashCiphertexts(deck);
  }

  computeShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    return this.computeChunkShareOutputHash(ciphertexts, nActualPlayers);
  }

  computeChunkShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    return this.shareCardCommitment(ciphertexts, nActualPlayers).finalHash;
  }

  /**
   * One hash per card (every recipient's partials for that card), then the
   * folded public output. The initial deal is two cards per seat, so one card
   * of the pair can be checked without the other.
   */
  shareCardCommitment(ciphertexts: Ciphertext[][], nActualPlayers: number): { finalHash: bigint; cards: bigint[] } {
    const values = this.flattenShareValues(ciphertexts);
    if (values.length !== CHUNK_SHARE_POLY_TERMS) {
      throw new Error(
        `Expected ${CHUNK_SHARE_POLY_TERMS} BN254 values for chunk share hash, got ${values.length}`,
      );
    }
    if (nActualPlayers < 2 || nActualPlayers > MAX_SEATS) {
      throw new Error(`nActualPlayers must be 2..${MAX_SEATS}, got ${nActualPlayers}`);
    }
    const commitment = casinoShareCards(this.calcKind, { ciphertexts, nActualPlayers });
    if (commitment.cards.length !== CHUNK_SHARE_CARDS) {
      throw new Error(`Expected ${CHUNK_SHARE_CARDS} card hashes, got ${commitment.cards.length}`);
    }
    return commitment;
  }

  cardShareHash(column: Ciphertext[]): bigint {
    if (column.length !== N_OTHERS) {
      throw new Error(`Expected ${N_OTHERS} recipient partials for one card, got ${column.length}`);
    }
    return casinoFr(this.calcKind, 'cardShareHash', { column });
  }

  shareChunk(
    ciphertext: Ciphertext[],
    publicKeys: PublicKey[],
    privateKey: PrivateKey,
    randomness: bigint[][],
  ) {
    return this.share(ciphertext, publicKeys, privateKey, randomness);
  }

  computeShowdownOutputHash(outcomes: HandOutcome[], coefficients: bigint[]): bigint {
    return computeOutcomesPolynomialHash(outcomes, coefficients);
  }

  computePlayerShowdownOutputHash(outcome: HandOutcome, coefficients: readonly bigint[]): bigint {
    return showdownTwoCoeffHash(BigInt(outcome), coefficients);
  }

  /**
   * Source indices for one-hand showdown (dense):
   * player used cards || dealer used cards || pad to MAX_SHOWDOWN_CARDS.
   */
  oneHandShowdownSourceIndices(
    layout: BlackjackHandLayout,
    playerIndex: number,
    handIndex: number,
  ): number[] {
    const len = layout.playerHandLengths[playerIndex]![handIndex]!;
    if (len <= 0) throw new Error(`Hand ${handIndex} for player ${playerIndex} is empty`);
    const sourceIndices: number[] = [];
    for (let c = 0; c < len; c++) {
      sourceIndices.push(layout.playerHandSourceIndices[playerIndex]![handIndex]![c]!);
    }
    for (let d = 0; d < layout.dealerCardCount; d++) {
      sourceIndices.push(layout.dealerSourceIndices[d]!);
    }
    while (sourceIndices.length < MAX_SHOWDOWN_CARDS) {
      sourceIndices.push(0);
    }
    return sourceIndices;
  }

  generateShowdownCoefficients(): bigint[] {
    const coefficients: bigint[] = [];
    for (let i = 0; i < OUTCOME_COUNT; i++) {
      let coeff = this.getRandom(128);
      while (coeff === 0n) coeff = this.getRandom(128);
      coefficients.push(coeff);
    }
    return coefficients;
  }

  evaluateActionStatus(cards: number[], cardCount: number, canSplit: boolean): BlackjackActionStatus {
    return evaluateBlackjackActionStatus(cards, cardCount, canSplit);
  }

  evaluateOutcomes(layout: BlackjackHandLayout): HandOutcome[] {
    return flattenOutcomes(evaluateBlackjackTable(layout));
  }
}
