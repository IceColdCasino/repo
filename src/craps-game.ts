import {
  Craps,
  MAX_PLAYERS,
  TOTAL_CARDS,
  parseSharePublicSignals,
  parseBetPublicSignals,
  type ShowdownHashInput,
} from './craps';
import { type Ciphertext, type PublicKey } from './zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { HouseZkGame, IDENTITY_POINT, type CasinoGamePhase } from './zk-game-base';
import { readShuffleProof } from './shuffle-signals';

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
    const transientHashExpected = this.#craps.shuffleHash(this.dice, this.players);
    const { outputDeckHash, inputHash } = readShuffleProof(publicSignals);
    if (inputHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${inputHash}`);
    }
    if (this.#craps.deckHash(privateData.dice.flat()) !== outputDeckHash) {
      throw new Error('Shuffle output hash does not match the dice');
    }
    this.verifyProof(proof, publicSignals, 'shuffle_2_dice_6_main', 'Invalid shuffle proof');
    this.#shuffled.push({ transientHash: inputHash, dice: privateData.dice });
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
    privateData: { publicKey: PublicKey ; coefficientCommitment: bigint },
  ) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertShowdownPlayer(playerIndex);
    const hashInput: ShowdownHashInput = {
      sealCommitment: privateData.coefficientCommitment,
      publicKeys: this.players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.finalShuffledDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
      ciphertextBets: this.getEncryptedBetsForPlayer(playerIndex),
      nActualBets: this.getNActualBetsForPlayer(playerIndex),
      phase: this.#phaseRoll,
      point: this.#point,
    };
    const expectedInputHash = this.#craps.showdownHash({
      ...hashInput,
      sealCommitment: privateData.coefficientCommitment,
    });
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }
    this.verifyProof(proof, publicSignals, 'craps_showdown_hashout_main', 'Invalid showdown proof');
    this.finishShowdown();
    return outputHash;
  }
}
