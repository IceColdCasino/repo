import { War, TOTAL_CARDS, SHOE_SIZE } from './war';
import {
  type PlayerKey,
  type PublicKey,
  type Ciphertext,
} from './zk-casino';
import { padPublicKeysForShuffle } from './shuffle-common';
import { Circuit } from './circuit';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import { GameKind } from './game-config';
import { tryOpenGameSession, shuffleVariant } from './player-zig-session';
import type { PlayerSession } from './player-native-bridge';

export interface WarCircuits {
  register: Circuit;
  shuffle: Circuit;
  share: Circuit;
  showdown: Circuit;
}

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
  winner: bigint;
  publicKey: PublicKey;
  plaintextCards: bigint[];
}

export async function loadWarCircuits(shoeDecks: 1 | 6 | 8 = 6): Promise<WarCircuits> {
  const { GameKind, normalizeGameConfig, shuffleCircuitId } = await import('./game-config');
  const shuffleName = shuffleCircuitId(normalizeGameConfig(GameKind.War, shoeDecks));
  const [register, shuffle, share, showdown] = await Promise.all([
    'register_main',
    shuffleName,
    'war_share_hashout_main',
    'war_showdown_hashout_main',
  ].map(async name => {
    const circuit = new Circuit(name);
    await circuit.load();
    return circuit;
  }));

  return { register: register!, shuffle: shuffle!, share: share!, showdown: showdown! };
}

export class Player {
  #war = new War();
  #key: PlayerKey | undefined;
  #circuits: WarCircuits;
  #balance: bigint = 1000n;
  #tableEscrow: bigint = 0n;

  #shuffleParams: { hash: bigint; permutationMatrix: bigint[]; randomness: bigint[]; deck: Ciphertext[] } | undefined;
  #shareParams: { hash: bigint; randomness: bigint[][]; nActualPlayers: number } | undefined;
  #showdownParams: {
    hash: bigint;
    hashInput: object;
    plaintextCards: bigint[];
    winner: bigint;
    coefficients: bigint[];
  } | undefined;
  #sealedCoefficients: bigint[] | undefined;
  #session: PlayerSession | undefined;
  #padding: Ciphertext | undefined;

  constructor(circuits: WarCircuits) {
    this.#circuits = circuits;
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  /** Host-sealed showdown coeffs. Players never generate these. */
  setSealedCoefficients(coeffs: bigint[]): void {
    if (coeffs.length !== 1) {
      throw new Error(`Expected 1 sealed coefficient, got ${coeffs.length}`);
    }
    if (coeffs[0]! === 0n) {
      throw new Error('Sealed coefficient must be non-zero');
    }
    this.#sealedCoefficients = [...coeffs];
    this.#showdownParams = undefined;
  }

  async init() {
    this.#session = await tryOpenGameSession({
      kind: GameKind.War,
      variant: shuffleVariant(this.#circuits.shuffle.circuitName),
    });
    await this.#war.init();
    if (this.#session) return;
    await this.#circuits.register.load();
    await this.#circuits.shuffle.load();
    await this.#circuits.share.load();
    await this.#circuits.showdown.load();
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) this.#key = this.#war.generatePlayerKey();
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
      throw new Error('Native padding is not cached — call registerProve() first');
    }
    return this.#war.getPadding(this.publicKey);
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
    const publicKey = this.publicKey;
    const privateKey = this.#privateKey;
    const padding = this.padding;

    const { proof, publicSignals } = await this.#circuits.register.prove({
      privateKey,
      publicKey,
    }) as { proof: Groth16Proof; publicSignals: string[] };

    return { proof, publicSignals, publicKey, padding };
  }

  private prepareShuffle(deck: Ciphertext[], publicKeys: PublicKey[]) {
    const hash = this.#war.shuffleHash(deck, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      const permutationMatrix = this.#war.generateShufflePermutation(SHOE_SIZE);
      const randomness = this.#war.generateShuffleRandomness(SHOE_SIZE);
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
    const params = this.prepareShuffle(deck, publicKeys);
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);

    const { ciphertexts, permutationHash } = this.#war.shuffle(
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

    this.#shuffleParams = undefined;

    return { proof, publicSignals, deck: ciphertexts, permutationHash };
  }

  private prepareShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number) {
    if (!this.#shareParams || this.#shareParams.nActualPlayers !== nActualPlayers) {
      const hash = this.#war.shareHash(deck, this.publicKey, publicKeys);
      const randomness = new Array(publicKeys.length).fill(0n)
        .map(() => new Array(TOTAL_CARDS).fill(0n)
          .map(() => this.#war.getRandom()));
      this.#shareParams = { hash, randomness, nActualPlayers };
    }
    return this.#shareParams;
  }

  preloadShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): void {
    if (this.usesZig()) return;
    const params = this.prepareShare(deck, publicKeys, nActualPlayers);
    this.#circuits.share.preloadWitness({
      hash: params.hash,
      ciphertext: deck,
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.randomness,
    });
  }

  async shareProve(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): Promise<ShareOutput> {
    if (this.#session) {
      const out = await this.#session.share(deck, publicKeys, nActualPlayers, this.#key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        ciphertexts: out.ciphertexts,
      };
    }
    const params = this.prepareShare(deck, publicKeys, nActualPlayers);
    const ciphertexts = this.#war.share(
      deck,
      publicKeys,
      this.#privateKey,
      params.randomness,
    );

    const { proof, publicSignals } = await this.#circuits.share.prove({
      hash: params.hash,
      ciphertext: deck,
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.randomness,
    }) as { proof: Groth16Proof; publicSignals: string[] };

    this.#shareParams = undefined;

    return { proof, publicSignals, ciphertexts };
  }

  private prepareShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ) {
    if (!this.#showdownParams) {
      const playerIndex = publicKeys.findIndex(pk =>
        pk.every((value, i) => value === this.publicKey[i]),
      );
      if (playerIndex < 0) throw new Error('Player public key not found');

      if (!this.#sealedCoefficients?.[0]) {
        throw new Error('showdown coefficients must come from the host');
      }
      const coefficient = this.#sealedCoefficients[0];

      const hashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards,
        ciphertextPartials,
      };

      const hash = this.#war.showdownHash(hashInput);
      const plaintextCards = this.#war.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      const winner = BigInt(this.#war.evaluateOutcome(plaintextCards));

      this.#showdownParams = {
        hash,
        hashInput,
        plaintextCards,
        winner,
        coefficients: [coefficient],
      };
    }
    return this.#showdownParams;
  }

  private showdownWitnessInput(params: {
    hash: bigint;
    hashInput: object;
    plaintextCards: bigint[];
    coefficients: bigint[];
  }) {
    return {
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextCards,
      coefficients: params.coefficients.map(c => c.toString()),
    };
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(publicKeys, ciphertextCards, ciphertextPartials);
    this.#circuits.showdown.preloadWitness(this.showdownWitnessInput(params));
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      if (!this.#sealedCoefficients?.[0]) {
        throw new Error('showdown coefficients must come from the host');
      }
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        coefficients: this.#sealedCoefficients,
        privateKey: this.#key?.privateKey,
      });
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        winner: out.winner ?? 0n,
        publicKey: out.publicKey,
        plaintextCards: out.plaintextCards ?? [],
      };
    }
    const params = this.prepareShowdown(publicKeys, ciphertextCards, ciphertextPartials);

    const { proof, publicSignals } = await this.#circuits.showdown.prove(
      this.showdownWitnessInput(params),
    );

    this.#showdownParams = undefined;

    return {
      proof,
      publicSignals,
      winner: params.winner,
      publicKey: this.publicKey,
      plaintextCards: params.plaintextCards,
    };
  }
}