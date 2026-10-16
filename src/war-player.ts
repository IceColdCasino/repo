import { War, TOTAL_CARDS } from './war';
import {
  type PlayerKey,
  type PublicKey,
  type Ciphertext,
} from './zk-casino';
import { padPublicKeysForShuffle } from './shuffle-common';
import { readShuffleProof } from './shuffle-signals';
import { Circuit } from './circuit';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import { GameKind } from './game-config';
import { requireHostShowdownCoefficients, sealCommitment, sealedShowdownWitness } from './host-showdown-coefficients';
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
  #shareParams: {
    hash: bigint;
    randomness: bigint[][];
    nActualPlayers: number;
  } | undefined;
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
  #house: boolean;

  constructor(circuits: WarCircuits, house = false) {
    this.#circuits = circuits;
    this.#house = house;
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  /** Host-sealed showdown coeffs (all 14 seal slots). Players never generate these. */
  setSealedCoefficients(coeffs: bigint[]): void {
    this.#sealedCoefficients = requireHostShowdownCoefficients(coeffs);
    this.#showdownParams = undefined;
  }

  async init() {
    this.#session = await tryOpenGameSession({
      kind: GameKind.War,
      variant: shuffleVariant(this.#circuits.shuffle.circuitName),
      house: this.#house,
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
      const permutationMatrix = this.#war.generateShufflePermutation(deck.length);
      const randomness = this.#war.generateShuffleRandomness(deck.length);
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

    const { ciphertexts } = this.#war.shuffle(
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

    return {
      proof,
      publicSignals,
      deck: ciphertexts,
      permutationHash: readShuffleProof(publicSignals).permutationHash,
    };
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

      const coefficients = requireHostShowdownCoefficients(this.#sealedCoefficients);

      const hashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards,
        ciphertextPartials,
        sealCommitment: sealCommitment(coefficients),
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
        coefficients,
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
      ...(params.hashInput as object),
      ...sealedShowdownWitness(params.hash, params.coefficients, 2),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextCards,
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
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        coefficients: requireHostShowdownCoefficients(this.#sealedCoefficients),
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