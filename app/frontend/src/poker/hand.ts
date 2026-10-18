import { Deck } from './deck';

export class Hand {
  playerCount: number;
  deck: Deck;
  playerCards: number[][] = [];
  flopCards: number[] = [];
  turnCards: number[] = [];
  riverCards: number[] = [];

  constructor(playerCount: number) {
    this.deck = new Deck();
    this.playerCount = playerCount;
    const cards = [...this.deck.cards];

    const playerCards = cards.splice(0, 2 * this.playerCount);

    for (let i = 0; i < this.playerCount; i++) {
      this.playerCards.push([playerCards[i], playerCards[i + this.playerCount]]);
    }

    this.flopCards = cards.splice(0, 3);
    this.turnCards = cards.splice(0, 1);
    this.riverCards = cards.splice(0, 1);
  }
}