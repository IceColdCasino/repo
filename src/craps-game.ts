import {
  Craps,
  MAX_PLAYERS,
  TOTAL_CARDS,
  N_DICE,
  N_FACES,
  parseSharePublicSignals,
  parseBetPublicSignals,
  type ShowdownHashInput,
} from './craps';
import { type Ciphertext, type PublicKey } from './zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { HouseZkGame, IDENTITY_POINT, type CasinoGamePhase } from './zk-game-base';

interface ShuffledDice {
  transientHash: bigint;
  dice: Ciphertext[][];
}

export type GamePhase = CasinoGamePhase;
export { IDENTITY_POINT };

export class Game extends HouseZkGame {
  #shuffled: ShuffledDice[] = [];
  #craps = new Craps();
  #phaseRoll: number;
  #point: number;

  constructor(dealerIndex = 0, phase = 0, point = 0) {
    super({ maxPlayers: MAX_PLAYERS, dealerIndex });
    this.#phaseRoll = phase;
    this.#point = point;
  }

  get tablePhase() {
    return this.#phaseRoll;
  }

  get tablePoint() {
    return this.#point;
  }

  async init() {
    await this.#craps.init();
  }

  protected override initialDeck(): Ciphertext[] {
    return this.#craps.initialDeck;
  }

  get dice() {
    return this.#shuffled.length < 1
      ? this.#craps.initialDice
      : this.#shuffled[this.#shuffled.length - 1]!.dice;
  }

  override get finalShuffledDeck() {
    if (this.#shuffled.length < this.numPlayers) {
      throw new Error('Not all players have shuffled');
    }
    return this.dice.map(die => die[0]!);
  }

  bet(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; encryptedBets: Ciphertext[]; nActualBets: number },
  ) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedHash = this.#craps.betHash(
      privateData.publicKey,
      this.housePublicKey,
      privateData.nActualBets,
    );
    const parsed = parseBetPublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedHash) {
      throw new Error(`Bet hash mismatch: expected ${expectedHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, 'craps_bet_main', 'Invalid bet proof');
    this.recordSealedBets(
      playerIndex,
      privateData.encryptedBets,
      privateData.nActualBets,
      parsed.encryptedBets[0]!,
    );
  }

  shuffle(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; dice: Ciphertext[][] },
  ) {
    this.assertPhase('Shuffle', 'Game is not in shuffle phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertTurn(playerIndex);
    const signalBigInts = publicSignals.map(s => BigInt(s));
    const transientHashExpected = this.#craps.shuffleHash(this.dice, this.players);
    const transientHash = signalBigInts.pop()!;
    if (transientHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${transientHash}`);
    }
    this.verifyProof(proof, publicSignals, 'shuffle_2_dice_6_main', 'Invalid shuffle proof');
    const diceFromSignals: Ciphertext[][] = [];
    for (let d = 0; d < N_DICE; d++) {
      const faces: Ciphertext[] = [];
      for (let f = 0; f < N_FACES; f++) {
        const i = (d * N_FACES + f) * 4;
        faces.push(signalBigInts.slice(i, i + 4) as Ciphertext);
      }
      diceFromSignals.push(faces);
    }
    this.#shuffled.push({ transientHash, dice: diceFromSignals });
    this.advanceAfterShuffle('Share');
  }

  share(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; ciphertexts: Ciphertext[][] },
  ) {
    this.assertPhase('Share', 'Not in Share phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedInputHash = this.#craps.shareHash(
      this.finalShuffledDeck,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );
    const parsed = parseSharePublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedInputHash) {
      throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, 'craps_share_hashout_main', 'Invalid share partials proof');
    const expectedOutputHash = this.#craps.computeShareOutputHash(
      privateData.ciphertexts,
      this.numPlayers,
    );
    if (parsed.outHash !== expectedOutputHash) {
      throw new Error(`Output hash mismatch: circuit has ${parsed.outHash}, expected ${expectedOutputHash}`);
    }
    this.recordShare(playerIndex, privateData.ciphertexts, true);
  }

  override getCiphertextPartialsForPlayer(playerIndex: number) {
    return super.getCiphertextPartialsForPlayer(playerIndex, TOTAL_CARDS);
  }

  verifyShowdown(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey },
  ) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertShowdownPlayer(playerIndex);
    const hashInput: ShowdownHashInput = {
      publicKeys: this.players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.finalShuffledDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
      ciphertextBets: this.getEncryptedBetsForPlayer(playerIndex),
      nActualBets: this.getNActualBetsForPlayer(playerIndex),
      phase: this.#phaseRoll,
      point: this.#point,
    };
    const expectedInputHash = this.#craps.showdownHash(hashInput);
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }
    this.verifyProof(proof, publicSignals, 'craps_showdown_hashout_main', 'Invalid showdown proof');
    this.finishShowdown();
    return outputHash;
  }
}
