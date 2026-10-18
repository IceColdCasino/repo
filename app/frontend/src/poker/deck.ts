// import { randomInt } from 'node:crypto';

function randomInt(min: number, max: number) {
  const byteArray = new Uint8Array(1);
  globalThis.crypto.getRandomValues(byteArray);

  const range = max - min + 1;
  const max_range = 256;
  if (byteArray[0] >= Math.floor(max_range / range) * range)
    return randomInt(min, max);
  return min + (byteArray[0] % range);
}

export class Deck {
  cardsSet: Set<number> = new Set();
  #seedLength = 0;

  get #cards() {
    return [...this.cardsSet];
  }

  #initialize(seed: number[] = []) {
    this.#seedLength = seed.length;
    this.cardsSet = new Set(seed);

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 13; j++) {
        this.cardsSet.add(i * 13 + j);
      }
    }
  }

  #shuffle() {
    const cards = this.#cards;
    const seedLength = this.#seedLength;
    // Fisher-Yates algorithm
    for (let i = cards.length - 1; i > seedLength; i--) {
      const j = randomInt(seedLength, i + 1);
      const temp = cards[i];
      cards[i] = cards[j];
      cards[j] = temp;
    }

    this.cardsSet = new Set(cards);
  }

  constructor(seed: number[] = []) {
    this.#initialize(seed);
    this.#shuffle();
  }

  get cards() {
    return this.#cards as ReadonlyArray<number>;
  }
}