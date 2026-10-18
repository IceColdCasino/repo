import { describe, expect, it } from 'vitest';
import { Poker } from '@poker-src/poker';
import { ZkCryptoContext } from '@poker-src/backend/zk-crypto-context';
import { dealCardCount, shareCardMask } from '@poker-src/backend/card-layout';
import type { GameSnapshot } from '../backend/client';
import { decryptDealCards } from './decrypt-deal-cards';
import { FACE_DOWN_UNICODE, isFaceUpCard, tableShowsDecryptedFaces } from './decrypt-to-faces';
import { snapshotFromServer } from './server-view';
import { Card } from './card';

/**
 * Builds the same reveal payload shape the Solana worker returns from
 * GET /api/game/revealed-partials/:seat after markAllPartialsPublic().
 */
async function buildWorkerShapedShowdownPartials() {
  const poker = new Poker();
  await poker.init();
  const n = 2;
  const keys = [poker.generatePlayerKey(0), poker.generatePlayerKey(1)];
  const pks = keys.map((key) => key.publicKey);
  const nCards = dealCardCount();
  let deck = poker.initialDeck.slice(0, nCards);
  deck = poker.shuffle(
    deck,
    pks,
    poker.generateShufflePermutation(nCards),
    poker.generateShuffleRandomness(nCards),
  ).ciphertexts;
  deck = poker.shuffle(
    deck,
    pks,
    poker.generateShufflePermutation(nCards),
    poker.generateShuffleRandomness(nCards),
  ).ciphertexts;

  const cardMask = shareCardMask(n);
  const partials: Awaited<ReturnType<typeof poker.share>>[] = [];
  for (let sharer = 0; sharer < n; sharer += 1) {
    const others = pks.filter((_, index) => index !== sharer);
    const randomness = others.map(() =>
      Array.from({ length: nCards }, () => poker.getRandom()),
    );
    partials[sharer] = poker.share(
      deck,
      cardMask,
      others,
      keys[sharer]!.privateKey,
      randomness,
    );
  }

  const padding = pks.map((pk) => poker.getPadding(pk));
  const ctx = new ZkCryptoContext(poker, n, pks, padding, partials, deck);
  ctx.markShareComplete();
  ctx.markHolePartialsUnlocked();
  ctx.markAllPartialsPublic();

  const reveal = ctx.partialsForViewer(0);
  // Showdown must not publish unused empty-seat deal slots (4–19 for 2p).
  expect(reveal.revealedCardIndices).toEqual([0, 1, 2, 3, 20, 21, 22, 23, 24]);
  expect(reveal.entries.every((entry) => {
    const idx = entry.cardIndex;
    return (idx >= 0 && idx <= 3) || (idx >= 20 && idx <= 24);
  })).toBe(true);
  return {
    keys,
    zkCrypto: ctx.toSnapshot(),
    reveal,
  };
}

function completeSnapshot(
  zkCrypto: GameSnapshot['zkCrypto'],
  reveal: NonNullable<GameSnapshot['zkReveal']>,
): GameSnapshot {
  return {
    gameId: 'g1',
    backend: 'solana',
    phase: 'Complete',
    dealerSeat: 0,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    handNumber: 1,
    actionOrder: [0, 1],
    playerIndexBySeat: { 0: 0, 1: 1 },
    boardCards: [20, 21, 22, 23, 24],
    holeCards: { 0: [0, 1], 1: [2, 3] },
    seats: [
      {
        seat: 0,
        name: 'Seat 0',
        publicKey: 'a',
        playerIndex: 0,
        chips: '5020',
        bet: '0',
        folded: false,
        active: false,
      },
      {
        seat: 1,
        name: 'Seat 1',
        publicKey: 'b',
        playerIndex: 1,
        chips: '4980',
        bet: '0',
        folded: false,
        active: false,
      },
    ],
    pots: [{ amount: '30', lastBet: '0' }],
    zkCrypto,
    // Broadcast snapshot omits entries — UI must use fetchRevealedPartials.
    zkReveal: {
      revealedCardIndices: reveal.revealedCardIndices,
      newlyRevealed: [],
      allPartialsPublic: true,
      shareComplete: true,
      holePartialsUnlocked: true,
      entries: [],
    },
    handResult: {
      handNumber: 1,
      reason: 'showdown',
      potResults: [{ potIndex: 0, amount: '30', winnerSeats: [0] }],
      boardCards: [20, 21, 22, 23, 24],
      seatHands: [
        { seat: 0, playerIndex: 0, name: 'Seat 0', folded: false, holeCards: [0, 1] },
        { seat: 1, playerIndex: 1, name: 'Seat 1', folded: false, holeCards: [2, 3] },
      ],
      actionOrder: [0, 1],
      zkFinalDeck: zkCrypto!.finalDeck,
      handNumPlayers: 2,
    },
  };
}

const resultView = {
  handNumber: 1,
  reason: 'showdown',
  pots: [{
    potIndex: 0,
    amount: 30,
    winners: [{ seat: 0, name: 'Seat 0', wonAmount: 30 }],
  }],
  seats: [
    { seat: 0, name: 'Seat 0', folded: false, wonAmount: 30 },
    { seat: 1, name: 'Seat 1', folded: false, wonAmount: 0 },
  ],
};

describe('worker partials → face rendering', () => {
  it(
    'without decrypt map, Complete showdown paints 1F0A0 backs (the live bug)',
    async () => {
    const { zkCrypto, reveal } = await buildWorkerShapedShowdownPartials();
    expect(reveal.entries.length).toBeGreaterThan(0);
    expect(reveal.allPartialsPublic).toBe(true);

    const view = snapshotFromServer(
      completeSnapshot(zkCrypto, reveal),
      0,
      undefined,
      resultView,
    );

    expect(view.sharedCards.every((card) => card.unicode === FACE_DOWN_UNICODE)).toBe(true);
    expect(view.sharedCards.every((card) => !card.flipped)).toBe(true);
    expect(tableShowsDecryptedFaces(view, { holeSeats: [0, 1] })).toBe(false);
  },
    30_000,
  );

  it(
    'fetched worker-shaped partials decrypt into face-up unicode ≠ back',
    async () => {
    const { keys, zkCrypto, reveal } = await buildWorkerShapedShowdownPartials();

    // Mirror Poker.svelte: fetchRevealedPartials entries → decryptDealCards → snapshotFromServer
    const decrypted = await decryptDealCards({
      zkCrypto: zkCrypto!,
      partialEntries: reveal.entries,
      privateKey: keys[0]!.privateKey,
      viewerPlayerIndex: 0,
    });

    expect(decrypted.size).toBe(9);
    for (const dealIndex of [0, 1, 2, 3, 20, 21, 22, 23, 24]) {
      expect(decrypted.has(dealIndex)).toBe(true);
    }

    const view = snapshotFromServer(
      completeSnapshot(zkCrypto, reveal),
      0,
      decrypted,
      resultView,
    );

    expect(tableShowsDecryptedFaces(view, { holeSeats: [0, 1] })).toBe(true);
    for (const card of view.sharedCards) {
      expect(isFaceUpCard(card)).toBe(true);
      expect(card.unicode).not.toBe(FACE_DOWN_UNICODE);
    }
    expect(view.sharedCards.map((card) => card.unicode)).toEqual(
      [20, 21, 22, 23, 24].map((dealIndex) => new Card(decrypted.get(dealIndex)!).unicode),
    );
    expect(view.playerCards[0]?.map((card) => card.unicode)).toEqual(
      [0, 1].map((dealIndex) => new Card(decrypted.get(dealIndex)!).unicode),
    );
    expect(view.playerCards[1]?.map((card) => card.unicode)).toEqual(
      [2, 3].map((dealIndex) => new Card(decrypted.get(dealIndex)!).unicode),
    );
  },
    30_000,
  );
});
