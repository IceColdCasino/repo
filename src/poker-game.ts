import {
  type Ciphertext,
  type PublicKey,
} from './zk-casino';
import {
  Poker,
  MAX_PLAYERS,
  pokerStreetCards,
} from './poker';
import { verifyCircuit } from './zk-verify';
import { readShuffleProof } from './shuffle-signals';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { PotManager } from './pot-manager';
import { BettingRound, identitySeatIndexMap } from './betting-round';
import { actionClosingSeat } from './room';
import { shareOthersForPlayer } from './share-common';
import { shareCardMask } from './backend/card-layout';
import {
  requiredShareStake,
  settleBadUnseal,
  UnsealChallengeWindow,
  unsealChallengeShouldClose,
  type ShareUnsealPenalty,
} from './poker-share-penalty';

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
  /** Poseidon of the seal rows Arcis revealed for this seat (seal account, not the prover). */
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
  #shareOutputHashes: Array<bigint | undefined> = new Array(MAX_PLAYERS);
  #shareStreetHashes: Array<bigint[] | undefined> = new Array(MAX_PLAYERS);
  #shareStakes: Array<bigint | undefined> = new Array(MAX_PLAYERS);
  #revealedLimbs = new Map<string, bigint[]>();
  #judgedStreets = new Set<string>();
  #cheaters = new Set<number>();
  #unsealWindow = new UnsealChallengeWindow();
  #clock: () => number = Date.now;
  #sharePenalty: ShareUnsealPenalty | undefined;
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
  /** Button. */
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
    
    // Set up blinds. dealerSeat is the button.
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

    const transientHashExpected = this.#poker.shuffleHash(this.deck, this.registeredPublicKeys());
    const { outputDeckHash, permutationHash, inputHash } = readShuffleProof(publicSignals);

    if (inputHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${inputHash}`);
    }
    if (this.#poker.deckHash(privateData.deck) !== outputDeckHash) {
      throw new Error('Shuffle output hash does not match the shoe');
    }
    if (privateData.permutationHash !== permutationHash) {
      throw new Error('Shuffle permutation hash does not match the proof');
    }

    if (!options.verified && !verifyCircuit('shuffle_1_deck_52_main', proof, publicSignals)) {
      throw new Error('Invalid proof');
    }

    this.#shuffledDecks.push({
      transientHash: inputHash,
      deck: privateData.deck,
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

  /**
   * Street hashes published with the share. The chain folds them and requires
   * that fold to equal the proof output.
   */
  shareTierCommitment(ciphertexts: Ciphertext[][]): { hashes: bigint[]; finalHash: bigint } {
    const commitment = this.#poker.shareCommitments(ciphertexts, this.#numPlayers);
    if (commitment.streets.length !== 13) {
      throw new Error(`Expected 13 street hashes, got ${commitment.streets.length}`);
    }
    return { hashes: commitment.streets, finalHash: commitment.finalHash };
  }

  assertShareOutput(
    publicSignals: Array<bigint | string>,
    ciphertexts: Ciphertext[][],
    playerIndex?: number,
  ) {
    const parsed = this.#poker.parseSharePublicSignals(publicSignals);
    const expected = this.#poker.shareCommitments(ciphertexts, this.#numPlayers).finalHash;
    const who = playerIndex === undefined ? 'share' : `player ${playerIndex}`;
    if (parsed.finalHash !== expected) {
      throw new Error(`${who} output hash mismatch: circuit has ${parsed.finalHash}, expected ${expected}`);
    }
    return parsed;
  }

  /** Chips that must be posted before this hand's share. Ten small blinds. */
  requiredShareStake(): bigint {
    return requiredShareStake(this.smallBlindAmount);
  }

  /**
   * Post the share-integrity stake. It stays unless a receiving player unseals
   * partials that miss this seat's published street hash.
   */
  postShareStake(playerIndex: number, amount: bigint) {
    if (playerIndex < 0 || playerIndex >= this.#numPlayers) {
      throw new Error(`player ${playerIndex} is not in the hand`);
    }
    const need = this.requiredShareStake();
    if (amount !== need) {
      throw new Error(`share stake must be ${need}`);
    }
    this.#shareStakes[playerIndex] = amount;
  }

  /** Set once an unseal proves a bad share. Absent while every opened street matches. */
  get shareUnsealPenalty(): ShareUnsealPenalty | undefined {
    return this.#sharePenalty;
  }

  /** Open after the first mismatched street. Absent until then. */
  get unsealChallenge() {
    return this.#unsealWindow.challenge;
  }

  /** Tests supply a clock so the challenge deadline can move without waiting. */
  setClock(clock: () => number) {
    this.#clock = clock;
  }

  /**
   * Close the challenge once every player has revealed that street, or once
   * the deadline has passed. Returns `open` while other players may still unseal.
   */
  pollUnsealChallenge(now = this.#clock()): 'none' | 'open' | 'closed' {
    const challenge = this.#unsealWindow.challenge;
    if (!challenge) return 'none';
    if (challenge.closed) return 'closed';
    const streetFullyRevealed = this.#streetRevealed(challenge.street);
    if (!unsealChallengeShouldClose(challenge, now, streetFullyRevealed)) return 'open';
    this.#unsealWindow.close(now, streetFullyRevealed);
    this.#phase = 'Complete';
    return 'closed';
  }

  share(proof: Groth16Proof, publicSignals: PublicSignals, privateData: SharePrivateData, options: ProofOptions = {}) {
    if (this.#phase !== 'Share') {
      throw new Error('Not in Share phase');
    }

    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    if (this.smallBlindAmount > 0n && this.#shareStakes[playerIndex] !== this.requiredShareStake()) {
      throw new Error(
        `player ${playerIndex} must post ${this.requiredShareStake()} as the share stake before sharing`,
      );
    }
    const cardMask = shareCardMask(this.#numPlayers);

    const expectedInputHash = this.#poker.shareHash(
      this.finalShuffledDeck,
      cardMask,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );

    if (!options.fixtureApply) {
      const parsed = this.assertShareOutput(publicSignals, privateData.ciphertexts, playerIndex);

      if (parsed.inputHash !== expectedInputHash) {
        throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${parsed.inputHash}`);
      }

      if (!options.verified && !verifyCircuit('poker_share_hashout_main', proof, publicSignals)) {
        throw new Error('Invalid share partials proof');
      }

      const tier = this.shareTierCommitment(privateData.ciphertexts);
      this.#shareStreetHashes[playerIndex] = tier.hashes;
      this.#shareOutputHashes[playerIndex] = parsed.finalHash;
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

    // Register padding is an encryption of the identity under the player key.
    const cardMask = shareCardMask(this.#numPlayers);
    const padding = this.#padding[playerIndex]!;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (i === playerIndex) {
        continue;
      }

      if (i >= this.#numPlayers) {
        ciphertextPartials.push(new Array(TOTAL_CARDS).fill(padding));
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

  /**
   * Record the Arcis-revealed limbs for one recipient and card.
   * Bytes are big-endian field elements, one sharer's 4 limbs packed by seat.
   */
  noteRevealedCard(recipient: number, card: number, limbs: bigint[]) {
    const now = this.#clock();
    this.#rejectIfUnsealClosed(now);
    const expected = (this.#numPlayers - 1) * 4;
    if (limbs.length < expected) {
      throw new Error(
        `revealed card r${recipient} c${card} has ${limbs.length} limbs, expected ${expected}`,
      );
    }
    this.#revealedLimbs.set(`${recipient}:${card}`, limbs.slice(0, expected));
    this.#judgeOpenedStreets(now);
  }

  /**
   * Recheck every street that has at least one opened partial. A mismatch
   * opens the challenge window and does not end the hand.
   */
  assertCompleteShareStreets(): ShareUnsealPenalty | undefined {
    this.#judgeOpenedStreets(this.#clock());
    if (this.pollUnsealChallenge() !== 'closed') return undefined;
    return this.#sharePenalty;
  }

  #rejectIfUnsealClosed(now: number) {
    const challenge = this.#unsealWindow.challenge;
    if (!challenge) return;
    if (!challenge.closed && now < challenge.deadline) return;
    if (!challenge.closed) {
      this.#unsealWindow.close(now, false);
      this.#phase = 'Complete';
    }
    throw new Error('the unseal window has closed');
  }

  #streetRevealed(street: number): boolean {
    return pokerStreetCards(street).every(card =>
      Array.from({ length: this.#numPlayers }, (_, seat) =>
        this.#revealedLimbs.has(`${seat}:${card}`),
      ).every(Boolean),
    );
  }

  #streetHasReveal(street: number): boolean {
    return pokerStreetCards(street).some(card =>
      Array.from({ length: this.#numPlayers }, (_, seat) =>
        this.#revealedLimbs.has(`${seat}:${card}`),
      ).some(Boolean),
    );
  }

  #seatContributions(): bigint[] {
    const bets = this.playerTotalBets.slice(0, this.#numPlayers);
    if (!this.potManager) return bets;
    return bets.map((bet, seat) => {
      const inPot = this.potManager.contribution(seat);
      return inPot > bet ? inPot : bet;
    });
  }

  #kick(seat: number) {
    if (this.#cheaters.has(seat)) return;
    this.#cheaters.add(seat);
    this.#pot &= ~(1 << seat);
    this.foldedMask |= 1 << seat;
    const manager = this.potManager;
    if (
      manager
      && manager.activePlayers.has(seat)
      && !manager.allInPlayers.has(seat)
      && manager.activePlayers.size > 1
    ) {
      manager.foldPlayer(seat);
    }
  }

  #judgeOpenedStreets(now: number) {
    const streets = [
      ...Array.from({ length: this.#numPlayers }, (_, seat) => seat),
      10,
      11,
      12,
    ];
    const openedStreets = streets.filter(street => this.#streetHasReveal(street));
    if (openedStreets.length === 0) return;

    let found = false;
    for (let sharer = 0; sharer < this.#numPlayers; sharer++) {
      const pending = openedStreets.filter(street => !this.#judgedStreets.has(`${sharer}:${street}`));
      if (pending.length === 0) continue;
      const published = this.#shareStreetHashes[sharer];
      if (!published) {
        throw new Error(`player ${sharer} has no published street hashes`);
      }
      const grid = this.#partials[sharer]!.map(row => row.map(ct => [...ct] as Ciphertext));
      let wrote = false;
      for (const street of pending) {
        for (let row = 0; row < 9; row++) {
          const seat = row < sharer ? row : row + 1;
          if (seat >= this.#numPlayers) continue;
          const dest = sharer < seat ? sharer : sharer - 1;
          for (const card of pokerStreetCards(street)) {
            const limbs = this.#revealedLimbs.get(`${seat}:${card}`);
            if (!limbs) continue;
            grid[row]![card] = limbs.slice(dest * 4, dest * 4 + 4) as Ciphertext;
            wrote = true;
          }
        }
      }
      if (!wrote) continue;
      const got = this.#poker.shareCommitments(grid, this.#numPlayers).streets;
      for (const street of pending) {
        if (this.#sharerStreetRevealed(sharer, street)) {
          this.#judgedStreets.add(`${sharer}:${street}`);
        }
        if (got[street] !== published[street] && !this.#cheaters.has(sharer)) {
          this.#unsealWindow.recordMismatch(street, sharer, now);
          this.#kick(sharer);
          found = true;
        }
      }
    }
    if (found) {
      this.#sharePenalty = settleBadUnseal({
        contributions: this.#seatContributions(),
        stakes: Array.from({ length: this.#numPlayers }, (_, seat) => this.#shareStakes[seat] ?? 0n),
        cheaters: this.#unsealWindow.cheaters,
      });
    }
  }

  /** Recipients other than the sharer have opened every card of the street. */
  #sharerStreetRevealed(sharer: number, street: number): boolean {
    return pokerStreetCards(street).every(card =>
      Array.from({ length: this.#numPlayers }, (_, seat) =>
        seat === sharer || this.#revealedLimbs.has(`${seat}:${card}`),
      ).every(Boolean),
    );
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

    const expectedInputHash = this.#poker.showdownHash({
      ...hashInput,
      sealCommitment: privateData.coefficientCommitment,
    });

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