import {
  Bingo,
  BINGO_CHUNK_BALLS,
  parseCardPublicSignals,
  type BingoVariant,
} from './bingo';
import {
  evaluateBingo75,
  evaluateBingo90,
  type BingoPattern75,
} from './bingo-eval';
import { type PlayerKey, type PublicKey, type Ciphertext } from './zk-casino';
import { padPublicKeysForShuffle } from './shuffle-common';
import { Circuit } from './circuit';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import { GameKind } from './game-config';
import { tryOpenGameSession } from './player-zig-session';
import type { PlayerSession } from './player-native-bridge';

export interface BingoCircuits {
  register: Circuit;
  shuffle: Circuit;
  card: Circuit;
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

export interface CardCommitOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  encryptedCells: Ciphertext[];
  plaintextCells: number[];
}

export interface ShareOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  packed: number | number[];
  publicKey: PublicKey;
  plaintextBalls: bigint[];
}

interface BingoShowdownParams {
  hash: bigint;
  hashInput: object;
  plaintextBalls: bigint[];
  packed: number | number[];
  coefficients: bigint[];
}

export async function loadBingoCircuits(variant: BingoVariant = 75): Promise<BingoCircuits> {
  const names = [
    'register_main',
    `shuffle_1_deck_${variant}_main`,
    `bingo_card_${variant}_main`,
    'bingo_share_hashout_main',
    `bingo_showdown_${variant}_hashout_main`,
  ];
  const [register, shuffle, card, share, showdown] = await Promise.all(
    names.map(async name => {
      const circuit = new Circuit(name);
      await circuit.load();
      return circuit;
    }),
  );
  return { register: register!, shuffle: shuffle!, card: card!, share: share!, showdown: showdown! };
}

export class Player {
  #bingo: Bingo;
  #key: PlayerKey | undefined;
  #circuits: BingoCircuits;
  #shuffleParams: {
    hash: bigint;
    permutationMatrix: bigint[];
    randomness: bigint[];
    deck: Ciphertext[];
  } | undefined;
  #cardParams: {
    hash: bigint;
    plaintextCells: number[];
    randomness: bigint[];
    fingerprint: string;
  } | undefined;
  #shareParams: { hash: bigint; cardRandomness: bigint[][]; nActualPlayers: number } | undefined;
  #showdownParams: BingoShowdownParams | undefined;
  #sealedCoefficients: bigint[] | undefined;
  #session: PlayerSession | undefined;
  #padding: Ciphertext | undefined;

  constructor(circuits: BingoCircuits, variant: BingoVariant = 75) {
    this.#circuits = circuits;
    this.#bingo = new Bingo(variant);
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  get variant() {
    return this.#bingo.variant;
  }

  async init() {
    this.#session = await tryOpenGameSession({
      kind: GameKind.Bingo,
      variant: this.variant,
    });
    await this.#bingo.init();
    if (this.#session) return;
    await Promise.all([
      this.#circuits.register.load(),
      this.#circuits.shuffle.load(),
      this.#circuits.card.load(),
      this.#circuits.share.load(),
      this.#circuits.showdown.load(),
    ]);
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) this.#key = this.#bingo.generatePlayerKey();
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
    return this.#bingo.getPadding(this.publicKey);
  }

  get #privateKey() {
    if (!this.#key) throw new Error('Key not yet generated');
    assert(this.#key.privateKey > 1024n, 'Private Key is too small');
    return this.#key.privateKey;
  }

  setSealedCoefficients(coeffs: bigint[]): void {
    const need = this.variant === 90 ? 3 : 1;
    if (coeffs.length !== need) throw new Error(`Expected ${need} sealed coefficients, got ${coeffs.length}`);
    if (coeffs.some(c => c === 0n)) throw new Error('Sealed coefficient must be non-zero');
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

  private prepareShuffle(deck: Ciphertext[], publicKeys: PublicKey[]) {
    const hash = this.#bingo.shuffleHash(deck, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      this.#shuffleParams = {
        hash,
        permutationMatrix: this.#bingo.generateShufflePermutation(),
        randomness: this.#bingo.generateShuffleRandomness(),
        deck,
      };
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
    const { ciphertexts, permutationHash } = this.#bingo.shuffle(
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

  private prepareCard(cells: number[]) {
    const fingerprint = cells.join(',');
    if (!this.#cardParams || this.#cardParams.fingerprint !== fingerprint) {
      const randomness = cells.map(() => {
        let r = this.#bingo.getRandom();
        while (r === 0n) r = this.#bingo.getRandom();
        return r;
      });
      this.#cardParams = {
        hash: this.#bingo.cardHash(this.publicKey),
        plaintextCells: [...cells],
        randomness,
        fingerprint,
      };
    }
    return this.#cardParams;
  }

  preloadCard(cells: number[]): void {
    if (this.usesZig()) return;
    const params = this.prepareCard(cells);
    this.#circuits.card.preloadWitness({
      hash: params.hash,
      publicKey: this.publicKey,
      plaintextCells: params.plaintextCells,
      randomness: params.randomness,
    });
  }

  async cardProve(cells: number[]): Promise<CardCommitOutput> {
    if (this.#session) {
      const out = await this.#session.card(cells, this.#key?.privateKey);
      const parsed = parseCardPublicSignals(out.publicSignals, this.variant);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        encryptedCells: parsed.encryptedCells,
        plaintextCells: [...cells],
      };
    }
    const params = this.prepareCard(cells);
    const encryptedCells = this.#bingo.commitCard(
      params.plaintextCells,
      this.publicKey,
      params.randomness,
    );
    const { proof, publicSignals } = await this.#circuits.card.prove({
      hash: params.hash,
      publicKey: this.publicKey,
      plaintextCells: params.plaintextCells,
      randomness: params.randomness,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    parseCardPublicSignals(publicSignals, this.variant);
    this.#cardParams = undefined;
    return {
      proof,
      publicSignals,
      encryptedCells,
      plaintextCells: params.plaintextCells,
    };
  }

  private prepareShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number) {
    if (!this.#shareParams || this.#shareParams.nActualPlayers !== nActualPlayers) {
      this.#shareParams = {
        hash: this.#bingo.shareHash(deck, this.publicKey, publicKeys),
        cardRandomness: new Array(publicKeys.length).fill(0n).map(() =>
          new Array(BINGO_CHUNK_BALLS).fill(0n).map(() => this.#bingo.getRandom()),
        ),
        nActualPlayers,
      };
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
      nActualPlayers: params.nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.cardRandomness,
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
    const ciphertexts = this.#bingo.share(deck, publicKeys, this.#privateKey, params.cardRandomness);
    const { proof, publicSignals } = await this.#circuits.share.prove({
      hash: params.hash,
      ciphertext: deck,
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers: params.nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.cardRandomness,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    this.#shareParams = undefined;
    return { proof, publicSignals, ciphertexts };
  }

  private prepareShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextCardCells: Ciphertext[],
    plaintextCells: number[],
    nCalled: number,
    patternId: BingoPattern75 = 0,
  ) {
    if (!this.#showdownParams) {
      const playerIndex = publicKeys.findIndex(pk =>
        pk.every((value, i) => value === this.publicKey[i]),
      );
      if (playerIndex < 0) throw new Error('Player public key not found');
      const need = this.variant === 90 ? 3 : 1;
      if (!this.#sealedCoefficients || this.#sealedCoefficients.length !== need) {
        throw new Error('showdown coefficients must come from the host');
      }
      const coefficients = [...this.#sealedCoefficients];
      const hashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards,
        ciphertextPartials,
        ciphertextCardCells,
        nCalled,
        patternId,
      };
      const hash = this.#bingo.showdownHash(hashInput);
      const plaintextBalls = this.#bingo.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
        nCalled,
      );
      const packed = this.variant === 75
        ? evaluateBingo75(plaintextCells, plaintextBalls.map(Number), nCalled, patternId).packed
        : (() => {
          const r = evaluateBingo90(plaintextCells, plaintextBalls.map(Number), nCalled);
          return [r.oneLine.packed, r.twoLines.packed, r.fullHouse.packed];
        })();
      this.#showdownParams = {
        hash,
        hashInput,
        plaintextBalls,
        packed,
        coefficients,
      };
    }
    return this.#showdownParams;
  }

  #showdownWitness(
    params: BingoShowdownParams,
    plaintextCells: number[],
    nCalled: number,
    patternId: BingoPattern75,
  ) {
    const paddedBalls = [
      ...params.plaintextBalls,
      ...Array.from({ length: this.#bingo.shoeSize - nCalled }, () => 0n),
    ];
    const base = {
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: paddedBalls,
      plaintextCells,
      coefficients: params.coefficients.map(c => c.toString()),
      nCalled,
    };
    return this.variant === 75 ? { ...base, patternId } : base;
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextCardCells: Ciphertext[],
    plaintextCells: number[],
    nCalled: number,
    patternId: BingoPattern75 = 0,
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextCardCells,
      plaintextCells, nCalled, patternId,
    );
    this.#circuits.showdown.preloadWitness(
      this.#showdownWitness(params, plaintextCells, nCalled, patternId),
    );
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextCardCells: Ciphertext[],
    plaintextCells: number[],
    nCalled: number,
    patternId: BingoPattern75 = 0,
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      const need = this.variant === 90 ? 3 : 1;
      if (!this.#sealedCoefficients || this.#sealedCoefficients.length !== need) {
        throw new Error('showdown coefficients must come from the host');
      }
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        ciphertextCardCells,
        cells: plaintextCells,
        nCalled,
        patternId,
        coefficients: this.#sealedCoefficients,
        privateKey: this.#key?.privateKey,
      });
      const plaintextBalls = this.#bingo.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
        nCalled,
      );
      const packed = this.variant === 75
        ? evaluateBingo75(plaintextCells, plaintextBalls.map(Number), nCalled, patternId).packed
        : (() => {
          const r = evaluateBingo90(plaintextCells, plaintextBalls.map(Number), nCalled);
          return [r.oneLine.packed, r.twoLines.packed, r.fullHouse.packed];
        })();
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        packed,
        publicKey: out.publicKey,
        plaintextBalls,
      };
    }
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextCardCells,
      plaintextCells, nCalled, patternId,
    );
    const { proof, publicSignals } = await this.#circuits.showdown.prove(
      this.#showdownWitness(params, plaintextCells, nCalled, patternId),
    );
    this.#showdownParams = undefined;
    return {
      proof,
      publicSignals,
      packed: params.packed,
      publicKey: this.publicKey,
      plaintextBalls: params.plaintextBalls,
    };
  }
}
