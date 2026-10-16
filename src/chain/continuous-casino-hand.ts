/**
 * Continuous casino hand (War / Baccarat): Groth16 + Arcis share/reveal/seal/showdown,
 * then dealer-pool settlement (`apply_casino_player_net` + `settle_casino_hand`).
 * The last seat is the house player (`src/house/baccarat.ts` or `src/house/war.ts`).
 *
 * No poker street betting / `compute_pots`. Contiguous share verify + card-major
 * reveal staging for `num_cards ∈ {4,6,…}` (not the poker 25-card window).
 */
import { randomBytes } from 'node:crypto';
import { BN, web3, type Program, type AnchorProvider } from '@coral-xyz/anchor';
import { getMXEPublicKey } from '@arcium-hq/client';
import { Game as WarGame } from '../war-game';
import { Player as WarPlayer, type WarCircuits } from '../war-player';
import { Game as BaccaratGame } from '../baccarat-game';
import { baccaratStreetFieldGroups, shareStreetChunkCount } from '../share-street-fields';
import { Player as BaccaratPlayer, type BaccaratCircuits } from '../baccarat-player';
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
import { beginHandCost, finishHandCost, gameKindName } from './hand-cost';
import {
  releaseDevnetSession,
  setupCasinoEncryptedTable,
  type CasinoEncryptedTable,
} from './betting-integration';
import { CasinoSettlementHelper } from './casino-settlement-helper';
import type { CasinoGame as SettlementGame } from '../casino-fees';
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
  toTwoPlayerCasinoCardMajorShareValues,
  shareValuesToCommitments,
  encryptCommitmentRowsForStaging,
  splitHashHalves,
} from './share-deck-staging';
import {
  mapPool,
  afterBackground,
} from '../arcium/verify-chunk-parallel';
import { casinoRevealConcurrency, groth16ProveConcurrency, sharePlayerConcurrency } from '../arcium/heap';
import {
  multiGameZkConfig,
  type MultiGameZkConfig,
} from './multi-game-zk-config';
import { GameKind } from '../game-config';
import type { Ciphertext } from '../zk-casino';
import type { ShowdownSealMaterial } from './continuous-zk-arcis-hand';

/** Head-to-head casino games supported by ContinuousCasinoHand. */
export type ContinuousCasinoKind = typeof GameKind.War | typeof GameKind.Baccarat;
export type CasinoCircuits = WarCircuits | BaccaratCircuits;
type CasinoGameOrchestrator = WarGame | BaccaratGame;
type CasinoZkPlayer = WarPlayer | BaccaratPlayer;

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  console.time(label);
  try {
    return await work();
  } finally {
    console.timeEnd(label);
  }
}

export interface ContinuousCasinoHandResult {
  gameId: Uint8Array;
  winner: bigint;
  sealedCoefficients: bigint[];
  showdownHash: bigint;
  deckHash: bigint;
  phase: number;
  showdownSubmitterPlayerIndex: number;
  showdownProveMs: number;
  handSettled: boolean;
  /** Decrypted shoe faces (0–51 after %52) for the native table. */
  plaintextCards: number[];
}

function settlementGameFor(kind: ContinuousCasinoKind): SettlementGame {
  return kind === GameKind.Baccarat ? 'baccarat' : 'war';
}

export class ContinuousCasinoHand {
  readonly gameId: Uint8Array;
  readonly game: CasinoGameOrchestrator;
  readonly players: CasinoZkPlayer[] = [];
  readonly arcium: ArciumMPCHelper;
  readonly polling: ArciumPollingHelper;
  readonly staging: DeckStagingHelper;
  readonly gameState: GameStateHelper;
  readonly revealedCards: RevealedCardsHelper;
  readonly zkConfig: MultiGameZkConfig;
  readonly showdownSeals = new Map<number, ShowdownSealMaterial>();
  readonly gameKind: ContinuousCasinoKind;

  tableKey: TableEncryptionKey;
  private lifecycle!: OnchainGameLifecycle;
  private casinoTable!: CasinoEncryptedTable;
  private settlement!: CasinoSettlementHelper;
  private numPlayers: number;
  private stakeAmount: bigint;
  private deckNonce = 0n;
  private shareCiphertextsForStaging: Ciphertext[][][] = [];
  private recordedRevealCards = new Set<number>();
  private deckStagingClosed = false;

  constructor(
    private circuits: CasinoCircuits,
    private pokerProgram: Program,
    private lightPokerProgram: Program,
    private provider: AnchorProvider,
    opts?: {
      gameKind?: ContinuousCasinoKind;
      numPlayers?: number;
      shoeDecks?: 1 | 6 | 8;
      stakeAmount?: bigint;
      zkConfig?: MultiGameZkConfig;
    },
  ) {
    this.numPlayers = opts?.numPlayers ?? 2;
    this.gameKind = opts?.gameKind ?? GameKind.War;
    if (this.gameKind !== GameKind.War && this.gameKind !== GameKind.Baccarat) {
      throw new Error('ContinuousCasinoHand supports War and Baccarat only');
    }
    const shoeDecks = opts?.shoeDecks ?? 6;
    this.stakeAmount = opts?.stakeAmount ?? 100n;
    this.zkConfig =
      opts?.zkConfig
      ?? multiGameZkConfig(this.gameKind, { numPlayers: this.numPlayers, shoeDecks });
    if (this.zkConfig.config.kind !== this.gameKind) {
      throw new Error(
        `zkConfig kind ${this.zkConfig.config.kind} does not match gameKind ${this.gameKind}`,
      );
    }
    this.game =
      this.gameKind === GameKind.Baccarat
        ? new BaccaratGame(shoeDecks)
        : new WarGame(shoeDecks);
    this.gameId = crypto.getRandomValues(new Uint8Array(32));
    this.arcium = new ArciumMPCHelper(pokerProgram, provider);
    this.polling = new ArciumPollingHelper(provider);
    this.staging = new DeckStagingHelper(pokerProgram as any, provider);
    this.gameState = new GameStateHelper(pokerProgram as any, provider);
    this.revealedCards = new RevealedCardsHelper(pokerProgram as any, provider);
    this.tableKey = generateTableEncryptionKey();
    this.settlement = new CasinoSettlementHelper(provider, pokerProgram);
  }

  /** Last seat is the house. The earlier seats are the bettors. */
  private houseSeat(): number {
    return this.numPlayers - 1;
  }

  private createPlayer(seat: number): CasinoZkPlayer {
    const house = seat === this.houseSeat();
    if (this.gameKind === GameKind.Baccarat) {
      return new BaccaratPlayer(this.circuits as BaccaratCircuits, house);
    }
    return new WarPlayer(this.circuits as WarCircuits, house);
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

  /** Economic seat (provider) for Enc settlement when present. */
  private economicPlayer(): { index: number; keypair: web3.Keypair } {
    const idx = this.casinoTable.players.findIndex((p) =>
      p.publicKey.equals(this.provider.wallet.publicKey),
    );
    if (idx >= 0) {
      return { index: idx, keypair: this.casinoTable.players[idx]! };
    }
    return { index: 0, keypair: this.casinoTable.players[0]! };
  }

  /** Bettors only. The house seat shuffles and does not lock a stake. */
  private economicBettors(): { index: number; keypair: web3.Keypair }[] {
    const house = this.houseSeat();
    return this.casinoTable.players.flatMap((keypair, index) =>
      index === house ? [] : [{ index, keypair }],
    );
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
    const list = names ?? [...ContinuousCasinoHand.HAND_COMP_DEFS];
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
        gameKind: this.gameKind,
        numPlayers: this.numPlayers,
        shoeDecks: this.zkConfig.config.shoeDecks,
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

  async shareAll(): Promise<bigint> {
    for (let p = 0; p < this.numPlayers; p++) {
      this.players[p]!.preloadShare(
        this.game.finalShuffledDeck,
        this.game.publicKeysShare(p),
        this.numPlayers,
      );
    }

    type PlayerShare = {
      p: number;
      proof: any;
      publicSignalsRaw: any;
      publicSignals: bigint[];
      ciphertexts: Ciphertext[][];
      expectedHash: bigint;
      tierHashes?: readonly bigint[];
    };

    const preparedSlots: Array<PlayerShare | undefined> = new Array(this.numPlayers);
    console.log(
      `[share] ${this.numPlayers} players prove W=${groth16ProveConcurrency()}`,
    );
    await mapPool(Array.from({ length: this.numPlayers }, (_, p) => p), this.numPlayers, async (p) => {
      const { proof, publicSignals, ciphertexts } = await timed(`prove:share:p${p}`, () =>
        this.players[p]!.shareProve(
          this.game.finalShuffledDeck,
          this.game.publicKeysShare(p),
          this.numPlayers,
        ),
      );
      const signals = publicSignals.map((s) => BigInt(s));
      let tierHashes: readonly bigint[] | undefined;
      if (this.gameKind === GameKind.Baccarat) {
        const tier = (this.game as BaccaratGame).shareTierCommitment(ciphertexts);
        if (signals[0] !== tier.finalHash) {
          throw new Error(
            `share output hash mismatch player=${p}: proof=${signals[0]} expected=${tier.finalHash}`,
          );
        }
        tierHashes = tier.hashes;
      }
      preparedSlots[p] = {
        p,
        proof,
        publicSignalsRaw: publicSignals,
        publicSignals: signals,
        ciphertexts,
        expectedHash: signals[0]!,
        tierHashes,
      };
    });

    const prepared: PlayerShare[] = [];
    for (let p = 0; p < this.numPlayers; p++) {
      const item = preparedSlots[p];
      if (!item) throw new Error(`share prepare missing player=${p}`);
      this.game.postShareStake(p, this.game.requiredShareStake(p));
      this.game.share(item.proof, item.publicSignalsRaw, {
        publicKey: this.players[p]!.publicKey,
        ciphertexts: item.ciphertexts,
      });
      this.shareCiphertextsForStaging[p] = item.ciphertexts;
      prepared.push(item);
    }

    const shareVerifyConcurrency = sharePlayerConcurrency(this.numPlayers, this.numPlayers);
    const revealStaging = this.numPlayers === 2
      ? timed('tx:write_reveal_staging', () => this.stageCasinoRevealStaging())
      : Promise.resolve();
    await afterBackground(revealStaging, () => mapPool(prepared, shareVerifyConcurrency, async (item) => {
      const { low, high } = splitHashHalves(item.publicSignals[0]!);
      const streets = item.tierHashes ? baccaratStreetFieldGroups(item.ciphertexts) : undefined;
      const laneFund = streets
        ? this.lifecycle.prepareShareLanes(
            this.casinoTable.players[item.p]!,
            shareStreetChunkCount(streets),
            item.p,
          )
        : undefined;
      if (laneFund) await laneFund.submitted;
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
          streets,
          laneFund,
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
    // Serial reveals for casino: parallel 4-card floods can stall ARX mempool.
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
          // Casino contiguous deals skip poker street gating; on-chain still enforces.
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
    winner: bigint;
    publicSignals: string[];
    proveMs: number;
    plaintextCards: number[];
  }> {
    await this.prepareShowdownMaterial(playerIndex);
    const player = this.players[playerIndex]!;
    const proveStartedAt = Date.now();
    const { proof, publicSignals, publicKey, winner, plaintextCards } = await timed(
      `prove:showdown:p${playerIndex}`,
      () => player.showdownProve(
        this.game.publicKeys,
        this.game.finalShuffledDeck,
        this.game.getCiphertextPartialsForPlayer(playerIndex),
      ),
    );
    const proveMs = Date.now() - proveStartedAt;
    const seal = this.showdownSeals.get(playerIndex);
    if (!seal) throw new Error(`Missing seal material for p${playerIndex}`);
    this.game.verifyShowdown(proof, publicSignals, {
      publicKey,
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
    return {
      winner,
      publicSignals,
      proveMs,
      plaintextCards: (plaintextCards ?? []).map((card) => Number(card)),
    };
  }

  /** Map head-to-head winner (0/1/2) → per-seat game escrow nets + aggregated pool settle. */
  async settleHeadToHeadOutcome(winner: bigint): Promise<void> {
    const bettors = this.economicBettors();
    const stake = this.stakeAmount;
    const playerWon = winner === 0n;
    const tie = winner === 2n;
    const playerNetAbs = tie ? 0n : stake;
    const seatCount = BigInt(bettors.length);
    const poolGrossWin = winner === 1n ? stake * seatCount : 0n;
    const playerPayout = playerWon ? stake * seatCount : 0n;
    const totalAction = stake * seatCount;
    // The house address staked the pool. Settle has to use that wallet's key.
    const settleKey = this.casinoTable.room.walletEncryptionKey(
      this.casinoTable.players[this.houseSeat()]!.publicKey,
    );

    for (const { keypair, index } of bettors) {
      const encKey = this.casinoTable.room.walletEncryptionKey(keypair.publicKey);
      let nonce = encKey.nonceBase;
      await timed(`arcis:fund_player_game_escrow:p${index}`, () =>
        this.settlement.fundPlayerGameEscrow(
          {
            roomId: this.casinoTable.roomId,
            tableId: this.casinoTable.tableId,
            gameId: this.gameId,
            playerIndex: index,
            stake,
            encryptionPubkey: encKey.publicKey,
            nonce: nonce++,
            player: keypair.publicKey,
          },
          this.nextOffsetU32(),
          keypair,
        ),
      );

      if (playerNetAbs > 0n) {
        await timed(`arcis:apply_casino_player_net:p${index}`, () =>
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
              showdownResults: [winner],
            },
            this.nextOffsetU32(),
            keypair,
          ),
        );
      }
    }

    await timed('arcis:settle_casino_hand', () =>
      this.settlement.settleCasinoHand(
        {
          game: settlementGameFor(this.gameKind),
          roomId: this.casinoTable.roomId,
          tableId: this.casinoTable.tableId,
          gameId: this.gameId,
          totalAction,
          poolGrossWin,
          playerPayout,
          encryptionPubkey: settleKey.publicKey,
          nonce: settleKey.nonceBase + 50n,
          showdownResults: [winner],
        },
        this.nextOffsetU32(),
        this.casinoTable.players[this.zkConfig.dealerIndex],
      ),
    );

    for (const { keypair, index } of bettors) {
      const encKey = this.casinoTable.room.walletEncryptionKey(keypair.publicKey);
      await timed(`arcis:return_player_game_escrow:p${index}`, () =>
        this.settlement.returnPlayerGameEscrow(
          {
            roomId: this.casinoTable.roomId,
            tableId: this.casinoTable.tableId,
            gameId: this.gameId,
            playerIndex: index,
            encryptionPubkey: encKey.publicKey,
            nonce: encKey.nonceBase + 20n,
            player: keypair.publicKey,
          },
          this.nextOffsetU32(),
          keypair,
        ),
      );
    }
  }

  /** @deprecated Use settleHeadToHeadOutcome */
  async settleWarOutcome(winner: bigint): Promise<void> {
    return this.settleHeadToHeadOutcome(winner);
  }

  async runCompleteHand(): Promise<ContinuousCasinoHandResult> {
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

    const submitter = this.economicPlayer().index;
    const cards = this.cardIndices();
    await timed('reveal:showdown_cards', () =>
      this.revealSealedPartials(submitter, cards),
    );
    // Defer deck_staging close until after showdown — casino phase/partial
    // bookkeeping differs from poker's street reveal close gate.

    const seal = await this.sealShowdownForPlayer(submitter);
    const { winner, publicSignals, proveMs, plaintextCards } = await this.showdownOnChain(submitter);
    const showdownHash = BigInt(publicSignals[0]!);
    const expected = showdownTwoCoeffHash(winner, seal.decryptedCoefficients);
    if (showdownHash !== expected) {
      throw new Error(
        `showdown hash mismatch: got ${showdownHash} expected ${expected}`,
      );
    }

    await this.settleHeadToHeadOutcome(winner);
    await this.closeDeckStagingWhenComplete();

    const state = await this.arcium.fetchGameState(this.gameId);
    return {
      gameId: this.gameId,
      winner,
      sealedCoefficients: seal.decryptedCoefficients,
      showdownHash,
      deckHash,
      phase: Number(state.phase ?? 0),
      showdownSubmitterPlayerIndex: submitter,
      showdownProveMs: proveMs,
      handSettled: true,
      plaintextCards,
    };
    } finally {
      console.timeEnd('timing:hand');
      await finishHandCost(this.provider, gameKindName(this.gameKind), this.casinoTable?.players ?? []);
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
