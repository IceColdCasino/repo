export * from './betting-round';
export * from './card';
export * from './deck';
export * from './game';
export * from './hand-eval';
export * from './player';
export * from './pot-manager';
export * from './pot';
export * from './table';
export * from './view-model';

import { Card } from './card';
import { Deck } from './deck';
import { Player } from './player';
import { Table } from './table';
import { UserInterface } from './user-interface';

export class GameState {
  table: Table;
  player: Player;
  ui: UserInterface;

  constructor(table: Table, player: Player) {
    this.table = table;
    this.player = player;
    this.ui = new UserInterface();
    this.#initDialog();
    this.#load();
  }

  #load() {
    const gameState = localStorage.getItem('GameState');

    if (!gameState) {
      this.table = new Table();
      this.player = new Player('');
    }
  }

  #initDialog() {
    const dialog = document.querySelector('#chipDialog') as HTMLDialogElement;
    const showButton = document.querySelector('#addChips');
    const closeButton = document.querySelector('#cancel');
    const form = document.querySelector('#chipDialog > form');

    showButton.addEventListener('click', () => {
      dialog.showModal();
    });

    closeButton.addEventListener('click', () => {
      dialog.close();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const chipInput = document.querySelector('#chips') as HTMLInputElement;
      const chipAmount = parseInt(chipInput.value, 10);
      console.log(`Adding ${chipAmount} chips to player.`);
      dialog.close();
    });
  }

  deal() {
    this.ui.dealPlayerCardsFaceDown(Array.from({ length: this.table.seats.size }, (_, i) => i));
    this.ui.dealSharedCardsFaceDown();
  }

  sit(seatIndex: number) {
    this.table.sit(seatIndex, this.player.publicKey);
  };

  addChips(amount: number) {
    this.player.addChips(amount);
  }

  startGame(seats: number[]) {
    console.debug('Starting game...');

    const deck = new Deck();

    for (let i = 0; i < seats.length; i++) {
      const cardGroups = document.querySelectorAll(`#player${i}_cards g`);
      cardGroups.forEach((group, index) => {
        const offset = 2 * i + 1 + index;
        const card = new Card(deck.cards[offset]);
        group.classList.add('flipped');
        group.classList.add(card.suitName);
        group.querySelector('text').innerHTML = `&#x${card.unicode};`;
      });
    }

    const sharedCards = document.querySelector('#shared_cards');
    const sharedIds = ['flop0', 'flop1', 'flop2', 'turn', 'river'];

    for (let i = 0; i < sharedIds.length; i++) {
      const card = new Card(deck.cards[seats.length * 2 + i]);
      const group = sharedCards.querySelector(`#${sharedIds[i]}`);
      group.classList.add('flipped');
      group.classList.add(card.suitName);
      group.querySelector('text').innerHTML = `&#x${card.unicode};`;
    }
  }
}