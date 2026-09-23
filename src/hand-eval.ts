const ranks = '23456789TJQKA'.split('');
const suits = 'SHDC'.split('');

export function toCardIndex(abbrev: string) {
  const [rank, suit] = abbrev.split('');

  return BigInt(13 * suits.indexOf(suit!) + ranks.indexOf(rank!));
}

export function toCardValue(index: number) {
  const suit = Math.floor(index / 13);
  const rank = index % 13;

  return `${ranks[rank]}${suits[suit]}`;
}

export type EvaluatedHand = bigint[];

export const handTypes = ['highCard', 'onePair', 'twoPair', 'threeOfAKind', 'straight', 'flush', 'fullHouse', 'fourOfAKind', 'straightFlush' ];

export interface CardFrequencies {
  ranks: Map<bigint, number>;
  suits?: Map<bigint, number>;
}

function zeroFilltoSeven(arr: bigint[]): bigint[] {
  return [
    ...arr,
    ...new Array(7 - arr.length).fill(0n),
  ];
}

export class HandEvaluator {
  calculateFrequencies(cards: bigint[]): CardFrequencies {
    const initial: CardFrequencies = {
      ranks: new Map<bigint, number>(),
      suits: new Map<bigint, number>(),
    };

    return cards.reduce((acc, val) => {
      const [rank, suit] = [val % 13n, val / 13n];
      acc.ranks.set(rank, (acc.ranks.get(rank) || 0) + 1);
      acc.suits!.set(suit, (acc.suits!.get(suit) || 0) + 1);
      return acc;
    }, initial);
  }

  straightCheck(ranks: CardFrequencies['ranks']): bigint[] | false {
    const freqKeysSet = new Set([...ranks.keys()]);
    const straightPossibilities = [...new Array(13).fill(0).map((_, i) => BigInt(12 - i)), 12n];

    for (let i = 0; i < straightPossibilities.length - 4; i++) {
      const straightSet = new Set(straightPossibilities.slice(i, i + 5));

      if (straightSet.isSubsetOf(freqKeysSet)) {
        return zeroFilltoSeven([5n, ...straightSet]);
      }
    }

    return false;
  }

  flushCheck(cards: bigint[], frequencies: CardFrequencies): bigint[] | false {
    let flushType = -1n;

    for (const [key, value] of frequencies.suits!.entries()) {
      if (value >= 5) {
        flushType = key;
        break;
      }
    }

    if (flushType > -1n) {
      return [
        6n,
        ...cards
          .filter(card => card / 13n === flushType)
          .map(card => card % 13n)
          .toSorted((a, b) => Number(b - a))
          .slice(0, 5),
        flushType,
      ];
    }

    return false;
  }

  straightFlushCheck(cards: bigint[], straight: bigint[] | false, flush: bigint[] | false): bigint[] | false {
    if (!straight || !flush) {
      return false;
    }

    const flushType = flush[6];
    const ranks = new Map(
      cards
        .filter(card => card / 13n === flushType)
        .map(card => [card % 13n, 1]),
    );
    const straightFlush = this.straightCheck(ranks);

    return straightFlush ? [9n, ...straightFlush.slice(1, 6), flushType!] : false;
  }

  nOfAKindCheck(n: number, frequencies: CardFrequencies): bigint[] | false {
    const kinds: bigint[] = [];
    const kickers: bigint[] = [];

    for (const [key, value] of frequencies.ranks.entries()) {
      const arr: bigint[] = value === n ? kinds : kickers;
      arr.push(key);
    }

    if (kinds.length < 1) {
      return false;
    }
    
    const kindsSorted = kinds.toSorted((a, b) => Number(b - a));
    const maxKinds = n < 3n ? 2 : 1;
    const nOfAKind = kindsSorted.slice(0, maxKinds);
  
    kickers.push(...kindsSorted.slice(nOfAKind.length));

    let handType: bigint;

    switch(n) {
      case 4:
        handType = 8n;
        break;
      case 3:
        handType = 4n;
        break;
      case 2:
        handType = BigInt(nOfAKind.length) + 1n;
        break;
      default:
        throw new Error('Not implemented');
    }

    return zeroFilltoSeven([
      handType,
      ...nOfAKind,
      ...kickers.toSorted((a, b) => Number(b - a)).slice(0, 5 - nOfAKind.length * n),
    ]);
  }

  fullHouseCheck(frequencies: CardFrequencies) {
    const sets = [];
    const pairs = [];
    for (const [rank, freq] of frequencies.ranks) {
      switch (freq) {
        case 2:
          pairs.push(rank);
          break;
        case 3:
          sets.push(rank);
          break;
      }
    }

    if (sets.length < 1 || (sets.length < 2 && pairs.length < 1)) {
      return false;
    }
  
    const sortedSets = sets.toSorted((a, b) => Number(b - a));
    const sortedPairs = pairs.toSorted((a, b) => Number(b - a));
    const primarySet = sortedSets[0]!;
    const pair = sortedSets.length > 1 ? sortedSets[1] : sortedPairs[0];

    return zeroFilltoSeven([7n, primarySet, pair!]);
  }

  highCardCheck(frequencies: CardFrequencies): bigint[] {
    return zeroFilltoSeven([
      1n,
      ...[...frequencies.ranks.keys()]
        .toSorted((a, b) => Number(b - a))
        .slice(0, 5),
    ]);
  }

  evaluateHand(cards: bigint[]): EvaluatedHand {
    const frequencies = this.calculateFrequencies(cards);
    const straight = this.straightCheck(frequencies.ranks);
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
    const fullHouse = this.fullHouseCheck(frequencies);

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
      if (handA[i]! > handB[i]!) {
        return -1;
      } else if (handA[i]! < handB[i]!) {
        return 1;
      }
    }

    return 0;
  }

  compareAllHands(hands: EvaluatedHand[]) {
    const topHand = hands.toSorted((a, b) => this.compareEvaluatedHands(a, b))[0]!;

    let winnerMask = 0;

    for (let i = 0; i < hands.length; i++) {  
      if (this.compareEvaluatedHands(topHand, hands[i]!) === 0) {
        winnerMask |= (1 << i);
      }
    }

    return BigInt(winnerMask);
  }
}