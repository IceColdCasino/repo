import { Slot, parseSlotSharePublicSignals, type SlotVariant } from './slot';
import { type PlayerKey, type PublicKey, type Ciphertext } from './zk-casino';
import { Circuit } from './circuit';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import { GameKind } from './game-config';
import { tryOpenGameSession } from './player-zig-session';
import type { PlayerSession } from './player-native-bridge';

export interface SlotCircuits {
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
  reels: Ciphertext[][];
  permutationHash: bigint;
}

export interface ShareOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
  encryptedBets: Ciphertext[];
  coinBet: number;
}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  payout: number;
  publicKey: PublicKey;
  plaintextCenters: bigint[];
}

function circuitNames(variant: SlotVariant) {
  return {
    shuffle: `shuffle_${variant}_reel_22_main`,
    share: `slot_share_${variant}_reel_hashout_main`,
    showdown: `slot_showdown_${variant}_reel_hashout_main`,
  } as const;
}

export async function loadSlotCircuits(variant: SlotVariant): Promise<SlotCircuits> {
  const names = circuitNames(variant);
  const [register, shuffle, share, showdown] = await Promise.all([
    'register_main',
    names.shuffle,
    names.share,
    names.showdown,
  ].map(async name => {
    const circuit = new Circuit(name);
    await circuit.load();
    return circuit;
  }));
  return { register: register!, shuffle: shuffle!, share: share!, showdown: showdown! };
}

export class Player {
  #slot: Slot;
  #key: PlayerKey | undefined;
  #circuits: SlotCircuits;
  #shuffleParams: {
    hash: bigint;
    permutationMatrices: bigint[][];
    randomness: bigint[][];
    reels: Ciphertext[][];
  } | undefined;
  #shareParams: {
    hash: bigint;
    cardRandomness: bigint[][];
    betRandomness: bigint[];
    coinBet: number;
  } | undefined;
  #showdownParams: {
    hash: bigint;
    hashInput: object;
    plaintextCenters: bigint[];
    payout: number;
    coefficients: bigint[];
  } | undefined;
  #sealedCoefficients: bigint[] | undefined;
  #session: PlayerSession | undefined;
  #padding: Ciphertext | undefined;

  constructor(circuits: SlotCircuits, variant: SlotVariant) {
    this.#circuits = circuits;
    this.#slot = new Slot(variant);
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  get nReels() {
    return this.#slot.nReels;
  }

  async init() {
    this.#session = await tryOpenGameSession({
      kind: GameKind.Slots,
      variant: this.nReels,
    });
    await this.#slot.init();
    if (this.#session) return;
    await Promise.all([
      this.#circuits.register.load(),
      this.#circuits.shuffle.load(),
      this.#circuits.share.load(),
      this.#circuits.showdown.load(),
    ]);
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) this.#key = this.#slot.generatePlayerKey();
  }

  get publicKey() {
    if (!this.#key) throw new Error('Key not yet generated');
    return this.#key.publicKey;
  }

  get padding() {
    if (this.#padding) return this.#padding;
    if (this.usesZig()) {
      throw new Error('Native padding is not cached — call registerProve() first');
    }
    return this.#slot.getPadding(this.publicKey);
  }

  get #privateKey() {
    if (!this.#key) throw new Error('Key not yet generated');
    assert(this.#key.privateKey > 1024n, 'Private Key is too small');
    return this.#key.privateKey;
  }

  setSealedCoefficients(coeffs: bigint[]): void {
    if (coeffs.length !== 1) throw new Error(`Expected 1 sealed coefficient, got ${coeffs.length}`);
    if (coeffs[0]! === 0n) throw new Error('Sealed coefficient must be non-zero');
    this.#sealedCoefficients = [...coeffs];
    this.#showdownParams = undefined;
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
    const padding = this.padding;
    const { proof, publicSignals } = await this.#circuits.register.prove({
      privateKey: this.#privateKey,
      publicKey,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    return { proof, publicSignals, publicKey, padding };
  }

  private prepareShuffle(reels: Ciphertext[][], publicKeys: PublicKey[]) {
    const hash = this.#slot.shuffleHash(reels, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      this.#shuffleParams = {
        hash,
        permutationMatrices: Array.from({ length: this.nReels }, () => this.#slot.generateReelPermutation()),
        randomness: Array.from({ length: this.nReels }, () => this.#slot.generateReelRandomness()),
        reels,
      };
    }
    return this.#shuffleParams;
  }

  preloadShuffle(reels: Ciphertext[][], publicKeys: PublicKey[]): void {
    if (this.usesZig()) return;
    const params = this.prepareShuffle(reels, publicKeys);
    this.#circuits.shuffle.preloadWitness({
      hash: params.hash,
      reels: params.reels,
      publicKeys,
      permutationMatrix: params.permutationMatrices,
      randomness: params.randomness,
    });
  }

  async shuffleProve(reels: Ciphertext[][], publicKeys: PublicKey[]): Promise<ShuffleOutput> {
    if (this.#session) {
      const out = await this.#session.shuffle([], publicKeys, this.#key?.privateKey, { reels });
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        reels: out.reels ?? chunkReels(out.deck, this.nReels),
        permutationHash: out.permutationHash,
      };
    }
    const params = this.prepareShuffle(reels, publicKeys);
    const pkAgg = this.#slot.aggregatePublicKeys(publicKeys);
    const shuffled = params.reels.map((reel, i) =>
      this.#slot.shuffleReel(reel, pkAgg, params.permutationMatrices[i]!, params.randomness[i]!),
    );
    const permutationHash = this.#slot.hashIndependentPermutations(params.permutationMatrices);
    const { proof, publicSignals } = await this.#circuits.shuffle.prove({
      hash: params.hash,
      reels: params.reels,
      publicKeys,
      permutationMatrix: params.permutationMatrices,
      randomness: params.randomness,
    });
    this.#shuffleParams = undefined;
    return { proof, publicSignals, reels: shuffled, permutationHash };
  }

  private prepareShare(
    centers: Ciphertext[],
    publicKeys: PublicKey[],
    coinBet: number,
  ) {
    if (!this.#shareParams || this.#shareParams.coinBet !== coinBet) {
      const cardRandomness = new Array(publicKeys.length).fill(0n).map(() =>
        new Array(this.nReels).fill(0n).map(() => this.#slot.getRandom()),
      );
      const betRandomness = [0, 1].map(() => {
        let r = this.#slot.getRandom();
        while (r === 0n) r = this.#slot.getRandom();
        return r;
      });
      this.#shareParams = {
        hash: this.#slot.shareHash(centers, this.publicKey, publicKeys),
        cardRandomness,
        betRandomness,
        coinBet,
      };
    }
    return this.#shareParams;
  }

  preloadShare(centers: Ciphertext[], publicKeys: PublicKey[], coinBet: number): void {
    if (this.usesZig()) return;
    const params = this.prepareShare(centers, publicKeys, coinBet);
    this.#circuits.share.preloadWitness({
      hash: params.hash,
      ciphertext: centers,
      publicKey: this.publicKey,
      publicKeys,
      privateKey: this.#privateKey,
      cardRandomness: params.cardRandomness,
      nActualPlayers: 2,
      coinBet,
      betRandomness: params.betRandomness,
    });
  }

  async shareProve(centers: Ciphertext[], publicKeys: PublicKey[], coinBet: number): Promise<ShareOutput> {
    if (this.#session) {
      const out = await this.#session.share(
        centers,
        publicKeys,
        2,
        this.#key?.privateKey,
        { coinBet },
      );
      const parsed = parseSlotSharePublicSignals(out.publicSignals);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        ciphertexts: out.ciphertexts,
        encryptedBets: parsed.encryptedBets,
        coinBet: out.coinBet ?? coinBet,
      };
    }
    const params = this.prepareShare(centers, publicKeys, coinBet);
    const ciphertexts = this.#slot.share(centers, publicKeys, this.#privateKey, params.cardRandomness);
    const encryptedBets = this.#slot.commitCoinBet(
      coinBet,
      [this.publicKey, ...publicKeys],
      params.betRandomness,
    );
    const { proof, publicSignals } = await this.#circuits.share.prove({
      hash: params.hash,
      ciphertext: centers,
      publicKey: this.publicKey,
      publicKeys,
      privateKey: this.#privateKey,
      cardRandomness: params.cardRandomness,
      nActualPlayers: 2,
      coinBet,
      betRandomness: params.betRandomness,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    this.#shareParams = undefined;
    return { proof, publicSignals, ciphertexts, encryptedBets, coinBet };
  }

  private prepareShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBet: Ciphertext,
    coinBet: number,
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
        ciphertextBet,
      };
      const hash = this.#slot.showdownHash(hashInput);
      const plaintextCenters = this.#slot.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      const payout = this.#slot.evaluatePayout(plaintextCenters.map(Number), coinBet);
      this.#showdownParams = {
        hash,
        hashInput,
        plaintextCenters,
        payout,
        coefficients: [coefficient],
      };
    }
    return this.#showdownParams;
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBet: Ciphertext,
    coinBet: number,
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextBet, coinBet,
    );
    this.#circuits.showdown.preloadWitness({
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextCenters,
      coinBet,
      coefficients: params.coefficients.map(c => c.toString()),
    });
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBet: Ciphertext,
    coinBet: number,
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      if (!this.#sealedCoefficients?.[0]) {
        throw new Error('showdown coefficients must come from the host');
      }
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        ciphertextBet,
        coinBet,
        coefficients: this.#sealedCoefficients,
        privateKey: this.#key?.privateKey,
      });
      const plaintextCenters = this.#slot.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        payout: this.#slot.evaluatePayout(plaintextCenters.map(Number), coinBet),
        publicKey: out.publicKey,
        plaintextCenters,
      };
    }
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextBet, coinBet,
    );
    const { proof, publicSignals } = await this.#circuits.showdown.prove({
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextCenters,
      coinBet,
      coefficients: params.coefficients.map(c => c.toString()),
    });
    this.#showdownParams = undefined;
    return {
      proof,
      publicSignals,
      payout: params.payout,
      publicKey: this.publicKey,
      plaintextCenters: params.plaintextCenters,
    };
  }
}

function chunkReels(flat: Ciphertext[], nReels: number): Ciphertext[][] {
  const stops = 22;
  return Array.from({ length: nReels }, (_, i) => flat.slice(i * stops, (i + 1) * stops));
}
