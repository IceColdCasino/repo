/**
 * Continuous blackjack hand: Groth16 + Arcis chunked share/reveal/seal/showdown,
 * then dealer-pool settlement for the bettor seat only.
 *
 * Topology (2p E2E): provider locks seat 0 as bettor; seat 1 is the house
 * (`dealerIndex: 1`, `src/house/blackjack.ts`). Share is lazy: on-chain starts at 1×16-card chunk;
 * further chunks open only when the shoe cursor needs card 16+.
 *
 * Action policy: player follows basic strategy with up to three splits; every
 * player/dealer state transition is proven and verified before the next draw.
 *
 * Reveal policy (staged): the initial face-up cards are one wave — every
 * player card and the dealer upcard, including the dealer's own copy of the
 * upcard. The dealer then receives the hole card so the action circuit can
 * see it. That hole card is not revealed to the other players until they
 * have finished betting and drawing, which is when the dealer may draw. The dealer's initial action
 * proof is the blackjack check: status 2 is a natural, and any other status
 * means the dealer does not have one. If the upcard is an Ace, the bettor may
 * buy insurance (or even money on a natural) before further hit/stand/split.
 * Subsequent dealer draws are revealed as they are dealt. Never bulk-reveal
 * the full 24-card shoe window.
 */
import { randomBytes } from 'node:crypto';
import { BN, web3, type Program, type AnchorProvider } from '@coral-xyz/anchor';
import { getMXEPublicKey } from '@arcium-hq/client';
import { Game } from '../blackjack-game';
import { blackjackCardFieldGroups, shareStreetChunkCount } from '../share-street-fields';
import { Player, type BlackjackCircuits } from '../blackjack-player';
import {
  BlackjackActionLayout,
  MAX_DEALER_CARDS,
  MAX_SHOWDOWN_CARDS,
  computeHandValue,
  dealerActionStatusTerminal,
  type BlackjackHandLayout,
  type HandOutcome,
} from '../blackjack';
import {
  dealerOffersInsurance,
  defaultInsuranceDecision,
  insuranceNet,
  type InsuranceDecision,
} from '../blackjack-insurance';
import {
  generateTableEncryptionKey,
  type TableEncryptionKey,
} from '../bet-encryption';
import {
  showdownTwoCoeffHash,
  openSealedShowdown,
  type SealedShowdownAccount,
} from '../showdown-sealed-coeffs';
import { OnchainGameLifecycle, showdownCardIndicesForGame } from './onchain-game-lifecycle';
import { beginHandCost, finishHandCost } from './hand-cost';
import {
  releaseDevnetSession,
  setupCasinoEncryptedTable,
  type CasinoEncryptedTable,
} from './betting-integration';
import { CasinoSettlementHelper } from './casino-settlement-helper';
import { ArciumMPCHelper, sealShowdownCompDefNames } from '../arcium/mpc';
import { ArciumPollingHelper } from '../arcium/polling';
import { loadMxeAuthorityProvider } from './admin-provider';
import { loadCasinoProgram } from '../testing/deploy';
import {
  DeckStagingHelper,
  GameStateHelper,
  RevealedCardsHelper,
} from './staging';
import {
  flattenCasinoShareCiphertexts,
  encryptContiguousShareForStaging,
  toTwoPlayerCasinoCardMajorShareValues,
  shareValuesToCommitments,
  encryptCommitmentRowsForStaging,
  splitHashHalves,
  BLACKJACK_N_OTHERS,
  BLACKJACK_CHUNK_CARDS,
} from './share-deck-staging';
import {
  mapPool,
  isVerifyChunkStartDone,
  runShareVerifyChunks,
  afterBackground,
} from '../arcium/verify-chunk-parallel';
import { casinoRevealConcurrency, groth16ProveConcurrency, shareChunkConcurrency, sharePlayerConcurrency } from '../arcium/heap';
import {
  multiGameZkConfig,
  type MultiGameZkConfig,
} from './multi-game-zk-config';
import { GameKind } from '../game-config';
import type { Ciphertext } from '../zk-casino';
import type { ShowdownSealMaterial } from './continuous-zk-arcis-hand';
import {
  blackjackBasicStrategy,
  isDoubleFallback,
} from '../blackjack-basic-strategy';

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  console.time(label);
  try {
    return await work();
  } finally {
    console.timeEnd(label);
  }
}

export interface ContinuousBlackjackHandResult {
  gameId: Uint8Array;
  outcome: HandOutcome;
  outcomes: HandOutcome[];
  sealedCoefficients: bigint[];
  showdownHash: bigint;
  deckHash: bigint;
  phase: number;
  showdownSubmitterPlayerIndex: number;
  showdownProveMs: number;
  handSettled: boolean;
  /** True when every player hand busted via action — showdown skipped. */
  skippedShowdown: boolean;
  /** Verified player/dealer action-circuit proofs (≥2). */
  actionProofCount: number;
  /** Insurance / even-money decision (decline when not offered). */
  insurance: InsuranceDecision;
  /** True when dealer upcard was an Ace (insurance was offered). */
  insuranceOffered: boolean;
}

interface ActionResolvedHand {
  layout: BlackjackHandLayout;
  survivingHands: Array<{
    handIndex: number;
    playerCardCount: number;
    dealerCardCount: number;
    sourceIndices: number[];
  }>;
  allHandsBusted: boolean;
  earlyOutcome?: HandOutcome;
  actionProofCount: number;
  insurance: InsuranceDecision;
  insuranceOffered: boolean;
  dealerHasBlackjack: boolean;
}

/** Continuous E2E defaults to S17 (stand soft 17). */
const DEALER_HIT_SOFT_17 = false;
/** Dealer shoe order: first card face-up, second face-down (hole). */
const DEALER_UPCARD_OFFSET = 0;
const DEALER_HOLE_OFFSET = 1;

export class ContinuousBlackjackHand {
  readonly gameId: Uint8Array;
  readonly game: Game;
  readonly players: Player[] = [];
  readonly arcium: ArciumMPCHelper;
  readonly polling: ArciumPollingHelper;
  readonly staging: DeckStagingHelper;
  readonly gameState: GameStateHelper;
  readonly revealedCards: RevealedCardsHelper;
  readonly zkConfig: MultiGameZkConfig;
  readonly showdownSeals = new Map<number, ShowdownSealMaterial>();

  tableKey: TableEncryptionKey;
  private lifecycle!: OnchainGameLifecycle;
  private casinoTable!: CasinoEncryptedTable;
  private settlement!: CasinoSettlementHelper;
  private numPlayers: number;
  private stakeAmount: bigint;
  private deckNonce = 0n;
  private shareCiphertextsForStaging: Ciphertext[][][] = [];
  private shareChunkCiphertexts: Ciphertext[][][][] = [];
  private recordedRevealCards = new Set<number>();
  private deckStagingClosed = false;
  /** On-chain / local prefix of shoe cards whose share round is finalized. */
  private sharedCardsReady = 0;
  /** Light `n_share_chunks` after init/extends (starts at 1). */
  private onChainShareChunks = 1;
  private shareStagingCreated = false;
  /** >2p: next-chunk share kicked off after chunk 0, overlapping actions. */
  private prefetchShare: Promise<void> | null = null;
  /** Serialize lazy share rounds (prefetch vs ensureSharedThrough). */
  private shareExtendGate: Promise<void> = Promise.resolve();
  private deckHash = 0n;

  constructor(
    private circuits: BlackjackCircuits,
    private pokerProgram: Program,
    private lightPokerProgram: Program,
    private provider: AnchorProvider,
    opts?: {
      numPlayers?: number;
      shoeDecks?: 1 | 6 | 8;
      stakeAmount?: bigint;
      zkConfig?: MultiGameZkConfig;
    },
  ) {
    this.numPlayers = opts?.numPlayers ?? 2;
    const shoeDecks = opts?.shoeDecks ?? 6;
    this.stakeAmount = opts?.stakeAmount ?? 100n;
    this.zkConfig =
      opts?.zkConfig
      ?? multiGameZkConfig(GameKind.Blackjack, { numPlayers: this.numPlayers, shoeDecks });
    if (this.zkConfig.config.kind !== GameKind.Blackjack) {
      throw new Error(
        `zkConfig kind ${this.zkConfig.config.kind} does not match GameKind.Blackjack`,
      );
    }
    this.game = new Game(shoeDecks);
    this.gameId = crypto.getRandomValues(new Uint8Array(32));
    this.arcium = new ArciumMPCHelper(pokerProgram, provider);
    this.polling = new ArciumPollingHelper(provider);
    this.staging = new DeckStagingHelper(pokerProgram as any, provider);
    this.gameState = new GameStateHelper(pokerProgram as any, provider);
    this.revealedCards = new RevealedCardsHelper(pokerProgram as any, provider);
    this.tableKey = generateTableEncryptionKey();
    this.settlement = new CasinoSettlementHelper(provider, pokerProgram);
  }

  private createPlayer(seat: number): Player {
    return new Player(this.circuits, seat === this.zkConfig.dealerIndex);
  }

  private nextOffset(): BN {
    return new BN(randomBytes(8), 'hex');
  }

  private nextOffsetU32(): number {
    return 1000 + Math.floor(Math.random() * 1_000_000);
  }

  private gameStatePda(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('game_state'), Buffer.from(this.gameId)],
      this.pokerProgram.programId,
    )[0];
  }

  private cardIndices(): number[] {
    return showdownCardIndicesForGame(
      this.zkConfig.config.kind,
      this.numPlayers,
      this.zkConfig.showdownCards,
    );
  }

  /** Economic bettor seat (provider at seat 0 when present). */
  private bettorPlayer(): { index: number; keypair: web3.Keypair } {
    const dealer = this.zkConfig.dealerIndex;
    const bettor = dealer === 0 ? 1 : 0;
    const idx = this.casinoTable.players.findIndex((p) =>
      p.publicKey.equals(this.provider.wallet.publicKey),
    );
    if (idx >= 0 && idx !== dealer) {
      return { index: idx, keypair: this.casinoTable.players[idx]! };
    }
    return { index: bettor, keypair: this.casinoTable.players[bettor]! };
  }

  static readonly HAND_COMP_DEFS = [
    'revealCard',
    ...sealShowdownCompDefNames(2),
    'fundPlayerGameEscrow',
    'applyCasinoPlayerNet',
    'returnPlayerGameEscrow',
    'settleCasinoHand',
  ];

  async initCompDefs(names?: string[]): Promise<void> {
    if (process.env.SKIP_COMP_DEFS === '1') {
      console.log('[comp-def] SKIP_COMP_DEFS=1 — assuming CompDefs already finalized');
      return;
    }
    const list = names ?? [...ContinuousBlackjackHand.HAND_COMP_DEFS];
    const adminProvider = await loadMxeAuthorityProvider(this.provider.connection);
    const adminArcium = new ArciumMPCHelper(loadCasinoProgram(adminProvider), adminProvider);

    if (process.env.UPLOAD_COMP_DEFS === '1') {
      const { finalized, uploaded } = await adminArcium.ensureCompDefs(list, {
        uploadConcurrency: Number(process.env.COMP_DEF_UPLOAD_CONCURRENCY ?? '1'),
      });
      console.log(
        `[comp-def] done — skipped=${finalized.length} uploaded=${uploaded.length}`,
      );
      return;
    }

    const missing: string[] = [];
    for (const name of list) {
      const state = await adminArcium.getCompDefState(name);
      if (state === 'OnchainFinalized') {
        console.log(`[comp-def] ${name} already finalized — skip`);
      } else {
        missing.push(`${name} (${state})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Arcis CompDefs not finalized:\n`
          + missing.map((m) => `  - ${m}`).join('\n')
          + `\nRun: bun run localnet:compdefs`,
      );
    }
    console.log(`[comp-def] all ${list.length} CompDefs finalized — no upload`);
  }

  async initialize(): Promise<void> {
    await this.game.init();
    this.lifecycle = new OnchainGameLifecycle(
      this.lightPokerProgram,
      this.provider,
      this.gameId,
      this.pokerProgram,
    );
    this.casinoTable = await setupCasinoEncryptedTable(
      this.pokerProgram,
      this.provider,
      this.gameId,
      {
        gameKind: GameKind.Blackjack,
        numPlayers: this.numPlayers,
        shoeDecks: this.zkConfig.config.shoeDecks as 1 | 6 | 8,
        buyIn: 10_000n,
        onStaged: async () => {
          await this.lifecycle.initializeGames(
            this.numPlayers,
            this.zkConfig.config.kind,
            this.zkConfig.config.shoeDecks,
            this.zkConfig.config.rouletteVariant,
            this.zkConfig.dealerIndex,
          );
        },
      },
    );
    this.staging.writeAuth = {
      tableState: this.casinoTable.tableState,
      authority: this.casinoTable.players[0],
    };
    await this.arcium.initPlayerGameEscrows(this.gameId, this.numPlayers);
  }

  async registerAll(): Promise<void> {
    console.log(`[register] ${this.numPlayers} players parallel`);
    const proved = (
      await Promise.all(
        Array.from({ length: this.numPlayers }, async (_, p) => {
          const player = this.createPlayer(p);
          await player.init();
          player.generateKey();
          const { proof, publicSignals } = await timed(`prove:register:p${p}`, () =>
            player.registerProve(),
          );
          await timed(`verify:register:p${p}`, () =>
            this.lifecycle.registerPlayer(
              p,
              proof,
              publicSignals,
              this.casinoTable.players[p],
            ),
          );
          return { p, player, proof, publicSignals };
        }),
      )
    ).sort((a, b) => a.p - b.p);
    for (const { player, proof, publicSignals } of proved) {
      this.game.addPlayer(proof, publicSignals);
      this.players.push(player);
    }
    this.game.start();
  }

  async shuffleAll(): Promise<void> {
    const publicKeys = this.game.publicKeys;
    let priorDeck = this.game.deck;
    this.players[0]!.preloadShuffle(priorDeck, publicKeys);
    for (let p = 0; p < this.numPlayers; p++) {
      if (p > 0) {
        priorDeck = await timed(`light:fetch_shuffled_deck:p${p}`, () =>
          this.lifecycle.fetchShuffledDeck(),
        );
        this.players[p]!.preloadShuffle(priorDeck, publicKeys);
      }
      const deckBefore =
        p === 0
          ? priorDeck.map((card) => card.map((c) => BigInt(c)))
          : undefined;
      const { proof, publicSignals, deck, permutationHash } = await timed(
        `prove:shuffle:p${p}`,
        () => this.players[p]!.shuffleProve(priorDeck, publicKeys),
      );
      this.game.shuffle(proof, publicSignals, {
        publicKey: this.players[p]!.publicKey,
        deck,
        permutationHash,
      });
      const signals = publicSignals.map((s) => BigInt(s));
      await timed(`verify:shuffle:p${p}`, () =>
        this.lifecycle.verifyShuffle(
          p,
          proof,
          signals,
          deck,
          deckBefore,
          this.casinoTable.players[p],
        ),
      );
    }
  }

  private combineChunkCiphertexts(p: number, nChunks: number, nCards: number): Ciphertext[][] {
    const chunks = this.shareChunkCiphertexts[p];
    if (!chunks) {
      throw new Error(`Missing share chunks for player ${p}`);
    }
    for (let ci = 0; ci < nChunks; ci++) {
      if (!chunks[ci]) {
        throw new Error(`Missing share chunk player=${p} chunk=${ci}`);
      }
    }
    // Chunks are [7 others][16 cards]; concat then trim to the shared prefix.
    return chunks[0]!.map((_, j) => {
      const combined: Ciphertext[] = [];
      for (let ci = 0; ci < nChunks; ci++) {
        combined.push(...chunks[ci]![j]!);
      }
      if (combined.length < nCards) {
        throw new Error(
          `Combined share cards player=${p} other=${j}: got ${combined.length} need ${nCards}`,
        );
      }
      return combined.slice(0, nCards);
    });
  }

  private async ensureShareStaging(): Promise<void> {
    if (this.shareStagingCreated) return;
    const shareStagingReady = Array.from({ length: this.numPlayers }, (_, p) =>
      this.staging.createShare(this.gameId, p, this.casinoTable.players[p]),
    );
    await Promise.all(
      shareStagingReady.map((ready, p) =>
        timed(`tx:create_share_staging:p${p}`, () => ready),
      ),
    );
    this.shareStagingCreated = true;
  }

  private async closeShareStaging(): Promise<void> {
    if (!this.shareStagingCreated) return;
    for (let p = 0; p < this.numPlayers; p++) {
      await timed(`tx:close_share_deck_staging:p${p}`, () =>
        this.staging.closeShare(this.gameId, p, this.casinoTable.players[p]),
      );
    }
    this.shareStagingCreated = false;
  }

  /** Prove + Arcis + light verify one share chunk for every seat. */
  private async shareChunkRound(chunk: number): Promise<void> {
    const shareDeck = this.game.shareCiphertextCards;
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');
    const shareChunkTimeoutMs = Number(process.env.SHARE_VERIFY_CHUNK_TIMEOUT_MS ?? '180000');

    for (let p = 0; p < this.numPlayers; p++) {
      this.players[p]!.preloadShareChunk(
        shareDeck,
        this.game.publicKeysShare(p),
        chunk,
        this.numPlayers,
      );
    }

    type PreparedChunk = {
      p: number;
      proof: any;
      publicSignals: any;
      signals: bigint[];
      ciphertexts: Ciphertext[][];
      rows: Awaited<ReturnType<typeof encryptContiguousShareForStaging>>['rows'];
      nonce: bigint;
      expectedHash: bigint;
      arcisHash: bigint;
      tierHashes: bigint[];
    };
    const preparedSlots: Array<PreparedChunk | undefined> = new Array(this.numPlayers);
    const playerW = sharePlayerConcurrency(this.numPlayers, 1);
    console.log(
      `[share] chunk ${chunk} ${this.numPlayers} players prove W=${groth16ProveConcurrency()} arcis W=${playerW}`,
    );
    await mapPool(Array.from({ length: this.numPlayers }, (_, p) => p), this.numPlayers, async (p) => {
      const { proof, publicSignals, ciphertexts } = await timed(
        `prove:share:p${p}:c${chunk}`,
        () =>
          this.players[p]!.shareProveChunk(
            shareDeck,
            this.game.publicKeysShare(p),
            chunk,
            this.numPlayers,
          ),
      );
      const signals = publicSignals.map((s) => BigInt(s));
      const recipientMajor = flattenCasinoShareCiphertexts(
        ciphertexts,
        BLACKJACK_CHUNK_CARDS,
        BLACKJACK_N_OTHERS,
      );
      const { rows, nonce, arcisHash } = encryptContiguousShareForStaging(
        this.tableKey,
        mxe,
        recipientMajor,
        this.numPlayers,
        BLACKJACK_CHUNK_CARDS,
        BLACKJACK_N_OTHERS,
      );
      const tier = this.game.shareTierCommitment(ciphertexts);
      if (signals[0] !== tier.finalHash) {
        throw new Error(
          `share output hash mismatch player=${p} chunk=${chunk}: proof=${signals[0]} fold=${tier.finalHash}`,
        );
      }
      preparedSlots[p] = {
        p,
        proof,
        publicSignals,
        signals,
        ciphertexts,
        rows,
        nonce,
        expectedHash: tier.finalHash,
        arcisHash,
        tierHashes: tier.hashes,
      };
    });

    const prepared: PreparedChunk[] = [];
    for (let p = 0; p < this.numPlayers; p++) {
      const item = preparedSlots[p];
      if (!item) throw new Error(`share prepare missing player=${p} chunk=${chunk}`);
      if (p === 0 && chunk === 0) this.deckHash = item.expectedHash;
      this.game.shareChunk(item.proof, item.publicSignals, {
        publicKey: this.players[p]!.publicKey,
        ciphertexts: item.ciphertexts,
      });
      if (!this.shareChunkCiphertexts[p]) this.shareChunkCiphertexts[p] = [];
      this.shareChunkCiphertexts[p]![chunk] = item.ciphertexts;
      prepared.push(item);
    }

    const cardStart = chunk * BLACKJACK_CHUNK_CARDS;
    const cardEnd = cardStart + BLACKJACK_CHUNK_CARDS;
    const revealStaging = this.numPlayers === 2
      ? timed(`tx:write_reveal_staging:cards${cardStart}..${cardEnd}`, () =>
          this.stageCasinoRevealStaging(cardStart, cardEnd))
      : Promise.resolve();
    await afterBackground(revealStaging, () => mapPool(prepared, playerW, async (item) => {
      const { p, proof, signals, rows, nonce, arcisHash } = item;
      const { low, high } = splitHashHalves(signals[0]!);
      const streets = blackjackCardFieldGroups(item.ciphertexts);
      const laneFund = this.lifecycle.prepareShareLanes(
        this.casinoTable.players[p]!,
        shareStreetChunkCount(streets),
        p,
      );
      await laneFund.submitted;
      await timed(`tx:begin_share_verify:p${p}:c${chunk}`, () =>
        this.arcium.beginVerifyShareHash(
          this.gameId,
          p,
          low,
          high,
          this.casinoTable.tableState,
          this.casinoTable.players[p],
          {
            encryptionPubkey: this.tableKey.publicKey,
            nonceBase: this.tableKey.nonceBase,
          },
        ),
      );

      await timed(`verify:share:p${p}:c${chunk}`, () =>
        this.lifecycle.verifyShare(
          p,
          proof,
          signals,
          chunk,
          this.casinoTable.players[p],
          streets,
          laneFund,
        ),
      );
    }));
  }

  private async finalizeShareRound(): Promise<void> {
    await timed('finalize:share', () =>
      this.arcium.finalizeSharePhase(this.gameId, this.numPlayers),
    );
    const state = await this.arcium.fetchGameState(this.gameId);
    if (state.verified !== true || state.shareFinalized !== true) {
      throw new Error(
        `finalize_share_phase failed: verified=${state.verified} shareFinalized=${state.shareFinalized}`,
      );
    }
    await this.lifecycle.closeShareReceipts(this.casinoTable.players);
    const sharedCards = Number(state.sharedCards ?? state.shared_cards ?? 0);
    if (sharedCards <= this.sharedCardsReady) {
      throw new Error(
        `shared_cards did not grow: was ${this.sharedCardsReady} now ${sharedCards}`,
      );
    }
    this.sharedCardsReady = sharedCards;
  }

  private async openNextShareChunk(): Promise<void> {
    const maxChunks = this.zkConfig.nShareChunks;
    if (this.onChainShareChunks >= maxChunks) {
      throw new Error(
        `Cannot extend share chunks: already at max ${maxChunks}`,
      );
    }
    const [lightGameState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from('game_state'), Buffer.from(this.gameId)],
      this.lightPokerProgram.programId,
    );
    await timed('tx:extend_share_chunks', () =>
      (this.lightPokerProgram.methods as any)
        .extendShareChunks()
        .accounts({
          signer: this.provider.wallet.publicKey,
          gameState: lightGameState,
        })
        .rpc(),
    );
    await timed('tx:reopen_share_for_next_chunk', () =>
      this.arcium.reopenShareForNextChunk(this.gameId),
    );
    this.onChainShareChunks += 1;
  }

  /**
   * Ensure shoe slots `0..cardIndex` are covered by finalized share rounds.
   * Opens + proves the next 16-card chunk when the cursor crosses a boundary.
   */
  async ensureSharedThrough(cardIndex: number): Promise<void> {
    const showdownLimit = this.zkConfig.showdownCards;
    if (cardIndex < 0 || cardIndex >= showdownLimit) {
      throw new Error(`cardIndex ${cardIndex} outside showdown window ${showdownLimit}`);
    }
    // Join any in-flight prefetch / extend so we don't double-open a chunk.
    const prev = this.shareExtendGate;
    let release!: () => void;
    this.shareExtendGate = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      while (cardIndex >= this.sharedCardsReady) {
        const nextChunk = Math.floor(this.sharedCardsReady / BLACKJACK_CHUNK_CARDS);
        if (nextChunk >= this.zkConfig.nShareChunks) {
          throw new Error(
            `Need card ${cardIndex} but max share chunks ${this.zkConfig.nShareChunks} exhausted`,
          );
        }
        // Capacity starts at 1; open light+poker before proving chunk ≥ 1.
        if (nextChunk >= this.onChainShareChunks) {
          await this.openNextShareChunk();
        }
        await this.ensureShareStaging();
        await this.shareChunkRound(nextChunk);
        await this.finalizeShareRound();
        console.log(
          `[blackjack] share prefix ready through card ${this.sharedCardsReady - 1} `
            + `(chunk ${nextChunk})`,
        );
      }
    } finally {
      release();
    }
  }

  /** First share round (chunk 0). >2p prefetches chunk 1 during actions. */
  async shareAll(): Promise<bigint> {
    await this.ensureShareStaging();
    await this.ensureSharedThrough(0); // proves chunk 0 → sharedCardsReady ≥ 16
    if (this.numPlayers > 2 && this.zkConfig.nShareChunks > 1) {
      // Prefetch next chunk in parallel with action / early reveals.
      this.prefetchShare = this.ensureSharedThrough(BLACKJACK_CHUNK_CARDS).catch((err) => {
        console.error('[blackjack] prefetch share chunk failed', err);
        throw err;
      });
    }
    return this.deckHash;
  }

  async stageCasinoRevealStaging(
    cardStart: number = 0,
    cardEnd: number = this.sharedCardsReady || this.zkConfig.showdownCards,
  ): Promise<void> {
    const nChunks = Math.ceil(cardEnd / BLACKJACK_CHUNK_CARDS);
    for (let p = 0; p < this.numPlayers; p++) {
      this.shareCiphertextsForStaging[p] = this.combineChunkCiphertexts(
        p,
        nChunks,
        cardEnd,
      );
    }
    if (this.numPlayers !== 2) {
      throw new Error('casino reveal staging currently supports 2 players');
    }
    const values = toTwoPlayerCasinoCardMajorShareValues(
      this.shareCiphertextsForStaging,
      cardEnd,
      BLACKJACK_N_OTHERS,
    );
    const commitments = shareValuesToCommitments(values);
    const stagingReady = this.staging.create(this.gameId);
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');
    const cards = Array.from({ length: cardEnd - cardStart }, (_, i) => cardStart + i);
    const fixedNonce = cardStart > 0 && this.deckNonce !== 0n ? this.deckNonce : undefined;
    const { rows, nonce } = encryptCommitmentRowsForStaging(
      this.tableKey,
      mxe,
      commitments,
      cards,
      this.numPlayers,
      fixedNonce,
    );
    // Nonce must stay stable across appends — first write wins.
    if (cardStart === 0 || this.deckNonce === 0n) {
      this.deckNonce = nonce;
    }
    await stagingReady;
    await this.staging.writeRevealRows(this.gameId, rows);
  }

  async revealSealedPartials(
    recipientIndex: number,
    cardIndices: number[],
  ): Promise<void> {
    const totalCount = (this.numPlayers - 1) * 4;
    const deckNonce = this.deckNonce;
    const concurrency = casinoRevealConcurrency(cardIndices.length);
    console.log(`[reveal] r${recipientIndex} ${cardIndices.length} cards W=${concurrency}`);
    await mapPool(cardIndices, concurrency, async (cardIndex) => {
      const revealLabel = `arcis:reveal:r${recipientIndex}:card${cardIndex}`;
      console.time(revealLabel);
      const revealed = this.polling.waitForRevealCardEvent(
        this.pokerProgram,
        cardIndex,
        totalCount,
        recipientIndex,
        { timeout: 180_000 },
      );
      try {
        await this.arcium.revealCardPartials(this.gameId, cardIndex, this.nextOffset(), {
          encryptionPubkey: this.tableKey.publicKey,
          baseNonce: deckNonce,
          totalCount,
          recipientIndex,
          recipient: this.casinoTable.players[recipientIndex]!,
          tableState: this.casinoTable.tableState,
          skipClientPolicyCheck: true,
        });
        await revealed;
      } finally {
        console.timeEnd(revealLabel);
      }
      this.recordedRevealCards.add(cardIndex);
    });
  }

  async closeDeckStagingWhenComplete(): Promise<void> {
    if (this.deckStagingClosed) return;
    const state = await this.arcium.fetchGameState(this.gameId);
    const total = Number(state.totalPartials ?? state.total_partials ?? 0);
    let revealed = Number(state.revealedPartials ?? state.revealed_partials ?? 0);
    const fromUnique = this.recordedRevealCards.size * (this.numPlayers - 1);
    const credit = Math.max(0, fromUnique - revealed);
    if (credit > 0) {
      await this.gameState.recordReveal(this.gameId, credit);
      revealed += credit;
    }
    const remaining = Math.max(0, total - revealed);
    if (remaining > 0) {
      await this.gameState.recordReveal(this.gameId, remaining);
    }
    await this.staging.close(this.gameId);
    this.deckStagingClosed = true;
    await this.lifecycle.refundSeatRent(this.casinoTable.players);
  }

  async sealShowdownForPlayer(playerIndex: number): Promise<ShowdownSealMaterial> {
    const cached = this.showdownSeals.get(playerIndex);
    if (cached) return cached;

    const key = generateTableEncryptionKey();
    const nonce = key.nonceBase;
    await timed(`arcis:seal_showdown:p${playerIndex}`, () =>
      this.arcium.sealShowdownCoefficients(
        this.gameId,
        this.nextOffset(),
        key.publicKey,
        nonce,
        playerIndex,
        this.casinoTable.tableState,
        this.casinoTable.players[playerIndex],
        this.zkConfig.coeffCount,
      ),
    );

    const sealedPda = this.arcium.deriveSealedShowdownCoeffsPDA(
      this.casinoTable.players[playerIndex]!.publicKey,
    );
    const sealed = await this.polling.waitForCallback(
      sealedPda,
      () => this.arcium.fetchSealedShowdownCoefficients(this.casinoTable.players[playerIndex]!.publicKey),
      (s: SealedShowdownAccount) =>
        s.written && s.encryptionPubkey.every((b, i) => b === key.publicKey[i]),
      { timeout: 180_000, interval: 2_000 },
    );

    const want = this.zkConfig.coeffCount;
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');
    const { coefficients, coefficientCommitment } = await openSealedShowdown(key, mxe, sealed);
    this.players[playerIndex]!.setSealedCoefficients(coefficients);
    const material = {
      ciphertexts: sealed.coefficientsCiphertext.slice(0, want),
      nonce: sealed.nonce,
      key,
      decryptedCoefficients: coefficients.slice(0, want),
      coefficientCommitment,
    };
    this.showdownSeals.set(playerIndex, material);
    return material;
  }

  async prepareShowdownMaterial(
    playerIndex: number,
    usedCardIndices: number[],
  ): Promise<void> {
    const player = this.casinoTable.players[playerIndex]!;
    const generationBn = new BN(0);
    const showdownMaterial = this.arcium.deriveShowdownMaterialCommitment(
      this.gameId,
      generationBn,
      playerIndex,
    );
    const gameStatePda = this.gameStatePda();
    const tableState = this.casinoTable.tableState;
    if (!(await this.provider.connection.getAccountInfo(showdownMaterial))) {
      await timed(`tx:begin_showdown_material:p${playerIndex}`, () =>
        (this.pokerProgram.methods as any)
          .beginShowdownMaterial(generationBn, playerIndex)
          .accounts({
            payer: player.publicKey,
            gameState: gameStatePda,
            tableState,
            showdownMaterial,
            systemProgram: web3.SystemProgram.programId,
          })
          .remainingAccounts(this.lifecycle.seatVaultRemaining(player.publicKey))
          .signers([player])
          .rpc(),
      );
    }

    // Unique used shoe slots (sorted) — not the full 24-card window.
    const cards = [...new Set(usedCardIndices)].sort((a, b) => a - b);
    if (cards.length === 0) {
      throw new Error('prepareShowdownMaterial requires at least one used card');
    }
    const revealedMetas = cards.map((cardIndex) => {
      const le = Buffer.alloc(2);
      le.writeUInt16LE(cardIndex);
      return {
        pubkey: web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('RevealedCard'),
            Buffer.from(this.gameId),
            Buffer.from([playerIndex]),
            le,
          ],
          this.pokerProgram.programId,
        )[0],
        isSigner: false,
        isWritable: false,
      };
    });
    await timed(`tx:sync_showdown_material:p${playerIndex}`, () =>
      (this.pokerProgram.methods as any)
        .syncShowdownMaterial(generationBn, playerIndex)
        .accounts({
          payer: player.publicKey,
          gameState: gameStatePda,
          tableState,
          showdownMaterial,
        })
        .remainingAccounts(revealedMetas)
        .signers([player])
        .rpc(),
    );
  }

  /**
   * Deal and verify both initial hands, resolve naturals, then run basic strategy
   * with split/hit/stay proofs before the verified dealer draw loop.
   */
  async playActions(playerIndex: number): Promise<ActionResolvedHand> {
    const player = this.players[playerIndex]!;
    const dealerIndex = this.zkConfig.dealerIndex;
    const ciphertextCards = this.game.shareCiphertextCards;
    const ciphertextPartials = this.game.getCiphertextPartialsForPlayer(playerIndex);
    const decrypted = player.decryptShareCards(ciphertextCards, ciphertextPartials);
    const plaintext = decrypted.map((c) => Number(c));
    const shoeLimit = this.zkConfig.showdownCards;

    let nextSlot = 0;
    const take = async (): Promise<number> => {
      if (nextSlot >= shoeLimit) {
        throw new Error(`Blackjack shoe window exhausted at slot ${nextSlot}`);
      }
      await this.ensureSharedThrough(nextSlot);
      return nextSlot++;
    };

    const playerSlots = [await take(), await take()];
    const dealerSlots = [await take(), await take()];
    const dealerUpcard = dealerSlots[DEALER_UPCARD_OFFSET]!;
    const dealerHole = dealerSlots[DEALER_HOLE_OFFSET]!;

    await timed('reveal:initial_deal', () =>
      Promise.all([
        this.revealSealedPartials(playerIndex, [...playerSlots, dealerUpcard]),
        this.revealSealedPartials(dealerIndex, [dealerUpcard]),
      ]),
    );
    await this.revealSealedPartials(dealerIndex, [dealerHole]);

    const actions = new BlackjackActionLayout();
    actions.startHand(playerIndex, playerSlots);
    const actionSeq = new Map<number, number>();
    let actionProofs = 0;
    const proveAndVerify = async (
      seatIndex: number,
      sourceIndices: number[],
      opts: { canSplit: boolean; hitSoft17: boolean; isDealer: boolean },
    ) => {
      const seatPlayer = this.players[seatIndex]!;
      const partials = this.game.getCiphertextPartialsForPlayer(seatIndex);
      const padded = Array.from(
        { length: MAX_DEALER_CARDS },
        (_, i) => sourceIndices[i] ?? 0,
      );
      const selectedCards = padded.map((index) => ciphertextCards[index]!);
      const selectedPartials = partials.map((row) => padded.map((index) => row[index]!));
      const material = this.game.actionHashMaterial(
        this.game.publicKeys,
        selectedCards,
        selectedPartials,
      );
      if (!this.showdownSeals.has(seatIndex)) {
        await this.sealShowdownForPlayer(seatIndex);
      }
      const output = await seatPlayer.actionProve(
        this.game.publicKeys,
        ciphertextCards,
        partials,
        sourceIndices,
        dealerUpcard,
        opts,
      );
      if (BigInt(output.publicSignals[0]!) !== output.actionHash) {
        throw new Error(`action output hash mismatch for seat ${seatIndex}`);
      }
      const seq = actionSeq.get(seatIndex) ?? 0;
      await this.lifecycle.verifyAction(
        seatIndex,
        seq,
        output.proof,
        output.publicSignals,
        {
          ...material,
          cardCount: sourceIndices.length,
          canSplit: opts.canSplit,
          hitSoft17: opts.hitSoft17,
          isDealer: opts.isDealer,
          insuranceEligible: dealerOffersInsurance(plaintext[dealerUpcard]!),
          upcardHash: this.players[seatIndex]!.upcardActionHash(
            ciphertextCards[dealerUpcard]!,
            partials.map((row) => row[dealerUpcard]!),
          ),
        },
        this.casinoTable.players[seatIndex],
      );
      actionSeq.set(seatIndex, seq + 1);
      actionProofs++;
      return output;
    };

    const [playerInitial, dealerInitial] = await timed(
      `prove+verify:action:initial:p${playerIndex}+p${dealerIndex}`,
      () => Promise.all([
        proveAndVerify(playerIndex, playerSlots, {
          canSplit: true,
          hitSoft17: false,
          isDealer: false,
        }),
        proveAndVerify(dealerIndex, dealerSlots, {
          canSplit: false,
          hitSoft17: DEALER_HIT_SOFT_17,
          isDealer: true,
        }),
      ]),
    );

    const playerCards = playerSlots.map((slot) => plaintext[slot]!);
    const initialPlayerValue = computeHandValue(playerCards, 2);
    // Dealer action status 2 is a natural. Any other status is not.
    const dealerHasBlackjack = dealerInitial.status === 2;

    const insuranceOffered = dealerOffersInsurance(plaintext[dealerUpcard]!);
    const insuranceWindow = {
      dealerUpIsAce: insuranceOffered,
      playerCardCount: 2,
      holeRevealedToPlayer: false,
      playerHasActed: false,
    };
    const insurance = defaultInsuranceDecision(
      insuranceWindow,
      this.stakeAmount,
      playerCards,
    );
    if (insuranceOffered) {
      await timed('tx:record_blackjack_insurance', () =>
        this.lifecycle.recordBlackjackInsurance(
          playerIndex,
          {
            taken: insurance.kind === 'insurance',
            evenMoney: insurance.kind === 'evenMoney',
          },
          this.casinoTable.players[playerIndex],
        ),
      );
    }

    if (insurance.kind === 'evenMoney') {
      actions.stayHand(0);
      const layout = player.buildHandLayoutFromShareSlots(decrypted, {
        playerHands: [{ player: playerIndex, hand: 0, shareSlots: playerSlots }],
        dealerShareSlots: dealerSlots,
      });
      return {
        layout,
        survivingHands: [],
        allHandsBusted: false,
        earlyOutcome: 2, // even money pays 1:1
        actionProofCount: actionProofs,
        insurance,
        insuranceOffered,
        dealerHasBlackjack,
      };
    }

    if (initialPlayerValue.isBlackjack || dealerHasBlackjack) {
      if (dealerHasBlackjack) {
        await this.revealSealedPartials(playerIndex, [dealerHole]);
      }
      actions.stayHand(0);
      const layout = player.buildHandLayoutFromShareSlots(decrypted, {
        playerHands: [{ player: playerIndex, hand: 0, shareSlots: playerSlots }],
        dealerShareSlots: dealerSlots,
      });
      const earlyOutcome: HandOutcome = initialPlayerValue.isBlackjack
        ? (dealerHasBlackjack ? 1 : 3)
        : 0;
      return {
        layout,
        survivingHands: [],
        allHandsBusted: false,
        earlyOutcome,
        actionProofCount: actionProofs,
        insurance,
        insuranceOffered,
        dealerHasBlackjack,
      };
    }

    await this.lifecycle.openBlackjackActionWindow(
      playerIndex,
      dealerIndex,
      this.casinoTable.players[playerIndex],
    );

    let handIndex = 0;
    let cachedAction: typeof playerInitial | undefined = playerInitial;
    while (handIndex < actions.hands.length) {
      let doubleFallbackTaken = false;
      while (!actions.hands[handIndex]!.stayed) {
        const hand = actions.hands[handIndex]!;
        const canSplit = hand.sourceIndices.length === 2 && actions.hands.length < 4;
        const current = cachedAction ?? await proveAndVerify(
          playerIndex,
          hand.sourceIndices,
          { canSplit, hitSoft17: false, isDealer: false },
        );
        cachedAction = undefined;
        if (current.status === 1 || current.status === 3) {
          actions.stayHand(handIndex);
          break;
        }
        const cards = hand.sourceIndices.map((slot) => plaintext[slot]!);
        const decision = blackjackBasicStrategy(
          cards,
          plaintext[dealerUpcard]!,
          actions.hands.length,
          doubleFallbackTaken,
        );
        if (decision === 'split') {
          const leftDraw = await take();
          const rightDraw = await take();
          await this.revealSealedPartials(playerIndex, [leftDraw, rightDraw]);
          actions.splitHand(handIndex, leftDraw, rightDraw);
          doubleFallbackTaken = false;
          continue;
        }
        if (decision === 'stand') {
          actions.stayHand(handIndex);
          break;
        }
        if (hand.sourceIndices.length >= MAX_DEALER_CARDS) {
          throw new Error('Player must hit but max cards reached');
        }
        const doubled = isDoubleFallback(cards, plaintext[dealerUpcard]!);
        const drawn = await take();
        actions.hitHand(handIndex, drawn);
        await this.revealSealedPartials(playerIndex, [drawn]);
        doubleFallbackTaken ||= doubled;
      }
      handIndex++;
    }

    const playerSurvives = actions.hands.some((hand) => {
      const cards = hand.sourceIndices.map((slot) => plaintext[slot]!);
      return computeHandValue(cards, cards.length).isBust === 0;
    });
    let dealerStatus = dealerInitial.status as 0 | 1 | 2 | 3;
    if (playerSurvives) {
      await this.revealSealedPartials(playerIndex, [dealerHole]);
      while (!dealerActionStatusTerminal(dealerStatus)) {
        if (dealerSlots.length >= MAX_DEALER_CARDS) {
          throw new Error('Dealer must hit but max dealer cards reached');
        }
        const drawn = await take();
        dealerSlots.push(drawn);
        await this.revealSealedPartials(playerIndex, [drawn]);
        const dealerNext = await proveAndVerify(
          dealerIndex,
          dealerSlots,
          {
            canSplit: false,
            hitSoft17: DEALER_HIT_SOFT_17,
            isDealer: true,
          },
        );
        dealerStatus = dealerNext.status as 0 | 1 | 2 | 3;
      }
    }

    const layout = player.buildHandLayoutFromShareSlots(decrypted, {
      playerHands: actions.hands.map((hand, index) => ({
        player: playerIndex,
        hand: index,
        shareSlots: [...hand.sourceIndices],
      })),
      dealerShareSlots: dealerSlots,
    });
    const survivingHands = actions.hands.flatMap((hand, handIndex) => {
      const cards = hand.sourceIndices.map((slot) => plaintext[slot]!);
      if (computeHandValue(cards, cards.length).isBust) return [];
      const sourceIndices = [...hand.sourceIndices, ...dealerSlots];
      while (sourceIndices.length < MAX_SHOWDOWN_CARDS) sourceIndices.push(0);
      return [{
        handIndex,
        playerCardCount: hand.sourceIndices.length,
        dealerCardCount: dealerSlots.length,
        sourceIndices,
      }];
    });
    return {
      layout,
      survivingHands,
      allHandsBusted: survivingHands.length === 0,
      actionProofCount: actionProofs,
      insurance,
      insuranceOffered,
      dealerHasBlackjack,
    };
  }

  async showdownOnChain(
    playerIndex: number,
    resolved: ActionResolvedHand,
  ): Promise<{
    outcomes: HandOutcome[];
    publicSignals: string[][];
    proveMs: number;
  }> {
    if (resolved.allHandsBusted || resolved.survivingHands.length === 0) {
      throw new Error('showdownOnChain called after all hands busted');
    }
    await this.lifecycle.openShowdownWindow(
      playerIndex,
      this.casinoTable.players[playerIndex],
    );
    const materialCards = new Set<number>([0]);
    for (const hand of resolved.survivingHands) {
      const used = hand.playerCardCount + hand.dealerCardCount;
      for (const source of hand.sourceIndices.slice(0, used)) materialCards.add(source);
    }
    await this.prepareShowdownMaterial(
      playerIndex,
      [...materialCards],
    );
    const player = this.players[playerIndex]!;
    const ciphertextCards = this.game.shareCiphertextCards;
    const ciphertextPartials = this.game.getCiphertextPartialsForPlayer(playerIndex);
    const outcomes: HandOutcome[] = [];
    const allSignals: string[][] = [];
    let proveMs = 0;
    for (let i = 0; i < resolved.survivingHands.length; i++) {
      const hand = resolved.survivingHands[i]!;
      await timed(`tx:record_bj_layout:p${playerIndex}:h${hand.handIndex}`, () =>
        this.lifecycle.recordBlackjackShowdownLayout(
          playerIndex,
          hand.handIndex,
          hand.playerCardCount,
          hand.dealerCardCount,
          hand.sourceIndices,
          this.casinoTable.players[playerIndex],
        ),
      );
      const startedAt = Date.now();
      const result = await timed(
        `prove:showdown:p${playerIndex}:h${hand.handIndex}`,
        () => player.showdownProve(
          this.game.publicKeys,
          ciphertextCards,
          ciphertextPartials,
          resolved.layout,
          hand.handIndex,
        ),
      );
      proveMs += Date.now() - startedAt;
      const seal = this.showdownSeals.get(playerIndex);
      if (!seal) throw new Error(`Missing seal material for p${playerIndex}`);
      this.game.verifyShowdown(result.proof, result.publicSignals, {
        publicKey: result.publicKey,
        coefficientCommitment: seal.coefficientCommitment,
        outcomesHash: result.outcomesHash,
        handLayout: resolved.layout,
        handIndex: hand.handIndex,
        complete: i === resolved.survivingHands.length - 1,
      });
      await timed(`verify:showdown:p${playerIndex}:h${hand.handIndex}`, () =>
        this.lifecycle.verifyShowdown(
          playerIndex,
          result.proof,
          result.publicSignals.map((signal) => BigInt(signal)),
          this.casinoTable.players[playerIndex],
          hand.handIndex,
        ),
      );
      outcomes.push(result.outcome);
      allSignals.push(result.publicSignals);
    }
    const finalHand = resolved.survivingHands.at(-1)!;
    await timed(`finalize:showdown:p${playerIndex}:h${finalHand.handIndex}`, () =>
      this.lifecycle.finalizeShowdown(
        playerIndex,
        this.casinoTable.players[playerIndex],
      ),
    );
    return { outcomes, publicSignals: allSignals, proveMs };
  }

  /** Bettor settlement vs dealer pool from blackjack HandOutcome (+ optional insurance). */
  async settleBlackjackOutcome(
    outcome: HandOutcome | HandOutcome[],
    opts?: {
      insurance?: InsuranceDecision;
      dealerHasBlackjack?: boolean;
    },
  ): Promise<void> {
    const { keypair, index } = this.bettorPlayer();
    const stake = this.stakeAmount;
    const encKey = this.casinoTable.room.walletEncryptionKey(keypair.publicKey);
    const outcomes = Array.isArray(outcome) ? outcome : [outcome];
    const insurance = opts?.insurance ?? { kind: 'decline' as const };
    const insStake = insurance.kind === 'insurance' ? insurance.stake : 0n;
    const totalAction = stake * BigInt(outcomes.length) + insStake;
    let nonce = encKey.nonceBase;

    let playerPayout = 0n;
    for (const handOutcome of outcomes) {
      switch (handOutcome) {
        case 0:
          break;
        case 1:
          playerPayout += stake;
          break;
        case 2:
          playerPayout += stake * 2n;
          break;
        case 3:
          playerPayout += stake * 2n + stake / 2n;
          break;
        default:
          throw new Error(`Invalid HandOutcome ${handOutcome}`);
      }
    }
    // Insurance return: stake + 2:1 profit when dealer has BJ; else 0.
    if (insStake > 0n && opts?.dealerHasBlackjack) {
      playerPayout += insStake * 3n;
    }
    const playerNet = playerPayout - totalAction;
    // Cross-check side-bet net helper (even money has no separate insurance stake).
    if (insStake > 0n) {
      const expectedIns = insuranceNet(insStake, !!opts?.dealerHasBlackjack);
      const mainPayout = playerPayout - (opts?.dealerHasBlackjack ? insStake * 3n : 0n);
      const mainNet = mainPayout - (totalAction - insStake);
      if (mainNet + expectedIns !== playerNet) {
        throw new Error(
          `insurance net mismatch: main=${mainNet} ins=${expectedIns} combined=${playerNet}`,
        );
      }
    }
    const playerWon = playerNet > 0n;
    const playerNetAbs = playerNet < 0n ? -playerNet : playerNet;
    const poolGrossWin = playerNet < 0n ? -playerNet : 0n;

    await timed('arcis:fund_player_game_escrow', () =>
      this.settlement.fundPlayerGameEscrow(
        {
          roomId: this.casinoTable.roomId,
          tableId: this.casinoTable.tableId,
          gameId: this.gameId,
          playerIndex: index,
          stake: totalAction,
          encryptionPubkey: encKey.publicKey,
          nonce: nonce++,
          player: keypair.publicKey,
        },
        this.nextOffsetU32(),
        keypair,
      ),
    );

    if (playerNetAbs > 0n) {
      await timed('arcis:apply_casino_player_net', () =>
        this.settlement.applyCasinoPlayerNet(
          {
            roomId: this.casinoTable.roomId,
            tableId: this.casinoTable.tableId,
            gameId: this.gameId,
            playerIndex: index,
            playerNetAbs,
            playerWon,
            encryptionPubkey: encKey.publicKey,
            nonce: nonce++,
            player: keypair.publicKey,
            showdownResults: outcomes,
            resultCount: outcomes.length,
          },
          this.nextOffsetU32(),
          keypair,
        ),
      );
    }

    const house = this.casinoTable.players[this.zkConfig.dealerIndex]!;
    const poolKey = this.casinoTable.room.walletEncryptionKey(house.publicKey);
    await timed('arcis:settle_casino_hand', () =>
      this.settlement.settleCasinoHand(
        {
          game: 'blackjack',
          roomId: this.casinoTable.roomId,
          tableId: this.casinoTable.tableId,
          gameId: this.gameId,
          totalAction,
          poolGrossWin,
          playerPayout,
          encryptionPubkey: poolKey.publicKey,
          nonce: poolKey.nonceBase + 50n,
          showdownResults: outcomes,
          resultCount: outcomes.length,
        },
        this.nextOffsetU32(),
        house,
      ),
    );

    await timed('arcis:return_player_game_escrow', () =>
      this.settlement.returnPlayerGameEscrow(
        {
          roomId: this.casinoTable.roomId,
          tableId: this.casinoTable.tableId,
          gameId: this.gameId,
          playerIndex: index,
          encryptionPubkey: encKey.publicKey,
          nonce: nonce++,
          player: keypair.publicKey,
        },
        this.nextOffsetU32(),
        keypair,
      ),
    );
  }

  async runCompleteHand(): Promise<ContinuousBlackjackHandResult> {
    await this.initCompDefs();
    await beginHandCost(this.provider);
    console.time('timing:hand');
    try {
    await this.initialize();

    console.time('critical:register→share_finalize');
    let deckHash: bigint;
    try {
      await this.registerAll();
      await this.shuffleAll();
      deckHash = await this.shareAll();
    } finally {
      console.timeEnd('critical:register→share_finalize');
    }

    const submitter = this.bettorPlayer().index;

    // Staged reveals live inside playActions (initial deal → hole after stay → draws).
    const resolved = await timed('actions:player_stay_dealer', () =>
      this.playActions(submitter),
    );

    await this.closeShareStaging();
    this.game.enterShowdownFromSharePrefix();

    let outcome: HandOutcome;
    let sealedCoefficients: bigint[] = [];
    let showdownHash = 0n;
    let proveMs = 0;
    let skippedShowdown = false;

    const settleOpts = {
      insurance: resolved.insurance,
      dealerHasBlackjack: resolved.dealerHasBlackjack,
    };
    let outcomes: HandOutcome[];
    if (resolved.earlyOutcome !== undefined) {
      skippedShowdown = true;
      outcome = resolved.earlyOutcome;
      outcomes = [outcome];
      await this.settleBlackjackOutcome(outcomes, settleOpts);
    } else if (resolved.allHandsBusted) {
      skippedShowdown = true;
      outcome = 0;
      const handCount = resolved.layout.playerHandLengths[submitter]!
        .filter((count) => count > 0).length;
      outcomes = Array.from({ length: handCount }, () => 0 as HandOutcome);
      await this.settleBlackjackOutcome(outcomes, settleOpts);
    } else {
      const seal = await this.sealShowdownForPlayer(submitter);
      sealedCoefficients = seal.decryptedCoefficients;
      const shown = await this.showdownOnChain(submitter, resolved);
      outcomes = shown.outcomes;
      outcome = outcomes[0]!;
      proveMs = shown.proveMs;
      showdownHash = BigInt(shown.publicSignals.at(-1)![0]!);
      for (let i = 0; i < outcomes.length; i++) {
        const actual = BigInt(shown.publicSignals[i]![0]!);
        const expected = showdownTwoCoeffHash(BigInt(outcomes[i]!), seal.decryptedCoefficients);
        if (actual !== expected) {
          throw new Error(`showdown hash mismatch: got ${actual} expected ${expected}`);
        }
      }
      await this.settleBlackjackOutcome(outcomes, settleOpts);
    }

    await this.closeDeckStagingWhenComplete();

    const state = await this.arcium.fetchGameState(this.gameId);
    return {
      gameId: this.gameId,
      outcome,
      outcomes,
      sealedCoefficients,
      showdownHash,
      deckHash,
      phase: Number(state.phase ?? 0),
      showdownSubmitterPlayerIndex: submitter,
      showdownProveMs: proveMs,
      handSettled: true,
      skippedShowdown,
      actionProofCount: resolved.actionProofCount,
      insurance: resolved.insurance,
      insuranceOffered: resolved.insuranceOffered,
    };
    } finally {
      console.timeEnd('timing:hand');
      await finishHandCost(this.provider, 'blackjack', this.casinoTable?.players ?? []);
      if (this.casinoTable) {
        await releaseDevnetSession({
          provider: this.provider,
          room: this.casinoTable.room,
          tableId: this.casinoTable.tableId,
          gameId: this.casinoTable.gameId,
          players: this.casinoTable.players,
          refundSeatRent: () => this.lifecycle.refundSeatRent(this.casinoTable.players),
          reclaimComputations: () => this.arcium.reclaimFinalizedComputations(),
          closeLightSession: (dest) => this.lifecycle.closeLightSession(this.casinoTable.players.length, dest),
        });
      }
    }
  }
}
