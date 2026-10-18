const ranks = '23456789TJQKA'.split('');
const suits = 'SHDC'.split('');

export function toCardIndex(abbrev: string) {
  const [rank, suit] = abbrev.split('');

  return 13 * suits.indexOf(suit) + ranks.indexOf(rank);
}

export type EvaluatedHand = number[];

export const handTypes = ['highCard', 'onePair', 'twoPair', 'threeOfAKind', 'straight', 'flush', 'fullHouse', 'fourOfAKind', 'straightFlush' ];

export interface CardFrequencies {
  ranks: Map<number, number>;
  suits?: Map<number, number>;
}

function zeroFilltoSeven(arr: number[]) {
  return [
    ...arr,
    ...new Array(7 - arr.length).fill(0),
  ];
}

export class HandEvaluator {
  calculateFrequencies(cards: number[]): CardFrequencies {
    const initial: CardFrequencies = {
      ranks: new Map<number, number>(),
      suits: new Map<number, number>(),
    };

    return cards.reduce((acc, val) => {
      const [rank, suit] = [val % 13, Math.floor(val / 13)];
      acc.ranks.set(rank, (acc.ranks.get(rank) || 0) + 1);
      acc.suits!.set(suit, (acc.suits!.get(suit) || 0) + 1);
      return acc;
    }, initial);
  }

  straightCheck(frequencies: CardFrequencies): number[] | false {
    const freqKeysSet = new Set([...frequencies.ranks.keys()]);
    const straightPossibilities = [...new Array(13).fill(0).map((_, i) => 12 - i), 12];

    for (let i = 0; i < straightPossibilities.length - 4; i++) {
      const straightSet = new Set(straightPossibilities.slice(i, i + 5));

      if (straightSet.isSubsetOf(freqKeysSet)) {
        return zeroFilltoSeven([5, ...straightSet]);
      }
    }

    return false;
  }

  flushCheck(cards: number[], frequencies: CardFrequencies): number[] | false {
    let flushType: number = -1;

    for (const [key, value] of frequencies.suits!.entries()) {
      if (value >= 5) {
        flushType = key;
        break;
      }
    }

    if (flushType > -1) {
      return [
        6,
        ...cards
          .filter(card => Math.floor(card / 13) === flushType)
          .map(card => card % 13)
          .toSorted((a, b) => b - a)
          .slice(0, 5),
        flushType,
      ];
    }

    return false;
  }

  straightFlushCheck(cards: number[], straight: number[] | false, flush: number[] | false): number[] | false {
    if (!straight || !flush) {
      return false;
    }

    const flushType = flush[6];
    const ranks = new Map<number, number>(
      cards
        .filter(card => Math.floor(card / 13) === flushType)
        .map(card => [card % 13, 1]),
    );
    const straightFlush = this.straightCheck({ ranks });

    return straightFlush ? [9, ...straightFlush.slice(1, 6), flushType] : false;
  }

  nOfAKindCheck(n: number, frequencies: CardFrequencies): number[] | false {
    const kinds: number[] = [];
    const kickers: number[] = [];

    for (const [key, value] of frequencies.ranks.entries()) {
      const arr: number[] = value === n ? kinds : kickers;
      arr.push(key);
    }

    if (kinds.length < 1) {
      return false;
    }
    
    const kindsSorted = kinds.toSorted().toReversed();
    const maxKinds = n < 3 ? 2 : 1;
    const nOfAKind = kindsSorted.slice(0, maxKinds);
  
    kickers.push(...kindsSorted.slice(nOfAKind.length));

    let handType: number;

    switch(n) {
      case 4:
        handType = 8;
        break;
      case 3:
        handType = 4;
        break;
      case 2:
        handType = nOfAKind.length + 1;
        break;
      default:
        throw new Error('Not implemented');
    }

    return zeroFilltoSeven([
      handType,
      ...nOfAKind,
      ...kickers.toSorted((a, b) => b - a).slice(0, 5 - nOfAKind.length * n),
    ]);
  }

  fullHouseCheck(set: number[] | false, pairs: number[] | false) {
    if (!set || !pairs) {
      return false;
    }

    return zeroFilltoSeven([7, set[1], pairs[1]]);
  }

  highCardCheck(frequencies: CardFrequencies): number[] {
    return zeroFilltoSeven([
      1,
      ...[...frequencies.ranks.keys()]
        .toSorted((a, b) => b - a)
        .slice(0, 5),
    ]);
  }

  evaluateHand(cards: number[]): EvaluatedHand {
    const frequencies = this.calculateFrequencies(cards);
    const straight = this.straightCheck(frequencies);
    const flush = this.flushCheck(cards, frequencies);
    const straightFlush = this.straightFlushCheck(cards, straight, flush);

    if (straightFlush) {
      return straightFlush;
    }

    const fourOfAKind = this.nOfAKindCheck(4, frequencies);

    if (fourOfAKind) {
      return fourOfAKind;
    }

    const threeOfAKind = this.nOfAKindCheck(3, frequencies);
    const pairs = this.nOfAKindCheck(2, frequencies);
    const fullHouse = this.fullHouseCheck(threeOfAKind, pairs);

    if (fullHouse) {
      return fullHouse;
    }

    if (flush) {
      return flush;
    }

    if (straight) {
      return straight;
    }

    if (threeOfAKind) {
      return threeOfAKind;
    }

    if (pairs) {
      return pairs;
    }

    return this.highCardCheck(frequencies);
  }

  compareEvaluatedHands(handA: EvaluatedHand, handB: EvaluatedHand) {
    for (let i = 0; i < 6; i++) {
      if (handA[i] > handB[i]) {
        return -1;
      } else if (handA[i] < handB[i]) {
        return 1;
      }
    }

    return 0;
  }

  compareAllHands(hands: EvaluatedHand[]) {
    const sortedHands = hands.toSorted((a, b) => this.compareEvaluatedHands(a, b));

    for (let i = 0; i < sortedHands.length - 2; i++) {
      const comparison = this.compareEvaluatedHands(sortedHands[i], sortedHands[i + 1]);
  
      if (comparison === 0) {
        continue;
      } else if (comparison < 0) {
        return sortedHands.slice(0, i + 1);
      }
  
      throw new Error('Unexpected comparison result');
    }
  }
}