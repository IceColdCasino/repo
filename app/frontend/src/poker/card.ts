const suits = ['spade', 'heart', 'diamond', 'club'];
const ranks = '23456789TJQKA'.split('');

const SUIT_HTML_ENTITIES: Record<(typeof suits)[number], string> = {
  spade: '&spades;',
  heart: '&hearts;',
  diamond: '&diams;',
  club: '&clubs;',
};

export class Card {
  index: number;

  constructor(index: number) {
    if (index < 0 || index >= suits.length * ranks.length || !Number.isInteger(index)) {
      throw new Error('Invalid card index');
    }

    this.index = index;
  }

  get suit() {
    return Math.floor(this.index / ranks.length);
  }

  get rank() {
    return this.index % ranks.length;
  }

  get suitName() {
    return suits[this.suit];
  }

  get unicode() {
    const rank = this.rank;
    const rankOffset = rank === 12 ? -1 : rank + Number(rank < 12 && rank > 9);
    const suitOffset = 0x10 * this.suit;

    const code = 0x1F0A2 + suitOffset + rankOffset;
    return code.toString(16).toUpperCase();
  }

  toString() {
    return `${ranks[this.rank]}${suits[this.suit]}`;
  }

  /** Rank + suit entity for HTML winner breakdowns (e.g. `A&spades;`). */
  toHtmlLabel() {
    return `${ranks[this.rank]}${SUIT_HTML_ENTITIES[this.suitName as (typeof suits)[number]]}`;
  }
}

export function cardHtmlLabel(index: number): string {
  return new Card(index).toHtmlLabel();
}

/** SVG `<text>` cannot render HTML entities; use Unicode suit glyphs instead. */
export function htmlCardLabelToSvgText(label: string): string {
  return label
    .replaceAll('&hearts;', '♥')
    .replaceAll('&spades;', '♠')
    .replaceAll('&clubs;', '♣')
    .replaceAll('&diams;', '♦');
}
