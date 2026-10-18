import { BettingRound } from './betting-round';
import { Hand } from './hand';
import {
  HandEvaluator,
} from './hand-eval';
import { Player } from './player';
import { PotManager } from './pot-manager';
import { Table } from './table';

const PHASES = {
  blinds: 0,
  preflop: 1,
  flop: 2,
  turn: 3,
  river: 4,
  showdown: 5,
  end: 6,
} as const;

export class Game {
  table: Table;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  readonly potManager: PotManager;
  currentBet: number = 0;
  phase: keyof PHASES = 'blinds';
  hand: Hand;
  actionOrder: number[];
  currentTurnIndex: number = 0;
  startTurnIndex: number = 0;
  lastAggressorIndex: number = -1;
  hasBetOccurred: boolean = false;
  activePlayers: Set<CryptoKey> = new Set();
  allInPlayers: Set<CryptoKey> = new Set();
  actionActiveSeats: Set<number> = new Set();
  evaluator = new HandEvaluator();
  bettingRounds: BettingRound[] = [];
  #smallBlindAmount: number;

  constructor(table: Table, dealerSeat: number, order: number[], smallBlindAmount: number, liveBlindSeats: number[] = []) {
    this.table = table;
    this.dealerSeat = dealerSeat;
    this.actionOrder = order;
    this.smallBlindSeat = order[0];
    this.bigBlindSeat = order[1];
    this.#smallBlindAmount = smallBlindAmount;

    const smallBlindPlayer = this.table.playerMap.get(this.table.seats.get(this.smallBlindSeat)!)!;
    const bigBlindPlayer = this.table.playerMap.get(this.table.seats.get(this.bigBlindSeat)!)!;
    const liveBlindPlayers = liveBlindSeats
      .map(seat => this.table.playerMap.get(this.table.seats.get(seat)!)!);

    this.potManager = new PotManager(this.table.players, smallBlindAmount, smallBlindPlayer, bigBlindPlayer, liveBlindPlayers);
    this.hand = new Hand(this.table.seats.size);
    this.activePlayers = new Set(order.map(seat => this.table.seats.get(seat)!));
    this.actionActiveSeats = new Set(this.actionOrder);
  }

  async start() {
    this.collectBlinds();
    this.phase = 'preflop';
    this.bettingRounds.push(new BettingRound(this.potManager, this.seatMap, this.bigBlindSeat, this.#smallBlindAmount * 2));
  }

  collectBlinds() {
    if (this.phase !== 'blinds') {
      throw new Error('Wrong game phase to collect the blinds');
    }

    this.potManager.collectBlinds();
    this.currentBet = this.table.bigBlind;
  }

  getPlayerFromSeat(seat: number): Player {
    const playerKey = this.table.seats.get(seat);
    if (!playerKey) {
      throw new Error('Player not found in this seat');
    }

    const player = this.table.playerMap.get(playerKey);
    if (!player) {
      throw new Error('Player not found');
    }

    return player;
  }

  get seatMap() {
    return new Map<number, Player>(
      this.actionOrder.map(seat => [seat, this.getPlayerFromSeat(seat)!]),
    );
  }

  startBettingRound() {
    if (this.bettingRounds.length === PHASES[this.phase]) {
      throw new Error('Already started');
    }
    this.bettingRounds.push(new BettingRound(this.potManager, this.seatMap));
  }

  changePhase() {
    switch (this.phase) {
      case 'preflop':
        this.phase = 'flop';
        break;
      case 'flop':
        this.phase = 'turn';
        break;
      case 'turn':
        this.phase = 'river';
        break;
      case 'river':
      case 'showdown':
        this.phase = 'end';
        return;
      case 'end':
        throw new Error('Game has ended');
      default:
        throw new Error('Invalid phase');
    }

    this.startBettingRound();
  }
}