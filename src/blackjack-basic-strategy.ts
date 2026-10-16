import { cardToRank, computeHandValue, rankToHardValue } from './blackjack';

export type BlackjackBasicAction = 'hit' | 'stand' | 'split';

function upcardValue(card: number): number {
  const { value, isAce } = rankToHardValue(cardToRank(card));
  return isAce ? 11 : value;
}

function wouldDoubleHard(total: number, dealer: number): boolean {
  if (total === 9) return dealer >= 3 && dealer <= 6;
  if (total === 10) return dealer >= 2 && dealer <= 9;
  return total === 11 && dealer >= 2 && dealer <= 10;
}

function wouldDoubleSoft(total: number, dealer: number): boolean {
  if (total === 13 || total === 14) return dealer === 5 || dealer === 6;
  if (total === 15 || total === 16) return dealer >= 4 && dealer <= 6;
  if (total === 17) return dealer >= 3 && dealer <= 6;
  return total === 18 && dealer >= 3 && dealer <= 6;
}

export function blackjackBasicStrategy(
  cards: number[],
  dealerUpcard: number,
  handCount: number,
  doubledFallbackTaken = false,
): BlackjackBasicAction {
  if (cards.length === 2 && handCount < 4) {
    const rank = cardToRank(cards[0]!);
    if (rank === cardToRank(cards[1]!) && (rank === 12 || rank === 6)) {
      return 'split';
    }
  }

  if (doubledFallbackTaken) return 'stand';

  const dealer = upcardValue(dealerUpcard);
  const hand = computeHandValue(cards, cards.length);
  const total = hand.bestValue;

  if (hand.isSoft) {
    if (total >= 19) return 'stand';
    if (total === 18) {
      if (wouldDoubleSoft(total, dealer)) return 'hit';
      return dealer === 2 || dealer === 7 || dealer === 8 ? 'stand' : 'hit';
    }
    return 'hit';
  }

  if (total >= 17) return 'stand';
  if (total >= 13) return dealer >= 2 && dealer <= 6 ? 'stand' : 'hit';
  if (total === 12) return dealer >= 4 && dealer <= 6 ? 'stand' : 'hit';
  if (wouldDoubleHard(total, dealer)) return 'hit';
  return 'hit';
}

export function isDoubleFallback(
  cards: number[],
  dealerUpcard: number,
): boolean {
  if (cards.length !== 2) return false;
  const dealer = upcardValue(dealerUpcard);
  const hand = computeHandValue(cards, cards.length);
  return hand.isSoft
    ? wouldDoubleSoft(hand.bestValue, dealer)
    : wouldDoubleHard(hand.bestValue, dealer);
}
