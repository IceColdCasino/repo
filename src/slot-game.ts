import { Slot, MAX_PLAYERS, N_STOPS, parseSlotSharePublicSignals, type SlotVariant, type ShowdownHashInput } from './slot';
import { type Ciphertext, type PublicKey } from './zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { ZkGame, IDENTITY_POINT, type CasinoGamePhase } from './zk-game-base';

interface ShuffledReels {
  transientHash: bigint;
  reels: Ciphertext[][];
  permutationHash: bigint;
}

export type GamePhase = CasinoGamePhase;
export { IDENTITY_POINT };

export class Game extends ZkGame {
  #shuffled: ShuffledReels[] = [];
  #slot: Slot;
  #variant: SlotVariant;
  #partials: Ciphertext[][][] = new Array(MAX_PLAYERS);
  #encryptedBets: (Ciphertext | undefined)[] = new Array(MAX_PLAYERS);
  #coinBets: number[] = new Array(MAX_PLAYERS).fill(0);
  #dealerSeat: number;

  constructor(variant: SlotVariant, dealerIndex = 0) {
    super({ maxPlayers: MAX_PLAYERS, padToMaxOnStart: false });
    if (dealerIndex !== 0 && dealerIndex !== 1) {
      throw new Error('Slots house seat must be 0 or 1');
    }
    this.#variant = variant;
    this.#dealerSeat = dealerIndex;
    this.#slot = new Slot(variant);
  }

  get dealerIndex() {
    return this.#dealerSeat;
  }

  isDealer(playerIndex: number) {
    return playerIndex === this.#dealerSeat;
  }

  get variant() {
    return this.#variant;
  }

  async init() {
    await this.#slot.init();
  }

  protected override initialDeck(): Ciphertext[] {
    return this.#slot.initialDeck;
  }

  get reels() {
    return this.#shuffled.length < 1
      ? this.#slot.initialReels
      : this.#shuffled[this.#shuffled.length - 1]!.reels;
  }

  override get finalShuffledDeck() {
    if (this.#shuffled.length < this.numPlayers) {
      throw new Error('Not all players have shuffled');
    }
    return this.reels.map(reel => reel[0]!);
  }

  #circuitNames() {
    return {
      shuffle: `shuffle_${this.#variant}_reel_22_main`,
      share: `slot_share_${this.#variant}_reel_hashout_main`,
      showdown: `slot_showdown_${this.#variant}_reel_hashout_main`,
    } as const;
  }

  override addPlayer(proof: Groth16Proof, publicSignals: PublicSignals) {
    if (this.players.length >= MAX_PLAYERS) {
      throw new Error('Slots is a 2-seat game');
    }
    super.addPlayer(proof, publicSignals);
  }

  override start() {
    if (this.numPlayers !== MAX_PLAYERS) {
      throw new Error('Slots requires exactly 2 registered seats');
    }
    this.beginShuffleAndPad();
  }

  shuffle(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; reels: Ciphertext[][]; permutationHash: bigint },
  ) {
    this.assertPhase('Shuffle', 'Game is not in shuffle phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertTurn(playerIndex);
    const signalBigInts = publicSignals.map(s => BigInt(s));
    const transientHashExpected = this.#slot.shuffleHash(this.reels, this.players);
    const transientHash = signalBigInts.pop()!;
    const permutationHash = signalBigInts.pop()!;
    if (transientHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${transientHash}`);
    }
    this.verifyProof(proof, publicSignals, this.#circuitNames().shuffle, 'Invalid shuffle proof');
    const reelsFromSignals: Ciphertext[][] = [];
    for (let r = 0; r < this.#variant; r++) {
      const stops: Ciphertext[] = [];
      for (let s = 0; s < N_STOPS; s++) {
        const i = (r * N_STOPS + s) * 4;
        stops.push(signalBigInts.slice(i, i + 4) as Ciphertext);
      }
      reelsFromSignals.push(stops);
    }
    this.#shuffled.push({ transientHash, reels: reelsFromSignals, permutationHash });
    this.advanceAfterShuffle('Share');
  }

  share(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; ciphertexts: Ciphertext[][]; encryptedBets: Ciphertext[]; coinBet: number },
  ) {
    this.assertPhase('Share', 'Not in Share phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedInputHash = this.#slot.shareHash(
      this.finalShuffledDeck,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );
    const parsed = parseSlotSharePublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedInputHash) {
      throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, this.#circuitNames().share, 'Invalid share partials proof');
    const expectedOutputHash = this.#slot.computeShareOutputHash(privateData.ciphertexts, this.numPlayers);
    if (parsed.outHash !== expectedOutputHash) {
      throw new Error(`Output hash mismatch: circuit has ${parsed.outHash}, expected ${expectedOutputHash}`);
    }
    const sealedToProver = parsed.encryptedBets[0]!;
    if (!sealedToProver.every((v, i) => v === privateData.encryptedBets[0]![i])) {
      throw new Error(`Encrypted coin-bet mismatch for player ${playerIndex}`);
    }
    if (this.#partials[playerIndex]?.length) {
      throw new Error('Partials are already shared for this player');
    }
    this.#partials[playerIndex] = privateData.ciphertexts;
    this.#encryptedBets[playerIndex] = privateData.encryptedBets[0];
    if (this.isDealer(playerIndex)) {
      this.#coinBets[playerIndex] = 0;
    } else if (privateData.coinBet !== 1 && privateData.coinBet !== 2 && privateData.coinBet !== 3) {
      throw new Error(`Player coinBet must be 1, 2, or 3, got ${privateData.coinBet}`);
    } else {
      this.#coinBets[playerIndex] = privateData.coinBet;
    }
    const activePartials = this.#partials.filter((p, i) => i < this.numPlayers && p && p.length).length;
    if (activePartials === this.numPlayers) {
      this.setPhase('Showdown');
    }
  }

  getEncryptedBetForPlayer(playerIndex: number): Ciphertext {
    const bet = this.#encryptedBets[playerIndex];
    if (!bet) throw new Error(`Player ${playerIndex} has not shared a coin-bet`);
    return bet;
  }

  getCoinBetForPlayer(playerIndex: number): number {
    return this.#coinBets[playerIndex] ?? 0;
  }

  getCiphertextPartialsForPlayer(playerIndex: number) {
    const ciphertextPartials: Ciphertext[][] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (i === playerIndex) continue;
      if (!this.#partials[i]) {
        throw new Error(`Player ${i} has not shared their partials`);
      }
      const index = i > playerIndex ? playerIndex : playerIndex - 1;
      const partials = this.#partials[i]![index];
      if (!partials) {
        throw new Error(`Player ${i} has not shared partials for player ${playerIndex}`);
      }
      ciphertextPartials.push(partials);
    }
    return ciphertextPartials;
  }

  verifyShowdown(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey },
  ) {
    this.assertPhase('Showdown', 'Not in Showdown phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    if (this.isDealer(playerIndex)) {
      throw new Error('House/dealer cannot submit showdown');
    }
    const hashInput: ShowdownHashInput = {
      publicKeys: this.players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.finalShuffledDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
      ciphertextBet: this.getEncryptedBetForPlayer(playerIndex),
    };
    const expectedInputHash = this.#slot.showdownHash(hashInput);
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }
    this.verifyProof(proof, publicSignals, this.#circuitNames().showdown, 'Invalid showdown proof');
    this.setPhase('Complete');
    return outputHash;
  }
}
