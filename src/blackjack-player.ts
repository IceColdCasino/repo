import {
  Blackjack,
  MAX_SHARE_CARDS,
  CHUNK_SHARE_CARDS,
  N_SHARE_CHUNKS,
  SHOE_SIZE,
  MAX_HANDS,
  MAX_CARDS_PER_HAND,
  MAX_DEALER_CARDS,
  MAX_SHOWDOWN_CARDS,
  SENTINEL_CARD,
  paddedShareChunk,
  emptyHandLayout,
  computeHandValue,
  compareHandToDealer,
  cardToRank,
  rankToHardValue,
  type BlackjackHandLayout,
  type BlackjackActionStatus,
  type BlackjackDealerActionStatus,
  type HandOutcome,
} from './blackjack';
import { type PlayerKey, type PublicKey, type Ciphertext } from './zk-casino';
import { padPublicKeysForShuffle } from './shuffle-common';
import { Circuit, type DeepArray, type NumberLike } from './circuit';
import type { Groth16Proof } from 'snarkjs';
import assert from 'assert';
import { GameKind } from './game-config';
import { tryOpenGameSession, shuffleVariant } from './player-zig-session';
import type { PlayerSession } from './player-native-bridge';

export interface BlackjackCircuits {
  register: Circuit;
  shuffle: Circuit;
  shareChunk: Circuit;
  action: Circuit;
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

export interface ShareChunkProofInput {
  chunkIndex: number;
  input: Record<string, NumberLike | DeepArray<NumberLike>>;
  ciphertexts: Ciphertext[][];
}

export interface IsolatedShareChunkProofJob {
  chunkIndex: number;
  circuit: Circuit;
  prove: () => Promise<ShareOutput>;
}

export interface ActionProveOptions {
  canSplit?: boolean;
  hitSoft17?: boolean;
  /** false = player path, true = dealer house rules */
  isDealer?: boolean;
}

export interface ActionProofInput {
  input: Record<string, NumberLike | DeepArray<NumberLike>>;
  status: BlackjackActionStatus | BlackjackDealerActionStatus;
  actionHash: bigint;
  publicKey: PublicKey;
  isDealer: boolean;
}

export interface ActionOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  status: BlackjackActionStatus | BlackjackDealerActionStatus;
  actionHash: bigint;
  publicKey: PublicKey;
  isDealer: boolean;
  /** Circuit output: Ace upcard when isDealer, else false. */
  dealerUpIsAce: boolean;
}

export interface ShowdownProofInput {
  input: Record<string, NumberLike | DeepArray<NumberLike>>;
  outcomesHash: bigint;
  publicKey: PublicKey;
  handLayout: BlackjackHandLayout;
  handIndex: number;
  outcome: HandOutcome;
}

export interface ShowdownOutput {
  proof: Groth16Proof;
  publicSignals: string[];
  outcomesHash: bigint;
  publicKey: PublicKey;
  handLayout: BlackjackHandLayout;
  handIndex: number;
  outcome: HandOutcome;
}

export async function loadBlackjackCircuits(
  shoeDecks: 1 | 6 | 8 = 6,
): Promise<BlackjackCircuits> {
  const { GameKind, normalizeGameConfig, shuffleCircuitId } = await import('./game-config');
  const shuffleName = shuffleCircuitId(normalizeGameConfig(GameKind.Blackjack, shoeDecks));
  const register = new Circuit('register_main');
  await register.load();
  const shuffle = new Circuit(shuffleName);
  await shuffle.load();
  const shareChunk = new Circuit('blackjack_share_hashout_main');
  await shareChunk.load();
  const action = new Circuit('blackjack_action_hashout_main');
  await action.load();
  const showdown = new Circuit('blackjack_showdown_hashout_main');
  await showdown.load();

  return { register, shuffle, shareChunk, action, showdown };
}

export class Player {
  #blackjack = new Blackjack();
  #key: PlayerKey | undefined;
  #circuits: BlackjackCircuits;

  #shuffleParams: {
    hash: bigint;
    permutationMatrix: bigint[];
    randomness: bigint[];
    deck: Ciphertext[];
  } | undefined;

  #shareChunkParams = new Map<string, { hash: bigint; randomness: bigint[][]; chunkIndex: number }>();

  #showdownParams: {
    hash: bigint;
    hashInput: object;
    plaintextCards: bigint[];
    playerCardCount: number;
    dealerCardCount: number;
    handLayout: BlackjackHandLayout;
    handIndex: number;
    outcome: HandOutcome;
    outcomesHash: bigint;
    coefficient: bigint;
  } | undefined;
  #sealedCoefficients: bigint[] | undefined;
  #session: PlayerSession | undefined;
  #padding: Ciphertext | undefined;

  constructor(circuits: BlackjackCircuits) {
    this.#circuits = circuits;
  }

  private usesZig(): boolean {
    return this.#session !== undefined;
  }

  /** Host-sealed coefficients. Showdown uses one; action uses two. Players never generate these. */
  setSealedCoefficients(coeffs: bigint[]): void {
    if (coeffs.length !== 1 && coeffs.length !== 2) {
      throw new Error(`Expected 1 or 2 sealed coefficients, got ${coeffs.length}`);
    }
    if (coeffs[0] === 0n) {
      throw new Error('Sealed coefficient must be non-zero');
    }
    this.#sealedCoefficients = [...coeffs];
    this.#showdownParams = undefined;
  }

  async init() {
    this.#session = await tryOpenGameSession({
      kind: GameKind.Blackjack,
      variant: shuffleVariant(this.#circuits.shuffle.circuitName),
    });
    await this.#blackjack.init();
    if (this.#session) return;
    await this.#circuits.register.load();
    await this.#circuits.shuffle.load();
    await this.#circuits.shareChunk.load();
    await this.#circuits.action.load();
    await this.#circuits.showdown.load();
  }

  generateKey() {
    if (this.usesZig()) return;
    if (!this.#key) this.#key = this.#blackjack.generatePlayerKey();
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
    return this.#blackjack.getPadding(this.publicKey);
  }

  get #privateKey() {
    if (!this.#key) throw new Error('Key not yet generated');
    assert(this.#key.privateKey > 1024n, 'Private Key is too small');
    return this.#key.privateKey;
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
    const hash = this.#blackjack.shuffleHash(deck, publicKeys);
    if (!this.#shuffleParams || this.#shuffleParams.hash !== hash) {
      const permutationMatrix = this.#blackjack.generateShufflePermutation(SHOE_SIZE);
      const randomness = this.#blackjack.generateShuffleRandomness(SHOE_SIZE);
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
    const { ciphertexts, permutationHash } = this.#blackjack.shuffle(
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

  prepareShareChunkParams(
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    chunkIndex: number,
    nActualPlayers: number,
  ) {
    const chunkDeck = paddedShareChunk(shareDeck, chunkIndex);
    const hash = this.#blackjack.shareHash(chunkDeck, this.publicKey, publicKeys);
    const cacheKey = `${chunkIndex}:${hash.toString()}`;
    let params = this.#shareChunkParams.get(cacheKey);
    if (!params) {
      const randomness = new Array(publicKeys.length).fill(0n)
        .map(() => new Array(CHUNK_SHARE_CARDS).fill(0n)
          .map(() => this.#blackjack.getRandom()));
      params = { hash, randomness, chunkIndex };
      this.#shareChunkParams.set(cacheKey, params);
    }
    return params;
  }

  private clearShareChunkParams(
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    chunkIndex: number,
    nActualPlayers: number,
  ) {
    const chunkDeck = paddedShareChunk(shareDeck, chunkIndex);
    const hash = this.#blackjack.shareHash(chunkDeck, this.publicKey, publicKeys);
    this.#shareChunkParams.delete(`${chunkIndex}:${hash.toString()}`);
  }

  preloadShareChunk(
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    chunkIndex: number,
    nActualPlayers: number,
  ): void {
    if (this.usesZig()) return;
    const chunkDeck = paddedShareChunk(shareDeck, chunkIndex);
    const params = this.prepareShareChunkParams(shareDeck, publicKeys, chunkIndex, nActualPlayers);
    this.#circuits.shareChunk.preloadWitness({
      hash: params.hash,
      ciphertext: chunkDeck,
      publicKey: this.publicKey,
      publicKeys,
      nActualPlayers,
      privateKey: this.#privateKey,
      randomness: params.randomness,
    });
  }

  createShareChunkProofInput(
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    chunkIndex: number,
    nActualPlayers: number,
  ): ShareChunkProofInput {
    const chunkDeck = paddedShareChunk(shareDeck, chunkIndex);
    const params = this.prepareShareChunkParams(shareDeck, publicKeys, chunkIndex, nActualPlayers);
    const ciphertexts = this.#blackjack.shareChunk(
      chunkDeck,
      publicKeys,
      this.#privateKey,
      params.randomness,
    );

    return {
      chunkIndex,
      input: {
        hash: params.hash,
        ciphertext: chunkDeck,
        publicKey: this.publicKey,
        publicKeys,
        nActualPlayers,
        privateKey: this.#privateKey,
        randomness: params.randomness,
      },
      ciphertexts,
    };
  }

  async shareProveChunk(
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    chunkIndex: number,
    nActualPlayers: number,
  ): Promise<ShareOutput> {
    if (this.#session) {
      const chunkDeck = paddedShareChunk(shareDeck, chunkIndex);
      const out = await this.#session.share(chunkDeck, publicKeys, nActualPlayers, this.#key?.privateKey);
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        ciphertexts: out.ciphertexts,
      };
    }
    return this.proveShareChunkWithCircuit(
      this.#circuits.shareChunk,
      shareDeck,
      publicKeys,
      chunkIndex,
      nActualPlayers,
      true,
    );
  }

  private async proveShareChunkWithCircuit(
    circuit: Circuit,
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    chunkIndex: number,
    nActualPlayers: number,
    clearParams: boolean,
  ): Promise<ShareOutput> {
    const { input, ciphertexts } = this.createShareChunkProofInput(
      shareDeck,
      publicKeys,
      chunkIndex,
      nActualPlayers,
    );
    const { proof, publicSignals } = await circuit.prove(input) as { proof: Groth16Proof; publicSignals: string[] };

    if (clearParams) this.clearShareChunkParams(shareDeck, publicKeys, chunkIndex, nActualPlayers);
    return { proof, publicSignals, ciphertexts };
  }

  async createIsolatedShareChunkProofJobs(
    shareDeck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
    nChunks: number = N_SHARE_CHUNKS,
  ): Promise<IsolatedShareChunkProofJob[]> {
    return Promise.all(Array.from({ length: nChunks }, async (_, chunkIndex) => {
      this.prepareShareChunkParams(shareDeck, publicKeys, chunkIndex, nActualPlayers);
      const circuit = new Circuit('blackjack_share_hashout_main');
      await circuit.load();
      return {
        chunkIndex,
        circuit,
        prove: async () => this.proveShareChunkWithCircuit(
          circuit,
          shareDeck,
          publicKeys,
          chunkIndex,
          nActualPlayers,
          false,
        ),
      };
    }));
  }

  clearAllShareChunkParams() {
    this.#shareChunkParams.clear();
  }

  buildHandLayoutFromShareSlots(
    plaintextCards: bigint[],
    deal: {
      playerHands: { player: number; hand: number; shareSlots: number[] }[];
      dealerShareSlots: number[];
    },
  ): BlackjackHandLayout {
    const layout = emptyHandLayout();

    for (const { player, hand, shareSlots } of deal.playerHands) {
      layout.playerHandLengths[player]![hand] = shareSlots.length;
      for (let i = 0; i < shareSlots.length; i++) {
        const shareSlot = shareSlots[i]!;
        layout.playerHandCards[player]![hand]![i] = Number(plaintextCards[shareSlot]!);
        layout.playerHandSourceIndices[player]![hand]![i] = shareSlot;
      }
    }

    layout.dealerCardCount = deal.dealerShareSlots.length;
    for (let i = 0; i < deal.dealerShareSlots.length; i++) {
      const shareSlot = deal.dealerShareSlots[i]!;
      layout.dealerCards[i] = Number(plaintextCards[shareSlot]!);
      layout.dealerSourceIndices[i] = shareSlot;
    }

    return layout;
  }

  private prepareShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    handLayout: BlackjackHandLayout,
    handIndex: number,
  ) {
    if (!this.#showdownParams || this.#showdownParams.handIndex !== handIndex) {
      const sharedCardCount = ciphertextPartials[0]?.length ?? ciphertextCards.length;
      const availableCiphertextCards = ciphertextCards.slice(0, sharedCardCount);
      const allPlaintextCards = this.#blackjack.decryptCards(
        this.#privateKey,
        availableCiphertextCards,
        ciphertextPartials,
      );
      const playerIndex = publicKeys.findIndex(pk =>
        pk.every((value, i) => value === this.publicKey[i]),
      );
      if (playerIndex < 0) throw new Error('Player public key not found');

      const playerCardCount = handLayout.playerHandLengths[playerIndex]![handIndex]!;
      if (playerCardCount <= 0) {
        throw new Error(`Cannot showdown empty hand ${handIndex}`);
      }

      const sourceIndices = this.#blackjack.oneHandShowdownSourceIndices(
        handLayout,
        playerIndex,
        handIndex,
      );
      const dealerCardCount = handLayout.dealerCardCount;
      const plaintextCards = sourceIndices.map(index => allPlaintextCards[index]!);
      if (plaintextCards.length !== MAX_SHOWDOWN_CARDS) {
        throw new Error(`Expected ${MAX_SHOWDOWN_CARDS} showdown cards, got ${plaintextCards.length}`);
      }

      // Dense layout: player used || dealer used || pad
      const playerCards = Array.from({ length: MAX_CARDS_PER_HAND }, (_, c) =>
        Number(plaintextCards[c] ?? 0n),
      );
      const dealerCards = Array.from({ length: MAX_DEALER_CARDS }, (_, d) =>
        Number(plaintextCards[playerCardCount + d] ?? 0n),
      );
      const playerHand = computeHandValue(playerCards, playerCardCount);
      if (playerHand.isBust) {
        throw new Error('Bust hands settle via action proof; skip showdown');
      }
      const dealerHand = computeHandValue(dealerCards, dealerCardCount);
      const outcome = compareHandToDealer(playerHand, dealerHand);

      const selectedCiphertextCards = sourceIndices.map(index => availableCiphertextCards[index]!);
      const selectedCiphertextPartials = ciphertextPartials.map(partials =>
        sourceIndices.map(index => partials[index]!),
      );
      const selectedHashInput = {
        publicKeys,
        playerIndex: BigInt(playerIndex),
        ciphertextCards: selectedCiphertextCards,
        ciphertextPartials: selectedCiphertextPartials,
        playerCardCount,
        dealerCardCount,
      };
      const selectedHash = this.#blackjack.showdownHash(selectedHashInput);
      if (!this.#sealedCoefficients?.[0]) {
        throw new Error('showdown coefficients must come from the host');
      }
      const coefficient = this.#sealedCoefficients[0];
      const outcomesHash = this.#blackjack.computePlayerShowdownOutputHash(outcome, coefficient);

      this.#showdownParams = {
        hash: selectedHash,
        hashInput: selectedHashInput,
        plaintextCards,
        playerCardCount,
        dealerCardCount,
        handLayout,
        handIndex,
        outcome,
        outcomesHash,
        coefficient,
      };
    }
    return this.#showdownParams;
  }

  preloadShowdown(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    handLayout: BlackjackHandLayout,
    handIndex = 0,
  ): void {
    const params = this.prepareShowdown(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
      handLayout,
      handIndex,
    );
    this.#circuits.showdown.preloadWitness(this.showdownWitnessInput(params));
  }

  private showdownWitnessInput(params: {
    hash: bigint;
    hashInput: object;
    plaintextCards: bigint[];
    playerCardCount: number;
    dealerCardCount: number;
    coefficient: bigint;
  }) {
    return {
      hash: params.hash,
      ...(params.hashInput as object),
      publicKey: this.publicKey,
      privateKey: this.#privateKey,
      plaintextCards: params.plaintextCards,
      playerCardCount: params.playerCardCount,
      dealerCardCount: params.dealerCardCount,
      coefficients: [params.coefficient.toString()],
    };
  }

  decryptShareCards(ciphertextCards: Ciphertext[], ciphertextPartials: Ciphertext[][]) {
    const sharedCardCount = ciphertextPartials[0]?.length ?? ciphertextCards.length;
    return this.#blackjack.decryptCards(this.#privateKey, ciphertextCards.slice(0, sharedCardCount), ciphertextPartials);
  }

  createActionProofInput(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    sourceIndices: number[],
    opts: boolean | ActionProveOptions = {},
  ): ActionProofInput {
    // Back-compat: actionProve(..., canSplit: boolean)
    const options: ActionProveOptions =
      typeof opts === 'boolean' ? { canSplit: opts, isDealer: false } : opts;
    const isDealer = options.isDealer ?? false;
    const canSplit = isDealer ? false : (options.canSplit ?? false);
    const hitSoft17 = isDealer ? (options.hitSoft17 ?? false) : false;

    const sharedCardCount = ciphertextPartials[0]?.length ?? ciphertextCards.length;
    const availableCiphertextCards = ciphertextCards.slice(0, sharedCardCount);
    const allPlaintextCards = this.#blackjack.decryptCards(
      this.#privateKey,
      availableCiphertextCards,
      ciphertextPartials,
    );
    // Unified circuit pads to maxDealerCards (13).
    const paddedSourceIndices = Array.from(
      { length: MAX_DEALER_CARDS },
      (_, i) => sourceIndices[i] ?? 0,
    );
    const plaintextCards = paddedSourceIndices.map(index => allPlaintextCards[index]!);
    const faceCards = plaintextCards.map(card => Number(card));
    const selectedCiphertextCards = paddedSourceIndices.map(
      index => availableCiphertextCards[index]!,
    );
    const selectedCiphertextPartials = ciphertextPartials.map(partials =>
      paddedSourceIndices.map(index => partials[index]!),
    );
    const hash = this.#blackjack.actionHash(
      publicKeys,
      selectedCiphertextCards,
      selectedCiphertextPartials,
      sourceIndices.length,
      { canSplit, hitSoft17, isDealer },
    );
    const status = isDealer
      ? this.#blackjack.evaluateDealerActionStatus(faceCards, sourceIndices.length, hitSoft17)
      : this.#blackjack.evaluateActionStatus(faceCards, sourceIndices.length, canSplit);
    const randomCoeffs = this.#blackjack.generateShowdownCoefficients();
    const statusCoeff = randomCoeffs[0]!;
    // Ace term: random on dealer path (binds Ace into poly hash); 0 on player path.
    const aceCoeff = isDealer ? randomCoeffs[1]! : 0n;
    const dealerUpIsAce = isDealer
      && rankToHardValue(cardToRank(faceCards[0]!)).isAce;
    const aceFlag = dealerUpIsAce ? 1n : 0n;
    const actionHash =
      (BigInt(status) + 1n) * statusCoeff + (aceFlag + 1n) * aceCoeff;

    return {
      input: {
        hash,
        publicKeys,
        publicKey: this.publicKey,
        ciphertextCards: selectedCiphertextCards,
        ciphertextPartials: selectedCiphertextPartials,
        privateKey: this.#privateKey,
        plaintextCards,
        cardCount: sourceIndices.length,
        canSplit: canSplit ? 1 : 0,
        hitSoft17: hitSoft17 ? 1 : 0,
        isDealer: isDealer ? 1 : 0,
        coefficients: [statusCoeff.toString(), aceCoeff.toString()],
      },
      status,
      actionHash,
      publicKey: this.publicKey,
      isDealer,
    };
  }

  async actionProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    sourceIndices: number[],
    opts: boolean | ActionProveOptions = {},
  ): Promise<ActionOutput> {
    if (this.#session) {
      const options: ActionProveOptions =
        typeof opts === 'boolean' ? { canSplit: opts, isDealer: false } : opts;
      const isDealer = options.isDealer ?? false;
      const coefficients = this.#sealedCoefficients;
      if (!coefficients || coefficients.length !== 2) {
        throw new Error('action coefficients must come from the host');
      }
      const out = await this.#session.action({
        publicKeys,
        cards: ciphertextCards,
        partials: ciphertextPartials,
        sourceIndices,
        cardCount: sourceIndices.length,
        canSplit: isDealer ? false : (options.canSplit ?? false),
        hitSoft17: isDealer ? (options.hitSoft17 ?? false) : false,
        isDealer,
        coefficients,
        privateKey: this.#key?.privateKey,
      });
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals,
        status: out.status as ActionOutput['status'],
        actionHash: BigInt(out.publicSignals[0]!),
        publicKey: out.publicKey,
        isDealer,
        dealerUpIsAce: BigInt(out.publicSignals[1]!) === 1n,
      };
    }
    const prepared = this.createActionProofInput(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
      sourceIndices,
      opts,
    );
    const { proof, publicSignals } = await this.#circuits.action.prove(prepared.input);
    // Public signals: [statusHash, dealerUpIsAce, inputHash]
    if (publicSignals.length < 3) {
      throw new Error(
        `blackjack action expects 3 public signals, got ${publicSignals.length}`,
      );
    }
    return {
      proof,
      publicSignals,
      status: prepared.status,
      actionHash: prepared.actionHash,
      publicKey: prepared.publicKey,
      isDealer: prepared.isDealer,
      dealerUpIsAce: BigInt(publicSignals[1]!) === 1n,
    };
  }

  createShowdownProofInput(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    handLayout: BlackjackHandLayout,
    handIndex = 0,
  ): ShowdownProofInput {
    const params = this.prepareShowdown(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
      handLayout,
      handIndex,
    );
    return {
      input: this.showdownWitnessInput(params),
      outcomesHash: params.outcomesHash,
      publicKey: this.publicKey,
      handLayout: params.handLayout,
      handIndex: params.handIndex,
      outcome: params.outcome,
    };
  }

  clearShowdownParams() {
    this.#showdownParams = undefined;
  }

  async showdownProve(
    publicKeys: PublicKey[],
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    handLayout: BlackjackHandLayout,
    handIndex = 0,
  ): Promise<ShowdownOutput> {
    if (this.#session) {
      const prepared = this.createShowdownProofInput(
        publicKeys,
        ciphertextCards,
        ciphertextPartials,
        handLayout,
        handIndex,
      );
      const input = prepared.input as {
        ciphertextCards: Ciphertext[];
        ciphertextPartials: Ciphertext[][];
        plaintextCards: bigint[];
        playerCardCount: number;
        dealerCardCount: number;
        coefficients: string[];
      };
      const out = await this.#session.showdown({
        publicKeys,
        cards: input.ciphertextCards,
        partials: input.ciphertextPartials,
        plaintextCards: input.plaintextCards,
        playerCardCount: input.playerCardCount,
        dealerCardCount: input.dealerCardCount,
        coefficients: input.coefficients.map(BigInt),
        privateKey: this.#key?.privateKey,
      });
      this.clearShowdownParams();
      return {
        proof: out.proof as Groth16Proof,
        publicSignals: out.publicSignals!,
        outcomesHash: prepared.outcomesHash,
        publicKey: prepared.publicKey,
        handLayout: prepared.handLayout,
        handIndex: prepared.handIndex,
        outcome: prepared.outcome,
      };
    }
    const prepared = this.createShowdownProofInput(
      publicKeys,
      ciphertextCards,
      ciphertextPartials,
      handLayout,
      handIndex,
    );

    const { proof, publicSignals } = await this.#circuits.showdown.prove(prepared.input);

    this.clearShowdownParams();

    return {
      proof,
      publicSignals,
      outcomesHash: prepared.outcomesHash,
      publicKey: prepared.publicKey,
      handLayout: prepared.handLayout,
      handIndex: prepared.handIndex,
      outcome: prepared.outcome,
    };
  }
}