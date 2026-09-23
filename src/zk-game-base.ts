import path from 'path';
import { type Ciphertext, type PublicKey } from './zk-casino';
import { verify } from './rapidsnark-ffi';
import type { Groth16Proof, PublicSignals } from 'snarkjs';

export type CasinoGamePhase =
  | 'Registration'
  | 'Shuffle'
  | 'Share'
  | 'Showdown'
  | 'Complete';

export const IDENTITY_POINT = [0n, 1n] as PublicKey;

export function verifyingKeyPath(circuitName: string): string {
  return path.join(__dirname, `../zkey/${circuitName}_verification_key.json`);
}

export function publicKeysEqual(a: PublicKey, b: PublicKey): boolean {
  return a.every((v, i) => v === b[i]);
}

export interface ShuffledDeck {
  transientHash: bigint;
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface AddPlayerOptions {
  verified?: boolean;
}

/**
 * Registration, turn order, and Groth16 verification shared by every table Game.
 */
export abstract class ZkGame<P extends string = CasinoGamePhase> {
  protected players: PublicKey[] = [];
  protected padding: Ciphertext[] = [];
  protected numPlayers = 0;
  protected inProgress = false;
  protected turnPlayerIndex = 0;
  protected gamePhase: P;
  protected shuffledDecks: ShuffledDeck[] = [];
  readonly maxPlayers: number;
  readonly padToMaxOnStart: boolean;

  constructor(opts: {
    maxPlayers: number;
    padToMaxOnStart?: boolean;
    initialPhase?: P;
  }) {
    this.maxPlayers = opts.maxPlayers;
    this.padToMaxOnStart = opts.padToMaxOnStart ?? true;
    this.gamePhase = (opts.initialPhase ?? ('Registration' as P));
  }

  get publicKeys(): PublicKey[] {
    return [...this.players];
  }

  publicKeysShare(playerIndex: number): PublicKey[] {
    const keys = this.publicKeys;
    keys.splice(playerIndex, 1);
    return keys;
  }

  get nPlayers(): number {
    return this.numPlayers;
  }

  get phase(): P {
    return this.gamePhase;
  }

  getPlayerIndex(publicKey: PublicKey): number {
    const index = this.players.findIndex(value => publicKeysEqual(value, publicKey));
    if (index < 0 || index >= this.numPlayers) {
      throw new Error('Invalid Player Public Key');
    }
    return index;
  }

  protected verifyProof(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    circuitName: string,
    message: string,
  ): void {
    if (!verify(proof, publicSignals, verifyingKeyPath(circuitName))) {
      throw new Error(message);
    }
  }

  protected verifyRegistration(proof: Groth16Proof, publicSignals: PublicSignals): void {
    this.verifyProof(proof, publicSignals, 'register_main', 'Invalid registration proof');
  }

  protected assertRegistration(): void {
    if (this.gamePhase !== 'Registration') {
      if (this.inProgress) {
        throw new Error('Game is already in progress');
      }
      if (this.gamePhase === 'Complete') {
        throw new Error('Game has been completed');
      }
      throw new Error('Game is not in registration phase');
    }
  }

  protected onPlayerRegistered(_playerIndex: number): void {}

  addPlayer(proof: Groth16Proof, publicSignals: PublicSignals, options: AddPlayerOptions = {}): void {
    this.assertRegistration();
    if (this.players.length >= this.maxPlayers) {
      throw new Error('Too many players');
    }
    if (!options.verified) {
      this.verifyRegistration(proof, publicSignals);
    }
    const signals = publicSignals.map(s => BigInt(s));
    const publicKeyFromProof = signals.slice(0, 2) as PublicKey;
    const paddingFromProof = signals.slice(2, 6) as Ciphertext;
    if (this.players.some(value => publicKeysEqual(value, publicKeyFromProof))) {
      throw new Error('Player already registered');
    }
    this.players.push(publicKeyFromProof);
    this.padding.push(paddingFromProof);
    const index = this.numPlayers;
    this.numPlayers++;
    this.onPlayerRegistered(index);
  }

  protected beginShuffleAndPad(): void {
    this.inProgress = true;
    this.gamePhase = 'Shuffle' as P;
    if (this.padToMaxOnStart && this.numPlayers < this.maxPlayers) {
      this.players.push(...new Array(this.maxPlayers - this.numPlayers).fill(IDENTITY_POINT));
    }
  }

  start(): void {
    this.beginShuffleAndPad();
  }

  protected assertPhase(phase: P, message?: string): void {
    if (this.gamePhase !== phase) {
      throw new Error(message ?? `Game is not in ${String(phase)} phase`);
    }
  }

  protected assertTurn(playerIndex: number): void {
    if (playerIndex !== this.turnPlayerIndex) {
      throw new Error('Not your turn');
    }
  }

  protected advanceAfterShuffle(next: P): void {
    if (++this.turnPlayerIndex === this.numPlayers) {
      this.gamePhase = next;
      this.turnPlayerIndex = 0;
    }
  }

  protected setPhase(phase: P): void {
    this.gamePhase = phase;
  }

  get finalShuffledDeck(): Ciphertext[] {
    if (this.shuffledDecks.length < this.numPlayers) {
      throw new Error('Not all players have shuffled');
    }
    return this.shuffledDecks[this.shuffledDecks.length - 1]!.deck;
  }

  get deck(): Ciphertext[] {
    return this.shuffledDecks.length < 1
      ? this.initialDeck()
      : this.shuffledDecks[this.shuffledDecks.length - 1]!.deck;
  }

  protected abstract initialDeck(): Ciphertext[];
}

/**
 * Player-vs-house tables: dealer seat, sealed bets, and a single share round.
 */
export abstract class HouseZkGame extends ZkGame {
  protected readonly dealerSeat: number;
  protected encryptedBets: (Ciphertext[] | undefined)[];
  protected nActualBets: number[];
  protected partials: Ciphertext[][][];

  constructor(opts: {
    maxPlayers: number;
    dealerIndex: number;
    padToMaxOnStart?: boolean;
  }) {
    super(opts);
    this.dealerSeat = opts.dealerIndex;
    this.encryptedBets = new Array(opts.maxPlayers);
    this.nActualBets = new Array(opts.maxPlayers).fill(0);
    this.partials = new Array(opts.maxPlayers);
  }

  get dealerIndex(): number {
    return this.dealerSeat;
  }

  isDealer(playerIndex: number): boolean {
    return playerIndex === this.dealerSeat;
  }

  get housePublicKey(): PublicKey {
    return this.players[this.dealerSeat]!;
  }

  protected assertBetWindow(playerIndex: number): void {
    if (this.gamePhase === 'Showdown' || this.gamePhase === 'Complete') {
      throw new Error('Betting is closed');
    }
    if (this.numPlayers < 2 || this.players[this.dealerSeat] == null) {
      throw new Error('Dealer and player must register before betting');
    }
    if (this.partials[playerIndex]?.length) {
      throw new Error('Cannot bet after encrypted partials are revealed');
    }
  }

  protected recordSealedBets(
    playerIndex: number,
    encryptedBets: Ciphertext[],
    nActualBets: number,
    sealedToProver: Ciphertext[],
  ): void {
    if (this.isDealer(playerIndex)) {
      throw new Error('House/dealer cannot submit a bet proof');
    }
    this.assertBetWindow(playerIndex);
    for (let b = 0; b < sealedToProver.length; b++) {
      if (!sealedToProver[b]!.every((v, i) => v === encryptedBets[b]![i])) {
        throw new Error(`Encrypted bet ${b} mismatch for player ${playerIndex}`);
      }
    }
    this.encryptedBets[playerIndex] = encryptedBets;
    this.nActualBets[playerIndex] = nActualBets;
  }

  protected recordShare(
    playerIndex: number,
    ciphertexts: Ciphertext[][],
    requireBet: boolean,
    missingBetMessage?: string,
  ): void {
    if (!this.isDealer(playerIndex) && requireBet && this.encryptedBets[playerIndex] === undefined) {
      throw new Error(
        missingBetMessage ?? `Player ${playerIndex} must commit bets before sharing partials`,
      );
    }
    if (this.partials[playerIndex]?.length) {
      throw new Error('Partials are already shared for this player');
    }
    this.partials[playerIndex] = ciphertexts;
    const active = this.partials.filter((p, i) => i < this.numPlayers && p && p.length).length;
    if (active === this.numPlayers) {
      this.gamePhase = 'Showdown';
    }
  }

  getEncryptedBetsForPlayer(playerIndex: number): Ciphertext[] {
    const bets = this.encryptedBets[playerIndex];
    if (!bets) throw new Error(`Player ${playerIndex} has not committed bets`);
    return bets;
  }

  getNActualBetsForPlayer(playerIndex: number): number {
    return this.nActualBets[playerIndex] ?? 0;
  }

  getCiphertextPartialsForPlayer(playerIndex: number, totalCards: number): Ciphertext[][] {
    const ciphertextPartials: Ciphertext[][] = [];
    const pad = this.padding[playerIndex]!;
    for (let i = 0; i < this.maxPlayers; i++) {
      if (i === playerIndex) continue;
      if (i >= this.numPlayers) {
        ciphertextPartials.push(new Array(totalCards).fill(pad));
        continue;
      }
      if (!this.partials[i]) {
        throw new Error(`Player ${i} has not shared their partials`);
      }
      const index = i > playerIndex ? playerIndex : playerIndex - 1;
      const row = this.partials[i]![index];
      if (!row) {
        throw new Error(`Player ${i} has not shared partials for player ${playerIndex}`);
      }
      ciphertextPartials.push(row);
    }
    return ciphertextPartials;
  }

  protected assertShowdownPlayer(playerIndex: number): void {
    this.assertPhase('Showdown', 'Not in Showdown phase');
    if (this.isDealer(playerIndex)) {
      throw new Error('House/dealer cannot submit showdown');
    }
  }

  protected finishShowdown(): void {
    this.gamePhase = 'Complete';
  }
}
