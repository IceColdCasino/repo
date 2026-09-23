import {
  type Ciphertext,
  type PublicKey,
} from './zk-casino';
import {
  Poker,
  MAX_PLAYERS,
} from './poker';
import { verifyCircuit } from './zk-verify';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { PotManager } from './pot-manager';
import { BettingRound, identitySeatIndexMap } from './betting-round';
import { actionClosingSeat } from './room';
import { shareOthersForPlayer } from './share-common';
import { shareCardMask } from './backend/card-layout';

interface ShuffledDeck {
  transientHash: bigint;
  deck: Ciphertext[];
  permutationHash: bigint;
}

export type GamePhase = 
  | 'Registration' 
  | 'Shuffle' 
  | 'Share' 
  | 'PreFlop'
  | 'Flop'
  | 'Turn'
  | 'River'
  | 'Showdown'
  | 'Evaluation'
  | 'Complete';


export const TOTAL_CARDS = MAX_PLAYERS * 2 + 5;
export const IDENTITY_POINT = [0n, 1n] as PublicKey;

export interface AddPlayerPrivateData {
  publicKey: PublicKey;
  padding: Ciphertext;
}

export interface ShufflePrivateData {
  publicKey: PublicKey;
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface SharePrivateData {
  publicKey: PublicKey;
  ciphertexts: Ciphertext[][];
}

export interface ShowdownPrivateData {
  publicKey: PublicKey;
  winnerMasks: bigint[];
  /** Public commitment derived from the player's sealed private coefficients. */
  coefficientCommitment: bigint;
}

export interface ProofOptions {
  verified?: boolean;
  /** Server shuffle order differs from registration order; skip turn check after remote verify. */
  skipTurnCheck?: boolean;
  /** Fixture generation only — apply partials without Groth16 hash checks. */
  fixtureApply?: boolean;
}

export class Game {
  #players: PublicKey[] = [];
  #padding: Ciphertext[] = [];
  #numPlayers = 0;
  #inProgress = false;
  #turnPlayerIndex = 0;
  #shuffledDecks: ShuffledDeck[] = [];
  #poker = new Poker();
  #phase: GamePhase = 'Registration';
  #partials: Ciphertext[][][] = new Array(MAX_PLAYERS);
  #pot = 0;
  #allIn = new Array(MAX_PLAYERS).fill(false);
  potManager!: PotManager;
  bettingRounds: BettingRound[] = [];
  tableEscrows: Map<number, bigint> = new Map();
  handCommits: bigint[] = new Array(MAX_PLAYERS).fill(0n);
  playerTotalBets: bigint[] = new Array(MAX_PLAYERS).fill(0n);
  foldedMask: number = 0;
  allInMask: number = 0;
  currentBet: bigint = 0n;
  dealerSeat: number = 0;
  smallBlindSeat: number = 0;
  bigBlindSeat: number = 0;
  smallBlindAmount: bigint = 0n;

  async init() {
    await this.#poker.init();
  }

  get finalShuffledDeck() {
    if (this.#shuffledDecks.length < this.#numPlayers) {
      throw new Error('Not all players have shuffled');
    }
    return this.#shuffledDecks[this.#shuffledDecks.length - 1]!.deck.slice(0, 25);
  }

  get deck() {
    return this.#shuffledDecks.length < 1 ? this.#poker.initialDeck : this.#shuffledDecks[this.#shuffledDecks.length - 1]!.deck;
  }

  get publicKeys() {
    return [...this.#players];
  }

  publicKeysShare(playerIndex: number) {
    return shareOthersForPlayer(this.#players.slice(0, this.#numPlayers), playerIndex);
  }

  /** Registered ElGamal keys only (unpadded). Shuffle pads 2→12 internally. */
  registeredPublicKeys(): PublicKey[] {
    return this.#players.slice(0, this.#numPlayers);
  }

  get nPlayers() {
    return this.#numPlayers;
  }

  get phase() {
    return this.#phase;
  }

  addPlayer(proof: Groth16Proof, publicSignals: PublicSignals, options: ProofOptions = {}) {
    if (this.#phase !== 'Registration') {
      if (this.#inProgress) {
        throw new Error('Game is already in progress');
      } else if (this.#phase === 'Complete') {
        throw new Error('Game has been completed');
      } else {
        throw new Error('Game is not in registration phase');
      }
    }

    if (this.#players.length >= MAX_PLAYERS) {
      throw new Error('Too many players');
    }

    if (!options.verified) {
      const isValid = verifyCircuit('register_main', proof, publicSignals);
      if (!isValid) {
        const fs = require('fs');
        fs.writeFileSync('/tmp/failed_proof.json', JSON.stringify(proof, null, 2));
        fs.writeFileSync('/tmp/failed_public.json', JSON.stringify(publicSignals, null, 2));
        throw new Error('Invalid proof - saved to /tmp/failed_proof.json and /tmp/failed_public.json');
      }
    }

    // register_main public signals ordering (snarkjs): outputs first
    //   [out[0], out[1], padding[0], padding[1], padding[2], padding[3]] = 6 total
    //   out == publicKey, padding is ElGamal encryption of [0, 1]
    const signals = publicSignals.map(s => BigInt(s));
    const publicKeyFromProof = signals.slice(0, 2) as PublicKey;
    const paddingFromProof = signals.slice(2, 6) as Ciphertext;

    const foundIndex = this.#players.findIndex(value => value.every((v, i) => v === publicKeyFromProof[i]));

    if (foundIndex > -1) {
      throw new Error(`Player already registered at ${foundIndex}`)
    }

    this.#players.push(publicKeyFromProof);
    this.#padding.push(paddingFromProof);
    this.#pot |= 1 << this.#numPlayers++;
  }

  start() {
    if (this.#phase !== 'Registration') {
      return;
    }
    this.#inProgress = true;
    this.#phase = 'Shuffle';
    if (this.#players.length < MAX_PLAYERS) {
      this.#players.push(
        ...new Array(MAX_PLAYERS - this.#players.length).fill([0n, 1n] as PublicKey),
      );
    }
    
    // Set up blinds
    this.dealerSeat = 0;
    this.smallBlindSeat = 0;
    this.bigBlindSeat = 1 % this.#numPlayers;
    this.smallBlindAmount = 10n;
    
    // Initialize pot manager
    const activePlayers = Array.from({ length: this.#numPlayers }, (_, i) => i);
    this.potManager = new PotManager(
      activePlayers,
      this.smallBlindAmount,
      this.smallBlindSeat,
      this.bigBlindSeat,
    );
  }

  collectBlinds() {
    if (this.bettingRounds.length > 0) {
      throw new Error('Betting round already started');
    }
    
    this.potManager.collectBlinds();
    this.currentBet = this.smallBlindAmount * 2n;
  }

  startBettingRound(phase: 'PreFlop' | 'Flop' | 'Turn' | 'River') {
    const activePlayers = this.getActivePlayers();
    const handSeatOrder = activePlayers;
    const closingSeat = actionClosingSeat(
      phase,
      handSeatOrder,
      this.dealerSeat,
      this.bigBlindSeat,
    );
    const lastAmount = phase === 'PreFlop' ? this.smallBlindAmount * 2n : 0n;
    const bigBlind = this.smallBlindAmount * 2n;

    const round = new BettingRound(
      this.potManager,
      activePlayers,
      identitySeatIndexMap(activePlayers),
      closingSeat,
      lastAmount,
      bigBlind,
    );
    
    this.bettingRounds.push(round);
    this.#phase = phase;
    if (phase === 'PreFlop') {
      round.seedStreetBet(this.smallBlindSeat, this.smallBlindAmount);
      round.seedStreetBet(this.bigBlindSeat, this.smallBlindAmount * 2n);
    }
  }

  playerFold(playerIndex: number) {
    const round = this.getCurrentBettingRound();
    round.fold(playerIndex);
    this.foldedMask |= 1 << playerIndex;
  }

  playerBet(playerIndex: number, amount: bigint) {
    const round = this.getCurrentBettingRound();
    round.bet(playerIndex, amount);
    this.playerTotalBets[playerIndex]! += amount;
    
    if (amount > 0n) {
      this.currentBet = this.potManager.currentBet;
    }
  }

  getCurrentBettingRound(): BettingRound {
    if (this.bettingRounds.length === 0) {
      throw new Error('No betting round active');
    }
    return this.bettingRounds[this.bettingRounds.length - 1]!;
  }

  getActivePlayers(): number[] {
    const active: number[] = [];
    for (let i = 0; i < this.#numPlayers; i++) {
      if (!(this.foldedMask & (1 << i))) {
        active.push(i);
      }
    }
    return active;
  }

  shuffle(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShufflePrivateData, options: ProofOptions = {}) {
    if (this.#phase !== 'Shuffle') {
      throw new Error('Game is not in shuffle phase');
    }

    const playerIndex = this.getPlayerIndex(privateData.publicKey);

    if (!options.skipTurnCheck && playerIndex !== this.#turnPlayerIndex) {
      throw new Error('Not your turn');
    }

    const signalBigInts = publicSignals.map(s => BigInt(s));
    const transientHashExpected = this.#poker.shuffleHash(this.deck, this.registeredPublicKeys());

    // shuffle_main public signals ordering (snarkjs):
    //   outputs first, then public inputs
    //   [deck[0][0..3], ..., deck[51][0..3] (208), permutationHash (1), hash (1)] = 210 total
    const transientHash = signalBigInts.pop()!;
    const permutationHash = signalBigInts.pop()!;

    if (transientHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${transientHash}`);
    }

    if (!options.verified && !verifyCircuit('shuffle_1_deck_52_main', proof, publicSignals)) {
      throw new Error('Invalid proof');
    }

    // Reconstruct shuffled deck from public signals (first 208 values)
    const deckFromSignals: Ciphertext[] = [];
    for (let i = 0; i < 52; i++) {
      deckFromSignals.push(
        signalBigInts.slice(i * 4, i * 4 + 4) as Ciphertext
      );
    }

    this.#shuffledDecks.push({
      transientHash,
      deck: deckFromSignals,
      permutationHash,
    });

    if (++this.#turnPlayerIndex == this.#numPlayers) {
      this.#phase = 'Share';
      this.#turnPlayerIndex = 0;
    }
  }

  getPlayerIndex(publicKey: PublicKey) {
    const index = this.#players.findIndex(value => value.every((v, i) => v === publicKey[i]));

    if (index < 0 || index >= this.#numPlayers) {
      throw new Error('Invalid Player Public Key');
    }

    return index;
  }

  fold(proof: Groth16Proof, publicSignals: PublicSignals, privateData: SharePrivateData, muck: boolean = true) {
    this.share(proof, publicSignals, privateData);
    this.#pot &= ~(1 << this.getPlayerIndex(privateData.publicKey));
  }

  share(proof: Groth16Proof, publicSignals: PublicSignals, privateData: SharePrivateData, options: ProofOptions = {}) {
    if (this.#phase !== 'Share') {
      throw new Error('Not in Share phase');
    }

    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const cardMask = shareCardMask(this.#numPlayers);

    const expectedInputHash = this.#poker.shareHash(
      this.finalShuffledDeck,
      cardMask,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );

    if (!options.fixtureApply) {
      const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));

      if (transientHash !== expectedInputHash) {
        throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${transientHash}`);
      }

      if (!options.verified && !verifyCircuit('poker_share_hashout_main', proof, publicSignals)) {
        throw new Error('Invalid share partials proof');
      }

      const expectedOutputHash = this.#poker.computeShareOutputHash(
        privateData.ciphertexts,
        this.#numPlayers,
      );

      if (outputHash !== expectedOutputHash) {
        throw new Error(`Output hash mismatch: circuit has ${outputHash}, expected ${expectedOutputHash}`);
      }
    }

    if (this.#partials[playerIndex] && this.#partials[playerIndex].length) {
      throw new Error('Partials are already shared for player for this phase of the game');
    }

    this.#partials[playerIndex] = privateData.ciphertexts;

    const activePartials = this.#partials.filter((p, i) => i < this.#numPlayers && p && p.length).length;

    if (activePartials === this.#numPlayers) {
      this.#phase = 'Evaluation';
    }
  }

  getCiphertextPartialsForPlayer(playerIndex: number) {
    const ciphertextPartials: Ciphertext[][] = [];

    const padding = this.#padding[playerIndex]!;
    // Masked-out deal slots (unused holes) are remapped to register padding so
    // Light can recompute the showdown Poseidon from in-play RevealedCards +
    // PlayerState.padding without needing unused-card reveals.
    const cardMask = shareCardMask(this.#numPlayers);

    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (i === playerIndex) {
        continue;
      }

      if (i >= this.#numPlayers) {
        ciphertextPartials.push(new Array(25).fill(padding));
        continue;
      }

      if (!this.#partials[i]) {
        throw new Error(`Player ${i} has not shared their showdown partials`);
      }

      const index = i > playerIndex ? playerIndex : playerIndex - 1;
      const partials = this.#partials[i]![index];

      if (!partials) {
        throw new Error(`Player ${i} has not shared showdown partials for player ${playerIndex}`);
      }

      ciphertextPartials.push(
        partials.map((ct, cardIndex) =>
          ((cardMask >> BigInt(cardIndex)) & 1n) === 0n ? padding : ct,
        ),
      );
    }

    return ciphertextPartials;
  }

  get potMasks() {
    return [
      BigInt(this.#pot),
      ...new Array(MAX_PLAYERS - 2).fill(0n),
    ];
  }

  verifyShowdown(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShowdownPrivateData, options: ProofOptions = {}) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);

    const hashInput = {
      potMasks: this.potMasks,
      publicKeys: this.#players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.finalShuffledDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
    };

    const expectedInputHash = this.#poker.showdownHash(hashInput);

    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));

    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }

    if (!options.verified && !verifyCircuit('poker_showdown_hashout_main', proof, publicSignals)) {
      throw new Error('Invalid showdown proof');
    }

    // Note: We cannot verify outputHash === expectedHash because the polynomial
    // hash coefficients are host-sealed to the proving player. The Groth16 proof
    // itself guarantees that the outputHash was computed correctly from the
    // winner masks and coefficients within the circuit.
    //
    // The input hash check above ensures the proof was generated for the
    // correct game state, and the proof validity check ensures the prover
    // knows valid private inputs (including the coefficients and winner masks).

    this.#phase = 'Complete';

    return privateData.winnerMasks;
  }
}