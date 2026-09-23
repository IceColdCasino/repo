import {
  Roulette,
  TOTAL_CARDS,
  MAX_BETS,
  MAX_PLAYERS,
  evaluateBets,
  padBets,
  parseBetPublicSignals,
  type RouletteBet,
  type RouletteVariant,
} from './roulette';
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

export interface RouletteCircuits {
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
  deck: Ciphertext[];
  permutationHash: bigint;
}

export interface BetOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  encryptedBets: Ciphertext[];
  nActualBets: number;
  plaintextBets: RouletteBet[];
}

export interface ShareOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  payouts: number[];
  publicKey: PublicKey;
  plaintextCard: bigint;
}

interface RouletteShareParams {
  hash: bigint;
  cardRandomness: bigint[][];
  nActualPlayers: number;
}

interface RouletteShowdownParams {
  hash: bigint;
  hashInput: object;
  plaintextCard: bigint;
  plaintextBets: RouletteBet[];
  payouts: number[];
  coefficients: bigint[];
}

function circuitNames(variant: RouletteVariant) {
  return {
    shuffle: `shuffle_1_deck_${variant}_main`,
    bet: `roulette_bet_${variant}_main`,
    share: 'roulette_share_hashout_main',
    showdown: `roulette_showdown_${variant}_hashout_main`,
  } as const;
}

export async function loadRouletteCircuits(variant: RouletteVariant): Promise<RouletteCircuits> {
  const names = circuitNames(variant);
  const [register, shuffle, bet, share, showdown] = await Promise.all([
    'register_main',
    names.shuffle,
    names.bet,
    names.share,
    names.showdown,
  ].map(async name => {
    const circuit = new Circuit(name);
    await circuit.load();
    return circuit;
  }));

  return { register: register!, shuffle: shuffle!, bet: bet!, share: share!, showdown: showdown! };
}

function betsKey(bets: RouletteBet[]): string {
  return bets.map(b => `${b[0]}:${b[1]}`).join(',');
}

export class Player {
  #roulette: Roulette;
  #key: PlayerKey | undefined;
  #circuits: RouletteCircuits;

  #shuffleParams: {
    hash: bigint;
    permutationMatrix: bigint[];
    randomness: bigint[];
    deck: Ciphertext[];
  } | undefined;
  #betParams: {
    hash: bigint;
    betRandomness: bigint[][];
    nActualBets: number;
    plaintextBets: RouletteBet[];
    betsFingerprint: string;
  } | undefined;
  #shareParams: RouletteShareParams | undefined;
  #showdownParams: RouletteShowdownParams | undefined;
  #sealedCoefficients: bigint[] | undefined;
  #session: PlayerSession | undefined;
  #padding: Ciphertext | undefined;

  constructor(circuits: RouletteCircuits, variant: RouletteVariant) {
    this.#circuits = circuits;
    this.#roulette = new Roulette(variant);
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  get deckSize() {
    return this.#roulette.deckSize;
  }

  async init() {
    this.#session = await tryOpenGameSession({
      kind: GameKind.Roulette,
      variant: this.#roulette.deckSize,
    });
    await this.#roulette.init();
    if (this.#session) return;
    await this.#circuits.register.load();
    await this.#circuits.shuffle.load();
    await this.#circuits.bet.load();
    await this.#circuits.share.load();
    await this.#circuits.showdown.load();
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) this.#key = this.#roulette.generatePlayerKey();
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
    return this.#roulette.getPadding(this.publicKey);
  }

  get #privateKey() {
    if (!this.#key) throw new Error('Key not yet generated');
    assert(this.#key.privateKey > 1024n, 'Private Key is too small');
    return this.#key.privateKey;
  }

  /** Host-sealed showdown coeffs. Players never generate these. */
  setSealedCoefficients(coeffs: bigint[]): void {
    if (coeffs.length !== MAX_BETS) {
      throw new Error(`Expected ${MAX_BETS} sealed coefficients, got ${coeffs.length}`);
    }
    for (let i = 0; i < MAX_BETS; i++) {
      if (coeffs[i]! === 0n) {
        throw new Error(`Sealed coefficient ${i} must be non-zero`);
      }
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
    const privateKey = this.#privateKey;
    const padding = this.padding;

    const { proof, publicSignals } = await this.#circuits.register.prove({
      privateKey,
      publicKey,
    }) as { proof: Groth16Proof; publicSignals: string[] };

    return { proof, publicSignals, publicKey, padding };
  }

  private prepareShuffle(deck: Ciphertext[], publicKeys: PublicKey[]) {
    const hash = this.#roulette.shuffleHash(deck, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      const n = this.deckSize;
      const permutationMatrix = this.#roulette.generateShufflePermutation(n);
      const randomness = this.#roulette.generateShuffleRandomness(n);
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

    const { ciphertexts, permutationHash } = this.#roulette.shuffle(
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

  private prepareBet(houseKey: PublicKey, bets: RouletteBet[]) {
    const nActualBets = bets.length;
    assert(nActualBets >= 0 && nActualBets <= MAX_BETS);
    const plaintextBets = padBets(bets, this.#roulette.deckSize);
    const fingerprint = betsKey(plaintextBets);
    if (
      !this.#betParams
      || this.#betParams.nActualBets !== nActualBets
      || this.#betParams.betsFingerprint !== fingerprint
    ) {
      const betRandomness = new Array(2).fill(0n).map(() =>
        new Array(MAX_BETS).fill(0n).map(() => {
          let r = this.#roulette.getRandom();
          while (r === 0n) r = this.#roulette.getRandom();
          return r;
        }),
      );
      this.#betParams = {
        hash: this.#roulette.betHash(this.publicKey, houseKey, nActualBets),
        betRandomness,
        nActualBets,
        plaintextBets,
        betsFingerprint: fingerprint,
      };
    }
    return this.#betParams;
  }

  preloadBet(houseKey: PublicKey, bets: RouletteBet[]): void {
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

  async betProve(houseKey: PublicKey, bets: RouletteBet[]): Promise<BetOutput> {
    if (this.#session) {
      const plaintextBets = padBets(bets, this.#roulette.deckSize);
      const out = await this.#session.bet({
        house: houseKey,
        bets: plaintextBets.slice(0, bets.length),
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
    const encryptedBetsAll = this.#roulette.commitBets(
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

  private prepareShare(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
  ) {
    if (!this.#shareParams || this.#shareParams.nActualPlayers !== nActualPlayers) {
      const hash = this.#roulette.shareHash(deck, this.publicKey, publicKeys);
      const cardRandomness = new Array(publicKeys.length).fill(0n)
        .map(() => new Array(TOTAL_CARDS).fill(0n)
          .map(() => this.#roulette.getRandom()));
      this.#shareParams = { hash, cardRandomness, nActualPlayers };
    }
    return this.#shareParams;
  }

  private shareWitnessInput(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    params: RouletteShareParams,
  ) {
    return {
      hash: params.hash,
      ciphertext: deck,
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers: params.nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.cardRandomness,
    };
  }

  preloadShare(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShare(deck, publicKeys, nActualPlayers);
    this.#circuits.share.preloadWitness(this.shareWitnessInput(deck, publicKeys, params));
  }

  async shareProve(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
  ): Promise<ShareOutput> {
    if (this.#session) {
      const out = await this.#session.share(deck, publicKeys, nActualPlayers, this.#key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        ciphertexts: out.ciphertexts,
      };
    }
    const params = this.prepareShare(deck, publicKeys, nActualPlayers);
    const ciphertexts = this.#roulette.share(
      deck,
      publicKeys,
      this.#privateKey,
      params.cardRandomness,
    );
    const { proof, publicSignals } = await this.#circuits.share.prove(
      this.shareWitnessInput(deck, publicKeys, params),
    ) as { proof: Groth16Proof; publicSignals: string[] };
    this.#shareParams = undefined;
    return { proof, publicSignals, ciphertexts };
  }

  private prepareShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextBets: RouletteBet[],
    nActualBets: number,
  ) {
    if (!this.#showdownParams) {
      const playerIndex = publicKeys.findIndex(pk =>
        pk.every((value, i) => value === this.publicKey[i]),
      );
      if (playerIndex < 0) throw new Error('Player public key not found');

      if (!this.#sealedCoefficients || this.#sealedCoefficients.length !== MAX_BETS) {
        throw new Error('showdown coefficients must come from the host');
      }
      const coefficients = [...this.#sealedCoefficients];

      const paddedBets = padBets(plaintextBets, this.#roulette.deckSize);
      const hashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards,
        ciphertextPartials,
        ciphertextBets,
        nActualBets,
      };

      const hash = this.#roulette.showdownHash(hashInput);
      const plaintextCards = this.#roulette.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      const plaintextCard = plaintextCards[0]!;
      const payouts = evaluateBets(
        paddedBets,
        Number(plaintextCard),
        this.#roulette.deckSize,
        nActualBets,
      );

      this.#showdownParams = {
        hash,
        hashInput,
        plaintextCard,
        plaintextBets: paddedBets,
        payouts,
        coefficients,
      };
    }
    return this.#showdownParams;
  }

  private showdownWitnessInput(params: RouletteShowdownParams) {
    return {
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCard: params.plaintextCard,
      plaintextBets: params.plaintextBets.map(b => [b[0], b[1]]),
      coefficients: params.coefficients.map(c => c.toString()),
    };
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextBets: RouletteBet[],
    nActualBets: number,
  ): void {
    if (this.usesZig()) return;
    const params = this.prepareShowdown(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
      ciphertextBets,
      plaintextBets,
      nActualBets,
    );
    this.#circuits.showdown.preloadWitness(this.showdownWitnessInput(params));
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    ciphertextBets: Ciphertext[],
    plaintextBets: RouletteBet[],
    nActualBets: number,
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      if (!this.#sealedCoefficients || this.#sealedCoefficients.length !== MAX_BETS) {
        throw new Error('showdown coefficients must come from the host');
      }
      const paddedBets = padBets(plaintextBets, this.#roulette.deckSize);
      const out = await this.#session.showdown({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        ciphertextBets,
        bets: paddedBets,
        nActualBets,
        coefficients: this.#sealedCoefficients,
        privateKey: this.#key?.privateKey,
      });
      const plaintextCards = this.#roulette.decryptCards(
        this.#privateKey,
        ciphertextCards,
        ciphertextPartials,
      );
      const plaintextCard = plaintextCards[0]!;
      const payouts = evaluateBets(
        paddedBets,
        Number(plaintextCard),
        this.#roulette.deckSize,
        nActualBets,
      );
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        payouts,
        publicKey: out.publicKey,
        plaintextCard,
      };
    }
    const params = this.prepareShowdown(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
      ciphertextBets,
      plaintextBets,
      nActualBets,
    );

    const { proof, publicSignals } = await this.#circuits.showdown.prove(
      this.showdownWitnessInput(params),
    );

    this.#showdownParams = undefined;

    return {
      proof,
      publicSignals,
      payouts: params.payouts,
      publicKey: this.publicKey,
      plaintextCard: params.plaintextCard,
    };
  }
}
