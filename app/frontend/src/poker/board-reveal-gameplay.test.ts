import { describe, expect, it } from 'vitest';
import { Poker } from '@poker-src/poker';
import { ZkCryptoContext } from '@poker-src/backend/zk-crypto-context';
import { dealCardCount, shareCardMask } from '@poker-src/backend/card-layout';
import type { GameSnapshot } from '../backend/client';
import { decryptDealCards } from './decrypt-deal-cards';
import { isFaceUpCard } from './decrypt-to-faces';
import { snapshotFromServer } from './server-view';
import { Card } from './card';

async function buildFlopReveal() {
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
    partials[sharer] = poker.share(deck, cardMask, others, keys[sharer]!.privateKey, randomness);
  }

  const padding = pks.map((pk) => poker.getPadding(pk));
  const ctx = new ZkCryptoContext(poker, n, pks, padding, partials, deck);
  ctx.markShareComplete();
  ctx.markHolePartialsUnlocked();
  // Flop: only board 20,21,22 revealed (NOT all-public).
  ctx.revealCardIndices([20, 21, 22]);

  const reveal = ctx.partialsForViewer(0);
  return { keys, zkCrypto: ctx.toSnapshot(), reveal };
}

function flopSnapshot(
  zkCrypto: GameSnapshot['zkCrypto'],
  reveal: NonNullable<GameSnapshot['zkReveal']>,
): GameSnapshot {
  return {
    gameId: 'g1',
    backend: 'solana',
    phase: 'Flop',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '10',
    currentBet: '0',
    currentPlayerSeat: 0,
    currentPlayerIndex: 0,
    bettingRoundOpen: true,
    handNumber: 1,
    actionOrder: [0, 1],
    playerIndexBySeat: { 0: 0, 1: 1 },
    boardCards: [20, 21, 22, 23, 24],
    holeCards: { 0: [0, 1], 1: [2, 3] },
    seats: [
      { seat: 0, name: 'Seat 0', publicKey: 'a', playerIndex: 0, chips: '5000', bet: '0', folded: false, active: true },
      { seat: 1, name: 'Seat 1', publicKey: 'b', playerIndex: 1, chips: '5000', bet: '0', folded: false, active: false },
    ],
    pots: [{ amount: '40', lastBet: '0' }],
    zkCrypto,
    zkReveal: {
      revealedCardIndices: reveal.revealedCardIndices,
      newlyRevealed: [],
      allPartialsPublic: false,
      shareComplete: true,
      holePartialsUnlocked: true,
      entries: [],
    },
  };
}

describe('gameplay board reveal (Flop, partial)', () => {
  it('flop board decrypts to faces during betting', { timeout: 30_000 }, async () => {
    const { keys, zkCrypto, reveal } = await buildFlopReveal();

    const decrypted = await decryptDealCards({
      zkCrypto: zkCrypto!,
      partialEntries: reveal.entries,
      privateKey: keys[0]!.privateKey,
      viewerPlayerIndex: 0,
    });

    // Flop board + own holes should decrypt.
    for (const dealIndex of [0, 1, 20, 21, 22]) {
      expect(decrypted.has(dealIndex)).toBe(true);
    }

    const view = snapshotFromServer(flopSnapshot(zkCrypto, reveal), 0, decrypted, null);

    // The three flop cards must be face-up with real faces.
    for (const slot of [0, 1, 2]) {
      expect(isFaceUpCard(view.sharedCards[slot])).toBe(true);
    }
    expect(view.sharedCards.slice(0, 3).map((c) => c.unicode)).toEqual(
      [20, 21, 22].map((dealIndex) => new Card(decrypted.get(dealIndex)!).unicode),
    );
  });
});
