import {
  Roulette,
  MAX_PLAYERS,
  TOTAL_CARDS,
  parseSharePublicSignals,
  parseBetPublicSignals,
  type RouletteVariant,
  type ShowdownHashInput,
} from './roulette';
import { type Ciphertext, type PublicKey } from './zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { HouseZkGame, IDENTITY_POINT, type CasinoGamePhase } from './zk-game-base';

export type GamePhase = CasinoGamePhase;
export { MAX_PLAYERS, TOTAL_CARDS, IDENTITY_POINT };

export interface ShufflePrivateData {
  publicKey: PublicKey;
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface BetPrivateData {
  publicKey: PublicKey;
  encryptedBets: Ciphertext[];
  nActualBets: number;
}

export interface SharePrivateData {
  publicKey: PublicKey;
  ciphertexts: Ciphertext[][];
}

export interface ShowdownPrivateData {
  publicKey: PublicKey;
}

export class Game extends HouseZkGame {
  #roulette: Roulette;
  #variant: RouletteVariant;

  constructor(variant: RouletteVariant, dealerIndex = 0) {
    super({ maxPlayers: MAX_PLAYERS, dealerIndex });
    this.#variant = variant;
    this.#roulette = new Roulette(variant);
  }

  get variant() {
    return this.#variant;
  }

  get deckSize() {
    return this.#roulette.deckSize;
  }

  async init() {
    await this.#roulette.init();
  }

  protected override initialDeck(): Ciphertext[] {
    return this.#roulette.initialDeck;
  }

  override get finalShuffledDeck() {
    return super.finalShuffledDeck.slice(0, TOTAL_CARDS);
  }

  #circuitNames() {
    return {
      shuffle: `shuffle_1_deck_${this.#variant}_main`,
      share: 'roulette_share_hashout_main',
      showdown: `roulette_showdown_${this.#variant}_hashout_main`,
    } as const;
  }

  shuffle(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShufflePrivateData) {
    this.assertPhase('Shuffle', 'Game is not in shuffle phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertTurn(playerIndex);
    const signalBigInts = publicSignals.map(s => BigInt(s));
    const transientHashExpected = this.#roulette.shuffleHash(this.deck, this.players);
    const transientHash = signalBigInts.pop()!;
    const permutationHash = signalBigInts.pop()!;
    if (transientHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${transientHash}`);
    }
    this.verifyProof(proof, publicSignals, this.#circuitNames().shuffle, 'Invalid shuffle proof');
    const deckFromSignals: Ciphertext[] = [];
    for (let i = 0; i < this.deckSize; i++) {
      deckFromSignals.push(signalBigInts.slice(i * 4, i * 4 + 4) as Ciphertext);
    }
    this.shuffledDecks.push({ transientHash, deck: deckFromSignals, permutationHash });
    this.advanceAfterShuffle('Share');
  }

  bet(proof: Groth16Proof, publicSignals: PublicSignals, privateData: BetPrivateData) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedHash = this.#roulette.betHash(
      privateData.publicKey,
      this.housePublicKey,
      privateData.nActualBets,
    );
    const parsed = parseBetPublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedHash) {
      throw new Error(`Bet hash mismatch: expected ${expectedHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(
      proof,
      publicSignals,
      `roulette_bet_${this.#variant}_main`,
      'Invalid bet proof',
    );
    this.recordSealedBets(
      playerIndex,
      privateData.encryptedBets,
      privateData.nActualBets,
      parsed.encryptedBets[0]!,
    );
  }

  share(proof: Groth16Proof, publicSignals: PublicSignals, privateData: SharePrivateData) {
    this.assertPhase('Share', 'Not in Share phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedInputHash = this.#roulette.shareHash(
      this.finalShuffledDeck,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );
    const parsed = parseSharePublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedInputHash) {
      throw new Error(
        `Input hash mismatch: expected ${expectedInputHash}, got ${parsed.inputHash}`,
      );
    }
    this.verifyProof(proof, publicSignals, this.#circuitNames().share, 'Invalid share partials proof');
    const expectedOutputHash = this.#roulette.computeShareOutputHash(
      privateData.ciphertexts,
      this.numPlayers,
    );
    if (parsed.outHash !== expectedOutputHash) {
      throw new Error(
        `Output hash mismatch: circuit has ${parsed.outHash}, expected ${expectedOutputHash}`,
      );
    }
    this.recordShare(playerIndex, privateData.ciphertexts, true);
  }

  override getEncryptedBetsForPlayer(playerIndex: number): Ciphertext[] {
    const bets = this.encryptedBets[playerIndex];
    if (!bets) {
      throw new Error(`Player ${playerIndex} has not shared encrypted bets`);
    }
    return bets;
  }

  override getCiphertextPartialsForPlayer(playerIndex: number) {
    return super.getCiphertextPartialsForPlayer(playerIndex, TOTAL_CARDS);
  }

  verifyShowdown(proof: Groth16Proof, publicSignals: PublicSignals, privateData: ShowdownPrivateData) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertShowdownPlayer(playerIndex);
    const hashInput: ShowdownHashInput = {
      publicKeys: this.players,
      playerIndex: BigInt(playerIndex),
      ciphertextCards: this.finalShuffledDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
      ciphertextBets: this.getEncryptedBetsForPlayer(playerIndex),
      nActualBets: this.getNActualBetsForPlayer(playerIndex),
    };
    const expectedInputHash = this.#roulette.showdownHash(hashInput);
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }
    this.verifyProof(proof, publicSignals, this.#circuitNames().showdown, 'Invalid showdown proof');
    this.finishShowdown();
    return outputHash;
  }
}
