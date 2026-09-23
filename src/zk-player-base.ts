import assert from 'assert';
import type { Groth16Proof } from 'snarkjs';
import { Circuit } from './circuit';
import { padPublicKeysForShuffle } from './shuffle-common';
import { publicKeysEqual } from './zk-game-base';
import type { Ciphertext, PlayerKey, PrivateKey, PublicKey } from './zk-casino';
import type { ZkCrypto } from './zk-crypto-base';

export interface RegisterOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  publicKey: PublicKey;
  padding: Ciphertext;
}

export interface DeckShuffleOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface LinearShareOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}

export interface RegisterCircuitSet {
  register: Circuit;
}

export async function loadNamedCircuits(names: string[]): Promise<Circuit[]> {
  return Promise.all(names.map(async name => {
    const circuit = new Circuit(name);
    await circuit.load();
    return circuit;
  }));
}

export interface DeckShuffleCrypto {
  shuffleHash(deck: Ciphertext[], publicKeys: PublicKey[]): bigint;
  generateShufflePermutation(numCards?: number): bigint[];
  generateShuffleRandomness(numCards?: number): bigint[];
  shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ): { ciphertexts: Ciphertext[]; permutationHash: bigint };
}

export interface LinearShareCrypto {
  shareHash(deck: Ciphertext[], publicKey: PublicKey, publicKeys: PublicKey[]): bigint;
  share(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    privateKey: PrivateKey,
    cardRandomness: bigint[][],
  ): Ciphertext[][];
  getRandom(max?: number): bigint;
}

/**
 * Keying, registration, sealed showdown coeffs, and the standard deck
 * shuffle / linear-share prove loop shared by every table Player.
 */
export abstract class ZkPlayer<C extends RegisterCircuitSet> {
  protected key: PlayerKey | undefined;
  protected circuits: C;
  protected sealedCoefficients: bigint[] | undefined;
  protected shuffleParams: {
    hash: bigint;
    permutationMatrix: bigint[];
    randomness: bigint[];
    deck: Ciphertext[];
  } | undefined;
  protected shareParams: {
    hash: bigint;
    cardRandomness: bigint[][];
    nActualPlayers: number;
  } | undefined;
  protected showdownParams: {
    hash: bigint;
    hashInput: object;
    coefficients: bigint[];
  } | undefined;

  constructor(circuits: C) {
    this.circuits = circuits;
  }

  protected abstract get crypto(): ZkCrypto;

  protected circuitsToLoad(): Circuit[] {
    return Object.values(this.circuits);
  }

  async init(): Promise<void> {
    await this.crypto.init();
    await Promise.all(this.circuitsToLoad().map(circuit => circuit.load()));
  }

  generateKey(): void {
    if (!this.key) this.key = this.crypto.generatePlayerKey();
  }

  get publicKey(): PublicKey {
    if (!this.key) throw new Error('Key not yet generated');
    return this.key.publicKey;
  }

  get padding(): Ciphertext {
    return this.crypto.getPadding(this.publicKey);
  }

  protected get privateKey(): PrivateKey {
    if (!this.key) throw new Error('Key not yet generated');
    assert(this.key.privateKey > 1024n, 'Private Key is too small');
    return this.key.privateKey;
  }

  setSealedCoefficients(coeffs: bigint[], expectedLen?: number): void {
    const need = expectedLen ?? coeffs.length;
    if (coeffs.length !== need) {
      throw new Error(`Expected ${need} sealed coefficients, got ${coeffs.length}`);
    }
    if (coeffs.some(c => c === 0n)) {
      throw new Error('Sealed coefficient must be non-zero');
    }
    this.sealedCoefficients = [...coeffs];
    this.showdownParams = undefined;
  }

  async registerProve(): Promise<RegisterOutput> {
    const publicKey = this.publicKey;
    const padding = this.padding;
    const { proof, publicSignals } = await this.circuits.register.prove({
      privateKey: this.privateKey,
      publicKey,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    return { proof, publicSignals, publicKey, padding };
  }

  protected indexOfSelf(publicKeys: PublicKey[]): number {
    const playerIndex = publicKeys.findIndex(pk => publicKeysEqual(pk, this.publicKey));
    if (playerIndex < 0) throw new Error('Player public key not found');
    return playerIndex;
  }

  protected requireHostCoefficients(count: number): bigint[] {
    if (!this.sealedCoefficients || this.sealedCoefficients.length !== count) {
      throw new Error(
        `showdown coefficients must come from the host (expected ${count}, got ${this.sealedCoefficients?.length ?? 0})`,
      );
    }
    if (this.sealedCoefficients.some((value) => value === 0n)) {
      throw new Error('Host showdown coefficient must be non-zero');
    }
    return [...this.sealedCoefficients];
  }

  protected prepareDeckShuffle(
    crypto: DeckShuffleCrypto,
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    numCards?: number,
  ) {
    const hash = crypto.shuffleHash(deck, publicKeys);
    if (!this.shuffleParams || this.shuffleParams.hash !== hash) {
      this.shuffleParams = {
        hash,
        permutationMatrix: crypto.generateShufflePermutation(numCards),
        randomness: crypto.generateShuffleRandomness(numCards),
        deck,
      };
    }
    return this.shuffleParams;
  }

  protected preloadDeckShuffle(
    crypto: DeckShuffleCrypto,
    circuit: Circuit,
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    numCards?: number,
  ): void {
    const params = this.prepareDeckShuffle(crypto, deck, publicKeys, numCards);
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);
    circuit.preloadWitness({
      hash: params.hash,
      deck,
      publicKeys: shuffleKeys,
      permutationMatrix: params.permutationMatrix,
      randomness: params.randomness,
    });
  }

  protected async proveDeckShuffle(
    crypto: DeckShuffleCrypto,
    circuit: Circuit,
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    numCards?: number,
  ): Promise<DeckShuffleOutput> {
    const params = this.prepareDeckShuffle(crypto, deck, publicKeys, numCards);
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);
    const { ciphertexts, permutationHash } = crypto.shuffle(
      deck,
      shuffleKeys,
      params.permutationMatrix,
      params.randomness,
    );
    const { proof, publicSignals } = await circuit.prove({
      hash: params.hash,
      deck,
      publicKeys: shuffleKeys,
      permutationMatrix: params.permutationMatrix,
      randomness: params.randomness,
    });
    this.shuffleParams = undefined;
    return { proof, publicSignals, deck: ciphertexts, permutationHash };
  }

  protected prepareLinearShare(
    crypto: LinearShareCrypto,
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
    cardsPerShare: number,
  ) {
    if (!this.shareParams || this.shareParams.nActualPlayers !== nActualPlayers) {
      this.shareParams = {
        hash: crypto.shareHash(deck, this.publicKey, publicKeys),
        cardRandomness: publicKeys.map(() =>
          Array.from({ length: cardsPerShare }, () => crypto.getRandom()),
        ),
        nActualPlayers,
      };
    }
    return this.shareParams;
  }

  protected linearShareWitness(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    params: NonNullable<ZkPlayer<C>['shareParams']>,
  ) {
    return {
      hash: params.hash,
      ciphertext: deck,
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers: params.nActualPlayers,
      privateKey: this.privateKey,
      randomness: params.cardRandomness,
    };
  }

  protected preloadLinearShare(
    crypto: LinearShareCrypto,
    circuit: Circuit,
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
    cardsPerShare: number,
  ): void {
    const params = this.prepareLinearShare(crypto, deck, publicKeys, nActualPlayers, cardsPerShare);
    circuit.preloadWitness(this.linearShareWitness(deck, publicKeys, params));
  }

  protected async proveLinearShare(
    crypto: LinearShareCrypto,
    circuit: Circuit,
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
    cardsPerShare: number,
  ): Promise<LinearShareOutput> {
    const params = this.prepareLinearShare(crypto, deck, publicKeys, nActualPlayers, cardsPerShare);
    const ciphertexts = crypto.share(deck, publicKeys, this.privateKey, params.cardRandomness);
    const { proof, publicSignals } = await circuit.prove(
      this.linearShareWitness(deck, publicKeys, params),
    ) as { proof: Groth16Proof; publicSignals: string[] };
    this.shareParams = undefined;
    return { proof, publicSignals, ciphertexts };
  }
}
