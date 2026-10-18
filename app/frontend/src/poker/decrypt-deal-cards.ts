import { dealCardCount } from '@poker-src/backend/card-layout';
import { ciphertextFromJson } from '@poker-src/backend/zk-serialize';
import type { Ciphertext } from '@poker-src/zk-casino';
import type { ZkCryptoSnapshot, ZkRevealedPartialEntry } from '../backend/client';
import type { Poker } from '@poker-src/poker';
import { decryptDeal, hasPlayerBridge } from './player-bridge';

let fallbackPoker: Promise<Poker> | null = null;

async function getJsFallbackPoker(): Promise<Poker> {
  if (!fallbackPoker) {
    fallbackPoker = (async () => {
      const { Poker } = await import('@poker-src/poker');
      const poker = new Poker();
      await poker.init();
      return poker;
    })();
  }
  return fallbackPoker;
}

export interface DecryptDealCardsParams {
  zkCrypto: ZkCryptoSnapshot;
  partialEntries: ZkRevealedPartialEntry[];
  privateKey: bigint;
  viewerPlayerIndex: number;
  /** When set, only these deal-layout indices are decrypted (street paint). */
  onlyDealIndices?: number[];
}

export async function decryptDealCards(params: DecryptDealCardsParams): Promise<Map<number, number>> {
  const { zkCrypto, partialEntries, privateKey, viewerPlayerIndex, onlyDealIndices } = params;
  const handNumPlayers = zkCrypto.handNumPlayers;
  const dealCards = zkCrypto.dealCardCount ?? dealCardCount(handNumPlayers);
  const finalDeck = zkCrypto.finalDeck.map((card) => ciphertextFromJson(card));
  const wanted = onlyDealIndices ? new Set(onlyDealIndices) : null;

  const byCard = new Map<number, ZkRevealedPartialEntry[]>();
  for (const entry of partialEntries) {
    if (entry.toPlayerIndex !== viewerPlayerIndex || entry.fromPlayerIndex === viewerPlayerIndex) {
      continue;
    }
    if (wanted && !wanted.has(entry.cardIndex)) {
      continue;
    }
    const list = byCard.get(entry.cardIndex) ?? [];
    list.push(entry);
    byCard.set(entry.cardIndex, list);
  }

  const result = new Map<number, number>();
  const dealIndices: number[] = [];
  const cards: Ciphertext[] = [];
  const partials: Ciphertext[][] = [];
  for (let dealIndex = 0; dealIndex < dealCards; dealIndex += 1) {
    if (wanted && !wanted.has(dealIndex)) {
      continue;
    }
    const entries = byCard.get(dealIndex);
    if (!entries || entries.length !== handNumPlayers - 1) {
      continue;
    }
    const ciphertext = finalDeck[dealIndex];
    if (!ciphertext) {
      continue;
    }
    dealIndices.push(dealIndex);
    cards.push(ciphertext);
    partials.push(entries.map((entry) => ciphertextFromJson(entry.ciphertext)));
  }
  if (dealIndices.length === 0) {
    return result;
  }

  if (hasPlayerBridge()) {
    try {
      const indices = await decryptDeal(privateKey, cards, partials);
      for (let i = 0; i < dealIndices.length; i += 1) {
        const cardValue = indices[i]!;
        if (cardValue >= 0) {
          result.set(dealIndices[i]!, cardValue);
        }
      }
    } catch {
      // Partials may be incomplete or invalid until the reveal catches up.
    }
    return result;
  }

  const poker = await getJsFallbackPoker();
  for (let i = 0; i < dealIndices.length; i += 1) {
    try {
      const cardValue = poker.decryptFromPartials(privateKey, cards[i]!, partials[i]!);
      if (cardValue >= 0) {
        result.set(dealIndices[i]!, cardValue);
      }
    } catch {
      // Partials may be incomplete or invalid until the reveal catches up.
    }
    if (i < dealIndices.length - 1) {
      await Promise.resolve();
    }
  }

  return result;
}
