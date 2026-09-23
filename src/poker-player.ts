import {
  Poker,
  MAX_PLAYERS,
  type PlayerKey,
  type PublicKey,
  type Ciphertext,
} from './poker';
import { padPublicKeysForShuffle } from './shuffle-common';
import { SHARE_OTHER_SLOTS } from './share-common';
import { TOTAL_CARDS } from './poker-game';
import { shareCardMask } from './backend/card-layout';
import type { Circuits } from './circuit-manager';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import * as nativePlayer from './player-native-bridge';
import type { PlayerSession } from './player-native-bridge';
import { requireHostShowdownCoefficients } from './host-showdown-coefficients';

export interface RegisterOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  publicKey: PublicKey;
  padding: Ciphertext;
}

export interface ShuffleOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface ShareOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  winnerMasks: bigint[];
  publicKey: PublicKey;
  coefficientCommitment: bigint;
}

interface PokerShowdownParams {
  hash: bigint;
  hashInput: object;
  plaintextCards: bigint[];
  winnerMasks: bigint[];
  coefficients: bigint[];
}

export class Player {
  #poker = new Poker();
  #key: PlayerKey | undefined;
  #padding: Ciphertext | undefined;
  #circuits: Circuits;
  #balance: bigint = 1000n;
  #tableEscrow: bigint = 0n;

  // Prepared params for witness preloading (randomness generated once, used by both preload and prove)
  #shuffleParams: { hash: bigint; permutationMatrix: bigint[]; randomness: bigint[]; deck: Ciphertext[] } | undefined;
  #shareParams: { hash: bigint; cardMask: bigint; randomness: bigint[][]; nActualPlayers: number } | undefined;
  #showdownParams: PokerShowdownParams | undefined;
  /** Host-sealed showdown coeffs (Arcis `seal_showdown_coefficients` or local host). */
  #sealedCoefficients: bigint[] | undefined;
  /** Zig player (window.zero or host FFI). When set, Groth16 never runs in TypeScript. */
  #session: PlayerSession | undefined;

  constructor(circuits: Circuits) {
    this.#circuits = circuits;
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  /**
   * Use Arcis-sealed coefficients for the next showdown proof.
   * Must be 9 non-zero u128 values decrypted from SealedShowdownCoefficients.
   */
  setSealedCoefficients(coeffs: bigint[]): void {
    this.#sealedCoefficients = requireHostShowdownCoefficients(coeffs, MAX_PLAYERS - 1);
    this.#showdownParams = undefined;
  }

  async init() {
    if (await this.#openZigSession()) return;
    await this.#poker.init();
    await this.#circuits.register.load();
    await this.#circuits.shuffle.load();
    await this.#circuits.share.load();
    await this.#circuits.showdown.load();
  }

  async #openZigSession(): Promise<boolean> {
    if (this.#session) return true;
    if (nativePlayer.hasPlayerBridge()) {
      this.#session = nativePlayer.openWindowSession();
      return true;
    }
    const ffi = await import('./player-bridge-ffi');
    ffi.requirePlayerBridge();
    this.#session = ffi.openSession();
    return true;
  }

  /**
   * Native shell: Zig `player` owns keygen + prove. circomlib / BridgeCircuit
   * load only when the native player bridge is absent.
   */
  async initForNativeBridge(
    getSharedPoker?: () => Promise<Poker>,
    opts?: { registerOnly?: boolean },
  ) {
    if (await this.#openZigSession()) {
      return;
    }
    if (!getSharedPoker) {
      throw new Error('native player bridge is required');
    }
    this.#poker = await getSharedPoker();
    await this.#circuits.register.load();
    if (opts?.registerOnly) {
      void this.#ensureRemainingNativeCircuits();
      return;
    }
    await this.#ensureRemainingNativeCircuits();
  }

  async #ensureRemainingNativeCircuits(): Promise<void> {
    await Promise.all([
      this.#circuits.shuffle.load(),
      this.#circuits.share.load(),
      this.#circuits.showdown.load(),
    ]);
  }

  /** Await shuffle/share/showdown circuit load (no-op on the native player bridge). */
  async ensureNativeCircuitsForPhase(
    phase: 'Shuffle' | 'Share' | 'Showdown',
  ): Promise<void> {
    if (this.usesZig()) return;
    if (phase === 'Shuffle') {
      await this.#circuits.shuffle.load();
      return;
    }
    if (phase === 'Share') {
      await this.#circuits.share.load();
      return;
    }
    await this.#circuits.showdown.load();
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) {
      this.#key = this.#poker.generatePlayerKey();
    }
  }

  async ensureKey(): Promise<void> {
    if (this.#session) {
      const minted = this.#key
        ? await this.#session.key(this.#key.privateKey)
        : await this.#session.key();
      this.#key = minted.key;
      this.#padding = minted.padding;
      return;
    }
    if (this.#key) return;
    this.generateKey();
  }

  /** Restore a previously generated ElGamal key (e.g. after WebView reload mid-hand). */
  loadPlayerKey(key: PlayerKey): void {
    this.#key = key;
    this.#padding = undefined;
    this.#shuffleParams = undefined;
    this.#shareParams = undefined;
    this.#showdownParams = undefined;
    this.#sealedCoefficients = undefined;
  }

  get publicKey() {
    if (!this.#key) {
      throw new Error('Key not yet generated');
    }
    return this.#key.publicKey;
  }

  get padding() {
    if (this.#padding) return this.#padding;
    if (this.usesZig()) {
      throw new Error('Native padding is not cached — call registerProve() / ensureKey() first');
    }
    return this.#poker.getPadding(this.publicKey);
  }

  /** ElGamal secret key for local UI card decryption from revealed partials. */
  get elGamalPrivateKey(): bigint {
    return this.#privateKey;
  }

  get #privateKey() {
    if (!this.#key) {
      throw new Error('Key not yet generated');
    }

    assert(this.#key.privateKey > 1024n, 'Private Key is too small');

    return this.#key.privateKey;
  }

  setBalance(balance: bigint) {
    this.#balance = balance;
  }

  get balance(): bigint {
    return this.#balance;
  }

  get chips(): number {
    return Number(this.#balance);
  }

  addChips(amount: number) {
    this.#balance += BigInt(amount);
  }

  setTableEscrow(amount: bigint) {
    this.#tableEscrow = amount;
    this.#balance -= amount;
  }

  get tableEscrow(): bigint {
    return this.#tableEscrow;
  }

  async registerProve(): Promise<RegisterOutput> {
    if (this.#session) {
      const out = await this.#session.register(this.#key?.privateKey);
      this.#key = out.key;
      this.#padding = out.padding;
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        publicKey: out.key.publicKey,
        padding: out.padding,
      };
    }
    await this.ensureKey();
    const publicKey = this.publicKey;
    const privateKey = this.#privateKey;
    const padding = this.padding;

    const { proof, publicSignals } = await this.#circuits.register.prove({
      privateKey,
      publicKey,
    }) as { proof: any; publicSignals: string[] };

    return {
      proof,
      publicSignals,
      publicKey,
      padding,
    };
  }

  private prepareShuffle(deck: Ciphertext[], publicKeys: PublicKey[]) {
    // Always compute hash to detect deck content changes, since game.deck
    // returns a new array reference each time but content may be identical.
    const hash = this.#poker.shuffleHash(deck, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      const permutationMatrix = this.#poker.generateShufflePermutation();
      const randomness = this.#poker.generateShuffleRandomness();
      this.#shuffleParams = { hash, permutationMatrix, randomness, deck };
    }
    return this.#shuffleParams;
  }

  preloadShuffle(deck: Ciphertext[], publicKeys: PublicKey[]): void {
    if (this.usesZig()) return;
    const params = this.prepareShuffle(deck, publicKeys);
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);
    this.#circuits.shuffle.preloadWitness({
      hash: params.hash,
      deck,
      publicKeys: shuffleKeys,
      permutationMatrix: params.permutationMatrix,
      randomness: params.randomness,
    });
  }

  async shuffleProve(deck: Ciphertext[], publicKeys: PublicKey[]): Promise<ShuffleOutput> {
    if (this.#session) {
      const out = await this.#session.shuffle(deck, publicKeys, this.#key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        deck: out.deck,
        permutationHash: out.permutationHash,
      };
    }
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);
    const params = this.prepareShuffle(deck, publicKeys);

    const { ciphertexts, permutationHash } = this.#poker.shuffle(
      deck,
      shuffleKeys,
      params.permutationMatrix,
      params.randomness,
    );
    const { proof, publicSignals } = await this.#circuits.shuffle.prove({
      hash: params.hash,
      deck,
      publicKeys: shuffleKeys,
      permutationMatrix: params.permutationMatrix,
      randomness: params.randomness,
    });

    // Clear prepared params after use
    this.#shuffleParams = undefined;

    return {
      proof,
      publicSignals,
      deck: ciphertexts,
      permutationHash,
    };
  }

  private prepareShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number) {
    const expectedOthers = SHARE_OTHER_SLOTS;
    if (publicKeys.length !== expectedOthers) {
      throw new Error(`Expected ${expectedOthers} share recipient keys, got ${publicKeys.length}`);
    }
    const cardMask = shareCardMask(nActualPlayers);
    const hash = this.#poker.shareHash(deck, cardMask, this.publicKey, publicKeys);
    if (!this.#shareParams || this.#shareParams.hash !== hash) {
      const randomness = new Array(expectedOthers).fill(0n)
        .map(() => new Array(TOTAL_CARDS).fill(0n)
          .map(() => this.#poker.getRandom())
        );
      this.#shareParams = { hash, cardMask, randomness, nActualPlayers };
    }
    return this.#shareParams;
  }

  preloadShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): void {
    if (this.usesZig()) return;
    const params = this.prepareShare(deck, publicKeys, nActualPlayers);
    this.#circuits.share.preloadWitness({
      hash: params.hash,
      ciphertext: deck,
      cardMask: params.cardMask.toString(),
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers: params.nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.randomness,
    });
  }

  /** Witness-only share partials (no Groth16) — for fixture generation. */
  sharePartialsOnly(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): Ciphertext[][] {
    const params = this.prepareShare(deck, publicKeys, nActualPlayers);
    return this.#poker.share(deck, params.cardMask, publicKeys, this.#privateKey, params.randomness);
  }

  async shareProve(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): Promise<ShareOutput> {
    if (this.#session) {
      await this.ensureKey();
      const out = await this.#session.share(deck, publicKeys, nActualPlayers, this.#privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        ciphertexts: out.ciphertexts,
      };
    }
    try {
      const params = this.prepareShare(deck, publicKeys, nActualPlayers);

      const ciphertexts = this.#poker.share(deck, params.cardMask, publicKeys, this.#privateKey, params.randomness);

      const { proof, publicSignals } = await this.#circuits.share.prove({
        hash: params.hash,
        ciphertext: deck,
        cardMask: params.cardMask.toString(),
        publicKey: this.publicKey,
        publicKeys,
        nActualPlayers: params.nActualPlayers,
        privateKey: this.#privateKey,
        randomness: params.randomness,
      }) as { proof: any; publicSignals: string[] };

      return {
        proof,
        publicSignals,
        ciphertexts,
      };
    } finally {
      this.#shareParams = undefined;
    }
  }

  private prepareShowdown(
    playerIndex: number,
    publicKeys: PublicKey[],
    potMasks: bigint[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    sealedCoefficients?: bigint[],
  ) {
    if (!this.#showdownParams) {
      const publicKey = this.publicKey;
      const coefficients = requireHostShowdownCoefficients(
        sealedCoefficients ?? this.#sealedCoefficients,
        MAX_PLAYERS - 1,
      );

      const hashInput = {
        publicKeys,
        potMasks,
        ciphertextCards,
        playerIndex: BigInt(playerIndex),
        publicKey,
        ciphertextPartials,
      };
      const hash = this.#poker.showdownHash(hashInput);
      const coefficientCommitment = this.#poker.computeCoefficientCommitment(coefficients);
      const plaintextCards = this.#poker.decryptCards(this.#privateKey, potMasks[0]!, ciphertextCards, ciphertextPartials);
      const winnerMasks = this.#poker.compareHands(potMasks, plaintextCards);

      this.#showdownParams = {
        hash,
        hashInput: { ...hashInput, coefficientCommitment },
        plaintextCards,
        winnerMasks,
        coefficients,
      };
    }
    return this.#showdownParams!;
  }

  preloadShowdown(
    playerIndex: number,
    publicKeys: PublicKey[],
    potMasks: bigint[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][]
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(playerIndex, publicKeys, potMasks, ciphertextCards, ciphertextPartials);
    this.#circuits.showdown.preloadWitness(this.showdownWitnessInput(params));
  }

  /** Winner masks from decrypted cards — same for every non-folded player. */
  previewShowdownWinnerMasks(
    playerIndex: number,
    publicKeys: PublicKey[],
    potMasks: bigint[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): bigint[] {
    if (this.#session) {
      return nativePlayer.showdownPreviewSync(this.#session, {
        publicKeys,
        potMasks,
        playerIndex,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        privateKey: this.#key?.privateKey,
      });
    }
    // Preview ranks hands only. Host-sealed coefficients are required later
    // for Groth16 prove, after Arcis `seal_showdown_coefficients`.
    const plaintextCards = this.#poker.decryptCards(
      this.#privateKey,
      potMasks[0]!,
      ciphertextCards,
      ciphertextPartials,
    );
    return [...this.#poker.compareHands(potMasks, plaintextCards)];
  }

  async previewShowdownWinnerMasksAsync(
    playerIndex: number,
    publicKeys: PublicKey[],
    potMasks: bigint[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): Promise<bigint[]> {
    if (this.#session) {
      await this.ensureKey();
      const out = await this.#session.showdown({
        publicKeys,
        potMasks,
        playerIndex,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        privateKey: this.#privateKey,
        prove: false,
      });
      if (!out.winnerMasks) throw new Error('poker showdown missing winner masks');
      return [...out.winnerMasks];
    }
    return this.previewShowdownWinnerMasks(
      playerIndex,
      publicKeys,
      potMasks,
      ciphertextCards,
      ciphertextPartials,
    );
  }

  async showdownProve(
    playerIndex: number,
    publicKeys: PublicKey[],
    potMasks: bigint[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][]
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      await this.ensureKey();
      const out = await this.#session.showdown({
        publicKeys,
        potMasks,
        playerIndex,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        coefficients: requireHostShowdownCoefficients(this.#sealedCoefficients, MAX_PLAYERS - 1),
        privateKey: this.#privateKey,
      });
      if (!out.winnerMasks || out.coefficientCommitment === undefined || !out.publicSignals) {
        throw new Error('poker showdown missing outputs');
      }
      this.#showdownParams = undefined;
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        winnerMasks: out.winnerMasks,
        publicKey: out.publicKey,
        coefficientCommitment: out.coefficientCommitment,
      };
    }
    const params = this.prepareShowdown(playerIndex, publicKeys, potMasks, ciphertextCards, ciphertextPartials);

    const { proof, publicSignals } = await this.#circuits.showdown.prove(this.showdownWitnessInput(params));

    // Clear prepared params after use
    this.#showdownParams = undefined;

    return {
      proof,
      publicSignals,
      winnerMasks: params.winnerMasks,
      publicKey: this.publicKey,
      coefficientCommitment: (params.hashInput as { coefficientCommitment: bigint }).coefficientCommitment,
    };
  }

  /** Circuit inputs only — omit hash-only fields like coefficientCommitment. */
  private showdownWitnessInput(params: PokerShowdownParams) {
    const { coefficientCommitment: _omit, ...circuitHashInput } = params.hashInput as {
      coefficientCommitment: bigint;
      [key: string]: unknown;
    };
    return {
      hash: params.hash,
      ...circuitHashInput,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextCards,
      coefficients: params.coefficients.map(c => c.toString()),
    };
  }
}