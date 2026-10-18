/** Playwright helper — mirrors app/frontend/src/poker/card.ts unicode encoding. */
const RANKS = '23456789TJQKA';
const SUITS = ['spade', 'heart', 'diamond', 'club'] as const;
const SUIT_LABELS = ['spades', 'hearts', 'diamonds', 'clubs'] as const;

export function cardUnicode(cardIndex: number): string {
  if (cardIndex < 0 || cardIndex >= 52) {
    return '1F0A0';
  }
  const rank = cardIndex % 13;
  const suit = Math.floor(cardIndex / 13);
  const rankOffset = rank === 12 ? -1 : rank + Number(rank < 12 && rank > 9);
  const code = 0x1f0a2 + 0x10 * suit + rankOffset;
  return code.toString(16).toUpperCase();
}

export const FACE_DOWN_UNICODE = '1F0A0';

export function unicodeToCardIndex(unicode: string): number | null {
  if (unicode.toUpperCase() === FACE_DOWN_UNICODE) {
    return null;
  }
  const code = Number.parseInt(unicode, 16);
  if (!Number.isFinite(code)) {
    return null;
  }
  for (let index = 0; index < 52; index += 1) {
    if (cardUnicode(index) === unicode.toUpperCase()) {
      return index;
    }
  }
  return null;
}

export function suitNameFromUnicode(unicode: string): (typeof SUITS)[number] | '' {
  const index = unicodeToCardIndex(unicode);
  if (index === null) {
    return '';
  }
  return SUITS[Math.floor(index / 13)]!;
}

export function cardRankSuitLabel(unicode: string): string {
  if (unicode.toUpperCase() === FACE_DOWN_UNICODE) {
    return 'face-down';
  }
  const index = unicodeToCardIndex(unicode);
  if (index === null) {
    return `unknown(${unicode})`;
  }
  const rank = RANKS[index % 13]!;
  const suit = SUIT_LABELS[Math.floor(index / 13)]!;
  return `${rank} of ${suit}`;
}

export function cardShortLabel(unicode: string): string {
  if (unicode.toUpperCase() === FACE_DOWN_UNICODE) {
    return 'down';
  }
  const index = unicodeToCardIndex(unicode);
  if (index === null) {
    return '?';
  }
  const rank = RANKS[index % 13]!;
  const suitChar = ['S', 'H', 'D', 'C'][Math.floor(index / 13)]!;
  return `${rank}${suitChar}`;
}
