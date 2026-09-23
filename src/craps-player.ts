import {
  Craps,
  MAX_CRAPS_BETS,
  CRAPS_SHOWDOWN_TERMS,
  padCrapsBets,
  parseBetPublicSignals,
  type CrapsBet,
} from './craps';
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
import { tryOpenGameSession } from './player-zig-session';
import type { PlayerSession } from './player-native-bridge';

export interface CrapsCircuits {
  register: Circuit;
  shuffle: Circuit;
  bet: Circuit;
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
  dice: Ciphertext[][];
}

export interface BetOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  encryptedBets: Ciphertext[];
  nActualBets: number;
  plaintextBets: CrapsBet[];
}

export interface ShareOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  results: number[];
  publicKey: PublicKey;
  plaintextDice: bigint[];
}

export async function loadCrapsCircuits(): Promise<CrapsCircuits> {
  const names = [
    'register_main',
    'shuffle_2_dice_6_main',
    'craps_bet_main',
    'craps_share_hashout_main',
    'craps_showdown_hashout_main',
  ];
  const [register, shuffle, bet, share, showdown] = await Promise.all(
    names.map(async name => {
      const circuit = new Circuit(name);
      await circuit.load();
      return circuit;
    }),
  );
  return { register: register!, shuffle: shuffle!, bet: bet!, share: share!, showdown: showdown! };
}

function betsKey(bets: CrapsBet[]): string {
  return bets.map(b => `${b[0]}:${b[1]}`).join(',');
}

export class Player {
  #craps = new Craps();
  #key: PlayerKey | undefined;
  #circuits: CrapsCircuits;
  #shuffleParams: {
    hash: bigint;
    permutationMatrices: bigint[][];
    randomness: bigint[][];
    dice: Ciphertext[][];
  } | undefined;
  #betParams: {
    hash: bigint;
    nActualBets: number;
    plaintextBets: CrapsBet[];
    betRandomness: bigint[][];
    fingerprint: string;
  } | undefined;
  #shareParams: {
    hash: bigint;
    cardRandomness: bigint[][];
    nActualPlayers: number;
  } | undefined;
  #showdownParams: {
    hash: bigint;
    hashInput: object;
    plaintextDice: bigint[];
    results: number[];
    coefficients: bigint[];
  } | undefined;
  #sealedCoefficients: bigint[] | undefined;
  #session: PlayerSession | undefined;
  #padding: Ciphertext | undefined;

  constructor(circuits: CrapsCircuits) {
    this.#circuits = circuits;
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  async init() {
    this.#session = await tryOpenGameSession({ kind: GameKind.Craps });
    await this.#craps.init();
    if (this.#session) return;
    await this.#circuits.register.load();
    await this.#circuits.shuffle.load();
    await this.#circuits.bet.load();
    await this.#circuits.share.load();
    await this.#circuits.showdown.load();
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) this.#key = this.#craps.generatePlayerKey();
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
    return this.#craps.getPadding(this.publicKey);
  }

  get #privateKey() {
    if (!this.#key) throw new Error('Key not yet generated');
    assert(this.#key.privateKey > 1024n, 'Private Key is too small');
    return this.#key.privateKey;
  }

  setSealedCoefficients(coeffs: bigint[]): void {
    if (coeffs.length !== CRAPS_SHOWDOWN_TERMS) {
      throw new Error(`Expected ${CRAPS_SHOWDOWN_TERMS} sealed coefficients, got ${coeffs.length}`);
    }
    for (const coeff of coeffs) {
      if (coeff === 0n) throw new Error('Sealed coefficient must be non-zero');
    }
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

  private prepareShuffle(dice: Ciphertext[][], publicKeys: PublicKey[]) {
    const hash = this.#craps.shuffleHash(dice, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      this.#shuffleParams = {
        hash,
        permutationMatrices: [this.#craps.generateDiePermutation(), this.#craps.generateDiePermutation()],
        randomness: [this.#craps.generateDieRandomness(), this.#craps.generateDieRandomness()],
        dice,
      };
    }
    return this.#shuffleParams;
  }

  preloadShuffle(dice: Ciphertext[][], publicKeys: PublicKey[]): void {
    if (this.usesZig()) return;
    const params = this.prepareShuffle(dice, publicKeys);
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);
    this.#circuits.shuffle.preloadWitness({
      hash: params.hash,
      dice: params.dice,
      publicKeys: shuffleKeys,
      permutationMatrix: params.permutationMatrices,
      randomness: params.randomness,
    });
  }

  async shuffleProve(dice: Ciphertext[][], publicKeys: PublicKey[]): Promise<ShuffleOutput> {
    if (this.#session) {
      const out = await this.#session.shuffle(dice.flat(), publicKeys, this.#key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        dice: out.dice ?? [out.deck.slice(0, 6), out.deck.slice(6, 12)],
      };
    }
    const params = this.prepareShuffle(dice, publicKeys);
    const shuffleKeys = padPublicKeysForShuffle(publicKeys);
    const pkAgg = this.#craps.aggregatePublicKeys(shuffleKeys);
    const shuffled = [0, 1].map(i =>
      this.#craps.shuffleDie(params.dice[i]!, pkAgg, params.permutationMatrices[i]!, params.randomness[i]!),
    );
    const { proof, publicSignals } = await this.#circuits.shuffle.prove({
      hash: params.hash,
      dice: params.dice,
      publicKeys: shuffleKeys,
      permutationMatrix: params.permutationMatrices,
      randomness: params.randomness,
    });
    this.#shuffleParams = undefined;
    return { proof, publicSignals, dice: shuffled };
  }

  private prepareBet(houseKey: PublicKey, bets: CrapsBet[]) {
    const nActualBets = bets.length;
    assert(nActualBets >= 0 && nActualBets <= MAX_CRAPS_BETS);
    const plaintextBets = padCrapsBets(bets);
    const fingerprint = betsKey(plaintextBets);
    if (!this.#betParams || this.#betParams.fingerprint !== fingerprint || this.#betParams.nActualBets !== nActualBets) {
      const betRandomness = new Array(2).fill(0n).map(() =>
        new Array(MAX_CRAPS_BETS).fill(0n).map(() => {
          let r = this.#craps.getRandom();
          while (r === 0n) r = this.#craps.getRandom();
          return r;
        }),
      );
      this.#betParams = {
        hash: this.#craps.betHash(this.publicKey, houseKey, nActualBets),
        nActualBets,
        plaintextBets,
        betRandomness,
        fingerprint,
      };
    }
    return this.#betParams;
  }

  preloadBet(houseKey: PublicKey, bets: CrapsBet[]): void {
    if (this.usesZig()) return;
    const params = this.prepareBet(houseKey, bets);
    this.#circuits.bet.preloadWitness({
      hash: params.hash,
      publicKey: this.publicKey,
      publicKeys: [houseKey],
      nActualBets: params.nActualBets,
      plaintextBets: params.plaintextBets.map(b => [b[0], b[1]]),
      randomness: params.betRandomness,
    });
  }

  async betProve(houseKey: PublicKey, bets: CrapsBet[]): Promise<BetOutput> {
    if (this.#session) {
      const plaintextBets = padCrapsBets(bets);
      const out = await this.#session.bet({
        house: houseKey,
        bets: bets,
        privateKey: this.#key?.privateKey,
      });
      const parsed = parseBetPublicSignals(out.publicSignals);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        encryptedBets: parsed.encryptedBets[0]!,
        nActualBets: out.nActualBets,
        plaintextBets,
      };
    }
    const params = this.prepareBet(houseKey, bets);
    const encryptedBetsAll = this.#craps.commitBets(
      params.plaintextBets,
      [this.publicKey, houseKey],
      params.betRandomness,
    );
    const { proof, publicSignals } = await this.#circuits.bet.prove({
      hash: params.hash,
      publicKey: this.publicKey,
      publicKeys: [houseKey],
      nActualBets: params.nActualBets,
      plaintextBets: params.plaintextBets.map(b => [b[0], b[1]]),
      randomness: params.betRandomness,
    }) as { proof: Groth16Proof; publicSignals: string[] };
    this.#betParams = undefined;
    return {
      proof,
      publicSignals,
      encryptedBets: encryptedBetsAll[0]!,
      nActualBets: params.nActualBets,
      plaintextBets: params.plaintextBets,
    };
  }

  private prepareShare(deck: Ciphertext[], publicKeys: PublicKey[], nActualPlayers: number) {
    if (!this.#shareParams || this.#shareParams.nActualPlayers !== nActualPlayers) {
      const cardRandomness = new Array(publicKeys.length).fill(0n).map(() =>
        new Array(2).fill(0n).map(() => this.#craps.getRandom()),
      );
      this.#shareParams = {
        hash: this.#craps.shareHash(deck, this.publicKey, publicKeys),
        cardRandomness,
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
    const ciphertexts = this.#craps.share(deck, publicKeys, this.#privateKey, params.cardRandomness);
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
    ciphertextBets: Ciphertext[],
    plaintextBets: CrapsBet[],
    nActualBets: number,
    phase: number,
    point: number,
  ) {
    if (!this.#showdownParams) {
      const playerIndex = publicKeys.findIndex(pk =>
        pk.every((value, i) => value === this.publicKey[i]),
      );
      if (playerIndex < 0) throw new Error('Player public key not found');
      if (!this.#sealedCoefficients || this.#sealedCoefficients.length !== CRAPS_SHOWDOWN_TERMS) {
        throw new Error('showdown coefficients must come from the host');
      }
      const coefficients = [...this.#sealedCoefficients];
      const paddedBets = padCrapsBets(plaintextBets);
      const hashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards,
        ciphertextPartials,
        ciphertextBets,
        nActualBets,
        phase,
        point,
      };
      const hash = this.#craps.showdownHash(hashInput);
      const plaintextDice = this.#craps.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      const results = this.#craps.evaluateShowdown(
        paddedBets,
        plaintextDice.map(Number),
        phase,
        point,
        nActualBets,
      );
      this.#showdownParams = { hash, hashInput, plaintextDice, results, coefficients };
    }
    return this.#showdownParams;
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextBets: CrapsBet[],
    nActualBets: number,
    phase: number,
    point: number,
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextBets,
      plaintextBets, nActualBets, phase, point,
    );
    this.#circuits.showdown.preloadWitness({
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextDice,
      plaintextBets: plaintextBets.length === MAX_CRAPS_BETS
        ? plaintextBets.map(b => [b[0], b[1]])
        : padCrapsBets(plaintextBets).map(b => [b[0], b[1]]),
      coefficients: params.coefficients.map(c => c.toString()),
    });
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextBets: CrapsBet[],
    nActualBets: number,
    phase: number,
    point: number,
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      if (!this.#sealedCoefficients || this.#sealedCoefficients.length !== CRAPS_SHOWDOWN_TERMS) {
        throw new Error('showdown coefficients must come from the host');
      }
      const paddedBets = padCrapsBets(plaintextBets);
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        ciphertextBets,
        bets: paddedBets,
        nActualBets,
        phase,
        point,
        coefficients: this.#sealedCoefficients,
        privateKey: this.#key?.privateKey,
      });
      const plaintextDice = this.#craps.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      const results = this.#craps.evaluateShowdown(
        paddedBets,
        plaintextDice.map(Number),
        phase,
        point,
        nActualBets,
      );
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        results,
        publicKey: out.publicKey,
        plaintextDice,
      };
    }
    const params = this.prepareShowdown(
      publicKeys, ciphertextCards, ciphertextPartials, ciphertextBets,
      plaintextBets, nActualBets, phase, point,
    );
    const paddedBets = padCrapsBets(plaintextBets);
    const { proof, publicSignals } = await this.#circuits.showdown.prove({
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextDice,
      plaintextBets: paddedBets.map(b => [b[0], b[1]]),
      coefficients: params.coefficients.map(c => c.toString()),
    });
    this.#showdownParams = undefined;
    return {
      proof,
      publicSignals,
      results: params.results,
      publicKey: this.publicKey,
      plaintextDice: params.plaintextDice,
    };
  }
}
