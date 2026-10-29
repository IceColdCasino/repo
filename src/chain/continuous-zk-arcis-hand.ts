/**
 * Continuous 2-player hand: all 4 Groth16 circuits + Arcis MPC circuits.
 *
 * Unified verify ∥ Poseidon-input-hash → finalize pattern for shuffle, share,
 * and showdown (see `docs/e2e-speed-and-runbook.md`).
 *
 * Order:
 *   register → shuffle (compute input hash ∥ verify → finalize_shuffle)
 *   → share (prove → Groth16 ∥ Arcis decrypt of staged shares → finalize_share_phase)
 *   → encrypted betting (validate_bet)
 *   → reveal_card (surfaces sealed partials only — never plaintext cards)
 *   → seal_showdown_coefficient → showdown (compute input hash ∥ verify → finalize_showdown)
 *   → compute_pots / distribute_and_settle (fused Arcis: verify sealed-coeff poly hash
 *     over Rescue Enc masks, then pay; gated on showdown_finalized — no separate verify ix)
 *
 * Privacy: share seals each player's threshold partial to every other player
 * (up to 9 recipients × 25 cards × 4 BN254 = 900). Per-player Arcis opens those
 * ciphertexts; global `deck_staging` stays card-major for `reveal_card` only.
 * `finalize_share_phase` sets `verified`.
 *
 * Rent: close `share_deck_staging[p]` after share finalize; close each
 * `RevealedCard` after the Arcis reveal; close `deck_staging` after the last reveal that
 * still needs it (`record_reveal` gates the on-chain close).
 *
 * No setShowdownHash / setPotAmounts / mockSealedCoefficients.
 */
import { randomBytes } from 'node:crypto';
import { BN, web3, type Program, type AnchorProvider } from '@coral-xyz/anchor';
import { rentExemptLamports } from './fund-sol';
import { clusterRentLamportsPerByte, drawStagedRent } from './rent-vault';
import { BET_ACTION_LOG_DATA, ENCRYPTED_BETTING_DATA } from './table-float';
import { getMXEPublicKey } from '@arcium-hq/client';
import { MAX_PLAYERS } from '../poker';
import { pokerStreetFieldGroups, shareStreetChunkCount } from '../share-street-fields';
import { Game } from '../poker-game';
import { readShuffleProof } from '../shuffle-signals';
import { Player } from '../poker-player';
import type { Circuits } from '../circuit-manager';
import {
  generateTableEncryptionKey,
  type TableEncryptionKey,
} from '../bet-encryption';
import {
  encryptWinnerMasksWithSealedKey,
  openSealedShowdown,
  type SealedShowdownAccount,
} from '../showdown-sealed-coeffs';
import { OnchainGameLifecycle } from './onchain-game-lifecycle';
import { beginHandCost, finishHandCost } from './hand-cost';
import {
  OnchainBettingManager,
  releaseDevnetSession,
  setupEncryptedBettingTable,
  type EncryptedBettingTable,
} from './betting-integration';
import { ArciumMPCHelper, SEAL_CONSUMED_OFFSET, sealShowdownCompDefNames } from '../arcium/mpc';
import { ArciumPollingHelper } from '../arcium/polling';
import { loadMxeAuthorityProvider } from './admin-provider';
import { loadCasinoProgram } from '../testing/deploy';
import {
  DeckStagingHelper,
  GameStateHelper,
  RevealedCardsHelper,
} from './staging';
import {
  flattenShareCiphertexts,
  shareValuesToCommitments,
  encryptCommitmentRowsForStaging,
  encryptRecipientMajorRowsForStaging,
  toRecipientCardMajorShareValues,
  toTwoPlayerRecipientCardMajorShareValues,
} from './share-deck-staging';
import {
  mapPool,
  isVerifyChunkStartDone,
  runShareVerifyChunks,
  afterBackground,
} from '../arcium/verify-chunk-parallel';
import {
  groth16ProveConcurrency,
  revealCardConcurrency,
  revealRecipientConcurrency,
  shareChunkConcurrency,
  sharePlayerConcurrency,
} from '../arcium/heap';
import { usedCardIndices } from '../backend/card-layout';
import { preferredShowdownSubmitterSeat } from '../backend/hand-result';
import { resolveEncryptedBetAmount } from './bet-amount';
import {
  multiGameZkConfig,
  type MultiGameZkConfig,
} from './multi-game-zk-config';
export type { MultiGameZkConfig } from './multi-game-zk-config';
export { multiGameZkConfig } from './multi-game-zk-config';
import { GameKind } from '../game-config';

function buildPotResultsFromAuthenticatedMasks(
  masks: bigint[],
  handNumPlayers: number,
  handSeatOrder: number[],
  pots: { amount: bigint }[],
): Array<{ potIndex: number; amount: string; winnerSeats: number[] }> {
  return pots.flatMap((pot, potIndex) => {
    const mask = masks[potIndex] ?? 0n;
    const winnerSeats = handSeatOrder.filter((_seat, playerIndex) =>
      playerIndex < handNumPlayers && Boolean(mask & (1n << BigInt(playerIndex))),
    );
    return pot.amount > 0n && winnerSeats.length > 0
      ? [{ potIndex, amount: pot.amount.toString(), winnerSeats }]
      : [];
  });
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  console.time(label);
  try {
    return await work();
  } finally {
    console.timeEnd(label);
  }
}

export type BettingPhase = 'PreFlop' | 'Flop' | 'Turn' | 'River';

/** True when every recipient's card set is pairwise disjoint (safe for parallel staging). */
export function recipientCardSetsDisjoint(
  cardSets: ReadonlyArray<ReadonlyArray<number>>,
): boolean {
  const seen = new Set<number>();
  for (const cards of cardSets) {
    for (const card of cards) {
      if (seen.has(card)) return false;
      seen.add(card);
    }
  }
  return true;
}

/**
 * Act order matching on-chain `first_to_act` (seat_order.rs).
 * Preflop multiway starts at UTG (index 2). Heads-up preflop starts at SB/dealer (0).
 * Postflop multiway starts at SB (0). Heads-up postflop starts at BB (1).
 */
export function streetActionOrder(phase: BettingPhase, numPlayers: number): number[] {
  if (numPlayers < 2) throw new Error(`numPlayers must be >= 2, got ${numPlayers}`);
  const start = phase === 'PreFlop'
    ? (numPlayers > 2 ? 2 : 0)
    : (numPlayers === 2 ? 1 : 0);
  return Array.from({ length: numPlayers }, (_, i) => (start + i) % numPlayers);
}

/**
 * Check-down preflop actions in on-chain turn order (UTG→…→SB→BB for N>2).
 *
 * Heads-up: blinds are posted first (`collect_blinds`), then SB completes with
 * a call. That limp does not close preflop — the BB checks or raises.
 *
 * Multiway: UTG… calls `bb`, SB completes for `bb - sb`, BB checks.
 */
export function checkDownPreFlopActions(
  numPlayers: number,
  blinds: { sb: bigint; bb: bigint } = { sb: 10n, bb: 20n },
): Array<{ player: number; action: string; amount: bigint }> {
  if (numPlayers === 2) {
    return [
      { player: 0, action: 'call', amount: blinds.bb - blinds.sb },
      { player: 1, action: 'check', amount: 0n },
    ];
  }
  return streetActionOrder('PreFlop', numPlayers).map((player) => {
    if (player === 0) return { player, action: 'call', amount: blinds.bb - blinds.sb };
    if (player === 1) return { player, action: 'check', amount: 0n };
    return { player, action: 'call', amount: blinds.bb };
  });
}

/**
 * Resolve the encrypted `action_amount` for validate_bet.
 * Raise/bet `amount` is chips **added** this action (matches frontend + local backend),
 * not the resulting street total.
 */
export { resolveEncryptedBetAmount } from './bet-amount';

export interface EncryptedBettingStreetSnapshot {
  currentPlayer: number;
  currentBet: bigint;
  lastAggressorAmount: bigint;
  foldedMask: number;
  showOnFoldMask: number;
  allInMask: number;
  playerTotalBets: bigint[];
  pots: bigint[];
  streetBets: bigint[];
  playerBalances: bigint[];
  bettingPhase: number;
}

export interface ShowdownSealMaterial {
  ciphertexts: Uint8Array[];
  nonce: bigint;
  key: TableEncryptionKey;
  decryptedCoefficients: bigint[];
  /** Poseidon of the seal rows; Light binds the showdown proof to it. */
  coefficientCommitment: bigint;
}

export interface ContinuousHandResult {
  gameId: Uint8Array;
  winnerMasks: bigint[];
  sealedCoefficients: bigint[];
  showdownHash: bigint;
  deckHash: bigint;
  phase: number;
  showdownSubmitterPlayerIndex: number;
  showdownProveMs: number;
}

const retainedShowdownKeys = new Map<string, TableEncryptionKey>();

export class ContinuousZkArcisHand {
  readonly gameId: Uint8Array;
  readonly game = new Game();
  readonly players: Player[] = [];
  readonly arcium: ArciumMPCHelper;
  readonly polling: ArciumPollingHelper;
  readonly staging: DeckStagingHelper;
  readonly gameState: GameStateHelper;
  readonly revealedCards: RevealedCardsHelper;
  tableKey: TableEncryptionKey;
  readonly showdownSeals = new Map<number, ShowdownSealMaterial>();
  private readonly sealJobs = new Map<number, Promise<ShowdownSealMaterial>>();
  private lifecycle!: OnchainGameLifecycle;
  private betting!: OnchainBettingManager;
  private bettingTable!: EncryptedBettingTable;
  /** Seat escrow stacks seeded by {@link setupEncryptedBettingTable}. */
  private seatBuyIn = 1_000n;
  private numPlayers: number;
  /** Per-game circuit / card / coeff layout (default poker). */
  readonly zkConfig: MultiGameZkConfig;
  private deckNonce = 0n;
  private playerBalances: bigint[] | null = null;
  /** Street-local bets for Rescue payloads (circuit `player_current_bet`). */
  private streetBet: bigint[] | null = null;
  private streetCurrentBet = 0n;
  private streetLastAggressorAmount = 0n;
  private interactiveBettingPhase: BettingPhase | null = null;
  /** Per-sharer outputs used to assemble recipient-owned card-major sections. */
  private shareCiphertextsForStaging: import('../zk-casino').Ciphertext[][][] = [];
  /** Unique card indices already counted toward `record_reveal` / deck_staging close. */
  private recordedRevealCards = new Set<number>();
  private deckStagingClosed = false;
  /**
   * Parallel register buffers proofs by on-chain player index. `Game.addPlayer`
   * appends in call order — if p1's RPC finishes before p0's, keys swap and
   * shuffle hashes diverge from zkHand / clients (Input hash mismatch).
   */
  private pendingRegister: Array<{
    proof: object;
    publicSignals: string[];
  } | null>;

  constructor(
    private circuits: Circuits,
    private pokerProgram: Program,
    private lightPokerProgram: Program,
    private provider: AnchorProvider,
    numPlayers = 2,
    zkConfig?: MultiGameZkConfig,
  ) {
    this.numPlayers = numPlayers;
    this.zkConfig =
      zkConfig ??
      multiGameZkConfig(GameKind.Poker, { numPlayers });
    this.pendingRegister = Array.from({ length: numPlayers }, () => null);
    this.gameId = crypto.getRandomValues(new Uint8Array(32));
    this.arcium = new ArciumMPCHelper(pokerProgram, provider);
    this.polling = new ArciumPollingHelper(provider);
    this.staging = new DeckStagingHelper(pokerProgram as any, provider);
    this.gameState = new GameStateHelper(pokerProgram as any, provider);
    this.revealedCards = new RevealedCardsHelper(pokerProgram as any, provider);
    this.tableKey = generateTableEncryptionKey();
  }

  /** Arcium computation offsets must be random u64s (see rust/casino/tests/*.ts). */
  private nextOffset(): BN {
    return new BN(randomBytes(8), 'hex');
  }

  private gameStatePda(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('game_state'), Buffer.from(this.gameId)],
      this.pokerProgram.programId,
    )[0];
  }

  /** Full-hand CompDef set (upload once per localnet; then skipped). */
  static readonly HAND_COMP_DEFS = [
    'verifyDeckHashChunk',
    'revealCard',
    'validateBet',
    ...sealShowdownCompDefNames(2),
    'computePots',
    'distributeAndSettle',
  ];

  /**
   * Ensure Arcis CompDefs are finalized.
   *
   * Default: require already-finalized CompDefs (no upload). Load circuits once via
   * `bun run localnet:compdefs` (or `UPLOAD_COMP_DEFS=1` here).
   * Set SKIP_COMP_DEFS=1 to skip the check entirely.
   */
  async initCompDefs(names?: string[]): Promise<void> {
    if (process.env.SKIP_COMP_DEFS === '1') {
      console.log('[comp-def] SKIP_COMP_DEFS=1 — assuming CompDefs already finalized');
      return;
    }
    const list = names ?? [...ContinuousZkArcisHand.HAND_COMP_DEFS];
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
      const orphanHint = missing.some((m) => m.includes('mxe_orphan'))
        ? `\nMXE orphan: bun run scripts/patch-mxe-comp-def-offsets.ts validate_bet`
          + ` && bun run localnet:stop && bun run localnet:start:detach`
        : '';
      throw new Error(
        `Arcis CompDefs not finalized (load once per localnet, not per game):\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          `\nRun: bun run localnet:compdefs` +
          orphanHint,
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
    const buyIn = 1_000n;
    this.seatBuyIn = buyIn;
    this.bettingTable = await setupEncryptedBettingTable(
      this.pokerProgram,
      this.provider,
      this.gameId,
      {
        numPlayers: this.numPlayers,
        buyIn,
        onStaged: async () => {
          await this.lifecycle.initializeGames(
            this.numPlayers,
            this.zkConfig.config.kind,
            this.zkConfig.config.shoeDecks,
            this.zkConfig.config.rouletteVariant,
            this.zkConfig.dealerIndex,
          );
          this.lifecycle.beginDeckWarm();
        },
      },
    );
    // Typed staging writes require a seated signer + table; default to seat 0
    // for global deck_staging. Share writes pass the owning seat explicitly.
    this.staging.writeAuth = {
      tableState: this.bettingTable.tableState,
      authority: this.bettingTable.players[0],
    };

    await this.arcium.initPlayerGameEscrows(this.gameId, this.numPlayers);

    const gameState = this.gameStatePda();
    const rentRate = await clusterRentLamportsPerByte(this.provider.connection);
    await drawStagedRent(
      this.provider,
      this.provider.wallet.publicKey,
      this.provider.wallet.publicKey,
      rentExemptLamports(ENCRYPTED_BETTING_DATA, rentRate)
        + rentExemptLamports(BET_ACTION_LOG_DATA, rentRate),
    );
    await Promise.all([
      (this.pokerProgram.methods as any)
        .initEncryptedGameBetting()
        .accounts({
          payer: this.provider.wallet.publicKey,
          gameState,
          encryptedGameBetting: web3.PublicKey.findProgramAddressSync(
            [Buffer.from('encrypted_betting'), Buffer.from(this.gameId)],
            this.pokerProgram.programId,
          )[0],
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc()
        .catch(() => {}),
      (this.pokerProgram.methods as any)
        .initBetActionLog()
        .accounts({
          payer: this.provider.wallet.publicKey,
          gameState,
          betActionLog: web3.PublicKey.findProgramAddressSync(
            [Buffer.from('bet_action_log'), Buffer.from(this.gameId)],
            this.pokerProgram.programId,
          )[0],
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc()
        .catch(() => {}),
    ]);

    this.betting = new OnchainBettingManager(
      this.pokerProgram,
      this.provider,
      this.game,
      this.tableKey,
    );
    this.betting.bindTable(this.bettingTable);
  }

  /** Groth16 register → light-casino verify + CPI consume into poker. */
  async registerAll(): Promise<void> {
    // Each seat proves and submits together. The chain serializes the shared
    // game account; the two confirms still overlap.
    console.log(`[register] ${this.numPlayers} players parallel`);
    const proved = (
      await Promise.all(
        Array.from({ length: this.numPlayers }, async (_, p) => {
          const player = new Player(this.circuits);
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
              this.bettingTable.players[p],
            ),
          );
          console.log(`[showdown] sealing seated player p${p}`);
          const seal = this.sealShowdownForPlayer(p);
          seal.catch((err) => {
            console.error(`[showdown] seal p${p} failed`, err);
          });
          return { p, player, proof, publicSignals };
        }),
      )
    ).sort((a, b) => a.p - b.p);
    for (const { player, proof, publicSignals } of proved) {
      this.game.addPlayer(proof, publicSignals);
      this.players.push(player);
    }
    this.game.start();
    this.lifecycle.beginShuffleBufferWarm(0, this.bettingTable.players[0]);
  }

  /** Player count for this hand (set at construction). */
  get playerCount(): number {
    return this.numPlayers;
  }

  /**
   * Submit a client-proven register proof on-chain (UI / chain-worker path).
   * Call {@link finishRegistration} once every seat has registered.
   */
  async registerPlayerFromProof(
    playerIndex: number,
    proof: object,
    publicSignals: string[],
  ): Promise<void> {
    if (playerIndex < 0 || playerIndex >= this.numPlayers) {
      throw new Error(`Invalid playerIndex ${playerIndex}`);
    }
    if (this.pendingRegister[playerIndex]) {
      throw new Error(`Player ${playerIndex} already registered`);
    }
    await timed(`verify:register:p${playerIndex}`, () =>
      this.lifecycle.registerPlayer(
        playerIndex,
        proof,
        publicSignals,
        this.bettingTable.players[playerIndex],
      ),
    );
    // Buffer only — commit in player-index order in finishRegistration.
    this.pendingRegister[playerIndex] = { proof, publicSignals };
  }

  /** How many seats have completed on-chain register + local buffer (parallel-safe). */
  get registeredProofCount(): number {
    return this.pendingRegister.reduce((n, slot) => n + (slot ? 1 : 0), 0);
  }

  /**
   * After all seats registered via {@link registerPlayerFromProof}.
   * Commits keys to `Game` in index order so shuffle Poseidon matches clients.
   */
  async finishRegistration(): Promise<void> {
    if (this.registeredProofCount !== this.numPlayers) {
      throw new Error(
        `Cannot finish registration: ${this.registeredProofCount}/${this.numPlayers} proofs buffered`,
      );
    }
    if (this.game.nPlayers !== 0) {
      throw new Error('Game already has players — finishRegistration called twice?');
    }
    for (let i = 0; i < this.numPlayers; i++) {
      const pending = this.pendingRegister[i]!;
      this.game.addPlayer(pending.proof as any, pending.publicSignals as any, {
        verified: true,
      });
    }
    this.game.start();
  }

  /**
   * Submit a client-proven shuffle on-chain. The proof carries the two hashes.
   * `shoe` is the shuffled deck the prover returned beside the proof.
   */
  async shufflePlayerFromProof(
    playerIndex: number,
    proof: object,
    publicSignals: string[],
    shoe: import('../zk-casino').Ciphertext[],
  ): Promise<void> {
    const signals = publicSignals.map((s) => BigInt(s));
    const { permutationHash } = readShuffleProof(signals);
    const deck = shoe;
    const publicKey = this.game.publicKeys[playerIndex];
    if (!publicKey) {
      throw new Error(`Missing public key for player ${playerIndex}`);
    }
    const deckBefore =
      playerIndex === 0
        ? this.game.deck.map((card) => card.map((c) => BigInt(c)))
        : undefined;
    this.game.shuffle(proof as any, publicSignals as any, {
      publicKey,
      deck,
      permutationHash,
    }, { verified: true, skipTurnCheck: true });
    await timed(`verify:shuffle:p${playerIndex}`, () =>
      this.lifecycle.verifyShuffle(
        playerIndex,
        proof,
        signals,
        deck,
        deckBefore,
        this.bettingTable.players[playerIndex],
      ),
    );
  }

  /**
   * Submit a client-proven share (Groth16 + Arcis). When the last player submits,
   * finalizes the share phase (2p reveal staging + finalize_share_phase).
   */
  async sharePlayerFromProof(
    playerIndex: number,
    proof: object,
    publicSignals: string[],
    ciphertexts: import('../zk-casino').Ciphertext[][],
  ): Promise<bigint | null> {
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');

    const signals = publicSignals.map((s) => BigInt(s));

    const recipientMajor = flattenShareCiphertexts(ciphertexts);
    // Share receipt is allocated in `verifyShare` after Arcis freezes
    // `share_verify_acc` (needs verified+frozen generation).

    const stagingReady = this.staging.createShare(
      this.gameId,
      playerIndex,
      this.bettingTable.players[playerIndex],
    );
    const { rows, nonce, arcisHash } = encryptRecipientMajorRowsForStaging(
      this.tableKey,
      mxe,
      recipientMajor,
      this.numPlayers,
    );
    const shareCommit = this.game.assertShareOutput(signals, ciphertexts, playerIndex);
    await timed(`tx:create_share_staging:p${playerIndex}`, () => stagingReady);

    const publicKey = this.game.publicKeys[playerIndex];
    if (!publicKey) {
      throw new Error(`Missing public key for player ${playerIndex}`);
    }
    this.game.postShareStake(playerIndex, this.game.requiredShareStake());
    this.game.share(proof as any, publicSignals as any, {
      publicKey,
      ciphertexts,
    }, { verified: true });
    this.shareCiphertextsForStaging[playerIndex] = ciphertexts;

    const streets = pokerStreetFieldGroups(ciphertexts);
    const laneFund = this.lifecycle.prepareShareLanes(
      this.bettingTable.players[playerIndex]!,
      shareStreetChunkCount(streets),
      playerIndex,
    );
    await laneFund.submitted;
    await timed(`tx:begin_share_verify:p${playerIndex}`, () =>
      this.arcium.beginVerifyShareHash(
        this.gameId,
        playerIndex,
        0n,
        0n,
        this.bettingTable.tableState,
        this.bettingTable.players[playerIndex],
        {
          encryptionPubkey: this.tableKey.publicKey,
          nonceBase: this.tableKey.nonceBase,
        },
      ),
    );

    const seatsShared = this.shareCiphertextsForStaging.filter((c) => c != null && c.length > 0).length;
    const revealStaging = this.numPlayers === 2 && seatsShared >= this.numPlayers
      ? timed('tx:write_reveal_staging', () => this.stageCardMajorRevealStaging())
      : Promise.resolve();
    await revealStaging;
    await this.staging.finishRevealLaneSweep();
    const tier = this.game.shareTierCommitment(ciphertexts);
    if (signals[0] !== tier.finalHash) {
      throw new Error(
        `share output hash mismatch player=${playerIndex}: proof=${signals[0]} fold=${tier.finalHash}`,
      );
    }
    await timed(`verify:share:p${playerIndex}`, () =>
      this.lifecycle.verifyShare(
        playerIndex,
        proof,
        signals,
        0,
        this.bettingTable.players[playerIndex],
        streets,
        laneFund,
      ),
    );

    const sharedCount = this.shareCiphertextsForStaging.filter((c) => c != null && c.length > 0).length;
    if (sharedCount < this.numPlayers) {
      return null;
    }

    await timed('finalize:share', () =>
      this.arcium.finalizeSharePhase(this.gameId, this.numPlayers),
    );
    const state = await this.arcium.fetchGameState(this.gameId);
    if (state.verified !== true || state.shareFinalized !== true) {
      throw new Error(
        `finalize_share_phase failed: verified=${state.verified} shareFinalized=${state.shareFinalized}`,
      );
    }
    await this.lifecycle.closeShareReceipts(this.bettingTable.players);
    for (let p = 0; p < this.numPlayers; p++) {
      await timed(`tx:close_share_deck_staging:p${p}`, () =>
        this.staging.closeShare(this.gameId, p, this.bettingTable.players[p]),
      );
    }
    return shareCommit.finalHash;
  }

  /**
   * Groth16 shuffle per player (serial). Each isolated client:
   *   - P0 proves from the known identity deck, then verify writes outputs to
   *     light-casino `deck_state`.
   *   - P>0 **fetches** the prior shuffled deck from `deck_state` before prove
   *     (never reads another player's in-process `Game.deck`).
   *   - Prove → on-chain Poseidon input hash (P0: seeded; non-P0 folds
   *     deck_state) ∥ staged Groth16 verify → `finalize_shuffle`.
   */
  async shuffleAll(): Promise<void> {
    const publicKeys = this.game.publicKeys;
    // P0's prior deck is the identity deck (known constant), not Light-fetched.
    let priorDeck = this.game.deck;
    this.players[0]!.preloadShuffle(priorDeck, publicKeys);
    for (let p = 0; p < this.numPlayers; p++) {
      if (p > 0) {
        // Isolation: retrieve prior player's verified outputs from Light storage.
        priorDeck = await timed(`light:fetch_shuffled_deck:p${p}`, () =>
          this.lifecycle.fetchShuffledDeck(),
        );
        this.players[p]!.preloadShuffle(priorDeck, publicKeys);
      }
      // P0 still stages the identity deck into deck_state. Poseidon for P0
      // uses the shoe's baked initial-deck hash (1 deck, or 0..51 repeated
      // for a 6- or 8-deck shoe).
      const deckBefore =
        p === 0
          ? priorDeck.map((card) => card.map((c) => BigInt(c)))
          : undefined;
      const { proof, publicSignals, deck, permutationHash } = await timed(
        `prove:shuffle:p${p}`,
        () => this.players[p]!.shuffleProve(priorDeck, publicKeys),
      );
      // Local Game update is for this process's later phases (share/reveal),
      // not a source of truth for the next player's shuffle inputs.
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
          this.bettingTable.players[p],
        ),
      );
    }
  }

  /**
   * Share phase: on-chain Poseidon input hash → prove → parallel Groth16 +
   * per-player recipient-major Arcis verify → card-major reveal staging →
   * finalize_share_phase.
   *
   * Isolation: each player owns `share_deck_staging[p]` + `ShareVerifyAccumulator[p]`,
   * so Groth16 prove/verify and Arcis share-hash verify run across players concurrently.
   * (Shuffle remains serial — each player consumes the prior deck.)
   */
  async shareAll(): Promise<bigint> {
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
      /** Original proof public signals (strings/bignums) for local verifyCircuit. */
      publicSignalsRaw: any;
      publicSignals: bigint[];
      ciphertexts: import('../zk-casino').Ciphertext[][];
      expectedHash: bigint;
      arcisHash: bigint;
      shareNonce: bigint;
      rows: import('../../test/e2e/share-deck-staging').EncryptedRecipientMajorRow[];
    };

    // Each seat has its own witness slot. Proves overlap up to
    // GROTH16_PROVE_CONCURRENCY; staging and Arcis keep going on the other seats.
    const playerIndices = Array.from({ length: this.numPlayers }, (_, p) => p);
    console.log(
      `[share] ${this.numPlayers} players prove W=${groth16ProveConcurrency()}`,
    );
    const preparedSlots: Array<PlayerShare | undefined> = new Array(this.numPlayers);
    await mapPool(playerIndices, this.numPlayers, async (p) => {
      const { proof, publicSignals, ciphertexts } = await timed(`prove:share:p${p}`, () =>
        this.players[p]!.shareProve(
          this.game.finalShuffledDeck,
          this.game.publicKeysShare(p),
          this.numPlayers,
        ),
      );
      const signals = publicSignals.map((s) => BigInt(s));
      const recipientMajor = flattenShareCiphertexts(ciphertexts);
      // Receipt init waits until Arcis share verify freezes the accumulator.

      const stagingReady = this.staging.createShare(
        this.gameId,
        p,
        this.bettingTable.players[p],
      );
      const { rows, nonce, arcisHash } = encryptRecipientMajorRowsForStaging(
        this.tableKey,
        mxe,
        recipientMajor,
        this.numPlayers,
      );
      const shareCommit = this.game.assertShareOutput(signals, ciphertexts, p);
      await timed(`tx:create_share_staging:p${p}`, () => stagingReady);
      preparedSlots[p] = {
        p,
        proof,
        publicSignalsRaw: publicSignals,
        publicSignals: signals,
        ciphertexts,
        expectedHash: shareCommit.finalHash,
        arcisHash,
        shareNonce: nonce,
        rows,
      };
    });

    // Latch in-memory share state in seat order (cheap; avoids phase-flip races).
    const prepared: PlayerShare[] = [];
    for (let p = 0; p < this.numPlayers; p++) {
      const item = preparedSlots[p];
      if (!item) throw new Error(`share prepare missing player=${p}`);
      // Must pass raw proof signals — bigint[] breaks snarkjs verifyCircuit.
      this.game.postShareStake(p, this.game.requiredShareStake());
      this.game.share(item.proof, item.publicSignalsRaw, {
        publicKey: this.players[p]!.publicKey,
        ciphertexts: item.ciphertexts,
      });
      this.shareCiphertextsForStaging[p] = item.ciphertexts;
      prepared.push(item);
    }

    // Per-player share_deck_staging + ShareVerifyAccumulator — safe across players.
    // Localnet: W=3 for N>2, VERIFY_CHUNK_CONCURRENCY (default 5) for 2p, one fold
    // at a time. Devnet overlaps every seat and several folds per seat.
    const shareVerifyConcurrency = sharePlayerConcurrency(
      this.numPlayers,
      this.numPlayers > 2
        ? 3
        : Number(process.env.VERIFY_CHUNK_CONCURRENCY ?? '5'),
    );
    const shareFoldConcurrency = shareChunkConcurrency(shareVerifyConcurrency);
    const shareChunkTimeoutMs = Number(
      process.env.SHARE_VERIFY_CHUNK_TIMEOUT_MS
        ?? String(this.numPlayers > 2 ? 900_000 : 180_000),
    );
    console.log(
      `[share-verify] ${prepared.length} players W=${shareVerifyConcurrency} folds W=${shareFoldConcurrency} chunkTimeoutMs=${shareChunkTimeoutMs}`,
    );
    const revealStaging = this.numPlayers === 2
      ? timed('tx:write_reveal_staging', () => this.stageCardMajorRevealStaging())
      : Promise.resolve();
    await afterBackground(revealStaging, () => mapPool(
      prepared,
      shareVerifyConcurrency,
      async (item) => {
        const streets = pokerStreetFieldGroups(item.ciphertexts);
        const laneFund = this.lifecycle.prepareShareLanes(
          this.bettingTable.players[item.p]!,
          shareStreetChunkCount(streets),
          item.p,
        );
        await laneFund.submitted;
        await timed(`tx:begin_share_verify:p${item.p}`, () =>
          this.arcium.beginVerifyShareHash(
            this.gameId,
            item.p,
            0n,
            0n,
            this.bettingTable.tableState,
            this.bettingTable.players[item.p],
            {
              encryptionPubkey: this.tableKey.publicKey,
              nonceBase: this.tableKey.nonceBase,
            },
          ),
        );

        const tier = this.game.shareTierCommitment(item.ciphertexts);
        if (item.publicSignals[0] !== tier.finalHash) {
          throw new Error(
            `share output hash mismatch player=${item.p}: proof=${item.publicSignals[0]} fold=${tier.finalHash}`,
          );
        }
        await timed(`verify:share:p${item.p}`, () =>
          this.lifecycle.verifyShare(
            item.p,
            item.proof,
            item.publicSignals,
            0,
            this.bettingTable.players[item.p],
            streets,
            laneFund,
          ),
        );
      },
    ));

    await timed('finalize:share', () =>
      this.arcium.finalizeSharePhase(this.gameId, this.numPlayers),
    );
    const state = await this.arcium.fetchGameState(this.gameId);
    if (state.verified !== true || state.shareFinalized !== true) {
      throw new Error(
        `finalize_share_phase failed: verified=${state.verified} shareFinalized=${state.shareFinalized}`,
      );
    }
    await this.staging.finishRevealLaneSweep();
    await this.lifecycle.closeShareReceipts(this.bettingTable.players);
    // Share Arcis no longer needs per-player staging — refund rent immediately.
    for (let p = 0; p < this.numPlayers; p++) {
      await timed(`tx:close_share_deck_staging:p${p}`, () =>
        this.staging.closeShare(this.gameId, p, this.bettingTable.players[p]),
      );
    }
    return prepared[0]!.expectedHash;
  }

  /** Write transposed card-major rows into global deck_staging for reveal_card. */
  async stageCardMajorRevealStaging(): Promise<void> {
    if (this.shareCiphertextsForStaging.length !== this.numPlayers) {
      throw new Error('shareAll() must produce ciphertexts before reveal staging');
    }
    if (this.numPlayers !== 2) {
      throw new Error('Use stageRecipientRevealStaging() for games larger than 2 players');
    }
    const values = toTwoPlayerRecipientCardMajorShareValues(this.shareCiphertextsForStaging);
    const commitments = shareValuesToCommitments(values);
    const stagingReady = this.staging.create(this.gameId);
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');
    const activeCards = usedCardIndices(this.numPlayers);
    const { rows, nonce } = encryptCommitmentRowsForStaging(
      this.tableKey,
      mxe,
      commitments,
      activeCards,
      this.numPlayers,
    );
    this.deckNonce = nonce;
    await stagingReady;
    await this.staging.writeRevealRows(this.gameId, rows);
  }

  /**
   * Overwrite selected card rows with one recipient's N-player sealed partials.
   * Returns the Rescue base nonce for those rows (do not share across recipients).
   */
  async stageRecipientRevealStaging(
    recipientIndex: number,
    cardIndices: number[],
  ): Promise<bigint> {
    if (this.shareCiphertextsForStaging.length !== this.numPlayers) {
      throw new Error('shareAll() must produce ciphertexts before reveal staging');
    }
    const values = toRecipientCardMajorShareValues(
      this.shareCiphertextsForStaging,
      this.numPlayers,
      recipientIndex,
    );
    const commitments = shareValuesToCommitments(values);
    const stagingReady = this.staging.create(this.gameId);
    const mxe = await getMXEPublicKey(this.provider, this.pokerProgram.programId);
    if (!mxe) throw new Error('MXE public key unavailable');
    const { rows, nonce } = encryptCommitmentRowsForStaging(
      this.tableKey,
      mxe,
      commitments,
      cardIndices,
      this.numPlayers,
    );
    this.deckNonce = nonce;
    await stagingReady;
    await timed(`tx:write_reveal_staging:r${recipientIndex}`, () =>
      this.staging.writeRevealRows(this.gameId, rows),
    );
    return nonce;
  }

  /**
   * @deprecated Prefer shareAll() which now runs parallel Groth16 + Arcis and finalize.
   * Kept as an alias that stages card-major reveal rows only when ciphertexts exist.
   */
  async stageAndVerifySealedPartials(): Promise<bigint> {
    if (this.shareCiphertextsForStaging.length === 0) {
      throw new Error('shareAll() must run before stageAndVerifySealedPartials()');
    }
    // shareAll already finalized; return the recipient-major hash from player 0.
    return this.game.shareTierCommitment(this.shareCiphertextsForStaging[0]!).finalHash;
  }

  /**
   * Open preflop on-chain (`collect_blinds` + `open_preflop`).
   * Later streets advance via Enc bet callbacks — do not pass Flop/Turn/River here.
   * Interactive clients call this once per street, then `placeEncryptedBet`.
   *
   * @param initialSeatBalances — seat escrow stacks in hand-player order. Required
   *   on the first street of a hand (seeds encrypted `player_balance` for validate_bet).
   */
  async startBettingStreet(
    phase: BettingPhase,
    blinds?: { sb: bigint; bb: bigint },
    initialSeatBalances?: bigint[],
  ): Promise<void> {
    const phaseNum: Record<BettingPhase, number> = {
      PreFlop: 1,
      Flop: 2,
      Turn: 3,
      River: 4,
    };
    if (phase === 'PreFlop') {
      await timed(`tx:open_preflop`, () =>
        this.betting.startOnchainBettingRound(
          this.gameId,
          phase,
          blinds?.sb ?? 0n,
          blinds?.bb ?? 0n,
        ),
      );
    } else {
      // Later streets must already be open via Enc bet-callback advances.
      const state = await this.arcium.fetchGameState(this.gameId);
      const bp = Number(state.bettingPhase ?? state.betting_phase ?? 0);
      const want = phaseNum[phase];
      if (bp !== want) {
        throw new Error(
          `startBettingStreet(${phase}): on-chain betting_phase=${bp}, expected ${want} ` +
            '(streets advance only via validate_bet callbacks)',
        );
      }
    }

    this.interactiveBettingPhase = phase;
    this.streetCurrentBet = blinds?.bb ?? 0n;
    this.streetLastAggressorAmount = blinds?.bb ?? 0n;
    this.streetBet = new Array(this.numPlayers).fill(0n) as bigint[];
    if (blinds) {
      this.streetBet[0] = blinds.sb;
      this.streetBet[1] = blinds.bb;
    }
    // Balances persist across streets; only seed once on first blinds round.
    if (!this.playerBalances) {
      if (!initialSeatBalances) {
        throw new Error('initialSeatBalances required on first betting street (no fabricated defaults)');
      }
      if (initialSeatBalances.length !== this.numPlayers) {
        throw new Error(
          `initialSeatBalances length ${initialSeatBalances.length} != numPlayers ${this.numPlayers}`,
        );
      }
      this.playerBalances = [...initialSeatBalances];
      if (blinds) {
        this.playerBalances[0] = this.playerBalances[0]! - blinds.sb;
        this.playerBalances[1] = this.playerBalances[1]! - blinds.bb;
      }
    }
  }

  /** Reset in-hand balance tracking between hands (caller re-seeds via startBettingStreet). */
  clearPlayerBalances(): void {
    this.playerBalances = null;
  }

  /**
   * Submit one Rescue-encrypted bet via `submit_bet` → Arcis `validate_bet`
   * and wait for the callback to advance `current_player`.
   */
  async placeEncryptedBet(
    playerIndex: number,
    action: string,
    amount: bigint,
    options?: { showOnFold?: boolean },
  ): Promise<EncryptedBettingStreetSnapshot> {
    if (!this.streetBet || !this.playerBalances || !this.interactiveBettingPhase) {
      throw new Error('startBettingStreet() required before placeEncryptedBet()');
    }
    const balances = this.playerBalances;
    const streetBet = this.streetBet;
    const from = Number(
      (await this.arcium.fetchGameState(this.gameId)).currentPlayer,
    );
    if (from !== playerIndex) {
      throw new Error(
        `${this.interactiveBettingPhase}: expected current_player=${playerIndex} for ${action}, got ${from}`,
      );
    }

    const actionAmount = resolveEncryptedBetAmount(action, {
      amount,
      playerCurrentBet: streetBet[playerIndex]!,
      currentBet: this.streetCurrentBet,
      playerBalance: balances[playerIndex]!,
    });

    const beforeBet = await this.arcium.fetchGameState(this.gameId);
    const beforeBp = Number(beforeBet.bettingPhase);
    const beforeFolded = Number(beforeBet.foldedMask);

    await timed(`tx:bet:${this.interactiveBettingPhase}:p${playerIndex}:${action}`, () =>
      this.betting.placeBet(
        this.gameId,
        playerIndex,
        action,
        actionAmount,
        this.nextOffset(),
        {
          playerBalance: balances[playerIndex]!,
          playerCurrentBet: streetBet[playerIndex]!,
          currentBet: this.streetCurrentBet,
          lastAggressorAmount: this.streetLastAggressorAmount,
          showOnFold: options?.showOnFold === true,
        },
      ),
    );
    await this.betting.waitForTurnAdvance(
      this.gameId,
      from,
      Number(process.env.BET_CALLBACK_TIMEOUT_MS ?? '120000'),
      { bettingPhase: beforeBp, foldedMask: beforeFolded },
    );

    const afterBet = await this.arcium.fetchGameState(this.gameId);
    const afterBp = Number(afterBet.bettingPhase);
    const advancedStreet = afterBp !== beforeBp && afterBp >= 1 && afterBp <= 4;

    // Always apply chip deltas for the action that just cleared — including when
    // it closes the street (heads-up SB complete). Skipping this left off-chain
    // balances high → next validate_bet fails state_matches → InvalidBet.
    if (action === 'call' || action === 'bet' || action === 'raise' || action === 'all-in') {
      balances[playerIndex]! -= actionAmount;
      streetBet[playerIndex]! += actionAmount;
      if (!advancedStreet && streetBet[playerIndex]! > this.streetCurrentBet) {
        const previousCurrentBet = this.streetCurrentBet;
        this.streetCurrentBet = streetBet[playerIndex]!;
        this.streetLastAggressorAmount = this.streetCurrentBet - previousCurrentBet;
      }
    }

    if (advancedStreet) {
      this.streetBet = new Array(this.numPlayers).fill(0n) as bigint[];
      this.streetCurrentBet = 0n;
      this.streetLastAggressorAmount = 0n;
      this.interactiveBettingPhase = (
        ['PreFlop', 'Flop', 'Turn', 'River'] as const
      )[afterBp - 1]!;
    }

    return this.fetchEncryptedBettingSnapshot();
  }

  async fetchEncryptedBettingSnapshot(): Promise<EncryptedBettingStreetSnapshot> {
    const state = await this.arcium.fetchGameState(this.gameId);
    const num = Number(state.numPlayers);
    return {
      currentPlayer: Number(state.currentPlayer),
      currentBet: BigInt(state.currentBet.toString()),
      lastAggressorAmount: BigInt(state.lastAggressorAmount.toString()),
      foldedMask: Number(state.foldedMask),
      showOnFoldMask: Number(state.showOnFoldMask ?? state.show_on_fold_mask ?? 0),
      allInMask: Number(state.allInMask),
      playerTotalBets: (state.playerTotalBets as { toString(): string }[])
        .slice(0, num)
        .map((x) => BigInt(x.toString())),
      pots: (state.pots as { toString(): string }[])
        .slice(0, Number(state.potCount))
        .map((x) => BigInt(x.toString())),
      streetBets: this.streetBet ? [...this.streetBet] : new Array(num).fill(0n),
      playerBalances: this.playerBalances
        ? [...this.playerBalances]
        : (() => {
            throw new Error('playerBalances not seeded — call startBettingStreet with initialSeatBalances');
          })(),
      bettingPhase: Number(state.bettingPhase),
    };
  }

  async runBettingRound(
    phase: BettingPhase,
    actions: Array<{ player: number; action: string; amount: bigint }>,
    blinds?: { sb: bigint; bb: bigint },
    initialSeatBalances?: bigint[],
  ): Promise<void> {
    await this.startBettingStreet(phase, blinds, initialSeatBalances);
    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i]!;
      const before = await this.arcium.fetchGameState(this.gameId);
      const beforeBp = Number(before.bettingPhase ?? before.betting_phase ?? 0);
      await this.placeEncryptedBet(a.player, a.action, a.amount);
      // Heads-up preflop stays open until the big blind checks or the raise is called.
      if (phase === 'PreFlop' && this.numPlayers === 2 && i < actions.length - 1) {
        const after = await this.arcium.fetchGameState(this.gameId);
        const afterBp = Number(after.bettingPhase ?? after.betting_phase ?? 0);
        if (afterBp !== beforeBp) {
          throw new Error(
            `Preflop closed before the big blind finished acting `
            + `(player ${a.player} ${a.action} moved betting_phase ${beforeBp} → ${afterBp})`,
          );
        }
      }
    }
  }

  /**
   * Confirm showdown (`betting_phase` 5) after river betting.
   * Street advances are Enc bet-callback only — never force-select phase 5.
   */
  async beginShowdownReveal(): Promise<void> {
    const state = await this.arcium.fetchGameState(this.gameId);
    const bp = Number(state.bettingPhase ?? state.betting_phase ?? 0);
    if (bp !== 5) {
      throw new Error(
        `beginShowdownReveal: expected betting_phase=5 from bet callbacks, got ${bp}`,
      );
    }
  }

  /**
   * Publish sealed threshold partials for card indices via Arcis `reveal_card`.
   *
   * Staging is encrypted in 4-limb batches along each 36-limb card row; one MPC job
   * per card decrypts the row and publishes `totalCount = (nPlayers-1)*4` limbs.
   * All cards in the batch (every player's holes, or the street's board) are
   * queued in parallel by default; completion via `RevealCardEvent`.
   */
  /**
   * @param opts.skipStaging - caller already wrote this recipient's rows (and supplies deckNonce)
   * @param opts.deckNonce - Rescue base nonce matching staged ciphertext
   */
  async revealSealedPartials(
    recipientIndex: number,
    cardIndices: number[],
    opts?: { skipStaging?: boolean; deckNonce?: bigint },
  ): Promise<void> {
    const totalCount = (this.numPlayers - 1) * 4;
    // Per-recipient nonce: parallel recipients must not share `this.deckNonce`.
    let deckNonce = opts?.deckNonce ?? this.deckNonce;
    if (this.numPlayers > 2 && !opts?.skipStaging) {
      deckNonce = await this.stageRecipientRevealStaging(recipientIndex, cardIndices);
    }
    // Cards use distinct staging offsets (cardIndex*36). 2p: full batch.
    // 10p: one card at a time by default — wait for RevealCardEvent before the
    // next card so Arcis mempool can drain (HeapFull / 6602 under W≥2).
    const concurrency = revealCardConcurrency(this.numPlayers, cardIndices.length);
    const t0 = Date.now();
    console.log(
      `[reveal] r${recipientIndex} ${cardIndices.length} cards parallel W=${concurrency} indices=[${cardIndices.join(',')}]`,
    );
    await mapPool(cardIndices, concurrency, async (cardIndex) => {
      const cardT0 = Date.now();
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
          recipient: this.bettingTable.players[recipientIndex]!,
          tableState: this.bettingTable.tableState,
          sourceStart: this.numPlayers > 2 ? 0 : undefined,
        });
        await revealed;
      } finally {
        console.timeEnd(revealLabel);
      }
      console.log(`[reveal] card=${cardIndex} done ${Date.now() - cardT0}ms`);
      await timed(`tx:note_reveal:r${recipientIndex}:card${cardIndex}`, async () => {
        const revealedCard = await this.arcium.fetchRevealedCard(
          this.gameId,
          recipientIndex,
          cardIndex,
          totalCount,
        );
        const partials = (revealedCard.partials as Array<number[] | Uint8Array>)
          .slice(0, totalCount)
          .map((partial) => Uint8Array.from(partial));
        this.game.noteRevealedCard(
          recipientIndex,
          cardIndex,
          partials.map((partial) => {
            let value = 0n;
            for (const byte of partial) value = (value << 8n) + BigInt(byte);
            return value;
          }),
        );
      });
      // Keep the authoritative recipient/card PDA available to fetchers. Cleanup
      // is explicit and recipient-authorized; compressed commitments do not retain
      // these encrypted limbs.
      // Track unique cards for close_deck_staging bookkeeping (record at close).
      this.recordedRevealCards.add(cardIndex);
    });
    console.log(`[reveal] batch done ${Date.now() - t0}ms (${cardIndices.length} cards)`);
  }

  /**
   * After a mismatch, wait until every player has revealed that street or the
   * challenge deadline passes, then end the hand and slash everyone caught.
   */
  private async finishUnsealChallenge(): Promise<void> {
    for (;;) {
      const status = this.game.pollUnsealChallenge();
      if (status === 'none') return;
      if (status === 'closed') {
        const penalty = this.game.shareUnsealPenalty;
        if (penalty) {
          const street = this.game.unsealChallenge?.street;
          throw new Error(
            `share unseal penalty: street ${street} kicked [${penalty.kicked.join(', ')}], house pot ${penalty.houseFromPot}, players ${penalty.paidToPlayers.join(', ')}, protocol ${penalty.protocolLamports}`,
          );
        }
        return;
      }
      const deadline = this.game.unsealChallenge!.deadline;
      const wait = Math.max(0, deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1_000)));
    }
  }

  /**
   * After the last reveal that needs global `deck_staging`, credit reveal progress
   * (unique cards + unused deal slots) and close the PDA so rent is refunded.
   * On-chain gate: `revealed_partials >= total_partials`.
   */
  async closeDeckStagingWhenComplete(): Promise<void> {
    if (this.deckStagingClosed) return;
    const state = await this.arcium.fetchGameState(this.gameId);
    const total = Number(state.totalPartials ?? state.total_partials ?? 0);
    let revealed = Number(state.revealedPartials ?? state.revealed_partials ?? 0);
    const fromUnique = this.recordedRevealCards.size * (this.numPlayers - 1);
    const credit = Math.max(0, fromUnique - revealed);
    if (credit > 0) {
      await timed(`tx:record_reveal:unique:${credit}`, () =>
        this.gameState.recordReveal(this.gameId, credit),
      );
      revealed += credit;
    }
    const remaining = Math.max(0, total - revealed);
    if (remaining > 0) {
      // Unused deal slots (e.g. hole indices for empty seats) never need Arcis;
      // bookkeeping-only so the on-chain close gate can pass.
      await timed(`tx:record_reveal:unused:${remaining}`, () =>
        this.gameState.recordReveal(this.gameId, remaining),
      );
    }
    await timed('tx:close_deck_staging', () => this.staging.close(this.gameId));
    this.deckStagingClosed = true;
    await this.lifecycle.refundSeatRent(this.bettingTable.players);
  }

  /** Card indices whose sealed hole partials are published first. */
  holePartialCardIndices(): number[] {
    const indices: number[] = [];
    for (let p = 0; p < this.numPlayers; p++) {
      indices.push(p * 2, p * 2 + 1);
    }
    return indices;
  }

  /** Board card indices in the sealed-partials layout (hole slots 0..19). */
  communityPartialCardIndices(phase: 'Flop' | 'Turn' | 'River'): number[] {
    const start = 20;
    if (phase === 'Flop') return [start, start + 1, start + 2];
    if (phase === 'Turn') return [start + 3];
    return [start + 4];
  }

  /** Arcis seal → decrypt with this player's key → cache all PDA material. */
  async sealShowdownForPlayer(playerIndex: number): Promise<ShowdownSealMaterial> {
    const running = this.sealJobs.get(playerIndex);
    if (running) return running;
    const job = this.openShowdownSeal(playerIndex);
    this.sealJobs.set(playerIndex, job);
    return job;
  }

  private async openShowdownSeal(playerIndex: number): Promise<ShowdownSealMaterial> {
    const startedAt = Date.now();
    const owner = this.bettingTable.players[playerIndex]!;
    const cached = retainedShowdownKeys.get(owner.publicKey.toBase58());
    let key = cached;
    let reuse = false;
    if (cached) {
      try {
        const existing = await this.arcium.fetchSealedShowdownCoefficients(owner.publicKey);
        reuse = existing.written
          && existing.data[SEAL_CONSUMED_OFFSET] === 0
          && existing.encryptionPubkey.every((byte, index) => byte === cached.publicKey[index]);
      } catch {
        reuse = false;
      }
    }
    if (!reuse || !key) {
      key = generateTableEncryptionKey();
      retainedShowdownKeys.set(owner.publicKey.toBase58(), key);
    }
    const nonce = key.nonceBase;
    await timed(`arcis:seal_showdown:p${playerIndex}`, () =>
      this.arcium.sealShowdownCoefficients(
        this.gameId,
        this.nextOffset(),
        key.publicKey,
        nonce,
        playerIndex,
        this.bettingTable.tableState,
        owner,
        this.zkConfig.coeffCount,
      ),
    );

    const sealedPda = this.arcium.deriveSealedShowdownCoeffsPDA(owner.publicKey);
    const sealed = await this.polling.waitForCallback(
      sealedPda,
      () => this.arcium.fetchSealedShowdownCoefficients(owner.publicKey),
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
    console.log(`[showdown] seal p${playerIndex} done ${Date.now() - startedAt}ms`);
    return material;
  }

  /**
   * Begin + sync `ShowdownMaterialCommitment` over in-play RevealedCards.
   * Light reads the coefficient commitment from the seal rows Arcis wrote.
   */
  async prepareShowdownMaterial(playerIndex: number): Promise<void> {
    const player = this.bettingTable.players[playerIndex]!;
    // Must match Light `game_state.generation` / showdown proof receipt (always 0 today).
    // Poker RevealedCard.generation is async_generation at first write — not usable here.
    const generationBn = new BN(0);
    const showdownMaterial = this.arcium.deriveShowdownMaterialCommitment(
      this.gameId,
      generationBn,
      playerIndex,
    );
    const gameStatePda = this.gameStatePda();
    const tableState = this.bettingTable.tableState;
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

    const cards = usedCardIndices(this.numPlayers);
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
   * Groth16 showdown: parallel on-chain Poseidon input hash + verify receipt,
   * then `finalize_showdown` (gates `compute_pots` via poker `showdown_finalized`).
   */
  async showdownOnChain(playerIndex: number): Promise<{
    winnerMasks: bigint[];
    publicSignals: string[];
    proveMs: number;
  }> {
    await this.prepareShowdownMaterial(playerIndex);
    const player = this.players[playerIndex]!;
    const proveStartedAt = Date.now();
    const { proof, publicSignals, publicKey, winnerMasks, coefficientCommitment } = await timed(
      `prove:showdown:p${playerIndex}`,
      () => player.showdownProve(
        playerIndex,
        this.game.publicKeys,
        this.game.potMasks,
        this.game.finalShuffledDeck,
        this.game.getCiphertextPartialsForPlayer(playerIndex),
      ),
    );
    const proveMs = Date.now() - proveStartedAt;
    console.log(`[showdown] sole Groth16 prover p${playerIndex} done ${proveMs}ms`);
    const seal = this.showdownSeals.get(playerIndex);
    if (!seal) throw new Error(`Missing seal material for p${playerIndex}`);
    if (coefficientCommitment !== seal.coefficientCommitment) {
      throw new Error(`Showdown seal commitment for p${playerIndex} does not match the seal rows`);
    }
    this.game.verifyShowdown(proof, publicSignals, {
      publicKey,
      winnerMasks,
      coefficientCommitment: seal.coefficientCommitment,
    });
    const signals = publicSignals.map((s) => BigInt(s));
    // Showdown remains fail-closed until authenticated MPC materials are available.
    await timed(`verify:showdown:p${playerIndex}`, () =>
      this.lifecycle.verifyShowdown(
        playerIndex,
        proof,
        signals,
        this.bettingTable.players[playerIndex],
      ),
    );
    // Latch poker `showdown_finalized` + `showdown_hash_player` so compute_pots
    // can resolve the submitter's sealed coefficients PDA.
    await timed(`finalize:showdown:p${playerIndex}`, () =>
      this.lifecycle.finalizeShowdown(
        playerIndex,
        this.bettingTable.players[playerIndex],
      ),
    );
    return { winnerMasks, publicSignals, proveMs };
  }

  /**
   * Fused Arcis verify+distribute after Groth16 latch.
   * Enc masks under the submitter's seal Shared key; coeffs from that player's PDA.
   */
  async computePots(winnerMasks: bigint[], submitterPlayerIndex: number): Promise<void> {
    const state = await this.arcium.fetchGameState(this.gameId);
    if (Number(state.phase ?? 0) >= 6) {
      await this.closeRetainedRevealedCards();
      return;
    }
    const seal = this.showdownSeals.get(submitterPlayerIndex);
    if (!seal) {
      throw new Error(`Missing showdown seal for submitter p${submitterPlayerIndex}`);
    }
    const enc = await encryptWinnerMasksWithSealedKey(
      seal.key,
      this.provider,
      this.pokerProgram.programId,
      winnerMasks,
    );
    await timed('arcis:compute_pots', () =>
      this.arcium.computePots(
        this.gameId,
        this.nextOffset(),
        enc.ciphertexts,
        enc.encryptionPubkey,
        enc.nonce,
        this.bettingTable.tableState,
        this.bettingTable.players[submitterPlayerIndex]!.publicKey,
      ),
    );
    await this.polling.waitForPhase(
      this.gameStatePda(),
      (pda) => (this.pokerProgram.account as any).gameState.fetch(pda),
      6,
      { timeout: 180_000, interval: 2_000 },
    );
    await this.closeRetainedRevealedCards();
    await this.arcium.reclaimFinalizedComputations();
  }

  private async closeRetainedRevealedCards(): Promise<void> {
    const tableState = this.bettingTable.tableState;
    await Promise.all(
      Array.from({ length: this.numPlayers }, (_, recipientIndex) => recipientIndex).flatMap(
        (recipientIndex) => [...this.recordedRevealCards].map(async (cardIndex) => {
          const pda = this.revealedCards.derivePDA(this.gameId, recipientIndex, cardIndex);
          if (!(await this.provider.connection.getAccountInfo(pda))) return;
          await this.revealedCards.close(
            this.gameId,
            recipientIndex,
            cardIndex,
            this.gameStatePda(),
            tableState,
            this.bettingTable.players[recipientIndex],
          );
        }),
      ),
    );
  }

  /** Per-player escrow settlement (alternative to aggregate compute_pots). */
  async distributeAndSettle(winnerMasks: bigint[], playerIndex: number): Promise<void> {
    const state = await this.arcium.fetchGameState(this.gameId);
    if (Number(state.phase ?? 0) >= 6) {
      await this.closeRetainedRevealedCards();
      return;
    }
    const seal = this.showdownSeals.get(playerIndex);
    if (!seal) {
      throw new Error(`Missing showdown seal for p${playerIndex}`);
    }
    const enc = await encryptWinnerMasksWithSealedKey(
      seal.key,
      this.provider,
      this.pokerProgram.programId,
      winnerMasks,
    );
    await this.arcium.distributeAndSettle(
      this.gameId,
      this.nextOffset(),
      enc.ciphertexts,
      enc.encryptionPubkey,
      enc.nonce,
      playerIndex,
      this.bettingTable.players[playerIndex]!.publicKey,
    );
    await this.polling.waitForPhase(
      this.gameStatePda(),
      (pda) => (this.pokerProgram.account as any).gameState.fetch(pda),
      6,
      { timeout: 180_000, interval: 2_000 },
    );
    await this.closeRetainedRevealedCards();
    await this.arcium.reclaimFinalizedComputations();
  }

  /** Full continuous N-player check-down exercising every Groth16 + Arcis circuit. */
  async runCompleteHand(): Promise<ContinuousHandResult> {
    await this.initCompDefs();
    await beginHandCost(this.provider);
    console.time('timing:hand');
    try {
    await this.initialize();
    // Use monotonic clock — Date.now() can jump (NTP/sleep) and inflate shareAll.
    const handStart = performance.now();
    const phaseDurations: Record<string, number> = {};
    console.time('critical:register→share_finalize');
    let deckHash: bigint;
    try {
      let phaseStart = performance.now();
      await this.registerAll();
      phaseDurations.registerAll = Math.round(performance.now() - phaseStart);
      console.timeLog('critical:register→share_finalize', { phase: 'registerAll' });

      phaseStart = performance.now();
      await this.shuffleAll();
      phaseDurations.shuffleAll = Math.round(performance.now() - phaseStart);
      console.timeLog('critical:register→share_finalize', { phase: 'shuffleAll' });

      phaseStart = performance.now();
      deckHash = await this.shareAll();
      phaseDurations.shareAll = Math.round(performance.now() - phaseStart);
    } finally {
      console.timeEnd('critical:register→share_finalize');
      await this.staging.finishRevealLaneSweep().catch(() => undefined);
    }
    console.log('timing:hand_start_summary', {
      criticalMs: Math.round(performance.now() - handStart),
      ...phaseDurations,
    });

    const seatStacks = Array.from({ length: this.numPlayers }, () => this.seatBuyIn);
    await this.runBettingRound(
      'PreFlop',
      checkDownPreFlopActions(this.numPlayers, { sb: 10n, bb: 20n }),
      { sb: 10n, bb: 20n },
      seatStacks,
    );

    const revealForRecipients = async (
      cardsForRecipient: (recipient: number) => number[],
    ): Promise<void> => {
      const recipients = Array.from({ length: this.numPlayers }, (_, recipient) => recipient);
      const cardSets = recipients.map((recipient) => cardsForRecipient(recipient));
      // Same card index → one 36-limb staging row (10p fills all sharer slots),
      // so overlapping recipients must serialize. Disjoint hole cards are safe
      // to stage/reveal in parallel (distinct cardIndex*36 offsets + local nonces).
      const canParallelRecipients =
        this.numPlayers === 2 || recipientCardSetsDisjoint(cardSets);
      // 2p: both recipients, every card. Localnet N>2 stays at W=1 — a 10p run
      // with W=3×2 cards flooded the Docker mempool (`HeapFull` / 0x19ca).
      // Devnet raises N>2 to 2 recipients and up to 4 cards; limbs stay serial.
      const recipientConcurrency = revealRecipientConcurrency(
        this.numPlayers,
        canParallelRecipients,
      );
      console.log(
        `[reveal] recipients=${recipients.length} parallel=${canParallelRecipients} W=${recipientConcurrency}`,
      );
      if (canParallelRecipients && this.numPlayers > 2) {
        const nonces = new Map<number, bigint>();
        for (const recipient of recipients) {
          const cards = cardsForRecipient(recipient);
          const nonce = await this.stageRecipientRevealStaging(recipient, cards);
          nonces.set(recipient, nonce);
        }
        await mapPool(recipients, recipientConcurrency, async (recipient) => {
          await this.revealSealedPartials(recipient, cardsForRecipient(recipient), {
            skipStaging: true,
            deckNonce: nonces.get(recipient)!,
          });
        });
      } else {
        await mapPool(recipients, recipientConcurrency, async (recipient) => {
          await this.revealSealedPartials(recipient, cardsForRecipient(recipient));
        });
      }
    };
    await revealForRecipients((recipient) => [recipient * 2, recipient * 2 + 1]);
    await this.finishUnsealChallenge();

    for (const phase of ['Flop', 'Turn', 'River'] as const) {
      await this.runBettingRound(
        phase,
        streetActionOrder(phase, this.numPlayers).map((player) => ({
          player,
          action: 'check',
          amount: 0n,
        })),
      );
      const board = this.communityPartialCardIndices(phase);
      await revealForRecipients(() => board);
      await this.finishUnsealChallenge();
    }

    // River board partials are already revealed by the street loop.
    await this.beginShowdownReveal();
    if (this.numPlayers === 2) {
      await Promise.all([
        this.revealSealedPartials(0, [2, 3]),
        this.revealSealedPartials(1, [0, 1]),
      ]);
      await this.finishUnsealChallenge();
    }

    const previews = await Promise.all(this.players.map((player, playerIndex) =>
      player.previewShowdownWinnerMasksAsync(
        playerIndex,
        this.game.publicKeys,
        this.game.potMasks,
        this.game.finalShuffledDeck,
        this.game.getCiphertextPartialsForPlayer(playerIndex),
      ),
    ));
    if (previews.some((masks) => masks.some((mask, i) => mask !== previews[0]![i]))) {
      throw new Error('Players disagreed on previewed showdown winner masks');
    }

    // This continuous harness is a single-pot two-player check-down. Normalize
    // active pots to one chip; winner ranking and the action-order tie-break are
    // unchanged, while encrypted pot amounts remain private.
    const handSeatOrder = Array.from({ length: this.numPlayers }, (_, seat) => seat);
    const potResults = buildPotResultsFromAuthenticatedMasks(
      previews[0]!,
      this.numPlayers,
      handSeatOrder,
      this.game.potMasks.map((mask) => ({ amount: mask === 0n ? 0n : 1n })),
    );
    const submitterPlayerIndex = preferredShowdownSubmitterSeat(
      potResults,
      handSeatOrder,
    );
    if (submitterPlayerIndex === null) {
      throw new Error('No preferred showdown submitter from previewed winner masks');
    }
    console.log(`[showdown] selected sole prover p${submitterPlayerIndex}`);

    if (this.numPlayers > 2) {
      const opponentHoles = this.holePartialCardIndices().filter(
        (cardIndex) => Math.floor(cardIndex / 2) !== submitterPlayerIndex,
      );
      await this.revealSealedPartials(submitterPlayerIndex, opponentHoles);
      await this.finishUnsealChallenge();
    }

    await this.sealShowdownForPlayer(submitterPlayerIndex);
    const { winnerMasks, publicSignals, proveMs } =
      await this.showdownOnChain(submitterPlayerIndex);
    const seal = this.showdownSeals.get(submitterPlayerIndex);
    if (!seal) throw new Error(`Missing showdown seal for p${submitterPlayerIndex}`);
    const enc = await encryptWinnerMasksWithSealedKey(
      seal.key,
      this.provider,
      this.pokerProgram.programId,
      winnerMasks,
    );
    const submitter = this.bettingTable.players[submitterPlayerIndex]!.publicKey;
    for (let seat = 0; seat < this.numPlayers; seat += 1) {
      const phase = Number((await this.arcium.fetchGameState(this.gameId)).phase ?? 0);
      if (phase >= 6) break;
      try {
        await this.arcium.distributeAndSettle(
          this.gameId,
          this.nextOffset(),
          enc.ciphertexts,
          enc.encryptionPubkey,
          enc.nonce,
          seat,
          submitter,
        );
      } catch (err) {
        const phaseNow = Number((await this.arcium.fetchGameState(this.gameId)).phase ?? 0);
        if (phaseNow >= 6) break;
        throw err;
      }
    }
    await this.polling.waitForPhase(
      this.gameStatePda(),
      (pda) => (this.pokerProgram.account as any).gameState.fetch(pda),
      6,
      { timeout: 180_000, interval: 2_000 },
    );
    await this.closeRetainedRevealedCards();
    await this.arcium.reclaimFinalizedComputations();
    await Promise.all(
      [...this.sealJobs.values()].map((job) =>
        job.catch((err) => {
          console.error('[showdown] background seal failed', err);
        }),
      ),
    );

    // close_deck_staging requires phase==6 (post-settlement). Bookkeep reveals
    // after Arcis no longer needs staging, then close once pots settle.
    await this.closeDeckStagingWhenComplete();

    const state = await this.arcium.fetchGameState(this.gameId)
    const submitterSeal = this.showdownSeals.get(submitterPlayerIndex)!;
    return {
      gameId: this.gameId,
      winnerMasks,
      sealedCoefficients: submitterSeal.decryptedCoefficients,
      showdownHash: BigInt(publicSignals[0]!),
      deckHash,
      phase: Number(state.phase),
      showdownSubmitterPlayerIndex: submitterPlayerIndex,
      showdownProveMs: proveMs,
    };
    } finally {
      console.timeEnd('timing:hand');
      await finishHandCost(this.provider, 'poker', this.bettingTable?.players ?? []);
      if (this.bettingTable) {
        await releaseDevnetSession({
          provider: this.provider,
          room: this.bettingTable.room,
          tableId: this.bettingTable.tableId,
          gameId: this.bettingTable.gameId,
          players: this.bettingTable.players,
          refundSeatRent: () => this.lifecycle.refundSeatRent(this.bettingTable.players),
          reclaimComputations: () => this.arcium.reclaimFinalizedComputations(),
          closeLightSession: (dest) => this.lifecycle.closeLightSession(this.bettingTable.players.length, dest),
        });
      }
    }
  }

  /** Backward-compatible two-player entrypoint. */
  async runComplete2PlayerHand(): Promise<ContinuousHandResult> {
    if (this.numPlayers !== 2) {
      throw new Error(`runComplete2PlayerHand requires numPlayers=2, got ${this.numPlayers}`);
    }
    return this.runCompleteHand();
  }
}

export { MAX_PLAYERS };
