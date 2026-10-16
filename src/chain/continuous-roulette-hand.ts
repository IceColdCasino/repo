/**
 * Continuous roulette hand: Groth16 + Arcis share/reveal/seal/showdown,
 * then dealer-pool settlement for the bettor seat only.
 *
 * Topology (2p E2E): provider locks seat 0 as bettor; seat 1 is the house
 * (`dealerIndex: 1`, `src/house/roulette.ts`). House never submits a bet proof. Split bet may
 * land any time after both seats register and before Arcis reveal.
 */
import { randomBytes } from 'node:crypto';
import { BN, web3, type Program, type AnchorProvider } from '@coral-xyz/anchor';
import { getMXEPublicKey } from '@arcium-hq/client';
import { Game } from '../roulette-game';
import { Player, type RouletteCircuits } from '../roulette-player';
import {
  generateTableEncryptionKey,
  type TableEncryptionKey,
} from '../bet-encryption';
import { openSealedShowdown, type SealedShowdownAccount } from '../showdown-sealed-coeffs';
import { Roulette, type RouletteBet, type RouletteVariant } from '../roulette';
import { assertRouletteBetAmounts } from '../roulette-bet-limits';
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
  type EncryptedRecipientMajorRow,
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

/** Sample bettor bets: straight-up + red/black (matches offline proof test). */
const DEFAULT_BETTOR_BETS: RouletteBet[] = [[0, 17], [10, 0]];

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  console.time(label);
  try {
    return await work();
  } finally {
    console.timeEnd(label);
  }
}

export interface ContinuousRouletteHandResult {
  gameId: Uint8Array;
  payouts: number[];
  sealedCoefficients: bigint[];
  showdownHash: bigint;
  deckHash: bigint;
  phase: number;
  showdownSubmitterPlayerIndex: number;
  showdownProveMs: number;
  handSettled: boolean;
  plaintextCard: bigint;
}

export class ContinuousRouletteHand {
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
  readonly roulette: Roulette;

  tableKey: TableEncryptionKey;
  private lifecycle!: OnchainGameLifecycle;
  private casinoTable!: CasinoEncryptedTable;
  private settlement!: CasinoSettlementHelper;
  private numPlayers: number;
  private stakeAmount: bigint;
  private deckNonce = 0n;
  private shareCiphertextsForStaging: Ciphertext[][][] = [];
  private playerBets: RouletteBet[][] = [];
  private nActualBetsPerPlayer: number[] = [];
  private recordedRevealCards = new Set<number>();
  private deckStagingClosed = false;

  constructor(
    private circuits: RouletteCircuits,
    private pokerProgram: Program,
    private lightPokerProgram: Program,
    private provider: AnchorProvider,
    opts?: {
      numPlayers?: number;
      rouletteVariant?: RouletteVariant;
      /** Default 1 so seat-0 provider is bettor (see setupCasinoEncryptedTable). */
      dealerIndex?: number;
      stakeAmount?: bigint;
      bettorBets?: RouletteBet[];
      zkConfig?: MultiGameZkConfig;
    },
  ) {
    this.numPlayers = opts?.numPlayers ?? 2;
    const rouletteVariant = opts?.rouletteVariant ?? 37;
    this.stakeAmount = opts?.stakeAmount ?? 100n;
    this.zkConfig =
      opts?.zkConfig
      ?? multiGameZkConfig(GameKind.Roulette, {
        numPlayers: this.numPlayers,
        rouletteVariant,
        dealerIndex: opts?.dealerIndex ?? this.numPlayers - 1,
        shoeDecks: 0,
      });
    if (this.zkConfig.config.kind !== GameKind.Roulette) {
      throw new Error(
        `zkConfig kind ${this.zkConfig.config.kind} does not match GameKind.Roulette`,
      );
    }
    this.game = new Game(rouletteVariant, this.zkConfig.dealerIndex);
    this.roulette = new Roulette(rouletteVariant);
    this.gameId = crypto.getRandomValues(new Uint8Array(32));
    this.arcium = new ArciumMPCHelper(pokerProgram, provider);
    this.polling = new ArciumPollingHelper(provider);
    this.staging = new DeckStagingHelper(pokerProgram as any, provider);
    this.gameState = new GameStateHelper(pokerProgram as any, provider);
    this.revealedCards = new RevealedCardsHelper(pokerProgram as any, provider);
    this.tableKey = generateTableEncryptionKey();
    this.settlement = new CasinoSettlementHelper(provider, pokerProgram);

    const bettorBets = opts?.bettorBets ?? DEFAULT_BETTOR_BETS;
    for (let p = 0; p < this.numPlayers; p++) {
      this.playerBets[p] = this.game.isDealer(p) ? [] : [...bettorBets];
      this.nActualBetsPerPlayer[p] = this.playerBets[p]!.length;
    }
    // Room defaults: min=10 max=100 (see createTable). Validate class stakes.
    const classAmounts = Array.from({ length: 12 }, () => 0n);
    for (const [kind] of bettorBets) {
      const k = Number(kind);
      if (k >= 0 && k < 12) classAmounts[k] = this.stakeAmount;
    }
    assertRouletteBetAmounts(classAmounts, 10n, 100n);
  }

  private createPlayer(seat: number): Player {
    return new Player(
      this.circuits,
      this.zkConfig.config.rouletteVariant as RouletteVariant,
      seat === this.zkConfig.dealerIndex,
    );
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
    const list = names ?? [...ContinuousRouletteHand.HAND_COMP_DEFS];
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
    await Promise.all([this.game.init(), this.roulette.init()]);
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
        gameKind: GameKind.Roulette,
        numPlayers: this.numPlayers,
        shoeDecks: 0,
        rouletteVariant: this.zkConfig.config.rouletteVariant,
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

  async betAll(): Promise<void> {
    for (let p = 0; p < this.numPlayers; p++) {
      if (this.game.isDealer(p)) {
        this.nActualBetsPerPlayer[p] = 0;
        continue;
      }
      this.players[p]!.preloadBet(this.game.housePublicKey, this.playerBets[p]!);
    }
    for (let p = 0; p < this.numPlayers; p++) {
      if (this.game.isDealer(p)) continue;
      const { proof, publicSignals, encryptedBets, nActualBets } = await timed(
        `prove:bet:p${p}`,
        () => this.players[p]!.betProve(this.game.housePublicKey, this.playerBets[p]!),
      );
      this.game.bet(proof, publicSignals, {
        publicKey: this.players[p]!.publicKey,
        encryptedBets,
        nActualBets,
      });
      this.nActualBetsPerPlayer[p] = nActualBets;
      await timed(`verify:bet:p${p}`, () =>
        this.lifecycle.verifyBet(
          p,
          proof,
          publicSignals.map((s) => BigInt(s)),
          this.casinoTable.players[p],
        ),
      );
    }
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

  async shareAll(): Promise<bigint> {
    const nCards = this.zkConfig.showdownCards;
    for (let p = 0; p < this.numPlayers; p++) {
      this.players[p]!.preloadShare(
        this.game.finalShuffledDeck,
        this.game.publicKeysShare(p),
        this.numPlayers,
      );
    }

    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');

    type PlayerShare = {
      p: number;
      proof: any;
      publicSignalsRaw: any;
      publicSignals: bigint[];
      ciphertexts: Ciphertext[][];
      encryptedBets: Ciphertext[];
      nActualBets: number;
      expectedHash: bigint;
      arcisHash: bigint;
      shareNonce: bigint;
      rows: EncryptedRecipientMajorRow[];
    };

    const preparedSlots: Array<PlayerShare | undefined> = new Array(this.numPlayers);
    const shareArcisW = sharePlayerConcurrency(this.numPlayers, 1);
    console.log(
      `[share] ${this.numPlayers} players prove W=${groth16ProveConcurrency()} arcis W=${shareArcisW}`,
    );
    await mapPool(Array.from({ length: this.numPlayers }, (_, p) => p), this.numPlayers, async (p) => {
      const { proof, publicSignals, ciphertexts } =
        await timed(`prove:share:p${p}`, () =>
          this.players[p]!.shareProve(
            this.game.finalShuffledDeck,
            this.game.publicKeysShare(p),
            this.numPlayers,
          ),
        );
      const encryptedBets = this.game.isDealer(p)
        ? []
        : this.game.getEncryptedBetsForPlayer(p);
      const nActualBets = this.game.isDealer(p) ? 0 : this.nActualBetsPerPlayer[p]!;
      const signals = publicSignals.map((s) => BigInt(s));
      const recipientMajor = flattenCasinoShareCiphertexts(ciphertexts, nCards);
      const stagingReady = this.staging.createShare(
        this.gameId,
        p,
        this.casinoTable.players[p],
      );
      const { rows, nonce, arcisHash } = encryptContiguousShareForStaging(
        this.tableKey,
        mxe,
        recipientMajor,
        this.numPlayers,
        nCards,
      );
      await timed(`tx:create_share_staging:p${p}`, () => stagingReady);
      preparedSlots[p] = {
        p,
        proof,
        publicSignalsRaw: publicSignals,
        publicSignals: signals,
        ciphertexts,
        encryptedBets,
        nActualBets,
        expectedHash: signals[0],
        arcisHash,
        shareNonce: nonce,
        rows,
      };
    });

    const prepared: PlayerShare[] = [];
    for (let p = 0; p < this.numPlayers; p++) {
      const item = preparedSlots[p];
      if (!item) throw new Error(`share prepare missing player=${p}`);
      this.game.share(item.proof, item.publicSignalsRaw, {
        publicKey: this.players[p]!.publicKey,
        ciphertexts: item.ciphertexts,
      });
      this.shareCiphertextsForStaging[p] = item.ciphertexts;
      this.nActualBetsPerPlayer[p] = item.nActualBets;
      prepared.push(item);
    }

    const shareChunkTimeoutMs = Number(process.env.SHARE_VERIFY_CHUNK_TIMEOUT_MS ?? '180000');
    // Localnet keeps seats serial so Light's staged verify does not stack CU.
    // Devnet overlaps both seats; Arcis folds inside a seat overlap too.
    const shareVerifyConcurrency = sharePlayerConcurrency(this.numPlayers, 1);
    const revealStaging = this.numPlayers === 2
      ? timed('tx:write_reveal_staging', () => this.stageCasinoRevealStaging())
      : Promise.resolve();
    await afterBackground(revealStaging, () => mapPool(prepared, shareVerifyConcurrency, async (item) => {
      const { low, high } = splitHashHalves(item.publicSignals[0]!);
      await timed(`tx:begin_share_verify:p${item.p}`, () =>
        this.arcium.beginVerifyShareHash(
          this.gameId,
          item.p,
          low,
          high,
          this.casinoTable.tableState,
          this.casinoTable.players[item.p],
          {
            encryptionPubkey: this.tableKey.publicKey,
            nonceBase: this.tableKey.nonceBase,
          },
        ),
      );

      await timed(`verify:share:p${item.p}`, () =>
        this.lifecycle.verifyShare(
          item.p,
          item.proof,
          item.publicSignals,
          0,
          this.casinoTable.players[item.p],
        ),
      );
    }));

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
    for (let p = 0; p < this.numPlayers; p++) {
      await timed(`tx:close_share_deck_staging:p${p}`, () =>
        this.staging.closeShare(this.gameId, p, this.casinoTable.players[p]),
      );
    }
    return prepared[0]!.expectedHash;
  }

  async stageCasinoRevealStaging(): Promise<void> {
    if (this.shareCiphertextsForStaging.length !== this.numPlayers) {
      throw new Error('shareAll() must produce ciphertexts before reveal staging');
    }
    if (this.numPlayers !== 2) {
      throw new Error('casino reveal staging currently supports 2 players');
    }
    const nCards = this.zkConfig.showdownCards;
    const values = toTwoPlayerCasinoCardMajorShareValues(
      this.shareCiphertextsForStaging,
      nCards,
    );
    const commitments = shareValuesToCommitments(values);
    const stagingReady = this.staging.create(this.gameId);
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');
    const cards = this.cardIndices();
    const { rows, nonce } = encryptCommitmentRowsForStaging(
      this.tableKey,
      mxe,
      commitments,
      cards,
      this.numPlayers,
    );
    this.deckNonce = nonce;
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

  async prepareShowdownMaterial(playerIndex: number): Promise<void> {
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

    const cards = this.cardIndices();
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

  async showdownOnChain(playerIndex: number): Promise<{
    payouts: number[];
    publicSignals: string[];
    proveMs: number;
    plaintextCard: bigint;
  }> {
    await this.prepareShowdownMaterial(playerIndex);
    const player = this.players[playerIndex]!;
    const ciphertextBets = this.game.getEncryptedBetsForPlayer(playerIndex);
    const nActualBets = this.nActualBetsPerPlayer[playerIndex]!;
    const proveStartedAt = Date.now();
    const { proof, publicSignals, payouts, plaintextCard } = await timed(
      `prove:showdown:p${playerIndex}`,
      () => player.showdownProve(
        this.game.publicKeys,
        this.game.finalShuffledDeck,
        this.game.getCiphertextPartialsForPlayer(playerIndex),
        ciphertextBets,
        this.playerBets[playerIndex]!,
        nActualBets,
      ),
    );
    const proveMs = Date.now() - proveStartedAt;
    const seal = this.showdownSeals.get(playerIndex);
    if (!seal) throw new Error(`Missing seal material for p${playerIndex}`);
    this.game.verifyShowdown(proof, publicSignals, {
      publicKey: player.publicKey,
      coefficientCommitment: seal.coefficientCommitment,
    });
    const signals = publicSignals.map((s) => BigInt(s));
    await timed(`verify:showdown:p${playerIndex}`, () =>
      this.lifecycle.verifyShowdown(
        playerIndex,
        proof,
        signals,
        this.casinoTable.players[playerIndex],
      ),
    );
    await timed(`finalize:showdown:p${playerIndex}`, () =>
      this.lifecycle.finalizeShowdown(
        playerIndex,
        this.casinoTable.players[playerIndex],
      ),
    );
    return { payouts, publicSignals, proveMs, plaintextCard };
  }

  /** Bettor settlement vs dealer pool from roulette payouts. */
  async settleRouletteOutcome(payouts: number[], nActualBets: number): Promise<void> {
    const { keypair, index } = this.bettorPlayer();
    const stakePerBet = this.stakeAmount;
    const totalAction = BigInt(nActualBets) * stakePerBet;
    let totalProfit = 0n;
    for (let i = 0; i < nActualBets; i++) {
      totalProfit += stakePerBet * BigInt(payouts[i]!);
    }

    const encKey = this.casinoTable.room.walletEncryptionKey(keypair.publicKey);
    let nonce = encKey.nonceBase;
    const playerWon = totalProfit > 0n;
    const playerNetAbs = playerWon ? totalProfit : totalAction;
    const poolGrossWin = playerWon ? 0n : totalAction;
    const playerPayout = playerWon ? totalAction + totalProfit : 0n;

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
            showdownResults: payouts,
          },
          this.nextOffsetU32(),
          keypair,
        ),
      );
    }

    await timed('arcis:settle_casino_hand', () =>
      this.settlement.settleCasinoHand(
        {
          game: 'roulette',
          roomId: this.casinoTable.roomId,
          tableId: this.casinoTable.tableId,
          gameId: this.gameId,
          totalAction,
          poolGrossWin,
          playerPayout,
          encryptionPubkey: this.casinoTable.room.walletEncryptionKey(
            this.casinoTable.players[this.zkConfig.dealerIndex]!.publicKey,
          ).publicKey,
          nonce: this.casinoTable.room.walletEncryptionKey(
            this.casinoTable.players[this.zkConfig.dealerIndex]!.publicKey,
          ).nonceBase + 50n,
          showdownResults: payouts,
        },
        this.nextOffsetU32(),
        this.casinoTable.players[this.zkConfig.dealerIndex],
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

  async runCompleteHand(): Promise<ContinuousRouletteHandResult> {
    await this.initCompDefs();
    await beginHandCost(this.provider);
    console.time('timing:hand');
    try {
    await this.initialize();

    console.time('critical:register→share_finalize');
    let deckHash: bigint;
    try {
      await this.registerAll();
      await this.betAll();
      await this.shuffleAll();
      deckHash = await this.shareAll();
    } finally {
      console.timeEnd('critical:register→share_finalize');
    }

    const submitter = this.bettorPlayer().index;
    const cards = this.cardIndices();
    await timed('reveal:showdown_cards', () =>
      this.revealSealedPartials(submitter, cards),
    );

    const seal = await this.sealShowdownForPlayer(submitter);
    const nActualBets = this.nActualBetsPerPlayer[submitter]!;
    const { payouts, publicSignals, proveMs, plaintextCard } =
      await this.showdownOnChain(submitter);
    const showdownHash = BigInt(publicSignals[0]!);
    const expected = this.roulette.computeShowdownOutputHash(
      payouts,
      seal.decryptedCoefficients,
    );
    if (showdownHash !== expected) {
      throw new Error(
        `showdown hash mismatch: got ${showdownHash} expected ${expected}`,
      );
    }

    await this.settleRouletteOutcome(payouts, nActualBets);

    await this.closeDeckStagingWhenComplete();

    const state = await this.arcium.fetchGameState(this.gameId);
    return {
      gameId: this.gameId,
      payouts,
      sealedCoefficients: seal.decryptedCoefficients,
      showdownHash,
      deckHash,
      phase: Number(state.phase ?? 0),
      showdownSubmitterPlayerIndex: submitter,
      showdownProveMs: proveMs,
      handSettled: true,
      plaintextCard,
    };
    } finally {
      console.timeEnd('timing:hand');
      await finishHandCost(this.provider, 'roulette', this.casinoTable?.players ?? []);
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
