import {
  Keno,
  MAX_PLAYERS,
  TOTAL_CARDS,
  KENO_SHOE_SIZE,
  parseSharePublicSignals,
  parseBetPublicSignals,
  type ShowdownHashInput,
} from './keno';
import { type Ciphertext, type PublicKey } from './zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';
import { HouseZkGame, IDENTITY_POINT, type CasinoGamePhase } from './zk-game-base';

export type GamePhase = CasinoGamePhase;
export { IDENTITY_POINT };

export class Game extends HouseZkGame {
  #keno = new Keno();

  constructor(dealerIndex = 0) {
    super({ maxPlayers: MAX_PLAYERS, dealerIndex });
  }

  async init() {
    await this.#keno.init();
  }

  protected override initialDeck(): Ciphertext[] {
    return this.#keno.initialDeck;
  }

  override get finalShuffledDeck() {
    return super.finalShuffledDeck.slice(0, TOTAL_CARDS);
  }

  bet(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; encryptedBets: Ciphertext[]; nActualBets: number },
  ) {
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedHash = this.#keno.betHash(
      privateData.publicKey,
      this.housePublicKey,
      privateData.nActualBets,
    );
    const parsed = parseBetPublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedHash) {
      throw new Error(`Bet hash mismatch: expected ${expectedHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, 'keno_bet_main', 'Invalid bet proof');
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
    privateData: { publicKey: PublicKey; deck: Ciphertext[]; permutationHash: bigint },
  ) {
    this.assertPhase('Shuffle', 'Game is not in shuffle phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    this.assertTurn(playerIndex);
    const signalBigInts = publicSignals.map(s => BigInt(s));
    const transientHashExpected = this.#keno.shuffleHash(this.deck, this.players);
    const transientHash = signalBigInts.pop()!;
    const permutationHash = signalBigInts.pop()!;
    if (transientHash !== transientHashExpected) {
      throw new Error(`Input hash mismatch: expected ${transientHashExpected}, got ${transientHash}`);
    }
    this.verifyProof(proof, publicSignals, 'shuffle_1_deck_80_main', 'Invalid shuffle proof');
    const deckFromSignals: Ciphertext[] = [];
    for (let i = 0; i < KENO_SHOE_SIZE; i++) {
      deckFromSignals.push(signalBigInts.slice(i * 4, i * 4 + 4) as Ciphertext);
    }
    this.shuffledDecks.push({ transientHash, deck: deckFromSignals, permutationHash });
    this.advanceAfterShuffle('Share');
  }

  share(
    proof: Groth16Proof,
    publicSignals: PublicSignals,
    privateData: { publicKey: PublicKey; ciphertexts: Ciphertext[][] },
  ) {
    this.assertPhase('Share', 'Not in Share phase');
    const playerIndex = this.getPlayerIndex(privateData.publicKey);
    const expectedInputHash = this.#keno.shareHash(
      this.finalShuffledDeck,
      privateData.publicKey,
      this.publicKeysShare(playerIndex),
    );
    const parsed = parseSharePublicSignals(publicSignals.map(String));
    if (parsed.inputHash !== expectedInputHash) {
      throw new Error(`Input hash mismatch: expected ${expectedInputHash}, got ${parsed.inputHash}`);
    }
    this.verifyProof(proof, publicSignals, 'keno_share_hashout_main', 'Invalid share partials proof');
    const expectedOutputHash = this.#keno.computeShareOutputHash(
      privateData.ciphertexts,
      this.numPlayers,
    );
    if (parsed.outHash !== expectedOutputHash) {
      throw new Error(`Output hash mismatch: circuit has ${parsed.outHash}, expected ${expectedOutputHash}`);
    }
    this.recordShare(
      playerIndex,
      privateData.ciphertexts,
      true,
      `Player ${playerIndex} must commit a ticket before sharing partials`,
    );
  }

  override getEncryptedBetsForPlayer(playerIndex: number): Ciphertext[] {
    const bets = this.encryptedBets[playerIndex];
    if (!bets) throw new Error(`Player ${playerIndex} has not committed a ticket`);
    return bets;
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
    };
    const expectedInputHash = this.#keno.showdownHash(hashInput);
    const [outputHash, transientHash] = publicSignals.map(s => BigInt(s));
    if (transientHash !== expectedInputHash) {
      throw new Error('Input hash does not match expected');
    }
    this.verifyProof(proof, publicSignals, 'keno_showdown_hashout_main', 'Invalid showdown proof');
    this.finishShowdown();
    return outputHash;
  }
}
