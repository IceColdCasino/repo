import { Keno, MAX_KENO_SPOTS, padKenoSpots, parseBetPublicSignals } from './keno';
import { evaluateKeno } from './keno-eval';
import { type PublicKey, type Ciphertext } from './zk-casino';
import { Circuit } from './circuit';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import {
  ZkPlayer,
  loadNamedCircuits,
  type RegisterOutput,
  type DeckShuffleOutput,
  type LinearShareOutput,
} from './zk-player-base';
import { GameKind } from './game-config';
import { tryOpenGameSession } from './player-zig-session';
import type { PlayerSession } from './player-native-bridge';

export interface KenoCircuits {
  register: Circuit;
  shuffle: Circuit;
  bet: Circuit;
  share: Circuit;
  showdown: Circuit;
}

export type { RegisterOutput };

export interface ShuffleOutput extends DeckShuffleOutput {}

export interface BetOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  encryptedBets: Ciphertext[];
  nActualBets: number;
  plaintextSpots: number[];
}

export interface ShareOutput extends LinearShareOutput {}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  matches: number;
  publicKey: PublicKey;
  plaintextDraw: bigint[];
}

export async function loadKenoCircuits(): Promise<KenoCircuits> {
  const [register, shuffle, bet, share, showdown] = await loadNamedCircuits([
    'register_main',
    'shuffle_1_deck_80_main',
    'keno_bet_main',
    'keno_share_hashout_main',
    'keno_showdown_hashout_main',
  ]);
  return { register: register!, shuffle: shuffle!, bet: bet!, share: share!, showdown: showdown! };
}

export class Player extends ZkPlayer<KenoCircuits> {
  #keno = new Keno();
  #session: PlayerSession | undefined;
  #zigPadding: Ciphertext | undefined;
  #betParams: {
    hash: bigint;
    nActualBets: number;
    plaintextSpots: number[];
    betRandomness: bigint[][];
    fingerprint: string;
  } | undefined;
  #kenoShowdown: {
    hash: bigint;
    hashInput: object;
    plaintextDraw: bigint[];
    matches: number;
    coefficients: bigint[];
  } | undefined;

  constructor(circuits: KenoCircuits) {
    super(circuits);
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  override generateKey(): void {
    if (this.usesZig()) return;
    super.generateKey();
  }

  override async init(): Promise<void> {
    this.#session = await tryOpenGameSession({ kind: GameKind.Keno });
    await this.#keno.init();
    if (this.#session) return;
    await super.init();
  }

  override get padding(): Ciphertext {
    if (this.#zigPadding) return this.#zigPadding;
    if (this.usesZig()) {
      throw new Error('Native padding is not cached — call registerProve() first');
    }
    return super.padding;
  }

  override async registerProve(): Promise<RegisterOutput> {
    if (this.#session) {
      const out = await this.#session.register(this.key?.privateKey);
      this.key = out.key;
      this.#zigPadding = out.padding;
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        publicKey: out.key.publicKey,
        padding: out.padding,
      };
    }
    return super.registerProve();
  }

  protected override get crypto() {
    return this.#keno;
  }

  override setSealedCoefficients(coeffs: bigint[]): void {
    super.setSealedCoefficients(coeffs, 1);
  }

  preloadShuffle(deck: Ciphertext[], publicKeys: PublicKey[]): void {
    if (this.usesZig()) return;
    this.preloadDeckShuffle(this.#keno, this.circuits.shuffle, deck, publicKeys);
  }

  async shuffleProve(deck: Ciphertext[], publicKeys: PublicKey[]): Promise<ShuffleOutput> {
    if (this.#session) {
      const out = await this.#session.shuffle(deck, publicKeys, this.key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        deck: out.deck,
        permutationHash: out.permutationHash,
      };
    }
    return this.proveDeckShuffle(this.#keno, this.circuits.shuffle, deck, publicKeys);
  }

  private prepareBet(houseKey: PublicKey, spots: number[]) {
    const nActualBets = spots.length;
    assert(nActualBets >= 0 && nActualBets <= MAX_KENO_SPOTS);
    const plaintextSpots = padKenoSpots(spots);
    const fingerprint = plaintextSpots.join(',');
    if (
      !this.#betParams
      || this.#betParams.fingerprint !== fingerprint
      || this.#betParams.nActualBets !== nActualBets
    ) {
      const betRandomness = new Array(2).fill(0n).map(() =>
        new Array(MAX_KENO_SPOTS).fill(0n).map(() => {
          let r = this.#keno.getRandom();
          while (r === 0n) r = this.#keno.getRandom();
          return r;
        }),
      );
      this.#betParams = {
        hash: this.#keno.betHash(this.publicKey, houseKey, nActualBets),
        nActualBets,
        plaintextSpots,
        betRandomness,
        fingerprint,
      };
    }
    return this.#betParams;
  }

  preloadBet(houseKey: PublicKey, spots: number[]): void {
    if (this.usesZig()) return;
    const params = this.prepareBet(houseKey, spots);
    this.circuits.bet.preloadWitness({
      hash: params.hash,
      publicKey: this.publicKey,
      publicKeys: [houseKey],
      nActualBets: params.nActualBets,
      plaintextBets: params.plaintextSpots,
      randomness: params.betRandomness,
    });
  }

  async betProve(houseKey: PublicKey, spots: number[]): Promise<BetOutput> {
    if (this.#session) {
      const plaintextSpots = padKenoSpots(spots);
      const out = await this.#session.bet({
        house: houseKey,
        spots,
        privateKey: this.key?.privateKey,
      });
      const parsed = parseBetPublicSignals(out.publicSignals);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        encryptedBets: parsed.encryptedBets[0]!,
        nActualBets: out.nActualBets,
        plaintextSpots,
      };
    }
    const params = this.prepareBet(houseKey, spots);
    const encryptedBetsAll = this.#keno.commitSpots(
      params.plaintextSpots,
      [this.publicKey, houseKey],
      params.betRandomness,
    );
    const { proof, publicSignals } = await this.circuits.bet.prove({
      hash: params.hash,
      publicKey: this.publicKey,
      publicKeys: [houseKey],
      nActualBets: params.nActualBets,
      plaintextBets: params.plaintextSpots,
      randomness: params.betRandomness,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    this.#betParams = undefined;
    return {
      proof,
      publicSignals,
      encryptedBets: encryptedBetsAll[0]!,
      nActualBets: params.nActualBets,
      plaintextSpots: params.plaintextSpots,
    };
  }

  preloadShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): void {
    if (this.usesZig()) return;
    this.preloadLinearShare(this.#keno, this.circuits.share, deck, publicKeys, nActualPlayers, 20);
  }

  async shareProve(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number): Promise<ShareOutput> {
    if (this.#session) {
      const out = await this.#session.share(deck, publicKeys, nActualPlayers, this.key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        ciphertexts: out.ciphertexts,
      };
    }
    return this.proveLinearShare(this.#keno, this.circuits.share, deck, publicKeys, nActualPlayers, 20);
  }

  private prepareShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextSpots: number[],
    nActualBets: number,
  ) {
    if (!this.#kenoShowdown) {
      const playerIndex = this.indexOfSelf(publicKeys);
      const padded = padKenoSpots(plaintextSpots);
      const hashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards,
        ciphertextPartials,
        ciphertextBets,
        nActualBets,
      };
      const plaintextDraw = this.#keno.decryptCards(
        this.privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      this.#kenoShowdown = {
        hash: this.#keno.showdownHash(hashInput),
        hashInput,
        plaintextDraw,
        matches: evaluateKeno(plaintextDraw.map(Number), padded, nActualBets),
        coefficients: this.requireHostCoefficients(1),
      };
    }
    return this.#kenoShowdown;
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextSpots: number[],
    nActualBets: number,
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextBets, plaintextSpots, nActualBets,
    );
    this.circuits.showdown.preloadWitness({
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      plaintextCards: params.plaintextDraw,
      plaintextBets: padKenoSpots(plaintextSpots),
      coefficients: params.coefficients.map(c => c.toString()),
    });
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextSpots: number[],
    nActualBets: number,
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        ciphertextBets,
        spots: plaintextSpots,
        nActualBets,
        coefficients: this.requireHostCoefficients(1),
        privateKey: this.key?.privateKey,
      });
      const plaintextDraw = this.#keno.decryptCards(
        this.privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        matches: out.matches ?? 0,
        publicKey: out.publicKey,
        plaintextDraw,
      };
    }
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextBets, plaintextSpots, nActualBets,
    );
    const { proof, publicSignals } = await this.circuits.showdown.prove({
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      plaintextCards: params.plaintextDraw,
      plaintextBets: padKenoSpots(plaintextSpots),
      coefficients: params.coefficients.map(c => c.toString()),
    });
    this.#kenoShowdown = undefined;
    return {
      proof,
      publicSignals,
      matches: params.matches,
      publicKey: this.publicKey,
      plaintextDraw: params.plaintextDraw,
    };
  }
}
