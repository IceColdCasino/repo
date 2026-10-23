import { createHash } from 'node:crypto';
import { BN, Program, type AnchorProvider, web3 } from '@coral-xyz/anchor';
import { fieldToBytesBE, proofToBytes, publicSignalsToBytes } from '../groth16-convert';
import { readShuffleProof, SHUFFLE_PROOF_PUBLIC_SIGNALS } from '../shuffle-signals';
import type { Ciphertext } from '../zk-casino';
import {
  GameKind,
  bingoCalledBalls,
  gameKindNeedsHouseSeat,
  maxTableSeats,
  normalizeGameConfig,
  revealCardCount,
} from '../game-config';
import { usedCardIndices } from '../backend/card-layout';
import { logHandProgress } from '../hand-progress';
import { mapPool, withRetry } from '../arcium/verify-chunk-parallel';
import { LightProtocolStorageHelper } from './light-storage';
import {
  deckStateAccountSize,
  describeShuffleBuffer,
  shuffleBufferFilled,
  preparedCountOffset,
  shuffleInputsAccountSize,
  EIGHT_DECK_CALLER_INPUTS,
  MAX_CPI_ALLOC,
} from './shuffle-account';
import { confirmOrResend, installDurableConfirm } from './confirm-tx';
import {
  CLOSE_PLAYER_STATE,
  CLOSE_SEAT_RENT,
  CLOSE_SHARE_RECEIPT,
  casinoVaultRemaining,
  clusterRentLamportsPerByte,
  leadingVaultMeta,
  prependVault,
  depositRentVault,
  drawStagedRent,
  frontExtendFromVault,
  frontFromVault,
  rentVaultFor,
  rentVaultPda,
  SHUFFLE_CHUNK_ACCOUNT_SIZE,
  SHUFFLE_LANES_PER_TX,
  shuffleLanePlan,
} from './rent-vault';
import { loadWhitelistAdminProvider } from './admin-provider';
import { isLocalCluster, rentExemptLamports } from './fund-sol';
import { CASINO_PLAYER_STATE_DATA, LIGHT_PLAYER_STATE_DATA, LIGHT_GAME_STATE_DATA, CASINO_GAME_STATE_DATA } from './table-float';
import { KeypairWallet } from './keypair-wallet';

const TOTAL_POKER_CARDS = 25;
const SHUFFLE_PUBLIC_INPUTS_PER_WRITE = 8;
const SHUFFLE_DECK_FIELDS_PER_WRITE = 8;
/**
 * Max flattened deck fields (8 × 52 × 4). Matches on-chain
 * `deck_state::SHUFFLE_DECK_FIELDS` / `shared_zk_ids::MAX_DECK_FIELDS`.
 */
export const SHUFFLE_DECK_FIELDS = 8 * 52 * 4;
/** Poker single-deck active cards (parsed from the front of `deck_state`). */
const SHUFFLE_DECK_CARDS = 52;
const FIELDS_PER_CARD = 4;
/** Matches on-chain `deck_state::DECK_STATE_ACCOUNT_SIZE`. */
export const DECK_STATE_ACCOUNT_SIZE = 8 + SHUFFLE_DECK_FIELDS * 32;
/** Must match on-chain `PREPARE_INPUTS_PER_TX` (16 × BN254 mul/add per tx). */
const PREPARE_INPUTS_PER_TX = 16;
/** 8-deck ceiling. Live accounts use `shuffleInputsAccountSize` for the table shoe. */
export const SHUFFLE_INPUTS_ACCOUNT_SIZE = shuffleInputsAccountSize(EIGHT_DECK_CALLER_INPUTS);
/** Parallel random-access shuffle staging writes (fill-mask). Read at call time. */
function shuffleWriteConcurrency(): number {
  return Math.max(1, Number(process.env.SHUFFLE_WRITE_CONCURRENCY ?? '16'));
}
/** Parallel MSM prepare chunks (disjoint G1 partials). Read at call time. */
function shufflePrepareConcurrency(): number {
  return Math.max(1, Number(process.env.SHUFFLE_PREPARE_CONCURRENCY ?? '16'));
}
/** Roulette share staging: header + 579×32 + G1 + fill/prepare masks + partials. */
const ROULETTE_SHARE_PUBLIC_INPUTS = 579;
const ROULETTE_BET_LIMBS = 576;
const SHARE_STAGING_HEADER_SIZE = 8 + 32 + 8 + 1 + 2;
/** Matches on-chain `share_staging::FILL_MASK_BYTES` (ceil(579/8)). */
const SHARE_FILL_MASK_BYTES = Math.ceil(ROULETTE_SHARE_PUBLIC_INPUTS / 8);
/** Matches on-chain `share_staging::MAX_PREPARE_CHUNKS` = ceil(579/16) = 37. */
const SHARE_MAX_PREPARE_CHUNKS = Math.ceil(
  ROULETTE_SHARE_PUBLIC_INPUTS / PREPARE_INPUTS_PER_TX,
);
const SHARE_PREPARE_MASK_BYTES = Math.ceil(SHARE_MAX_PREPARE_CHUNKS / 8);
const SHARE_PREPARED_COUNT_OFFSET =
  SHARE_STAGING_HEADER_SIZE + 32 * ROULETTE_SHARE_PUBLIC_INPUTS + 64;
/** Matches on-chain `share_staging::SHARE_STAGING_ACCOUNT_SIZE`. */
const SHARE_STAGING_ACCOUNT_SIZE =
  SHARE_PREPARED_COUNT_OFFSET +
  2 +
  SHARE_FILL_MASK_BYTES +
  SHARE_PREPARE_MASK_BYTES +
  SHARE_MAX_PREPARE_CHUNKS * 64;
const SHARE_PUBLIC_INPUTS_PER_WRITE = 8;
/** Parallel random-access share staging writes (fill-mask). Read at call time. */
function shareWriteConcurrency(): number {
  return Math.max(1, Number(process.env.SHARE_WRITE_CONCURRENCY ?? '16'));
}
/** Parallel MSM prepare chunks for share staging. Read at call time. */
function sharePrepareConcurrency(): number {
  return Math.max(1, Number(process.env.SHARE_PREPARE_CONCURRENCY ?? '16'));
}
/** Final pairing + hash checks; Light uniqueness CPI adds ~100k CU to shuffle. */
const GROTH16_VERIFY_CU = 600_000;
/**
 * Prepare-chunk folds 16 IC mul/adds into a private partial (~cheap).
 * Finalize sums partials + re-derives Poseidon input hash once — needs the
 * higher CU budget (especially player>0 over a full shoe).
 */
const PREPARE_SHUFFLE_CHUNK_CU = 400_000;
const FINALIZE_PREPARE_SHUFFLE_CU = 1_400_000;
/** Share prepare / showdown still use the higher budget. */
const PREPARE_SHUFFLE_CU = FINALIZE_PREPARE_SHUFFLE_CU;

/** Decode a 32-byte big-endian field element. */
export function bytesToFieldBE(bytes: Uint8Array | Buffer): bigint {
  if (bytes.length !== 32) {
    throw new Error(`field element must be 32 bytes, got ${bytes.length}`);
  }
  let v = 0n;
  for (let i = 0; i < 32; i++) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}

/**
 * Parse light-casino `deck_state` account bytes into ElGamal ciphertexts.
 * Account is allocated at max shoe size; callers pass the active card count
 * (poker/roulette 52/37/38, baccarat/war/bj `shoeDecks * 52`).
 */
export function parseDeckStateAccount(
  data: Uint8Array | Buffer,
  nCards: number = SHUFFLE_DECK_CARDS,
): Ciphertext[] {
  const need = deckStateAccountSize(nCards * FIELDS_PER_CARD);
  if (data.length < need) {
    throw new Error(`deck_state too short: ${data.length} < ${need}`);
  }
  if (!Number.isInteger(nCards) || nCards < 1 || nCards * FIELDS_PER_CARD > SHUFFLE_DECK_FIELDS) {
    throw new Error(`invalid deck card count ${nCards}`);
  }
  const deck: Ciphertext[] = [];
  for (let card = 0; card < nCards; card++) {
    const limbs: bigint[] = [];
    for (let k = 0; k < FIELDS_PER_CARD; k++) {
      const fieldIndex = card * FIELDS_PER_CARD + k;
      const start = 8 + fieldIndex * 32;
      limbs.push(bytesToFieldBE(data.subarray(start, start + 32)));
    }
    deck.push(limbs as Ciphertext);
  }
  return deck;
}

/** Active shoe cards from light `GameState` (poker=52; casino=`shoeDecks*52`). */
export function shoeCardsFromGameState(gameState: {
  gameKind?: number;
  shoeDecks?: number;
  rouletteVariant?: number;
}): number {
  const kind = Number(gameState.gameKind ?? 0);
  if (kind === GameKind.Roulette) {
    const variant = Number(gameState.rouletteVariant ?? 37);
    return variant === 38 ? 38 : 37;
  }
  if (kind === GameKind.Poker) return 52;
  if (kind === GameKind.Craps) return 12;
  if (kind === GameKind.Keno) return 80;
  if (kind === GameKind.Slots) {
    const reels = Number(gameState.rouletteVariant ?? 3);
    return (reels === 5 ? 5 : 3) * 22;
  }
  if (kind === GameKind.Bingo) {
    const variant = Number(gameState.rouletteVariant ?? 75);
    return variant === 90 ? 90 : 75;
  }
  const decks = Number(gameState.shoeDecks ?? 6);
  return decks * 52;
}

/** Compact RevealedCard PDA indices (`0..n-1`). Shoe centers use `shareDealCardIndices`. */
export function showdownCardIndicesForGame(
  gameKind: number,
  numPlayers: number,
  showdownCards?: number,
): number[] {
  switch (gameKind) {
    case GameKind.Roulette:
      return [0];
    case GameKind.War:
      return [0, 1, 2, 3];
    case GameKind.Baccarat:
      return [0, 1, 2, 3, 4, 5];
    case GameKind.Craps:
      return [0, 1];
    case GameKind.Keno:
      return Array.from({ length: 20 }, (_, i) => i);
    case GameKind.Slots:
      return Array.from({ length: showdownCards ?? 3 }, (_, i) => i);
    case GameKind.Bingo:
      return Array.from({ length: showdownCards ?? 5 }, (_, i) => i);
    case GameKind.Blackjack:
      // Material sync covers the full 24-card window; verify_showdown_receipt
      // overrides with used layout sources only (tx size).
      return Array.from({ length: 24 }, (_, i) => i);
    default:
      return usedCardIndices(numPlayers);
  }
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  console.time(label);
  try {
    return await work();
  } finally {
    console.timeEnd(label);
  }
}

function verifyBudgetIxs(): web3.TransactionInstruction[] {
  return [
    web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: GROTH16_VERIFY_CU }),
  ];
}

/** Showdown re-derives Poseidon over 9×100 limb rows then Groth16 — needs max CU. */
function showdownVerifyBudgetIxs(): web3.TransactionInstruction[] {
  return [
    web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: PREPARE_SHUFFLE_CU }),
  ];
}

function prepareShuffleChunkBudgetIxs(): web3.TransactionInstruction[] {
  return [
    web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: PREPARE_SHUFFLE_CHUNK_CU }),
  ];
}

function finalizePrepareShuffleBudgetIxs(): web3.TransactionInstruction[] {
  return [
    web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: FINALIZE_PREPARE_SHUFFLE_CU }),
  ];
}

function prepareShuffleBudgetIxs(): web3.TransactionInstruction[] {
  return [
    web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: PREPARE_SHUFFLE_CU }),
  ];
}

function flattenPublicInputsChunk(inputs: number[][]): Buffer {
  return Buffer.from(inputs.flat());
}

function ixDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function errorText(error: unknown): string {
  const err = error as { message?: string; logs?: string[] };
  return [err?.message, ...(err?.logs ?? [])].join('\n');
}

/**
 * Chunks copied into the shuffle buffer by one transaction. Each chunk is one
 * account key. With the heap and compute-budget instructions, a 1232-byte
 * packet fits 26 beside the authority, game, player, buffer, and vault.
 * The instruction writes that chunk's fields and its MSM partial together.
 */
const SHUFFLE_ABSORB_PER_TX = 26;

function deckFieldBytes(deck: bigint[][]): Buffer {
  const fields = deck.flatMap(card => card.map(coord => coord));
  return flattenPublicInputsChunk(publicSignalsToBytes(fields));
}

/** Solana legacy transaction size limit. At or under this, the sender logs once. */
export const LEGACY_TX_BYTES = 1232;

export function senderLogsTxSize(legacySize: number): boolean {
  return legacySize <= LEGACY_TX_BYTES;
}

export class OnchainGameLifecycle {
  private cpiAuthorityReady = false;
  /** When false, verify/register omit poker CPI bridge accounts (light-only). */
  private pokerBridgeEnabled: boolean;
  /** `deck_state` allocation started once the light game exists. */
  private deckWarm: Promise<void> | null = null;
  /** Shuffle buffer allocation started once the phase is Shuffle. */
  private shuffleWarm: Promise<void> | null = null;
  /** Lane dust returning to the seat vault. The next fund waits for it. */
  private pendingShuffleSweep: Promise<void> = Promise.resolve();
  /** Lookup tables opened for oversized transactions. Closed back into the float. */
  private openLookupTables: { address: web3.PublicKey; authority?: web3.Keypair }[] = [];

  constructor(
    private lightPokerProgram: Program,
    private provider: AnchorProvider,
    private gameId: Uint8Array,
    private pokerProgram?: Program,
    options?: { pokerBridge?: boolean },
  ) {
    installDurableConfirm(provider.connection);
    // Default: enable bridge only when a poker program is provided.
    this.pokerBridgeEnabled = options?.pokerBridge ?? !!pokerProgram;
  }

  /**
   * Anchor's legacy 30-second confirmation path can time out on a busy localnet
   * even when the transaction landed successfully. Recover only when RPC proves
   * that exact signature succeeded; real transaction errors still propagate.
   */
  private async rpcProcessed(builder: any): Promise<string> {
    try {
      return await builder.rpc({
        commitment: 'processed',
        preflightCommitment: 'processed',
      });
    } catch (error: any) {
      const signature = typeof error?.signature === 'string' ? error.signature : '';
      if (!signature) throw error;
      for (let attempt = 0; attempt < 50; attempt++) {
        const { value } = await this.provider.connection.getSignatureStatuses(
          [signature],
          { searchTransactionHistory: true },
        );
        const status = value[0];
        if (status?.err) throw error;
        // Only treat as success once the cluster reports a real confirmation
        // level — `confirmations !== null` alone is true for dropped txs and
        // caused false recoveries that skipped PDA init under 10p load.
        if (
          status?.confirmationStatus === 'processed'
          || status?.confirmationStatus === 'confirmed'
          || status?.confirmationStatus === 'finalized'
        ) {
          console.warn(`[rpc] recovered confirmed signature ${signature}`);
          return signature;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw error;
    }
  }

  private async waitForConfirmedAccount(
    pda: web3.PublicKey,
    label: string,
    commitment: web3.Commitment = 'confirmed',
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await this.provider.connection.getAccountInfo(pda, commitment)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label} not visible at ${commitment} commitment: ${pda.toBase58()}`);
  }

  private async rpcAuthorityPaid(
    builder: any,
    authority: web3.Keypair,
    sizeLabel?: string,
    mutate?: (transaction: web3.Transaction) => void,
    commitment: web3.Commitment = 'confirmed',
    preflight: web3.Commitment = commitment,
    pollMs?: number,
  ): Promise<string> {
    return confirmOrResend(this.provider.connection, async (latest, attempt) => {
      const transaction = await builder.transaction();
      mutate?.(transaction);
      transaction.feePayer = authority.publicKey;
      transaction.recentBlockhash = latest.blockhash;
      transaction.sign(authority);
      const serialized = transaction.serialize();
      if (sizeLabel && attempt === 0) {
        console.log(`[tx-size] ${sizeLabel}: ${serialized.length} bytes`);
      }
      return this.provider.connection.sendRawTransaction(serialized, {
        preflightCommitment: preflight,
      });
    }, commitment, undefined, pollMs);
  }

  /** Casino remaining-account metas for this seat's rent vault. */
  seatVaultRemaining(player: web3.PublicKey): web3.AccountMeta[] {
    if (!this.pokerProgram) return [];
    return casinoVaultRemaining(player, this.pokerProgram.programId);
  }

  /**
   * Close the hand-scoped accounts the vault paid for. Light player state and
   * the casino MPC key, share accumulator, showdown material, and pending deposit
   * all return their rent to that vault.
   */
  async refundSeatRent(players: web3.Keypair[]): Promise<void> {
    if (!this.pokerProgram) return;
    await this.closeOpenLookupTables();
    await this.closeDeckState(players[0]);
    const gameState = this.derivePokerPDA('game_state');
    const state = await (this.pokerProgram.account as any).gameState.fetch(gameState);
    const roomId = Buffer.from(state.tableRoomId ?? state.table_room_id);
    const tableId = Buffer.alloc(8);
    tableId.writeBigUInt64LE(BigInt((state.tableId ?? state.table_id ?? 0).toString()));
    const tableState = web3.PublicKey.findProgramAddressSync(
      [Buffer.from('table'), roomId, tableId],
      this.pokerProgram.programId,
    )[0];
    for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
      const player = players[playerIndex]!;
      const vault = rentVaultPda(new Uint8Array(roomId), player.publicKey);
      if (!(await this.provider.connection.getAccountInfo(vault, 'confirmed'))) continue;
      await this.closeLightPlayerState(player, playerIndex, vault);
      await this.closeCasinoSeatRent(player, playerIndex, gameState, tableState, vault, roomId);
    }
  }

  /**
   * Return the consumed share receipt after `finalize_share_phase` has read it.
   * The generation is the share-verify accumulator's current generation.
   */
  async closeShareReceipts(players: web3.Keypair[]): Promise<void> {
    if (!this.pokerProgram) return;
    const gameState = this.derivePokerPDA('game_state');
    const state = await (this.pokerProgram.account as any).gameState.fetch(gameState);
    const roomId = Buffer.from(state.tableRoomId ?? state.table_room_id);
    for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
      const player = players[playerIndex]!;
      const vault = rentVaultPda(new Uint8Array(roomId), player.publicKey);
      if (!(await this.provider.connection.getAccountInfo(vault, 'confirmed'))) continue;
      const shareAcc = this.derivePokerPDA('share_verify_acc', Buffer.from([playerIndex]));
      const acc = await (this.pokerProgram.account as any).shareVerifyAccumulator.fetch(shareAcc);
      const receipt = this.deriveShareProofReceipt(playerIndex, acc.generation);
      if (!(await this.provider.connection.getAccountInfo(receipt, 'confirmed'))) continue;
      const data = Buffer.alloc(17);
      CLOSE_SHARE_RECEIPT.copy(data, 0);
      data.writeUInt8(playerIndex, 8);
      data.writeBigUInt64LE(BigInt(acc.generation.toString()), 9);
      await this.sendSeatIx(player, new web3.TransactionInstruction({
        programId: this.lightPokerProgram.programId,
        keys: [
          { pubkey: player.publicKey, isSigner: true, isWritable: true },
          { pubkey: this.deriveLightPDA('player', Buffer.from([playerIndex])), isSigner: false, isWritable: false },
          { pubkey: receipt, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
        ],
        data,
      }));
    }
  }

  private async closeLightPlayerState(
    player: web3.Keypair,
    playerIndex: number,
    vault: web3.PublicKey,
  ): Promise<void> {
    const playerState = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    if (!(await this.provider.connection.getAccountInfo(playerState, 'confirmed'))) return;
    const keys = [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.deriveLightPDA('game_state'), isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: this.derivePokerPDA('game_state'), isSigner: false, isWritable: false },
    ];
    const shareInputs = this.deriveLightPDA('share_inputs', Buffer.from([playerIndex]));
    const shareInfo = await this.provider.connection.getAccountInfo(shareInputs, 'processed');
    if (shareInfo && shareInfo.owner.equals(this.lightPokerProgram.programId) && shareInfo.data.length > 0) {
      keys.push({ pubkey: shareInputs, isSigner: false, isWritable: true });
    }
    await this.sendSeatIx(player, new web3.TransactionInstruction({
      programId: this.lightPokerProgram.programId,
      keys,
      data: CLOSE_PLAYER_STATE,
    }));
  }

  private async closeCasinoSeatRent(
    player: web3.Keypair,
    playerIndex: number,
    gameState: web3.PublicKey,
    tableState: web3.PublicKey,
    vault: web3.PublicKey,
    roomId: Buffer,
  ): Promise<void> {
    const programId = this.pokerProgram!.programId;
    const generation = Buffer.alloc(8);
    const mpcKey = web3.PublicKey.findProgramAddressSync([
      Buffer.from('player_mpc_key'),
      Buffer.from(this.gameId),
      Buffer.from([playerIndex]),
      Buffer.from([1]),
      generation,
    ], programId)[0];
    const shareAcc = web3.PublicKey.findProgramAddressSync([
      Buffer.from('share_verify_acc'),
      Buffer.from(this.gameId),
      Buffer.from([playerIndex]),
    ], programId)[0];
    const showdownMaterial = web3.PublicKey.findProgramAddressSync([
      Buffer.from('showdown_material'),
      Buffer.from(this.gameId),
      generation,
      Buffer.from([playerIndex]),
    ], programId)[0];
    const pendingDeposit = web3.PublicKey.findProgramAddressSync([
      Buffer.from('pending_deposit'),
      player.publicKey.toBuffer(),
      roomId,
    ], programId)[0];
    const showdownInfo = await this.provider.connection.getAccountInfo(showdownMaterial, 'confirmed');
    const pendingInfo = await this.provider.connection.getAccountInfo(pendingDeposit, 'confirmed');
    const data = Buffer.alloc(26);
    CLOSE_SEAT_RENT.copy(data, 0);
    data.writeUInt8(playerIndex, 8);
    data.writeUInt8(1, 9);
    data.writeBigUInt64LE(0n, 10);
    data.writeBigUInt64LE(0n, 18);
    await this.sendSeatIx(player, new web3.TransactionInstruction({
      programId,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: gameState, isSigner: false, isWritable: false },
        { pubkey: tableState, isSigner: false, isWritable: false },
        { pubkey: mpcKey, isSigner: false, isWritable: true },
        { pubkey: shareAcc, isSigner: false, isWritable: true },
        showdownInfo
          ? { pubkey: showdownMaterial, isSigner: false, isWritable: true }
          : { pubkey: programId, isSigner: false, isWritable: false },
        pendingInfo
          ? { pubkey: pendingDeposit, isSigner: false, isWritable: true }
          : { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
      ],
      data,
    }));
  }

  private async sendSeatIx(player: web3.Keypair, ix: web3.TransactionInstruction): Promise<void> {
    await confirmOrResend(this.provider.connection, async (latest) => {
      const tx = new web3.Transaction({
        feePayer: this.provider.wallet.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(ix);
      if (!player.publicKey.equals(this.provider.wallet.publicKey)) tx.partialSign(player);
      const signed = await this.provider.wallet.signTransaction(tx);
      return this.provider.connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: 'confirmed',
      });
    });
  }

  /** Signer for player_state.authority-gated IXs (defaults to provider wallet). */
  private authorityPubkey(authority?: web3.Keypair): web3.PublicKey {
    return authority?.publicKey ?? this.provider.wallet.publicKey;
  }

  /** Send with seat authority as fee payer when provided; else provider wallet. */
  private async rpcAs(
    builder: any,
    authority?: web3.Keypair,
    sizeLabel?: string,
    commitment: web3.Commitment = 'confirmed',
  ): Promise<string> {
    if (!authority) return this.rpcProcessed(builder);
    return this.rpcAuthorityPaid(builder, authority, sizeLabel, undefined, commitment);
  }

  /** Several instructions, one signature. Used when they share one writable account. */
  private async rpcAuthorityInstructions(
    instructions: web3.TransactionInstruction[],
    authority: web3.Keypair | undefined,
    commitment: web3.Commitment,
  ): Promise<string> {
    const signer = this.authorityPubkey(authority);
    if (authority) {
      return confirmOrResend(this.provider.connection, async (latest) => {
        const transaction = new web3.Transaction({
          feePayer: signer,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        }).add(...instructions);
        transaction.sign(authority);
        return this.provider.connection.sendRawTransaction(transaction.serialize(), {
          preflightCommitment: commitment,
        });
      }, commitment);
    }
    const latest = await this.provider.connection.getLatestBlockhash(commitment);
    const transaction = new web3.Transaction({
      feePayer: signer,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(...instructions);
    return this.provider.sendAndConfirm(transaction, [], { commitment });
  }

  /**
   * Legacy tx when it fits; otherwise a v0 tx with an ephemeral ALT for
   * remaining-account pubkeys (keno showdown is 1442 bytes without a LUT).
   */
  private async rpcAsOrLookupTable(
    builder: any,
    authority: web3.Keypair | undefined,
    lutAddresses: web3.PublicKey[],
    sizeLabel?: string,
    mutate?: (transaction: web3.Transaction) => void,
  ): Promise<string> {
    const signer = this.authorityPubkey(authority);
    const legacy = await builder.transaction();
    mutate?.(legacy);
    legacy.feePayer = signer;
    const latest = await this.provider.connection.getLatestBlockhash('confirmed');
    legacy.recentBlockhash = latest.blockhash;
    let legacySize = 0;
    try {
      legacySize = legacy.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }).length;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!message.includes('Transaction too large')) throw error;
      legacySize = 2048;
    }
    // The legacy sender logs the signed size. Logging here too printed every
    // bingo showdown row twice (591 bytes, then 591 bytes again).
    if (senderLogsTxSize(legacySize)) {
      return authority
        ? this.rpcAuthorityPaid(builder, authority, sizeLabel, mutate)
        : this.rpcAs(builder, authority, sizeLabel);
    }
    if (sizeLabel) {
      console.log(`[tx-size] ${sizeLabel}: ${legacySize} bytes`);
    }
    const discovered = legacy.instructions.flatMap((ix) => [
      ix.programId,
      ...ix.keys.map((meta) => meta.pubkey),
    ]);
    const lookupKeys = [
      ...new Map(
        [...lutAddresses, ...discovered].map((key) => [key.toBase58(), key]),
      ).values(),
    ];
    console.log(
      `[tx-size] ${sizeLabel ?? 'ix'} using ALT (${lookupKeys.length} lookup keys)`,
    );
    const lut = await this.createEphemeralLookupTable(lookupKeys, authority);
    this.openLookupTables.push({ address: lut.key, authority });
    const signature = await confirmOrResend(this.provider.connection, async (fresh) => {
      const message = new web3.TransactionMessage({
        payerKey: signer,
        recentBlockhash: fresh.blockhash,
        instructions: legacy.instructions,
      }).compileToV0Message([lut]);
      const vtx = new web3.VersionedTransaction(message);
      const signed = authority
        ? (vtx.sign([authority]), vtx)
        : await this.provider.wallet.signTransaction(vtx);
      return this.provider.connection.sendTransaction(signed, {
        preflightCommitment: 'confirmed',
      });
    });
    void this.deactivateLookupTable(lut.key, authority).catch(() => undefined);
    return signature;
  }

  private async createEphemeralLookupTable(
    addresses: web3.PublicKey[],
    authority?: web3.Keypair,
  ): Promise<web3.AddressLookupTableAccount> {
    const payerKey = this.authorityPubkey(authority);
    const unique = [
      ...new Map(addresses.map((key) => [key.toBase58(), key])).values(),
    ].filter((key) => !key.equals(web3.SystemProgram.programId));
    await frontFromVault(
      this.provider,
      payerKey,
      56 + 32 * unique.length,
      0,
      authority,
    );
    const sendPaid = async (ixs: web3.TransactionInstruction[]) => {
      await confirmOrResend(this.provider.connection, async (latest) => {
        const tx = new web3.Transaction({
          feePayer: payerKey,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        }).add(...ixs);
        if (authority) {
          tx.sign(authority);
          return this.provider.connection.sendRawTransaction(tx.serialize(), {
            preflightCommitment: 'confirmed',
          });
        }
        const signed = await this.provider.wallet.signTransaction(tx);
        return this.provider.connection.sendRawTransaction(signed.serialize(), {
          preflightCommitment: 'confirmed',
        });
      });
    };
    // CreateLookupTable accepts only a slot already in SlotHashes (about the
    // last 512). The processed tip is often too new, and a slot from another
    // RPC is often too old for the node that simulates this transaction.
    const tip = await this.provider.connection.getSlot('processed');
    const blocks = await this.provider.connection.getBlocks(
      Math.max(0, tip - 450),
      Math.max(0, tip - 20),
    );
    const candidates = blocks.slice(-8).reverse();
    if (candidates.length === 0) {
      throw new Error(`no recent slot for a lookup table near ${tip}`);
    }
    let lutAddress!: web3.PublicKey;
    let created = false;
    let lastError: unknown;
    for (const slot of candidates) {
      const [createIx, address] = web3.AddressLookupTableProgram.createLookupTable({
        authority: payerKey,
        payer: payerKey,
        recentSlot: slot,
      });
      lutAddress = address;
      try {
        await sendPaid([createIx]);
        created = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!created) throw lastError;
    for (let i = 0; i < unique.length; i += 20) {
      await sendPaid([
        web3.AddressLookupTableProgram.extendLookupTable({
          payer: payerKey,
          authority: payerKey,
          lookupTable: lutAddress,
          addresses: unique.slice(i, i + 20),
        }),
      ]);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      const acc = await this.provider.connection.getAddressLookupTable(lutAddress);
      const slot = await this.provider.connection.getSlot('confirmed');
      if (
        acc.value
        && acc.value.state.addresses.length >= unique.length
        && slot > Number(acc.value.state.lastExtendedSlot)
      ) {
        return acc.value;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`lookup table not ready: ${lutAddress.toBase58()}`);
  }

  private async deactivateLookupTable(
    lookupTable: web3.PublicKey,
    authority?: web3.Keypair,
  ): Promise<void> {
    const authorityKey = this.authorityPubkey(authority);
    const ix = web3.AddressLookupTableProgram.deactivateLookupTable({
      authority: authorityKey,
      lookupTable,
    });
    await this.sendPayers(
      [ix],
      authorityKey,
      authority ? [authority] : [],
      !authority,
      'processed',
    );
  }

  /** Return lookup-table rent to the float once the deactivation cooldown has passed. */
  private async closeOpenLookupTables(): Promise<void> {
    const pending = this.openLookupTables.splice(0);
    for (const table of pending) {
      const authorityKey = this.authorityPubkey(table.authority);
      const vault = rentVaultFor(authorityKey) ?? rentVaultFor(this.provider.wallet.publicKey);
      const recipient = vault ?? authorityKey;
      try {
        await this.deactivateLookupTable(table.address, table.authority);
      } catch {
        /* already deactivated */
      }
      try {
        await this.sendPayers(
          [
            web3.AddressLookupTableProgram.closeLookupTable({
              authority: authorityKey,
              lookupTable: table.address,
              recipient,
            }),
          ],
          authorityKey,
          table.authority ? [table.authority] : [],
          !table.authority,
          'processed',
        );
      } catch {
        this.openLookupTables.push(table);
      }
    }
  }

  setPokerBridgeEnabled(enabled: boolean): void {
    this.pokerBridgeEnabled = enabled;
  }

  private derivePDA(program: Program, seed: string, extra?: Buffer): web3.PublicKey {
    const seeds: Buffer[] = [Buffer.from(seed), Buffer.from(Array.from(this.gameId))];
    if (extra) seeds.push(extra);
    return web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  }

  private deriveLightPDA(seed: string, extra?: Buffer): web3.PublicKey {
    return this.derivePDA(this.lightPokerProgram, seed, extra);
  }

  private derivePokerPDA(seed: string, extra?: Buffer): web3.PublicKey {
    if (!this.pokerProgram) throw new Error('pokerProgram is required for poker PDA derivation');
    return this.derivePDA(this.pokerProgram, seed, extra);
  }

  /** Matches light-casino `PROOF_RECEIPT_V2_SEED` + generation + phase + player. */
  private deriveProofReceiptV2(
    phase: number,
    playerIndex: number,
    mpcGeneration: bigint | number = 0,
  ): web3.PublicKey {
    const generation = new BN(mpcGeneration.toString()).toArrayLike(Buffer, 'le', 8);
    return web3.PublicKey.findProgramAddressSync([
      Buffer.from('proof_receipt_v2'),
      Buffer.from(Array.from(this.gameId)),
      generation,
      Buffer.from([phase]),
      Buffer.from([playerIndex]),
    ], this.lightPokerProgram.programId)[0];
  }

  /**
   * Proof-receipt PDA for register/shuffle/showdown/action.
   * Uses light game_state.generation when available (defaults to 0).
   */
  private async deriveProofReceipt(
    phase: number,
    playerIndex: number,
  ): Promise<web3.PublicKey> {
    let generation: bigint | number = 0;
    try {
      const gameStatePDA = this.deriveLightPDA('game_state');
      const gs = await (this.lightPokerProgram.account as any).gameState.fetch(gameStatePDA);
      if (gs?.generation != null) generation = gs.generation;
    } catch {
      /* new game / not initialized yet — generation 0 */
    }
    return this.deriveProofReceiptV2(phase, playerIndex, generation);
  }

  private deriveShareProofReceipt(playerIndex: number, mpcGeneration: bigint | number): web3.PublicKey {
    // PROOF_PHASE_SHARE = 2
    return this.deriveProofReceiptV2(2, playerIndex, mpcGeneration);
  }

  private async deriveActionProofReceipt(
    playerIndex: number,
    actionSeq: number,
  ): Promise<web3.PublicKey> {
    const gameState = await this.fetchLightGameState(this.deriveLightPDA('game_state'));
    const generation = new BN(gameState.generation.toString()).toArrayLike(Buffer, 'le', 8);
    const seq = Buffer.alloc(2);
    seq.writeUInt16LE(actionSeq);
    return web3.PublicKey.findProgramAddressSync([
      Buffer.from('proof_receipt_v2'),
      Buffer.from(this.gameId),
      generation,
      Buffer.from([4]),
      Buffer.from([playerIndex]),
      seq,
    ], this.lightPokerProgram.programId)[0];
  }

  /** light-casino PDA that signs poker `consume_*` CPIs. */
  deriveCpiAuthority(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('cpi_authority')],
      this.lightPokerProgram.programId,
    )[0];
  }

  async initCpiAuthority(numPlayers = 2): Promise<web3.PublicKey> {
    const cpiAuthority = this.deriveCpiAuthority();
    const info = await this.provider.connection.getAccountInfo(cpiAuthority);
    // Program-owned stub (from init_cpi_authority) cannot pay SystemProgram creates
    // ("Transfer: from must not carry data"). Close it, then fund as a bare system account.
    if (info && info.data.length > 0) {
      await (this.lightPokerProgram.methods as any)
        .closeCpiAuthority()
        .accounts({
          payer: this.provider.wallet.publicKey,
          cpiAuthority,
        })
        .rpc({ commitment: 'processed', preflightCommitment: 'processed' });
    }
    // The float pre-funds this authority with each seat's player-state rent.
    // The account stays system-owned (no data) so it can pay SystemProgram creates.
    const rate = await clusterRentLamportsPerByte(this.provider.connection);
    const playerStateRent = rentExemptLamports(LIGHT_PLAYER_STATE_DATA, rate)
      + rentExemptLamports(CASINO_PLAYER_STATE_DATA, rate);
    const minLamports = rentExemptLamports(0, rate) + numPlayers * playerStateRent;
    const after = await this.provider.connection.getAccountInfo(cpiAuthority);
    const balance = after?.lamports ?? 0;
    if (balance < minLamports) {
      await drawStagedRent(
        this.provider,
        this.provider.wallet.publicKey,
        this.provider.wallet.publicKey,
        minLamports - balance,
      );
      const tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: this.provider.wallet.publicKey,
          toPubkey: cpiAuthority,
          lamports: minLamports - balance,
        }),
      );
      await this.provider.sendAndConfirm(tx);
    }
    this.cpiAuthorityReady = true;
    return cpiAuthority;
  }

  /**
   * Optional poker CPI bridge accounts for verify/register when `pokerProgram` is set.
   * Omit for light-only flows (registration-shuffle E2E).
   */
  private pokerBridgeAccounts(playerIndex?: number): Record<string, web3.PublicKey | null> {
    if (!this.pokerProgram || !this.pokerBridgeEnabled) {
      return {
        pokerProgram: null,
        cpiAuthority: null,
        pokerGameState: null,
        pokerPlayerState: null,
      };
    }
    const accounts: Record<string, web3.PublicKey | null> = {
      pokerProgram: this.pokerProgram.programId,
      cpiAuthority: this.deriveCpiAuthority(),
      pokerGameState: this.derivePokerPDA('game_state'),
      pokerPlayerState: null,
    };
    if (playerIndex !== undefined) {
      accounts.pokerPlayerState = this.derivePokerPDA('player', Buffer.from([playerIndex]));
    }
    return accounts;
  }

  async initializeGame(
    numPlayers: number,
    gameKind = 0,
    shoeDecks = 1,
    rouletteVariant = 0,
    dealerIndex = 255,
  ): Promise<web3.PublicKey> {
    const pda = this.deriveLightPDA('game_state');
    // 0 = standalone, 1 = Casino CPI required on proof finalize.
    const bridgeMode = this.pokerBridgeEnabled ? 1 : 0;
    const rate = await clusterRentLamportsPerByte(this.provider.connection);
    await drawStagedRent(
      this.provider,
      this.provider.wallet.publicKey,
      this.provider.wallet.publicKey,
      rentExemptLamports(LIGHT_GAME_STATE_DATA, rate),
    );
    await this.lightPokerProgram.methods
      .initializeGame!(
        Array.from(this.gameId) as any,
        numPlayers,
        gameKind,
        shoeDecks,
        rouletteVariant,
        dealerIndex,
        bridgeMode,
      )
      .accounts({
        payer: this.provider.wallet.publicKey,
        gameState: pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc({ commitment: 'processed', preflightCommitment: 'processed' });
    return pda;
  }

  async initializePokerGame(
    numPlayers: number,
    numCards: number = TOTAL_POKER_CARDS,
  ): Promise<web3.PublicKey> {
    if (!this.pokerProgram) throw new Error('pokerProgram is required to initialize poker game');
    const pda = this.derivePokerPDA('game_state');
    const payer = await this.gameAuthority();
    const rate = await clusterRentLamportsPerByte(this.provider.connection);
    await drawStagedRent(
      this.provider,
      this.provider.wallet.publicKey,
      payer.publicKey,
      rentExemptLamports(CASINO_GAME_STATE_DATA, rate),
    );
    await this.pokerProgram.methods
      .initializeGame!(Array.from(this.gameId) as any, numPlayers, numCards)
      .accounts({
        payer: payer.publicKey,
        gameState: pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers(payer.publicKey.equals(this.provider.wallet.publicKey) ? [] : [payer])
      .rpc();
    return pda;
  }

  /** Release builds accept only the whitelist admin. Localnet testing builds accept any payer. */
  private async gameAuthority(): Promise<web3.Keypair> {
    if (isLocalCluster(this.provider.connection.rpcEndpoint)) {
      const kp = (this.provider.wallet as { payer?: web3.Keypair }).payer;
      if (!kp) throw new Error('provider wallet has no keypair');
      return kp;
    }
    const admin = await loadWhitelistAdminProvider(this.provider.connection);
    return (admin.wallet as KeypairWallet).payer;
  }

  async initializeGames(
    numPlayers: number,
    gameKind = 0,
    shoeDecks = 1,
    rouletteVariant = 0,
    dealerIndex = 255,
  ): Promise<{ lightGameState: web3.PublicKey; pokerGameState: web3.PublicKey }> {
    const config = normalizeGameConfig(
      gameKind as GameKind,
      shoeDecks,
      rouletteVariant,
    );
    const seatCap = maxTableSeats(config.kind);
    if (numPlayers < 2 || numPlayers > seatCap) {
      throw new Error(`${config.kind} allows 2..${seatCap} seats, got ${numPlayers}`);
    }
    if (gameKindNeedsHouseSeat(config.kind) && dealerIndex !== numPlayers - 1) {
      throw new Error(`${config.kind} reserves the last seat for the house`);
    }
    const lightGameState = await this.initializeGame(
      numPlayers,
      gameKind,
      shoeDecks,
      rouletteVariant,
      dealerIndex,
    );
    const pokerGameState = await this.initializePokerGame(
      numPlayers,
      revealCardCount(config),
    );
    if (this.pokerBridgeEnabled) {
      await this.initCpiAuthority(numPlayers);
    }
    return { lightGameState, pokerGameState };
  }

  /** Poker-side PlayerState when CPI bridge is unavailable (pre-bridge genesis). */
  async initPokerPlayerState(playerIndex: number): Promise<void> {
    if (!this.pokerProgram) throw new Error('pokerProgram is required');
    await this.pokerProgram.methods
      .initPlayerState!(playerIndex)
      .accounts({
        payer: this.provider.wallet.publicKey,
        gameState: this.derivePokerPDA('game_state'),
        playerState: this.derivePokerPDA('player', Buffer.from([playerIndex])),
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
  }

  private withPokerBridge(
    accounts: Record<string, unknown>,
    playerIndex?: number,
  ): Record<string, unknown> {
    if (!this.pokerProgram || !this.pokerBridgeEnabled) {
      return {
        ...accounts,
        pokerProgram: null,
        cpiAuthority: null,
        pokerGameState: null,
        ...(playerIndex !== undefined ? { pokerPlayerState: null } : {}),
      };
    }
    const bridge = this.pokerBridgeAccounts(playerIndex);
    return {
      ...accounts,
      pokerProgram: bridge.pokerProgram,
      cpiAuthority: bridge.cpiAuthority,
      pokerGameState: bridge.pokerGameState,
      ...(playerIndex !== undefined ? { pokerPlayerState: bridge.pokerPlayerState } : {}),
    };
  }

  async registerPlayer(
    playerIndex: number,
    proof: any,
    publicSignals: string[],
    authority?: web3.Keypair,
  ): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const proofReceiptPDA = await this.deriveProofReceipt(0, playerIndex);
    const formattedInputs = publicSignalsToBytes(publicSignals);

    const builder = this.lightPokerProgram.methods
      .registerPlayerReceipt!(playerIndex, proofToBytes(proof), formattedInputs as any)
      .accounts(
        this.withPokerBridge(
          {
            signer: authority?.publicKey ?? this.provider.wallet.publicKey,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            proofReceipt: proofReceiptPDA,
            systemProgram: web3.SystemProgram.programId,
          },
          playerIndex,
        ) as any,
      )
      .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority)))
      .preInstructions([
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: GROTH16_VERIFY_CU }),
      ]);

    if (!authority) {
      await timed(`tx:register_receipt:p${playerIndex}`, () => builder.rpc());
      return;
    }

    // These E2E player authorities are already airdropped SOL. Paying the fee
    // from the authority keeps this bridged registration transaction to one
    // signature; using provider.rpc() adds the provider as a second signer and
    // pushes the legacy transaction over Solana's 1232-byte packet limit.
    await timed(`tx:register_receipt:p${playerIndex}`, () =>
      confirmOrResend(this.provider.connection, async (latest, attempt) => {
        const transaction = await builder.transaction();
        transaction.feePayer = authority.publicKey;
        transaction.recentBlockhash = latest.blockhash;
        transaction.sign(authority);
        const serialized = transaction.serialize();
        if (attempt === 0) {
          console.log(`[tx-size] register_player_receipt p${playerIndex}: ${serialized.length} bytes`);
        }
        return this.provider.connection.sendRawTransaction(serialized, {
          preflightCommitment: 'processed',
        });
      }),
    );
  }

  private async playerRemainingAccounts(numPlayers: number): Promise<{ pubkey: web3.PublicKey; isSigner: false; isWritable: false }[]> {
    return Array.from({ length: numPlayers }, (_, i) => ({
      pubkey: this.deriveLightPDA('player', Buffer.from([i])),
      isSigner: false,
      isWritable: false,
    }));
  }

  /**
   * Close this hand's light-casino accounts onto `rentDest`. The operator is
   * the fee payer. Rent vaults stay for the casino reclaim path.
   */
  async closeLightSession(playerCount: number, rentDest: web3.PublicKey): Promise<void> {
    const programId = this.lightPokerProgram.programId;
    const gameId = Buffer.from(Array.from(this.gameId));
    const generation = Buffer.alloc(8);
    const at = (seeds: Buffer[]) => web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
    const candidates: web3.PublicKey[] = [
      this.deriveLightPDA('game_state'),
      this.deriveLightPDA('deck_state'),
      this.deriveLightPDA('shuffle_inputs'),
    ];
    for (let index = 0; index < playerCount; index++) {
      const seat = Buffer.from([index]);
      candidates.push(
        this.deriveLightPDA('player', seat),
        this.deriveLightPDA('share_inputs', seat),
        this.deriveLightPDA('bet_inputs', seat),
        this.deriveLightPDA('roulette_bets', seat),
        this.deriveLightPDA('bingo_showdown_rows', seat),
        this.deriveLightPDA('keno_showdown_rows', seat),
        at([Buffer.from('bj_turn'), gameId, generation, seat]),
        at([Buffer.from('bj_insurance'), gameId, generation, seat]),
        at([Buffer.from('bj_showdown_layout'), gameId, seat, Buffer.from([0])]),
        at([Buffer.from('bj_showdown_layout'), gameId, seat, Buffer.from([1])]),
      );
      for (let seq = 0; seq < 4; seq++) {
        const action = Buffer.alloc(2);
        action.writeUInt16LE(seq);
        candidates.push(at([Buffer.from('bj_action_layout'), gameId, seat, action]));
      }
      for (let phase = 0; phase < 4; phase++) {
        candidates.push(at([
          Buffer.from('proof_receipt_v2'),
          gameId,
          generation,
          Buffer.from([phase]),
          seat,
        ]));
      }
    }
    const gameState = candidates[0]!;
    const infos = await this.provider.connection.getMultipleAccountsInfo(candidates, 'confirmed');
    const gameInfo = infos[0];
    if (!gameInfo || !gameInfo.owner.equals(programId) || gameInfo.data.length === 0) return;
    const open = candidates.filter((pubkey, index) => {
      const info = infos[index];
      return !!info
        && info.owner.equals(programId)
        && info.data.length > 0
        && !pubkey.equals(gameState)
        && !pubkey.equals(rentDest);
    });
    const disc = createHash('sha256').update('global:close_light_session').digest().subarray(0, 8);
    const batchSize = 50;
    const batches = open.length === 0 ? [[]] : [];
    for (let start = 0; start < open.length; start += batchSize) {
      batches.push(open.slice(start, start + batchSize));
    }
    for (let batch = 0; batch < batches.length; batch++) {
      const last = batch === batches.length - 1;
      const ix = new web3.TransactionInstruction({
        programId,
        keys: [
          { pubkey: rentDest, isSigner: true, isWritable: true },
          { pubkey: gameState, isSigner: false, isWritable: last },
          ...batches[batch]!.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        ],
        data: Buffer.concat([disc, Buffer.from([last ? 1 : 0])]),
      });
      const latest = await this.provider.connection.getLatestBlockhash('confirmed');
      const tx = new web3.Transaction({
        feePayer: this.provider.wallet.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(ix);
      const signed = await this.provider.wallet.signTransaction(tx);
      const signature = await this.provider.connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: 'confirmed',
      });
      const confirmation = await this.provider.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(`close_light_session failed: ${JSON.stringify(confirmation.value.err)}`);
      }
    }
  }

  private async closeDeckState(shufflePayer?: web3.Keypair): Promise<void> {
    const gameState = this.deriveLightPDA('game_state');
    const deckState = this.deriveLightPDA('deck_state');
    const info = await this.provider.connection.getAccountInfo(deckState, 'confirmed');
    if (!info || info.owner.equals(web3.SystemProgram.programId)) return;
    const remaining: { pubkey: web3.PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    const shuffleInputs = this.deriveLightPDA('shuffle_inputs');
    const shuffleInfo = await this.provider.connection.getAccountInfo(shuffleInputs, 'confirmed');
    if (
      shuffleInfo
      && shuffleInfo.owner.equals(this.lightPokerProgram.programId)
      && shuffleInfo.data.length > 0
      && shufflePayer
      && this.pokerProgram
    ) {
      const casinoGame = await (this.pokerProgram.account as any).gameState.fetch(
        this.derivePokerPDA('game_state'),
      );
      const roomId = Buffer.from(casinoGame.tableRoomId ?? casinoGame.table_room_id);
      remaining.push(
        { pubkey: shuffleInputs, isSigner: false, isWritable: true },
        {
          pubkey: rentVaultPda(new Uint8Array(roomId), shufflePayer.publicKey),
          isSigner: false,
          isWritable: true,
        },
      );
    }
    const operatorVault = rentVaultFor(this.provider.wallet.publicKey);
    if (operatorVault && !remaining.some((meta) => meta.pubkey.equals(operatorVault))) {
      remaining.push({ pubkey: operatorVault, isSigner: false, isWritable: true });
    }
    await this.lightPokerProgram.methods
      .closeDeckState!()
      .accounts({
        signer: this.provider.wallet.publicKey,
        gameState,
        deckState,
      })
      .remainingAccounts(remaining)
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' });
  }

  /**
   * Start `deck_state` allocation. `init_deck_state` has no phase check, so
   * this overlaps table setup and register. `create_shuffle_public_inputs`
   * still runs at shuffle time because it resets the buffer.
   */
  beginDeckWarm(): void {
    if (this.deckWarm) return;
    this.deckWarm = this.warmDeckFromChain().catch((err) => {
      console.error('[shuffle] deck warm failed', err);
      this.deckWarm = null;
      throw err;
    });
  }

  /**
   * Start the game shuffle buffer once every seat is registered and the phase
   * is Shuffle. The current shuffler is player 0.
   */
  beginShuffleBufferWarm(playerIndex: number, authority?: web3.Keypair): void {
    if (this.shuffleWarm) return;
    this.shuffleWarm = this.warmShuffleBuffer(playerIndex, authority).catch((err) => {
      console.error('[shuffle] buffer warm failed', err);
      this.shuffleWarm = null;
      throw err;
    });
  }

  private callerInputsFor(gameState: {
    gameKind?: number;
    shoeDecks?: number;
    rouletteVariant?: number;
  }): number {
    const deckFields = shoeCardsFromGameState(gameState) * FIELDS_PER_CARD;
    return deckFields + 1;
  }

  private async warmDeckFromChain(): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const deckFields = shoeCardsFromGameState(gameState) * FIELDS_PER_CARD;
    await this.initDeckStateIfNeeded(
      gameStatePDA,
      this.deriveLightPDA('deck_state'),
      deckFields,
    );
  }

  private async warmShuffleBuffer(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    await this.ensureShufflePublicInputs(
      gameStatePDA,
      this.deriveLightPDA('player', Buffer.from([playerIndex])),
      this.deriveLightPDA('shuffle_inputs'),
      this.callerInputsFor(gameState),
      authority,
    );
  }

  private async initDeckStateIfNeeded(
    gameStatePDA: web3.PublicKey,
    deckStatePDA: web3.PublicKey,
    deckFields: number,
  ): Promise<void> {
    let info = await this.provider.connection.getAccountInfo(deckStatePDA, 'processed');
    const target = deckStateAccountSize(deckFields);
    const operator = this.provider.wallet.publicKey;
    if (!info) {
      await frontFromVault(this.provider, operator, MAX_CPI_ALLOC, 0);
      await this.lightPokerProgram.methods
        .initDeckState!()
        .accounts({
          signer: this.provider.wallet.publicKey,
          gameState: gameStatePDA,
          deckState: deckStatePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' });
      await this.waitForConfirmedAccount(deckStatePDA, 'deck_state', 'confirmed');
      info = await this.provider.connection.getAccountInfo(deckStatePDA, 'confirmed');
    }
    if (!info) {
      throw new Error(`deck_state missing after init: ${deckStatePDA.toBase58()}`);
    }
    while (info.data.length < target) {
      await frontExtendFromVault(
        this.provider,
        operator,
        info.data.length,
        info.lamports,
        target,
      );
      await this.lightPokerProgram.methods
        .extendDeckState!()
        .accounts({
          signer: this.provider.wallet.publicKey,
          deckState: deckStatePDA,
          gameState: gameStatePDA,
          systemProgram: web3.SystemProgram.programId,
        } as any)
        .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' });
      info = await this.provider.connection.getAccountInfo(deckStatePDA, 'confirmed');
      if (!info) {
        throw new Error(`deck_state missing during extend: ${deckStatePDA.toBase58()}`);
      }
    }
  }

  private async ensureShufflePublicInputs(
    gameStatePDA: web3.PublicKey,
    playerStatePDA: web3.PublicKey,
    shufflePublicSignalsPDA: web3.PublicKey,
    callerInputs: number,
    authority?: web3.Keypair,
  ): Promise<void> {
    const signer = this.authorityPubkey(authority);
    const target = shuffleInputsAccountSize(callerInputs);
    let info = await this.provider.connection.getAccountInfo(
      shufflePublicSignalsPDA,
      'processed',
    );
    if (!info) {
      await frontFromVault(this.provider, signer, MAX_CPI_ALLOC, 0, authority);
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .allocateShufflePublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            shufflePublicInputs: shufflePublicSignalsPDA,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
        undefined,
        'processed',
      );
      await this.waitForConfirmedAccount(shufflePublicSignalsPDA, 'shuffle_inputs', 'processed');
      info = await this.provider.connection.getAccountInfo(
        shufflePublicSignalsPDA,
        'processed',
      );
    }
    if (!info) {
      throw new Error(
        `shuffle_inputs missing after allocate: ${shufflePublicSignalsPDA.toBase58()}`,
      );
    }
    while (info.data.length < target) {
      const before = info.data.length;
      await frontExtendFromVault(
        this.provider,
        signer,
        info.data.length,
        info.lamports,
        target,
        authority,
      );
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .extendShufflePublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            shufflePublicInputs: shufflePublicSignalsPDA,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
        undefined,
        'processed',
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        info = await this.provider.connection.getAccountInfo(
          shufflePublicSignalsPDA,
          'processed',
        );
        if (info && info.data.length > before) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!info) {
        throw new Error(
          `shuffle_inputs missing during extend: ${shufflePublicSignalsPDA.toBase58()}`,
        );
      }
      if (info.data.length <= before) {
        throw new Error(
          `shuffle_inputs did not grow past ${before} (target ${target})`,
        );
      }
    }
  }

  async initShareReceipt(
    playerIndex: number,
    mpcGeneration?: bigint | number | { toString(): string },
    authority?: web3.Keypair,
    confirm?: { commitment?: web3.Commitment; pollMs?: number },
  ): Promise<void> {
    let generation = mpcGeneration;
    if (generation == null) {
      const shareVerifyAcc = this.derivePokerPDA(
        'share_verify_acc',
        Buffer.from([playerIndex]),
      );
      const acc = await (this.pokerProgram!.account as any).shareVerifyAccumulator.fetch(
        shareVerifyAcc,
      );
      generation = acc.generation;
    }
    if (generation == null) {
      throw new Error(`share_verify_acc.generation missing for player ${playerIndex}`);
    }
    const proofReceipt = this.deriveShareProofReceipt(playerIndex, generation as any);
    if (await this.provider.connection.getAccountInfo(proofReceipt)) return;
    const builder = (this.lightPokerProgram.methods as any)
      .initShareReceipt(new BN(generation.toString()))
      .accounts({
        signer: this.authorityPubkey(authority),
        gameState: this.deriveLightPDA('game_state'),
        playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
        shareVerifyAcc: this.derivePokerPDA('share_verify_acc', Buffer.from([playerIndex])),
        proofReceipt,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority)));
    const commitment = confirm?.commitment ?? 'confirmed';
    if (authority) {
      await this.rpcAuthorityPaid(
        builder,
        authority,
        undefined,
        undefined,
        commitment,
        commitment,
        confirm?.pollMs,
      );
    } else {
      await builder.rpc({ commitment, preflightCommitment: commitment });
    }
  }

  /** Put the share receipt in the mempool and return once the RPC accepts it. */
  private async dispatchShareReceipt(
    playerIndex: number,
    generation: bigint | number | { toString(): string },
    authority: web3.Keypair,
  ): Promise<void> {
    const proofReceipt = this.deriveShareProofReceipt(playerIndex, generation as any);
    const builder = (this.lightPokerProgram.methods as any)
      .initShareReceipt(new BN(generation.toString()))
      .accounts({
        signer: authority.publicKey,
        gameState: this.deriveLightPDA('game_state'),
        playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
        shareVerifyAcc: this.derivePokerPDA('share_verify_acc', Buffer.from([playerIndex])),
        proofReceipt,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(leadingVaultMeta(authority.publicKey));
    const latest = await this.provider.connection.getLatestBlockhash('confirmed');
    const transaction = await builder.transaction();
    transaction.feePayer = authority.publicKey;
    transaction.recentBlockhash = latest.blockhash;
    transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
    transaction.sign(authority);
    await this.provider.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
    });
  }

  async initShuffleReceipt(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    const proofReceipt = await this.deriveProofReceipt(1, playerIndex);
    if (await this.provider.connection.getAccountInfo(proofReceipt)) return;
    const builder = (this.lightPokerProgram.methods as any)
      .initShuffleReceipt()
      .accounts({
        signer: this.authorityPubkey(authority),
        gameState: this.deriveLightPDA('game_state'),
        playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
        proofReceipt,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority)));
    if (authority) {
      await this.rpcAuthorityPaid(builder, authority);
    } else {
      await builder.rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' });
    }
  }

  async initShowdownReceipt(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    const proofReceipt = await this.deriveProofReceipt(3, playerIndex);
    if (await this.provider.connection.getAccountInfo(proofReceipt)) {
      logHandProgress(`Showdown tx: init_showdown_receipt already on chain (seat player ${playerIndex})`);
      return;
    }
    logHandProgress(`Showdown tx: init_showdown_receipt sending (seat player ${playerIndex})`);
    const builder = (this.lightPokerProgram.methods as any)
      .initShowdownReceipt()
      .accounts({
        signer: this.authorityPubkey(authority),
        gameState: this.deriveLightPDA('game_state'),
        playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
        proofReceipt,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority)));
    if (authority) {
      await this.rpcAuthorityPaid(builder, authority);
    } else {
      await builder.rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' });
    }
    logHandProgress(`Showdown tx: init_showdown_receipt confirmed (seat player ${playerIndex})`);
  }

  async initActionReceipt(
    playerIndex: number,
    actionSeq: number,
    authority?: web3.Keypair,
  ): Promise<void> {
    const proofReceipt = await this.deriveActionProofReceipt(playerIndex, actionSeq);
    if (await this.provider.connection.getAccountInfo(proofReceipt)) return;
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .initActionReceipt(actionSeq)
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: this.deriveLightPDA('game_state'),
          playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
          proofReceipt,
          systemProgram: web3.SystemProgram.programId,
        })
        .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority))),
      authority,
    );
  }

  /**
   * Record insurance / even-money. Requires the player and dealer initial
   * action proofs. The upcard is already public from the initial partials.
   */
  async recordBlackjackInsurance(
    playerIndex: number,
    opts: { taken: boolean; evenMoney: boolean },
    authority?: web3.Keypair,
  ): Promise<void> {
    const gameState = await this.fetchLightGameState(this.deriveLightPDA('game_state'));
    const generationLe = new BN(gameState.generation).toArrayLike(Buffer, 'le', 8);
    const dealerIndex = Number(gameState.dealerIndex ?? gameState.dealer_index ?? 0);
    const seq0 = Buffer.alloc(2);
    seq0.writeUInt16LE(0);
    const initialActionLayout = web3.PublicKey.findProgramAddressSync([
      Buffer.from('bj_action_layout'),
      Buffer.from(this.gameId),
      Buffer.from([playerIndex]),
      seq0,
    ], this.lightPokerProgram.programId)[0];
    const dealerActionLayout = web3.PublicKey.findProgramAddressSync([
      Buffer.from('bj_action_layout'),
      Buffer.from(this.gameId),
      Buffer.from([dealerIndex]),
      seq0,
    ], this.lightPokerProgram.programId)[0];
    const blackjackInsurance = web3.PublicKey.findProgramAddressSync([
      Buffer.from('bj_insurance'),
      Buffer.from(this.gameId),
      generationLe,
      Buffer.from([playerIndex]),
    ], this.lightPokerProgram.programId)[0];
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .recordBlackjackInsurance(opts.taken, opts.evenMoney)
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: this.deriveLightPDA('game_state'),
          playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
          initialActionLayout,
          dealerActionLayout,
          blackjackInsurance,
          systemProgram: web3.SystemProgram.programId,
        }),
      authority,
    );
  }

  async verifyAction(
    playerIndex: number,
    actionSeq: number,
    proof: any,
    publicSignals: Array<bigint | string>,
    material: {
      h1: bigint;
      h2: bigint;
      cardCount: number;
      canSplit: boolean;
      hitSoft17: boolean;
      isDealer: boolean;
      insuranceEligible: boolean;
      upcardHash: bigint;
    },
    authority?: web3.Keypair,
  ): Promise<void> {
    // Public signals: [statusHash, inputHash]
    if (publicSignals.length < 2) {
      throw new Error(`blackjack action expects 2 public signals, got ${publicSignals.length}`);
    }
    const seq = Buffer.alloc(2);
    seq.writeUInt16LE(actionSeq);
    const gameState = this.deriveLightPDA('game_state');
    const playerState = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const actionLayout = web3.PublicKey.findProgramAddressSync([
      Buffer.from('bj_action_layout'),
      Buffer.from(this.gameId),
      Buffer.from([playerIndex]),
      seq,
    ], this.lightPokerProgram.programId)[0];
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .recordBlackjackActionLayout(
          actionSeq,
          fieldToBytesBE(material.h1),
          fieldToBytesBE(material.h2),
          material.cardCount,
          material.canSplit,
          material.hitSoft17,
          material.isDealer,
        )
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState,
          playerState,
          blackjackActionLayout: actionLayout,
          systemProgram: web3.SystemProgram.programId,
        }),
      authority,
    );
    await this.initActionReceipt(playerIndex, actionSeq, authority);
    const accounts: Record<string, web3.PublicKey> = {
      signer: this.authorityPubkey(authority),
      gameState,
      playerState,
      proofReceipt: await this.deriveActionProofReceipt(playerIndex, actionSeq),
      blackjackActionLayout: actionLayout,
      // Optional on-chain. Anchor still requires the key: the program id means None.
      blackjackTurn: this.lightPokerProgram.programId,
      sealedShowdownCoefficients: web3.PublicKey.findProgramAddressSync(
        [Buffer.from('sealed_showdown_coeffs'), this.authorityPubkey(authority).toBuffer()],
        this.pokerProgram.programId,
      )[0],
    };
    if (!material.isDealer) {
      const turn = this.blackjackTurnPda(playerIndex);
      const existing = await this.provider.connection.getAccountInfo(turn, 'confirmed');
      if (existing) accounts.blackjackTurn = turn;
    }
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .verifyAction(
          actionSeq,
          proofToBytes(proof),
          fieldToBytesBE(publicSignals[0]!),
          material.insuranceEligible,
          fieldToBytesBE(material.upcardHash),
        )
        .accounts(accounts)
        .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority))),
      authority,
    );
  }

  blackjackTurnPda(playerIndex: number, generation = 0n): web3.PublicKey {
    const gen = Buffer.alloc(8);
    gen.writeBigUInt64LE(generation);
    return web3.PublicKey.findProgramAddressSync([
      Buffer.from('bj_turn'),
      Buffer.from(this.gameId),
      gen,
      Buffer.from([playerIndex]),
    ], this.lightPokerProgram.programId)[0];
  }

  /** Open the three-minute showdown-proof window. Blackjack and bingo call this; other games open it when share completes. */
  async openShowdownWindow(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .openShowdownWindow()
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: this.deriveLightPDA('game_state'),
          playerState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
        }),
      authority,
    );
  }

  /** Start the three-minute action clock for a blackjack seat. */
  async openBlackjackActionWindow(
    playerIndex: number,
    dealerIndex: number,
    authority?: web3.Keypair,
    generation = 0n,
  ): Promise<void> {
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .openBlackjackActionWindow()
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: this.deriveLightPDA('game_state'),
          seatState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
          dealerState: this.deriveLightPDA('player', Buffer.from([dealerIndex])),
          blackjackTurn: this.blackjackTurnPda(playerIndex, generation),
          systemProgram: web3.SystemProgram.programId,
        }),
      authority,
    );
  }

  /**
   * Stand a blackjack seat.
   * The seat signs to leave. The dealer signs after three minutes with no action.
   */
  async standBlackjackSeat(
    playerIndex: number,
    dealerIndex: number,
    authority?: web3.Keypair,
    generation = 0n,
  ): Promise<void> {
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .standBlackjackSeat()
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: this.deriveLightPDA('game_state'),
          seatState: this.deriveLightPDA('player', Buffer.from([playerIndex])),
          dealerState: this.deriveLightPDA('player', Buffer.from([dealerIndex])),
          blackjackTurn: this.blackjackTurnPda(playerIndex, generation),
        }),
      authority,
    );
  }

  /**
   * Dealer (or the game operator, when there is no house seat) closes an
   * unproven showdown as a player loss. Legal three minutes after the window opened.
   */
  async forfeitShowdown(authorityIndex: number, authority?: web3.Keypair): Promise<void> {
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .forfeitShowdown()
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: this.deriveLightPDA('game_state'),
          playerState: this.deriveLightPDA('player', Buffer.from([authorityIndex])),
        }),
      authority,
    );
  }

  /** Fetch GameState with retries — localnet can briefly lag after register. */
  private async fetchLightGameState(gameStatePDA: web3.PublicKey): Promise<any> {
    const commitment = 'confirmed' as web3.Commitment;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await (this.lightPokerProgram.account as { gameState: { fetch: (address: web3.PublicKey, commitment?: web3.Commitment) => Promise<unknown> } }).gameState.fetch(gameStatePDA, commitment);
      } catch (err) {
        lastErr = err;
        const raw = await this.provider.connection.getAccountInfo(gameStatePDA, commitment);
        if (raw && raw.data.length > 0) {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`GameState not found at ${gameStatePDA.toBase58()}`);
  }

  /**
   * Fetch the verified shuffled deck from light-casino `deck_state`.
   *
   * After each `verify_shuffle_staged`, the program copies Groth16 deck outputs
   * into this PDA. Isolated clients must read it here before proving the next
   * shuffle — not from shared in-process `Game` state.
   *
   * Fails if the account is missing or incomplete (enforces sequencing: prior
   * player must have finished Groth16 verify).
   */
  async fetchShuffledDeck(): Promise<Ciphertext[]> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const nCards = shoeCardsFromGameState(gameState);
    const deckStatePDA = this.deriveLightPDA('deck_state');
    const info = await this.provider.connection.getAccountInfo(deckStatePDA, 'confirmed');
    if (!info) {
      throw new Error(
        `deck_state not available yet at ${deckStatePDA.toBase58()} — prior shuffle verify incomplete`,
      );
    }
    return parseDeckStateAccount(info.data, nCards);
  }

  async finalizeShuffle(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const proofReceiptPDA = await this.deriveProofReceipt(1, playerIndex);
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .finalizeShuffle()
        .accounts(
          this.withPokerBridge({
            signer: this.authorityPubkey(authority),
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            proofReceipt: proofReceiptPDA,
          }) as any,
        )
        .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority))),
      authority,
    );
  }

  private shuffleChunkPda(start: number): web3.PublicKey {
    const startLe = Buffer.alloc(2);
    startLe.writeUInt16LE(start);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('shuffle_chunk'), Buffer.from(this.gameId), startLe],
      this.lightPokerProgram.programId,
    )[0];
  }

  /**
   * The hand operator signs lane funding. A seated starter, the provider
   * wallet, or the whitelist admin (the payer of initialize_game) can sign.
   */
  private async operatorFundAuth(
    operator: web3.PublicKey,
    seat: web3.Keypair | undefined,
  ): Promise<{ signers: web3.Keypair[]; walletSigns: boolean }> {
    if (seat?.publicKey.equals(operator)) {
      return { signers: [seat], walletSigns: false };
    }
    if (operator.equals(this.provider.wallet.publicKey)) {
      return { signers: [], walletSigns: true };
    }
    const { WHITELIST_ADMIN } = await import('./admin-provider');
    if (operator.equals(WHITELIST_ADMIN)) {
      const admin = await loadWhitelistAdminProvider(this.provider.connection);
      const adminKp = (admin.wallet as { payer?: web3.Keypair }).payer;
      if (adminKp) return { signers: [adminKp], walletSigns: false };
    }
    throw new Error('lane fund requires the game operator to sign');
  }

  private async seatVault(player: web3.PublicKey): Promise<web3.PublicKey> {
    const remembered = rentVaultFor(player);
    if (remembered) return remembered;
    if (!this.pokerProgram) throw new Error('rent vault for this seat is not staged');
    const casinoGame = await (this.pokerProgram.account as any).gameState.fetch(
      this.derivePokerPDA('game_state'),
    );
    const roomId = Buffer.from(casinoGame.tableRoomId ?? casinoGame.table_room_id);
    return rentVaultPda(new Uint8Array(roomId), player);
  }

  private async sendPayers(
    instructions: web3.TransactionInstruction[],
    feePayer: web3.PublicKey,
    signers: web3.Keypair[],
    walletSigns: boolean,
    commitment: web3.Commitment,
    _blockhash?: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<string> {
    return confirmOrResend(this.provider.connection, async (latest) => {
      const transaction = new web3.Transaction({
        feePayer,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(...instructions);
      if (signers.length > 0) transaction.partialSign(...signers);
      const signed = walletSigns
        ? await this.provider.wallet.signTransaction(transaction)
        : transaction;
      return this.provider.connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: commitment,
      });
    }, commitment);
  }

  /** Send a signed transaction without waiting for confirmation. Returns the signature. */
  private async submitPayers(
    instructions: web3.TransactionInstruction[],
    feePayer: web3.PublicKey,
    signers: web3.Keypair[],
    walletSigns: boolean,
    blockhash: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<string> {
    const transaction = new web3.Transaction({
      feePayer,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    }).add(...instructions);
    if (signers.length > 0) transaction.partialSign(...signers);
    const signed = walletSigns
      ? await this.provider.wallet.signTransaction(transaction)
      : transaction;
    return this.provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: true,
      preflightCommitment: 'processed',
    });
  }

  /** Wait until each signature is at least processed. A dropped write must not be folded. */
  private async confirmSubmitted(
    signatures: string[],
    lastValidBlockHeight: number,
  ): Promise<void> {
    if (signatures.length === 0) return;
    const pending = new Set(signatures);
    const deadline = Date.now() + 12_000;
    while (pending.size > 0 && Date.now() < deadline) {
      const list = [...pending];
      let statuses: Awaited<ReturnType<web3.Connection['getSignatureStatuses']>> | null = null;
      try {
        statuses = await this.provider.connection.getSignatureStatuses(list);
      } catch {
        statuses = null;
      }
      statuses?.value.forEach((status, index) => {
        if (!status) return;
        if (status.err) {
          throw new Error(`share upload failed: ${JSON.stringify(status.err)}`);
        }
        const conf = status.confirmationStatus;
        if (conf === 'processed' || conf === 'confirmed' || conf === 'finalized') {
          pending.delete(list[index]!);
        }
      });
      if (pending.size === 0) return;
      const height = await this.provider.connection.getBlockHeight('processed').catch(() => 0);
      if (height > lastValidBlockHeight) {
        throw new Error(`share upload expired before confirmation (${pending.size} left)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (pending.size > 0) {
      throw new Error(`share upload not confirmed (${pending.size} left)`);
    }
  }

  /** Poll until each lane holds `amount`. One resend covers a dropped fund transaction. */
  private async waitUntilFunded(
    lanes: web3.Keypair[],
    amount: number,
    resend: (unpaid: web3.Keypair[]) => Promise<void>,
  ): Promise<void> {
    const missing = async () => {
      const infos = await this.provider.connection.getMultipleAccountsInfo(
        lanes.map((lane) => lane.publicKey),
        'processed',
      );
      return lanes.filter((lane, index) => (infos[index]?.lamports ?? 0) < amount);
    };
    const deadline = Date.now() + 4_000;
    let unpaid = lanes;
    while (Date.now() < deadline) {
      unpaid = await missing();
      if (unpaid.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    unpaid = await missing();
    if (unpaid.length === 0) return;
    await resend(unpaid);
    const retryDeadline = Date.now() + 4_000;
    while (Date.now() < retryDeadline) {
      unpaid = await missing();
      if (unpaid.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`${unpaid.length} lanes were not funded`);
  }

  /**
   * Fund one signer per chunk and create every chunk account in one wave.
   * The seat signs read-only. Chunk accounts are distinct, so the writes do
   * not share a writable account. A fund transaction holds at most
   * `SHUFFLE_LANES_PER_TX` signers, the most that fit in a 1232-byte packet.
   */
  private async writeShuffleChunks(opts: {
    playerIndex: number;
    authority?: web3.Keypair;
    signer: web3.PublicKey;
    gameState: { operator: web3.PublicKey };
    gameStatePDA: web3.PublicKey;
    playerStatePDA: web3.PublicKey;
    formattedInputs: number[][];
    /** Fired once the lanes are funded, before the chunk writes are sent. */
    onLanes?: (lanes: web3.Keypair[]) => void;
  }): Promise<web3.Keypair[]> {
    await this.pendingShuffleSweep;
    const plan = shuffleLanePlan(
      opts.formattedInputs.length,
      await clusterRentLamportsPerByte(this.provider.connection),
    );
    const vault = await this.seatVault(opts.signer);
    const vaultInfo = await this.provider.connection.getAccountInfo(vault, 'confirmed');
    const need = plan.lanes * plan.amountPerLane;
    if (!vaultInfo || vaultInfo.lamports < need) {
      throw new Error(`rent vault is short for shuffle lanes: have ${vaultInfo?.lamports ?? 0}, need ${need}`);
    }
    const lanes = Array.from({ length: plan.lanes }, () => web3.Keypair.generate());
    const operator = new web3.PublicKey(opts.gameState.operator);
    const fundAuth = await this.operatorFundAuth(operator, opts.authority);
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(BigInt(plan.amountPerLane));
    const fundBatch = (batch: web3.Keypair[]) => new web3.TransactionInstruction({
      programId: this.lightPokerProgram.programId,
      keys: [
        { pubkey: operator, isSigner: true, isWritable: true },
        { pubkey: opts.gameStatePDA, isSigner: false, isWritable: false },
        { pubkey: opts.playerStatePDA, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        ...batch.map((lane) => ({ pubkey: lane.publicKey, isSigner: false, isWritable: true })),
      ],
      data: Buffer.concat([ixDiscriminator('fund_shuffle_lanes'), amount]),
    });
    let handedOff = false;
    try {
    const fundSigners = fundAuth.signers;
    const fundWalletSigns = fundAuth.walletSigns;
    for (let i = 0; i < lanes.length; i += SHUFFLE_LANES_PER_TX) {
      const batch = lanes.slice(i, i + SHUFFLE_LANES_PER_TX);
      const send = async (unpaid: web3.Keypair[]) => {
        const latest = await this.provider.connection.getLatestBlockhash('processed');
        await this.submitPayers(
          [fundBatch(unpaid)],
          operator,
          fundSigners,
          fundWalletSigns,
          latest,
        );
      };
      await send(batch);
      await this.waitUntilFunded(batch, plan.amountPerLane, send);
    }
    handedOff = true;
    opts.onLanes?.(lanes);
    const starts: number[] = [];
    for (let start = 0; start < opts.formattedInputs.length; start += PREPARE_INPUTS_PER_TX) {
      starts.push(start);
    }
    console.log(
      `[tx-size] shuffle_chunks p${opts.playerIndex}: ${starts.length} chunks, ${plan.lanes} lanes`,
    );
    const programId = this.lightPokerProgram.programId;
    const latest = await this.provider.connection.getLatestBlockhash('confirmed');
    const existing = await this.provider.connection.getMultipleAccountsInfo(
      starts.map((start) => this.shuffleChunkPda(start)),
      'processed',
    );
    await Promise.all(starts.map(async (start, index) => {
      const lane = lanes[index]!;
      const info = existing[index];
      if (
        info
        && info.owner.equals(programId)
        && info.data.length === SHUFFLE_CHUNK_ACCOUNT_SIZE
      ) {
        return;
      }
      const body = flattenPublicInputsChunk(
        opts.formattedInputs.slice(start, start + PREPARE_INPUTS_PER_TX),
      );
      const payload = Buffer.alloc(2 + body.length);
      payload.writeUInt16LE(start, 0);
      body.copy(payload, 2);
      const write = new web3.TransactionInstruction({
        programId,
        keys: [
          { pubkey: opts.signer, isSigner: true, isWritable: false },
          { pubkey: lane.publicKey, isSigner: true, isWritable: true },
          { pubkey: opts.gameStatePDA, isSigner: false, isWritable: false },
          { pubkey: opts.playerStatePDA, isSigner: false, isWritable: false },
          { pubkey: this.shuffleChunkPda(start), isSigner: false, isWritable: true },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([ixDiscriminator('write_prepare_shuffle_chunk'), payload]),
      });
      const budget = [
        web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ];
      await withRetry(async () => {
        try {
          await this.submitPayers(
            [...budget, write],
            lane.publicKey,
            opts.authority ? [lane, opts.authority] : [lane],
            !opts.authority,
            latest,
          );
        } catch (error) {
          const message = errorText(error);
          if (/already in use|already initialized|AccountAlreadyInitialized/i.test(message)) return;
          throw error;
        }
      }, { retries: 5, delayMs: 200 });
    }));
    } catch (error) {
      if (!handedOff) {
        await this.sweepShuffleLanes(opts.signer, lanes).catch(() => undefined);
      }
      throw error;
    }
    return lanes;
  }

  /**
   * Copy each chunk as soon as its account is visible. Later chunk creates
   * stay in flight while an earlier group is absorbed. Chunk rent returns to
   * the seat vault inside the partial.
   */
  private async absorbShuffleChunks(opts: {
    authority?: web3.Keypair;
    signer: web3.PublicKey;
    gameStatePDA: web3.PublicKey;
    playerStatePDA: web3.PublicKey;
    shufflePublicSignalsPDA: web3.PublicKey;
    formattedInputs: number[][];
    lanes: web3.Keypair[];
    abort?: { current: boolean };
  }): Promise<void> {
    const starts: number[] = [];
    for (let start = 0; start < opts.formattedInputs.length; start += PREPARE_INPUTS_PER_TX) {
      starts.push(start);
    }
    const pending = starts.slice();
    const programId = this.lightPokerProgram.programId;
    const vault = await this.seatVault(opts.signer);
    const absorbBatch = (group: number[]) => new web3.TransactionInstruction({
      programId,
      keys: [
        { pubkey: opts.signer, isSigner: true, isWritable: false },
        { pubkey: opts.gameStatePDA, isSigner: false, isWritable: false },
        { pubkey: opts.playerStatePDA, isSigner: false, isWritable: false },
        { pubkey: opts.shufflePublicSignalsPDA, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        ...group.map((start) => ({
          pubkey: this.shuffleChunkPda(start),
          isSigner: false,
          isWritable: true,
        })),
      ],
      data: ixDiscriminator('absorb_shuffle_batch'),
    });
    const budget = [
      web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ];
    const sendGroup = async (group: number[]) => {
      await withRetry(async () => {
        const latest = await this.provider.connection.getLatestBlockhash('confirmed');
        const transaction = new web3.Transaction({
          feePayer: opts.signer,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        }).add(...budget, absorbBatch(group));
        if (opts.authority) transaction.partialSign(opts.authority);
        const signed = opts.authority
          ? transaction
          : await this.provider.wallet.signTransaction(transaction);
        const signature = await this.provider.connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
          preflightCommitment: 'processed',
        });
        const giveUp = Date.now() + 20_000;
        while (Date.now() < giveUp) {
          const { value } = await this.provider.connection.getSignatureStatuses([signature]);
          const status = value[0];
          if (status?.err) {
            throw new Error(`absorb batch failed: ${JSON.stringify(status.err)}`);
          }
          if (
            status?.confirmationStatus === 'processed'
            || status?.confirmationStatus === 'confirmed'
            || status?.confirmationStatus === 'finalized'
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('absorb batch was not processed');
      }, { retries: 5, delayMs: 200 });
    };
    const deadline = Date.now() + 90_000;
    const written = (info: web3.AccountInfo<Buffer> | null, start: number) =>
      !!info
      && info.owner.equals(programId)
      && info.data.length >= SHUFFLE_CHUNK_ACCOUNT_SIZE
      && info.data.readUInt16LE(73) === start
      && info.data.readUInt16LE(75) > 0;
    try {
    while (pending.length > 0) {
      if (opts.abort?.current) {
        throw new Error('shuffle chunk writes failed');
      }
      const infos = await this.provider.connection.getMultipleAccountsInfo(
        pending.map((start) => this.shuffleChunkPda(start)),
        'processed',
      );
      const ready: number[] = [];
      pending.forEach((start, index) => {
        if (written(infos[index] ?? null, start)) ready.push(start);
      });
      const takeNow = ready.length >= SHUFFLE_ABSORB_PER_TX
        || (ready.length > 0 && ready.length === pending.length);
      if (!takeNow) {
        if (Date.now() > deadline) {
          throw new Error(`shuffle chunks not written: ${pending.join(',')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const groups: number[][] = [];
      while (ready.length > 0) groups.push(ready.splice(0, SHUFFLE_ABSORB_PER_TX));
      for (const group of groups) await sendGroup(group);
      for (const group of groups) {
        for (const start of group) {
          const at = pending.indexOf(start);
          if (at >= 0) pending.splice(at, 1);
        }
      }
    }
    } catch (error) {
      await this.sweepShuffleLanes(opts.signer, opts.lanes).catch(() => undefined);
      throw error;
    }
    this.pendingShuffleSweep = this.sweepShuffleLanes(opts.signer, opts.lanes);
  }

  /** Return whatever the lanes still hold. The provider pays the fee so a lane can be emptied. */
  private async sweepShuffleLanes(player: web3.PublicKey, lanes: web3.Keypair[]): Promise<void> {
    const vault = await this.seatVault(player);
    const infos = await this.provider.connection.getMultipleAccountsInfo(
      lanes.map((lane) => lane.publicKey),
      'processed',
    );
    const transfers: web3.TransactionInstruction[] = [];
    const payers: web3.Keypair[] = [];
    lanes.forEach((lane, index) => {
      const lamports = infos[index]?.lamports ?? 0;
      if (lamports === 0) return;
      transfers.push(web3.SystemProgram.transfer({
        fromPubkey: lane.publicKey,
        toPubkey: vault,
        lamports,
      }));
      payers.push(lane);
    });
    if (transfers.length === 0) return;
    for (let i = 0; i < transfers.length; i += 6) {
      await this.sendPayers(
        transfers.slice(i, i + 6),
        this.provider.wallet.publicKey,
        payers.slice(i, i + 6),
        true,
        'processed',
      );
    }
  }

  /**
   * Absorb can report processed while the next simulation still sees the reset
   * shuffle buffer. Wait until the filled account is visible, then retry the
   * follow-up transaction when that race still loses.
   */
  private async sendWhenShuffleFilled(
    shufflePublicSignalsPDA: web3.PublicKey,
    callerInputs: number,
    label: string,
    send: () => Promise<unknown>,
  ): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const info = await this.provider.connection.getAccountInfo(
        shufflePublicSignalsPDA,
        'confirmed',
      );
      if (info && shuffleBufferFilled(info.data, callerInputs)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let last: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await send();
        return;
      } catch (error) {
        last = error;
        const after = await this.provider.connection.getAccountInfo(
          shufflePublicSignalsPDA,
          'confirmed',
        );
        const filled = !!after && shuffleBufferFilled(after.data, callerInputs);
        if (!filled || attempt === 5) {
          const now = after
            ? describeShuffleBuffer(after.data, callerInputs)
            : 'shuffle buffer missing';
          throw new Error(`${label} (${now}): ${errorText(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw last;
  }

  async verifyShuffle(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    shoe: bigint[][],
    deckBeforeShuffle?: bigint[][],
    authority?: web3.Keypair,
  ): Promise<void> {
    const signer = this.authorityPubkey(authority);
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const proofReceiptPDA = await this.deriveProofReceipt(1, playerIndex);
    // One shuffle buffer per game (`shuffle_inputs || game_id`). The current
    // shuffler resets that buffer and writes the next proof's public outputs.
    // Those writes stay staged. `deck_state` is replaced only after
    // `verify_shuffle_staged` accepts the proof and the buffer still matches
    // that proof's output.
    const shufflePublicSignalsPDA = this.deriveLightPDA('shuffle_inputs');
    const deckStatePDA = this.deriveLightPDA('deck_state');
    const shoeCards = shoeCardsFromGameState(gameState);
    const deckFields = shoeCards * FIELDS_PER_CARD;
    const proofSignals = readShuffleProof(publicSignals);
    const shoeFields = shoe.flat();
    if (shoeFields.length !== deckFields) {
      throw new Error(`shuffle shoe has ${shoeFields.length} fields, expected ${deckFields}`);
    }
    const callerPublicInputs = deckFields + 1;
    const formattedInputs = this.formatPublicInputs([
      ...shoeFields,
      proofSignals.permutationHash,
    ]);
    const lightHelper = new LightProtocolStorageHelper(this.lightPokerProgram, this.provider);
    const permutationHash = proofSignals.permutationHash;
    const usedPerm = await lightHelper.proveNewUsedPermutation(permutationHash);
    const lightTail = usedPerm.lightAvailable ? usedPerm.remainingAccounts : [];

    if (playerIndex === 0) {
      if (!deckBeforeShuffle) {
        throw new Error('deckBeforeShuffle is required for the first shuffle');
      }
      await timed('tx:init_deck_state', async () => {
        if (this.deckWarm) {
          try {
            await this.deckWarm;
            return;
          } catch {
            this.deckWarm = null;
          }
        }
        await this.initDeckStateIfNeeded(gameStatePDA, deckStatePDA, deckFields);
      });
    }

    await timed(`tx:allocate_shuffle_public_signals:p${playerIndex}`, async () => {
      if (playerIndex === 0 && this.shuffleWarm) {
        try {
          await this.shuffleWarm;
          return;
        } catch {
          this.shuffleWarm = null;
        }
      }
      await this.ensureShufflePublicInputs(
        gameStatePDA,
        playerStatePDA,
        shufflePublicSignalsPDA,
        callerPublicInputs,
        authority,
      );
    });

    await timed(`tx:create_shuffle_public_signals:p${playerIndex}`, () =>
      this.rpcAs(
        this.lightPokerProgram.methods
          .createShufflePublicInputs!()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            shufflePublicInputs: shufflePublicSignalsPDA,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
      ),
    );

    let releaseLanes: (lanes: web3.Keypair[]) => void = () => undefined;
    let failLanes: (error: unknown) => void = () => undefined;
    const lanesReady = new Promise<web3.Keypair[]>((resolve, reject) => {
      releaseLanes = resolve;
      failLanes = reject;
    });
    const abort = { current: false };
    const written = timed(`tx:write_shuffle_public_signals:p${playerIndex}`, () =>
      this.writeShuffleChunks({
        playerIndex,
        authority,
        signer,
        gameState,
        gameStatePDA,
        playerStatePDA,
        formattedInputs,
        onLanes: releaseLanes,
      }),
    ).catch((error: unknown) => {
      abort.current = true;
      failLanes(error);
      throw error;
    });
    // Copy each chunk as soon as its account is visible. The writes are still in flight.
    const prepared = timed(`tx:prepare_shuffle_public_signals:p${playerIndex}`, async () => {
      const shuffleLanes = await lanesReady;
      const already = await this.provider.connection.getAccountInfo(
        shufflePublicSignalsPDA,
        'processed',
      );
      const preparedAt = preparedCountOffset(callerPublicInputs);
      const alreadyPrepared =
        already && already.data.length >= preparedAt + 2
          ? already.data.readUInt16LE(preparedAt)
          : 0;
      if (alreadyPrepared < SHUFFLE_PROOF_PUBLIC_SIGNALS) {
        await this.absorbShuffleChunks({
          authority,
          signer,
          gameStatePDA,
          playerStatePDA,
          shufflePublicSignalsPDA,
          formattedInputs,
          lanes: shuffleLanes,
          abort,
        });
      }
      if (playerIndex > 0) {
        await this.sendWhenShuffleFilled(
          shufflePublicSignalsPDA,
          callerPublicInputs,
          `cache shuffle deck hash p${playerIndex}`,
          () => this.rpcAuthorityInstructions(
            [
              ...finalizePrepareShuffleBudgetIxs(),
              new web3.TransactionInstruction({
                programId: this.lightPokerProgram.programId,
                keys: [
                  { pubkey: signer, isSigner: true, isWritable: false },
                  { pubkey: gameStatePDA, isSigner: false, isWritable: false },
                  { pubkey: playerStatePDA, isSigner: false, isWritable: false },
                  { pubkey: deckStatePDA, isSigner: false, isWritable: false },
                  { pubkey: shufflePublicSignalsPDA, isSigner: false, isWritable: true },
                ],
                data: ixDiscriminator('cache_shuffle_deck_hash'),
              }),
            ],
            authority,
            'confirmed',
          ),
        );
      }
      await this.sendWhenShuffleFilled(
        shufflePublicSignalsPDA,
        callerPublicInputs,
        `finalize shuffle inputs p${playerIndex}`,
        async () => this.rpcAs(
          (this.lightPokerProgram.methods as any)
            .finalizePrepareShuffleInputs()
            .accounts({
              signer,
              gameState: gameStatePDA,
              playerState: playerStatePDA,
              deckState: deckStatePDA,
              shufflePublicInputs: shufflePublicSignalsPDA,
            })
            .remainingAccounts(await this.playerRemainingAccounts(gameState.numPlayers))
            .preInstructions(finalizePrepareShuffleBudgetIxs()),
          authority,
        ),
      );
    });
    const settled = await Promise.allSettled([written, prepared]);
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    for (let attempt = 0; attempt < 100; attempt++) {
      const preparedInfo = await this.provider.connection.getAccountInfo(
        shufflePublicSignalsPDA,
        'processed',
      );
      const preparedAt = preparedCountOffset(callerPublicInputs);
      const preparedCount = preparedInfo && preparedInfo.data.length >= preparedAt + 2
        ? preparedInfo.data.readUInt16LE(preparedAt)
        : 0;
      if (preparedCount === SHUFFLE_PROOF_PUBLIC_SIGNALS) break;
      if (attempt === 99) {
        throw new Error(
          `shuffle prepared inputs incomplete: ${preparedCount}/${SHUFFLE_PROOF_PUBLIC_SIGNALS}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await Promise.all([
      timed(`tx:init_shuffle_receipt:p${playerIndex}`, () =>
        this.initShuffleReceipt(playerIndex, authority),
      ),
      this.pendingShuffleSweep,
    ]);
    const verifyBuilder = this.lightPokerProgram.methods
      .verifyShuffleStaged!(
        proofToBytes(proof),
        usedPerm.validityProof,
        usedPerm.addressTreeInfo,
        usedPerm.outputMerkleTreeIndex,
      )
      .accounts({
        signer,
        gameState: gameStatePDA,
        playerState: playerStatePDA,
        shufflePublicInputs: shufflePublicSignalsPDA,
        deckState: deckStatePDA,
        proofReceipt: proofReceiptPDA,
      } as any)
      .remainingAccounts(prependVault(signer, lightTail))
      .preInstructions(verifyBudgetIxs());
    const verifyTx = await verifyBuilder.transaction();
    verifyTx.feePayer = signer;
    verifyTx.recentBlockhash = (await this.provider.connection.getLatestBlockhash('confirmed')).blockhash;
    const legacySize = verifyTx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
    console.log(
      `[tx-size] verify_shuffle_staged p${playerIndex}: ${legacySize} bytes`,
    );
    await timed(`tx:verify_shuffle_staged:p${playerIndex}`, () =>
      authority
        ? this.rpcAuthorityPaid(verifyBuilder, authority)
        : verifyBuilder.rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' }),
    );

    // `verify_shuffle_staged` already copied the deck into `deck_state`.
    // The next player reads that account. The compressed limb archive is a
    // separate 150-transaction copy and is not on this path.

    await timed(`finalize:shuffle:p${playerIndex}`, () =>
      this.finalizeShuffle(playerIndex, authority),
    );
  }

  private shareChunkPda(
    generation: Buffer,
    playerIndex: number,
    street: number,
    chunk: number,
  ): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from('share_chunk'),
        Buffer.from(this.gameId),
        generation,
        Buffer.from([playerIndex]),
        Buffer.from([street]),
        Buffer.from([chunk]),
      ],
      this.lightPokerProgram.programId,
    )[0];
  }

  /**
   * Pay the lane fee payers before share verify starts. The transfers share
   * the seat with `begin_verify_share`, so they are submitted first and land
   * while that transaction confirms.
   */
  prepareShareLanes(authority: web3.Keypair, chunkCount: number, playerIndex: number): {
    lanes: web3.Keypair[];
    submitted: Promise<void>;
    funded: Promise<void>;
  } {
    const lanes = Array.from({ length: chunkCount }, () => web3.Keypair.generate());
    let markSubmitted: () => void = () => undefined;
    let failSubmitted: (error: unknown) => void = () => undefined;
    const submitted = new Promise<void>((resolve, reject) => {
      markSubmitted = resolve;
      failSubmitted = reject;
    });
    const funded = this.fundShareLanes(authority, lanes, playerIndex, markSubmitted).catch((error: unknown) => {
      failSubmitted(error);
      throw error;
    });
    void funded.catch(() => undefined);
    return { lanes, submitted, funded };
  }

  private async fundShareLanesFromVault(
    authority: web3.Keypair,
    lanes: web3.Keypair[],
    playerIndex: number,
    vault: web3.PublicKey,
    fund: number,
    onSubmitted?: () => void,
  ): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const game = await this.fetchLightGameState(gameStatePDA);
    const operator = new web3.PublicKey(game.operator);
    const fundAuth = await this.operatorFundAuth(operator, authority);
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(BigInt(fund));
    const fundBatch = (batch: web3.Keypair[]) => new web3.TransactionInstruction({
      programId: this.lightPokerProgram.programId,
      keys: [
        { pubkey: operator, isSigner: true, isWritable: true },
        { pubkey: gameStatePDA, isSigner: false, isWritable: false },
        { pubkey: playerStatePDA, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        ...batch.map((lane) => ({ pubkey: lane.publicKey, isSigner: false, isWritable: true })),
      ],
      data: Buffer.concat([ixDiscriminator('fund_shuffle_lanes'), amount]),
    });
    const signers = fundAuth.signers;
    for (let i = 0; i < lanes.length; i += SHUFFLE_LANES_PER_TX) {
      const batch = lanes.slice(i, i + SHUFFLE_LANES_PER_TX);
      const send = async (unpaid: web3.Keypair[]) => {
        const latest = await this.provider.connection.getLatestBlockhash('processed');
        await this.submitPayers(
          [fundBatch(unpaid)],
          operator,
          signers,
          fundAuth.walletSigns,
          latest,
        );
      };
      await send(batch);
      if (i === 0) onSubmitted?.();
      await this.waitUntilFunded(batch, fund, send);
    }
  }

  private async fundShareLanes(
    authority: web3.Keypair,
    lanes: web3.Keypair[],
    playerIndex: number,
    onSubmitted?: () => void,
  ): Promise<void> {
    const rent = await this.provider.connection.getMinimumBalanceForRentExemption(32);
    const fund = rent + 10_000;
    const vault = rentVaultFor(authority.publicKey);
    if (vault && lanes.length > 0) {
      await this.pendingShuffleSweep;
      await this.fundShareLanesFromVault(authority, lanes, playerIndex, vault, fund, onSubmitted);
      return;
    }
    const transfers = lanes.map((lane) =>
      web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: lane.publicKey,
        lamports: fund,
      }),
    );
    const latest = await this.provider.connection.getLatestBlockhash('processed');
    const groups = this.packInstructions(transfers, authority.publicKey, latest.blockhash);
    await Promise.all(groups.map((group) =>
      this.submitPayers(group, authority.publicKey, [authority], false, latest),
    ));
    onSubmitted?.();
    const deadline = Date.now() + 8_000;
    let unpaid = lanes.map((_, index) => index);
    while (unpaid.length > 0 && Date.now() < deadline) {
      const infos = await this.provider.connection.getMultipleAccountsInfo(
        unpaid.map((index) => lanes[index]!.publicKey),
        'processed',
      );
      unpaid = unpaid.filter((index, i) => (infos[i]?.lamports ?? 0) < fund);
      if (unpaid.length > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (unpaid.length > 0) {
      throw new Error(`share chunk lanes not funded: ${unpaid.length}`);
    }
  }

  /**
   * Upload every 12-field chunk at once. Each chunk has its own account and fee
   * payer. Funding is one wave, then the writes, then as few street-hash
   * transactions as fit in a packet. Lane rent is swept after this returns.
   */
  private async absorbShareStreets(
    playerIndex: number,
    streets: readonly (readonly bigint[])[],
    authority: web3.Keypair,
    gameState: web3.PublicKey,
    playerState: web3.PublicKey,
    receipt: web3.PublicKey,
    mpcGeneration: bigint | number,
    receiptReady: Promise<void>,
    prepared?: { lanes: web3.Keypair[]; funded: Promise<void> },
  ): Promise<void> {
    const generation = Buffer.alloc(8);
    generation.writeBigUInt64LE(BigInt(mpcGeneration.toString()));
    const chunks: { street: number; index: number; fields: readonly bigint[] }[] = [];
    streets.forEach((fields, street) => {
      for (let offset = 0, index = 0; offset < fields.length; offset += 12, index++) {
        chunks.push({ street, index, fields: fields.slice(offset, offset + 12) });
      }
    });
    const lanes = prepared?.lanes ?? chunks.map(() => web3.Keypair.generate());
    if (lanes.length !== chunks.length) {
      throw new Error(`share lane count ${lanes.length} does not match ${chunks.length} chunks`);
    }
    const programId = this.lightPokerProgram.programId;
    const vault = await this.seatVault(authority.publicKey);
    const budget = () => web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    void receiptReady.catch(() => undefined);
    void (prepared?.funded ?? Promise.resolve()).catch(() => undefined);
    try {
      if (prepared) await prepared.funded;
      else await this.fundShareLanes(authority, lanes, playerIndex);
      await receiptReady;
      const writeChunk = (
        chunk: (typeof chunks)[number],
        lane: web3.Keypair,
        latest: { blockhash: string; lastValidBlockHeight: number },
      ) => {
        const parts: Uint8Array[] = [
          ixDiscriminator('write_share_chunk'),
          generation,
          Uint8Array.from([chunk.street, chunk.index, chunk.fields.length]),
        ];
        for (const field of chunk.fields) parts.push(Uint8Array.from(fieldToBytesBE(field)));
        const write = new web3.TransactionInstruction({
          programId,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
            { pubkey: lane.publicKey, isSigner: true, isWritable: true },
            { pubkey: gameState, isSigner: false, isWritable: false },
            { pubkey: playerState, isSigner: false, isWritable: false },
            {
              pubkey: this.shareChunkPda(generation, playerIndex, chunk.street, chunk.index),
              isSigner: false,
              isWritable: true,
            },
            { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat(parts),
        });
        return this.submitPayers([budget(), write], lane.publicKey, [lane, authority], false, latest);
      };
      const sendMissing = async (
        pending: number[],
        block?: { blockhash: string; lastValidBlockHeight: number },
      ) => {
        if (pending.length === 0) return;
        const hash = block ?? await this.provider.connection.getLatestBlockhash('confirmed');
        const signatures = await Promise.all(
          pending.map((index) => writeChunk(chunks[index]!, lanes[index]!, hash)),
        );
        await this.confirmSubmitted(signatures, hash.lastValidBlockHeight);
      };
      const missing = () => this.missingShareChunks(chunks, generation, playerIndex);
      const latest = await this.provider.connection.getLatestBlockhash('confirmed');
      await sendMissing(chunks.map((_, index) => index), latest);
      const finishIx = (street: number) => {
        const streetChunks = chunks.filter((chunk) => chunk.street === street);
        return new web3.TransactionInstruction({
          programId,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: gameState, isSigner: false, isWritable: false },
            { pubkey: playerState, isSigner: false, isWritable: false },
            { pubkey: receipt, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            ...streetChunks.map((chunk) => ({
              pubkey: this.shareChunkPda(generation, playerIndex, street, chunk.index),
              isSigner: false,
              isWritable: true,
            })),
          ],
          data: Buffer.concat([ixDiscriminator('finish_share_street'), Buffer.from([street])]),
        });
      };
      const finishGroups = this.packInstructions(
        streets.map((_, street) => finishIx(street)),
        authority.publicKey,
        latest.blockhash,
        [budget()],
      );
      const sendFinish = async (block: { blockhash: string; lastValidBlockHeight: number }) => {
        const signatures = await Promise.all(finishGroups.map((group) =>
          this.submitPayers([budget(), ...group], authority.publicKey, [authority], false, block),
        ));
        await this.confirmSubmitted(signatures, block.lastValidBlockHeight);
      };
      // Chunk writes were confirmed above. Finish with a fresh blockhash so the
      // fold is of this upload, not the previous attempt's chunks.
      const finishBlock = await this.provider.connection.getLatestBlockhash('confirmed');
      await sendFinish(finishBlock);
      const streetsReady = async () => {
        const info = await this.provider.connection.getAccountInfo(receipt, 'processed');
        return !!info && info.data.length > 85 && info.data[85] === streets.length;
      };
      const waitReady = async (ms: number) => {
        const readyAt = Date.now() + ms;
        while (Date.now() < readyAt && !(await streetsReady())) await sleep(50);
      };
      await waitReady(800);
      if (!(await streetsReady())) {
        const pending = await missing();
        const again = await this.provider.connection.getLatestBlockhash('confirmed');
        if (pending.length > 0) await sendMissing(pending);
        if (!(await this.provider.connection.getAccountInfo(receipt, 'processed'))) {
          await this.initShareReceipt(playerIndex, mpcGeneration, authority, {
            commitment: 'processed',
            pollMs: 50,
          });
        }
        await sendFinish(again);
        await waitReady(2_000);
      }
      if (!(await streetsReady())) {
        throw new Error(`share streets not hashed for player ${playerIndex}`);
      }
      console.log(
        `[share-street] p${playerIndex} streets=${streets.length} chunks=${chunks.length} parallel`,
      );
    } finally {
      /* lane sweep is already in flight; a failed upload still returns the rent */
      void this.sweepShuffleLanes(authority.publicKey, lanes).catch(() => undefined);
    }
  }

  /** Group instructions into legacy transactions that stay within 1200 bytes. */
  private packInstructions(
    ixs: web3.TransactionInstruction[],
    feePayer: web3.PublicKey,
    blockhash: string,
    prefix: web3.TransactionInstruction[] = [],
  ): web3.TransactionInstruction[][] {
    const fits = (group: web3.TransactionInstruction[]) => {
      const tx = new web3.Transaction({ feePayer, recentBlockhash: blockhash }).add(...prefix, ...group);
      try {
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1200;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/Transaction too large/.test(message)) return false;
        throw error;
      }
    };
    const groups: web3.TransactionInstruction[][] = [];
    let current: web3.TransactionInstruction[] = [];
    for (const ix of ixs) {
      const trial = [...current, ix];
      if (current.length > 0 && !fits(trial)) {
        groups.push(current);
        current = [ix];
      } else {
        current = trial;
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private async missingShareChunks(
    chunks: { street: number; index: number }[],
    generation: Buffer,
    playerIndex: number,
  ): Promise<number[]> {
    const infos = await this.provider.connection.getMultipleAccountsInfo(
      chunks.map((chunk) => this.shareChunkPda(generation, playerIndex, chunk.street, chunk.index)),
      'processed',
    );
    const pending: number[] = [];
    infos.forEach((info, index) => {
      if (!info || !info.owner.equals(this.lightPokerProgram.programId) || info.data.length < 32) {
        pending.push(index);
      }
    });
    return pending;
  }

  private async pollShareChunks(missing: () => Promise<number[]>, timeoutMs: number): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    let pending = await missing();
    while (pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      pending = await missing();
    }
    return pending;
  }

  async verifyShare(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    chunkIndex = 0,
    authority?: web3.Keypair,
    streets?: readonly (readonly bigint[])[],
    prepared?: { lanes: web3.Keypair[]; funded: Promise<void> },
  ): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    // Legacy fused roulette share was 579 pubs and used the staged path.
    // Split share/bet hashouts are 2 pubs; slots share is 10 (outHash + 8 bet limbs + hash).
    if (publicSignals.length > 16) {
      await this.verifyShareStaged(playerIndex, proof, publicSignals, authority);
      return;
    }
    if (publicSignals.length === 10) {
      await this.verifySlotShare(playerIndex, proof, publicSignals, authority);
      return;
    }
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const shareVerifyAcc = this.derivePokerPDA('share_verify_acc', Buffer.from([playerIndex]));
    const acc = await (this.pokerProgram!.account as any).shareVerifyAccumulator.fetch(shareVerifyAcc);
    const proofReceiptPDA = this.deriveShareProofReceipt(playerIndex, acc.generation);
    const deckStatePDA = this.deriveLightPDA('deck_state');
    const outputHash = fieldToBytesBE(publicSignals[0]!);
    const remainingAccounts = await this.playerRemainingAccounts(gameState.numPlayers);

    const receiptReady = streets?.length
      ? this.dispatchShareReceipt(playerIndex, acc.generation, authority!)
      : this.initShareReceipt(playerIndex, acc.generation, authority);
    if (streets?.length) {
      if (!authority) throw new Error('uploading share streets needs the seat authority');
      await timed(`tx:absorb_share_streets:p${playerIndex}:c${chunkIndex}`, () =>
        this.absorbShareStreets(
          playerIndex,
          streets,
          authority,
          gameStatePDA,
          playerStatePDA,
          proofReceiptPDA,
          acc.generation,
          receiptReady,
          prepared,
        ),
      );
    } else {
      await receiptReady;
    }
    const verifyBuilder = (this.lightPokerProgram.methods as any)
      .verifyShare(proofToBytes(proof), outputHash as any, chunkIndex)
      .accounts(
        this.withPokerBridge({
          signer: this.authorityPubkey(authority),
          gameState: gameStatePDA,
          playerState: playerStatePDA,
          deckState: deckStatePDA,
          proofReceipt: proofReceiptPDA,
          shareVerifyAcc,
        }) as any,
      )
      .remainingAccounts(prependVault(this.authorityPubkey(authority), remainingAccounts))
      .preInstructions(verifyBudgetIxs());
    await timed(`tx:verify_share_receipt:p${playerIndex}:c${chunkIndex}`, () =>
      authority
        ? this.rpcAuthorityPaid(
            verifyBuilder,
            authority,
            `verify_share p${playerIndex} c${chunkIndex}`,
            undefined,
            'confirmed',
            'processed',
            streets?.length ? 50 : undefined,
          )
        : verifyBuilder.rpc(),
    );
  }

  async verifySlotShare(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    authority?: web3.Keypair,
  ): Promise<void> {
    if (publicSignals.length !== 10) {
      throw new Error(`slot share expects 10 public signals, got ${publicSignals.length}`);
    }
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const shareVerifyAcc = this.derivePokerPDA('share_verify_acc', Buffer.from([playerIndex]));
    const acc = await (this.pokerProgram!.account as any).shareVerifyAccumulator.fetch(shareVerifyAcc);
    const proofReceiptPDA = this.deriveShareProofReceipt(playerIndex, acc.generation);
    const deckStatePDA = this.deriveLightPDA('deck_state');
    const rouletteBetsPDA = this.deriveLightPDA('roulette_bets', Buffer.from([playerIndex]));
    const outputHash = fieldToBytesBE(publicSignals[0]!);
    const betLimbs = publicSignals.slice(1, 9).map((f) => Array.from(fieldToBytesBE(f)));
    const remainingAccounts = await this.playerRemainingAccounts(gameState.numPlayers);

    await this.initShareReceipt(playerIndex, acc.generation, authority);
    const verifyBuilder = (this.lightPokerProgram.methods as any)
      .verifySlotShare(proofToBytes(proof), outputHash as any, betLimbs)
      .accounts(
        this.withPokerBridge({
          signer: this.authorityPubkey(authority),
          gameState: gameStatePDA,
          playerState: playerStatePDA,
          deckState: deckStatePDA,
          proofReceipt: proofReceiptPDA,
          shareVerifyAcc,
          rouletteBetCommitment: rouletteBetsPDA,
          systemProgram: web3.SystemProgram.programId,
        }) as any,
      )
      .remainingAccounts(prependVault(this.authorityPubkey(authority), remainingAccounts))
      .preInstructions(verifyBudgetIxs());
    await timed(`tx:verify_slot_share:p${playerIndex}`, () =>
      authority ? this.rpcAuthorityPaid(verifyBuilder, authority) : verifyBuilder.rpc(),
    );
  }

  /** Stage + verify a split craps/keno/roulette bet proof; records bet commitment. */
  async verifyBet(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    authority?: web3.Keypair,
  ): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const betInputsPDA = this.deriveLightPDA('bet_inputs', Buffer.from([playerIndex]));
    const rouletteBetsPDA = this.deriveLightPDA('roulette_bets', Buffer.from([playerIndex]));
    const signer = this.authorityPubkey(authority);
    const formattedInputs = this.formatPublicInputs(publicSignals);
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const remainingAccounts = await this.playerRemainingAccounts(gameState.numPlayers);

    await timed(`tx:create_bet_public_inputs:p${playerIndex}`, () =>
      this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .createBetPublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            betPublicInputs: betInputsPDA,
            systemProgram: web3.SystemProgram.programId,
          })
          .remainingAccounts(leadingVaultMeta(signer)),
        authority,
      ),
    );

    await timed(`tx:write_bet_public_inputs:p${playerIndex}`, async () => {
      const chunks: { offset: number; chunk: number[][] }[] = [];
      for (
        let offset = 0;
        offset < formattedInputs.length;
        offset += SHUFFLE_PUBLIC_INPUTS_PER_WRITE
      ) {
        chunks.push({
          offset,
          chunk: formattedInputs.slice(offset, offset + SHUFFLE_PUBLIC_INPUTS_PER_WRITE),
        });
      }
      await mapPool(chunks, shuffleWriteConcurrency(), async ({ offset, chunk }) => {
        await withRetry(
          () =>
            this.rpcAs(
              (this.lightPokerProgram.methods as any)
                .writeBetPublicInputs(offset, flattenPublicInputsChunk(chunk))
                .accounts({
                  signer,
                  gameState: gameStatePDA,
                  playerState: playerStatePDA,
                  betPublicInputs: betInputsPDA,
                }),
              authority,
            ).then(() => undefined),
          { retries: 5, delayMs: 200 },
        );
      });
    });

    const prepareStarts: number[] = [];
    for (let start = 0; start < formattedInputs.length; start += PREPARE_INPUTS_PER_TX) {
      prepareStarts.push(start);
    }
    await timed(`tx:prepare_bet_chunks:p${playerIndex}`, async () => {
      await mapPool(prepareStarts, shufflePrepareConcurrency(), async (start) => {
        await withRetry(
          () =>
            this.rpcAs(
              (this.lightPokerProgram.methods as any)
                .prepareBetChunk(start)
                .accounts({
                  signer,
                  gameState: gameStatePDA,
                  playerState: playerStatePDA,
                  betPublicInputs: betInputsPDA,
                })
                .preInstructions(prepareShuffleChunkBudgetIxs()),
              authority,
            ).then(() => undefined),
          { retries: 5, delayMs: 200 },
        );
      });
    });

    await timed(`tx:verify_bet:p${playerIndex}`, () =>
      this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .verifyBet(proofToBytes(proof))
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            betPublicInputs: betInputsPDA,
            rouletteBetCommitment: rouletteBetsPDA,
            systemProgram: web3.SystemProgram.programId,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions(verifyBudgetIxs()),
        authority,
      ),
    );
    await this.closeBetPublicInputs(playerIndex, authority);
  }

  /** Stage + verify a PvP bingo card-commit proof (not a bet). */
  async verifyCardCommit(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    authority?: web3.Keypair,
  ): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const betInputsPDA = this.deriveLightPDA('bet_inputs', Buffer.from([playerIndex]));
    const rouletteBetsPDA = this.deriveLightPDA('roulette_bets', Buffer.from([playerIndex]));
    const signer = this.authorityPubkey(authority);
    const formattedInputs = this.formatPublicInputs(publicSignals);
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const remainingAccounts = await this.playerRemainingAccounts(gameState.numPlayers);

    await timed(`tx:create_bet_public_inputs:p${playerIndex}`, () =>
      this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .createBetPublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            betPublicInputs: betInputsPDA,
            systemProgram: web3.SystemProgram.programId,
          })
          .remainingAccounts(leadingVaultMeta(signer)),
        authority,
      ),
    );

    await timed(`tx:write_bet_public_inputs:p${playerIndex}`, async () => {
      const chunks: { offset: number; chunk: number[][] }[] = [];
      for (
        let offset = 0;
        offset < formattedInputs.length;
        offset += SHUFFLE_PUBLIC_INPUTS_PER_WRITE
      ) {
        chunks.push({
          offset,
          chunk: formattedInputs.slice(offset, offset + SHUFFLE_PUBLIC_INPUTS_PER_WRITE),
        });
      }
      await mapPool(chunks, shuffleWriteConcurrency(), async ({ offset, chunk }) => {
        await withRetry(
          () =>
            this.rpcAs(
              (this.lightPokerProgram.methods as any)
                .writeBetPublicInputs(offset, flattenPublicInputsChunk(chunk))
                .accounts({
                  signer,
                  gameState: gameStatePDA,
                  playerState: playerStatePDA,
                  betPublicInputs: betInputsPDA,
                }),
              authority,
            ).then(() => undefined),
          { retries: 5, delayMs: 200 },
        );
      });
    });

    const prepareStarts: number[] = [];
    for (let start = 0; start < formattedInputs.length; start += PREPARE_INPUTS_PER_TX) {
      prepareStarts.push(start);
    }
    await timed(`tx:prepare_bet_chunks:p${playerIndex}`, async () => {
      await mapPool(prepareStarts, shufflePrepareConcurrency(), async (start) => {
        await withRetry(
          () =>
            this.rpcAs(
              (this.lightPokerProgram.methods as any)
                .prepareBetChunk(start)
                .accounts({
                  signer,
                  gameState: gameStatePDA,
                  playerState: playerStatePDA,
                  betPublicInputs: betInputsPDA,
                })
                .preInstructions(prepareShuffleChunkBudgetIxs()),
              authority,
            ).then(() => undefined),
          { retries: 5, delayMs: 200 },
        );
      });
    });

    await timed(`tx:verify_card_commit:p${playerIndex}`, () =>
      this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .verifyCardCommit(proofToBytes(proof))
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            betPublicInputs: betInputsPDA,
            rouletteBetCommitment: rouletteBetsPDA,
            systemProgram: web3.SystemProgram.programId,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions(verifyBudgetIxs()),
        authority,
      ),
    );
    await this.closeBetPublicInputs(playerIndex, authority);
  }

  /** Refund `bet_inputs` rent after the hash is stored as a Light account. */
  async closeBetPublicInputs(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const betInputsPDA = this.deriveLightPDA('bet_inputs', Buffer.from([playerIndex]));
    const rouletteBetsPDA = this.deriveLightPDA('roulette_bets', Buffer.from([playerIndex]));
    const lightHelper = new LightProtocolStorageHelper(
      this.lightPokerProgram,
      this.provider,
    );
    await timed(`tx:close_bet_public_inputs:p${playerIndex}`, () =>
      lightHelper.closeBetPublicInputs(
        this.gameId,
        playerIndex,
        {
          gameState: gameStatePDA,
          playerState: playerStatePDA,
          betPublicInputs: betInputsPDA,
          rouletteBetCommitment: rouletteBetsPDA,
        },
        authority,
      ),
    );
  }

  async extendShareChunks(authority?: web3.Keypair): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    await timed('tx:extend_share_chunks', () =>
      this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .extendShareChunks()
          .accounts({
            signer: this.authorityPubkey(authority),
            gameState: gameStatePDA,
          }),
        authority,
      ),
    );
  }

  private async ensureSharePublicInputs(
    gameStatePDA: web3.PublicKey,
    playerStatePDA: web3.PublicKey,
    sharePublicInputsPDA: web3.PublicKey,
    authority?: web3.Keypair,
  ): Promise<void> {
    const signer = this.authorityPubkey(authority);
    let info = await this.provider.connection.getAccountInfo(
      sharePublicInputsPDA,
      'confirmed',
    );
    if (!info) {
      await frontFromVault(this.provider, signer, MAX_CPI_ALLOC, 0, authority);
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .allocateSharePublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            sharePublicInputs: sharePublicInputsPDA,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
      );
      await this.waitForConfirmedAccount(sharePublicInputsPDA, 'share_inputs');
      info = await this.provider.connection.getAccountInfo(
        sharePublicInputsPDA,
        'confirmed',
      );
    }
    if (!info) {
      throw new Error(
        `share_inputs missing after allocate: ${sharePublicInputsPDA.toBase58()}`,
      );
    }
    while (info.data.length < SHARE_STAGING_ACCOUNT_SIZE) {
      const before = info.data.length;
      await frontExtendFromVault(
        this.provider,
        signer,
        info.data.length,
        info.lamports,
        SHARE_STAGING_ACCOUNT_SIZE,
        authority,
      );
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .extendSharePublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            sharePublicInputs: sharePublicInputsPDA,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        info = await this.provider.connection.getAccountInfo(
          sharePublicInputsPDA,
          'confirmed',
        );
        if (info && info.data.length > before) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!info) {
        throw new Error(
          `share_inputs missing during extend: ${sharePublicInputsPDA.toBase58()}`,
        );
      }
      if (info.data.length <= before) {
        throw new Error(
          `share_inputs did not grow past ${before} (target ${SHARE_STAGING_ACCOUNT_SIZE})`,
        );
      }
    }
  }

  /**
   * Roulette share: stage 579 pubs → Arcis-bound Groth16 verify → Light bet store.
   * Same share_verify_acc binding as card games; bets land in compressed artifacts.
   */
  async verifyShareStaged(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    authority?: web3.Keypair,
  ): Promise<void> {
    if (publicSignals.length < ROULETTE_SHARE_PUBLIC_INPUTS) {
      throw new Error(
        `roulette share expects ${ROULETTE_SHARE_PUBLIC_INPUTS} public signals, got ${publicSignals.length}`,
      );
    }
    const signer = this.authorityPubkey(authority);
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const sharePublicInputsPDA = this.deriveLightPDA(
      'share_inputs',
      Buffer.from([playerIndex]),
    );
    const shareVerifyAcc = this.derivePokerPDA('share_verify_acc', Buffer.from([playerIndex]));
    const rouletteBetsPDA = this.deriveLightPDA(
      'roulette_bets',
      Buffer.from([playerIndex]),
    );
    const acc = await (this.pokerProgram!.account as any).shareVerifyAccumulator.fetch(
      shareVerifyAcc,
    );
    const proofReceiptPDA = this.deriveShareProofReceipt(playerIndex, acc.generation);
    const formattedInputs = this.formatPublicInputs(
      publicSignals.slice(0, ROULETTE_SHARE_PUBLIC_INPUTS),
    );

    await timed(`tx:allocate_share_public_inputs:p${playerIndex}`, () =>
      this.ensureSharePublicInputs(
        gameStatePDA,
        playerStatePDA,
        sharePublicInputsPDA,
        authority,
      ),
    );

    await timed(`tx:create_share_public_inputs:p${playerIndex}`, () =>
      this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .createSharePublicInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            sharePublicInputs: sharePublicInputsPDA,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
      ),
    );

    await timed(`tx:write_share_public_inputs:p${playerIndex}`, async () => {
      const chunks: { offset: number; chunk: number[][] }[] = [];
      for (
        let offset = 0;
        offset < formattedInputs.length;
        offset += SHARE_PUBLIC_INPUTS_PER_WRITE
      ) {
        chunks.push({
          offset,
          chunk: formattedInputs.slice(offset, offset + SHARE_PUBLIC_INPUTS_PER_WRITE),
        });
      }
      // Fill-mask staging allows out-of-order landing — fan out write txs.
      await mapPool(chunks, shareWriteConcurrency(), async ({ offset, chunk }) => {
        await withRetry(
          () =>
            this.rpcAs(
              (this.lightPokerProgram.methods as any)
                .writeSharePublicInputs(offset, flattenPublicInputsChunk(chunk))
                .accounts({
                  signer,
                  gameState: gameStatePDA,
                  playerState: playerStatePDA,
                  sharePublicInputs: sharePublicInputsPDA,
                }),
              authority,
            ).then(() => undefined),
          { retries: 5, delayMs: 200 },
        );
      });
    });

    const prepareStarts: number[] = [];
    for (let start = 0; start < ROULETTE_SHARE_PUBLIC_INPUTS; start += PREPARE_INPUTS_PER_TX) {
      prepareStarts.push(start);
    }
    // Disjoint MSM partials — fan out; finalize sums into prepared_g1.
    await timed(`tx:prepare_share_inputs:p${playerIndex}`, async () => {
      const already = await this.provider.connection.getAccountInfo(
        sharePublicInputsPDA,
        'processed',
      );
      const alreadyPrepared =
        already && already.data.length >= SHARE_PREPARED_COUNT_OFFSET + 2
          ? already.data.readUInt16LE(SHARE_PREPARED_COUNT_OFFSET)
          : 0;
      if (alreadyPrepared >= ROULETTE_SHARE_PUBLIC_INPUTS) return;

      await mapPool(prepareStarts, sharePrepareConcurrency(), async (start) => {
        await withRetry(
          () =>
            this.rpcAs(
              (this.lightPokerProgram.methods as any)
                .prepareShareChunk(start)
                .accounts({
                  signer,
                  gameState: gameStatePDA,
                  playerState: playerStatePDA,
                  sharePublicInputs: sharePublicInputsPDA,
                })
                .preInstructions(prepareShuffleChunkBudgetIxs()),
              authority,
            ).then(() => undefined),
          { retries: 5, delayMs: 200 },
        );
      });
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .finalizePrepareShareInputs()
          .accounts({
            signer,
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            sharePublicInputs: sharePublicInputsPDA,
          })
          .preInstructions(finalizePrepareShuffleBudgetIxs()),
        authority,
      );
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const preparedInfo = await this.provider.connection.getAccountInfo(
        sharePublicInputsPDA,
        'confirmed',
      );
      const preparedCount =
        preparedInfo && preparedInfo.data.length >= SHARE_PREPARED_COUNT_OFFSET + 2
          ? preparedInfo.data.readUInt16LE(SHARE_PREPARED_COUNT_OFFSET)
          : 0;
      if (preparedCount === ROULETTE_SHARE_PUBLIC_INPUTS) break;
      if (attempt === 99) {
        throw new Error(
          `share prepared inputs incomplete: ${preparedCount}/${ROULETTE_SHARE_PUBLIC_INPUTS}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await this.initShareReceipt(playerIndex, acc.generation, authority);
    // Pairing + roulette_bets init + Arcis binding exceeds 600k CU.
    const stagedBuilder = (this.lightPokerProgram.methods as any)
      .verifyShareStaged(proofToBytes(proof))
      .accountsPartial(
        this.withPokerBridge({
          signer,
          gameState: gameStatePDA,
          playerState: playerStatePDA,
          sharePublicInputs: sharePublicInputsPDA,
          shareVerifyAcc,
          rouletteBetCommitment: rouletteBetsPDA,
          proofReceipt: proofReceiptPDA,
          systemProgram: web3.SystemProgram.programId,
        }) as any,
      )
      .remainingAccounts(leadingVaultMeta(signer))
      .preInstructions(showdownVerifyBudgetIxs());
    await timed(`tx:verify_share_staged:p${playerIndex}`, () =>
      authority
        ? this.rpcAuthorityPaid(stagedBuilder, authority)
        : stagedBuilder.rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' }),
    );
    // Init of roulette_bets must be confirmed before store_roulette_bets.
    await this.waitForConfirmedAccount(rouletteBetsPDA, 'roulette_bets');

    await this.storeRouletteBets(playerIndex, publicSignals, authority);
  }

  /** Chunk encrypted bet limbs from share pubs into Light compressed artifacts. */
  async storeRouletteBets(
    playerIndex: number,
    publicSignals: bigint[],
    authority?: web3.Keypair,
  ): Promise<void> {
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const sharePublicInputsPDA = this.deriveLightPDA(
      'share_inputs',
      Buffer.from([playerIndex]),
    );
    const rouletteBetsPDA = this.deriveLightPDA(
      'roulette_bets',
      Buffer.from([playerIndex]),
    );
    const lightHelper = new LightProtocolStorageHelper(
      this.lightPokerProgram,
      this.provider,
    );
    const betFields = publicSignals.slice(2, 2 + ROULETTE_BET_LIMBS);
    if (betFields.length < ROULETTE_BET_LIMBS) {
      throw new Error(
        `roulette bets need ${ROULETTE_BET_LIMBS} limbs, got ${betFields.length}`,
      );
    }
    const limbBytes = betFields.map((f) => Uint8Array.from(fieldToBytesBE(f)));
    const player = this.authorityPubkey(authority);
    let chunkIndex = 0;
    for (let start = 0; start < ROULETTE_BET_LIMBS; start += 8) {
      const count = Math.min(8, ROULETTE_BET_LIMBS - start);
      const closes = start + count >= ROULETTE_BET_LIMBS;
      const staged = closes
        ? await this.provider.connection.getAccountInfo(sharePublicInputsPDA, 'confirmed')
        : null;
      const refund = staged?.lamports ?? 0;
      const before = closes
        ? await this.provider.connection.getBalance(player, 'confirmed')
        : 0;
      await timed(`tx:store_roulette_bets:p${playerIndex}:c${chunkIndex}`, () =>
        lightHelper.storeRouletteBetChunk(
          this.gameId,
          playerIndex,
          chunkIndex,
          start,
          count,
          limbBytes.slice(start, start + count),
          {
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            sharePublicInputs: sharePublicInputsPDA,
            rouletteBetCommitment: rouletteBetsPDA,
          },
          authority,
        ),
      );
      // The last chunk closes share staging onto the seat. Put that rent back
      // in the vault that fronted it. Skip when the close already credited the vault.
      if (refund > 0) {
        const after = await this.provider.connection.getBalance(player, 'confirmed');
        const vault = rentVaultFor(player);
        if (vault && after + 20_000 >= before + refund) {
          await depositRentVault(this.provider, vault, refund, authority);
        }
      }
      chunkIndex += 1;
    }
  }

  async finalizeShowdown(playerIndex: number, authority?: web3.Keypair): Promise<void> {
    logHandProgress(`Showdown tx: finalize_showdown sending (seat player ${playerIndex})`);
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const proofReceiptPDA = await this.deriveProofReceipt(3, playerIndex);
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .finalizeShowdown()
        .accounts(
          this.withPokerBridge({
            signer: this.authorityPubkey(authority),
            gameState: gameStatePDA,
            playerState: playerStatePDA,
            proofReceipt: proofReceiptPDA,
          }) as any,
        )
        .remainingAccounts(leadingVaultMeta(this.authorityPubkey(authority))),
      authority,
    );
    logHandProgress(`Showdown tx: finalize_showdown confirmed (seat player ${playerIndex})`);
  }

  /** Record action-derived blackjack hand layout before showdown verify. */
  async recordBlackjackShowdownLayout(
    playerIndex: number,
    handIndex: number,
    playerCardCount: number,
    dealerCardCount: number,
    sourceIndices: number[],
    authority?: web3.Keypair,
  ): Promise<void> {
    if (sourceIndices.length !== 24) {
      throw new Error(`blackjack sourceIndices length ${sourceIndices.length}, expected 24`);
    }
    const gameStatePDA = this.deriveLightPDA('game_state');
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const layoutPDA = web3.PublicKey.findProgramAddressSync([
      Buffer.from('bj_showdown_layout'),
      Buffer.from(this.gameId),
      Buffer.from([playerIndex]),
      Buffer.from([handIndex]),
    ], this.lightPokerProgram.programId)[0];
    const indices = Array.from({ length: 24 }, (_, i) => sourceIndices[i] ?? 0);
    await this.rpcAs(
      (this.lightPokerProgram.methods as any)
        .recordBlackjackShowdownLayout(
          handIndex,
          playerCardCount,
          dealerCardCount,
          indices,
        )
        .accounts({
          signer: this.authorityPubkey(authority),
          gameState: gameStatePDA,
          playerState: playerStatePDA,
          blackjackShowdownLayout: layoutPDA,
          systemProgram: web3.SystemProgram.programId,
        }),
      authority,
    );
  }

  private async stageBingoShowdownRows(
    playerIndex: number,
    bingoShowdownRows: web3.PublicKey,
    gameState: web3.PublicKey,
    playerState: web3.PublicKey,
    deckState: web3.PublicKey,
    showdownMaterial: web3.PublicKey,
    remainingAccounts: web3.AccountMeta[],
    authority?: web3.Keypair,
  ): Promise<void> {
    const existing = await this.provider.connection.getAccountInfo(bingoShowdownRows);
    if (!existing) {
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .initBingoShowdownRows()
          .accounts({
            signer: this.authorityPubkey(authority),
            gameState,
            playerState,
            bingoShowdownRows,
            systemProgram: web3.SystemProgram.programId,
          }),
        authority,
        `tx:init_bingo_showdown_rows:p${playerIndex}`,
      );
    }
    const lutAddresses = remainingAccounts.map((account) => account.pubkey);
    for (let row = 0; row < 12; row++) {
      await this.rpcAsOrLookupTable(
        (this.lightPokerProgram.methods as any)
          .hashBingoShowdownRow(row)
          .accounts({
            signer: this.authorityPubkey(authority),
            gameState,
            playerState,
            deckState,
            showdownMaterial,
            bingoShowdownRows,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions(showdownVerifyBudgetIxs()),
        authority,
        lutAddresses,
        `tx:hash_bingo_showdown_row:p${playerIndex}:r${row}`,
      );
    }
  }

  /**
   * Stage keno's 11 share-row hashes so verify does not carry 20 revealed-card
   * accounts. The rent vault pays for the rows account and takes it back when
   * the proof verifies.
   */
  private async stageKenoShowdownRows(
    playerIndex: number,
    kenoShowdownRows: web3.PublicKey,
    gameState: web3.PublicKey,
    playerState: web3.PublicKey,
    showdownMaterial: web3.PublicKey,
    numPlayers: number,
    cardAccounts: web3.AccountMeta[],
    authority?: web3.Keypair,
  ): Promise<void> {
    const signer = this.authorityPubkey(authority);
    const existing = await this.provider.connection.getAccountInfo(kenoShowdownRows);
    if (!existing) {
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .initKenoShowdownRows()
          .accounts({
            signer,
            gameState,
            playerState,
            kenoShowdownRows,
            systemProgram: web3.SystemProgram.programId,
          })
          .remainingAccounts(leadingVaultMeta(signer)),
        authority,
        `tx:init_keno_showdown_rows:p${playerIndex}`,
      );
    }
    const material = await this.provider.connection.getAccountInfo(showdownMaterial, 'confirmed');
    if (!material || material.data.length < 49) {
      throw new Error('ShowdownMaterialsNotVerified');
    }
    const recipient = material.data[48]!;
    const sharerForRow = (row: number): number => {
      let section = 0;
      for (let sharer = 0; sharer < 12; sharer++) {
        if (sharer === recipient) continue;
        if (section === row) return sharer;
        section += 1;
      }
      throw new Error('keno showdown row');
    };
    let padded = false;
    for (let row = 0; row < 11; row++) {
      const seated = sharerForRow(row) < numPlayers;
      if (!seated && padded) continue;
      if (!seated) padded = true;
      await this.rpcAs(
        (this.lightPokerProgram.methods as any)
          .hashKenoShowdownRow(row)
          .accounts({
            signer,
            gameState,
            playerState,
            showdownMaterial,
            kenoShowdownRows,
          })
          .remainingAccounts(seated ? cardAccounts : [])
          .preInstructions(showdownVerifyBudgetIxs()),
        authority,
        `tx:hash_keno_showdown_row:p${playerIndex}:r${row}`,
      );
    }
  }

  async verifyShowdown(
    playerIndex: number,
    proof: any,
    publicSignals: bigint[],
    authority?: web3.Keypair,
    handIndex = 0,
  ): Promise<void> {
    if (!this.pokerProgram) throw new Error('ShowdownMaterialsNotVerified');
    // The receipt is already consumed. Another verify only resimulates and
    // never reaches pot settlement.
    try {
      const pokerState = await (this.pokerProgram.account as any).gameState.fetch(
        this.derivePokerPDA('game_state'),
      );
      if (pokerState.showdownFinalized || pokerState.showdown_finalized) return;
    } catch {
      // Fall through and submit the receipt.
    }
    const signer = this.authorityPubkey(authority);
    const gameStatePDA = this.deriveLightPDA('game_state');
    const gameState = await this.fetchLightGameState(gameStatePDA);
    const gameKind = Number(gameState.gameKind ?? 0);
    const isRoulette = gameKind === GameKind.Roulette;
    const needsBetCommitment =
      isRoulette
      || gameKind === GameKind.Craps
      || gameKind === GameKind.Keno
      || gameKind === GameKind.Slots
      || gameKind === GameKind.Bingo;
    const isBlackjack = gameKind === GameKind.Blackjack;
    const generation = gameState.generation;
    const generationLe = new BN(generation).toArrayLike(Buffer, 'le', 8);
    const showdownMaterial = web3.PublicKey.findProgramAddressSync(
      [Buffer.from('showdown_material'), Buffer.from(this.gameId), generationLe, Buffer.from([playerIndex])],
      this.pokerProgram.programId,
    )[0];
    const material = await this.provider.connection.getAccountInfo(showdownMaterial, 'confirmed');
    // `ShowdownMaterialCommitment` is game_id, generation, recipient,
    // card_filled_bits, complete (after Anchor's 8-byte discriminator).
    if (!material || material.data.length < 58 || material.data[57] !== 1) {
      throw new Error('ShowdownMaterialsNotVerified');
    }
    const playerStatePDA = this.deriveLightPDA('player', Buffer.from([playerIndex]));
    const deckStatePDA = this.deriveLightPDA('deck_state');
    await this.initShowdownReceipt(playerIndex, authority);
    const proofReceiptPDA = await this.deriveProofReceipt(3, playerIndex);
    const sealedShowdownCoefficients = web3.PublicKey.findProgramAddressSync(
      [Buffer.from('sealed_showdown_coeffs'), signer.toBuffer()],
      this.pokerProgram.programId,
    )[0];
    const rouletteBetCommitment = needsBetCommitment
      ? this.deriveLightPDA('roulette_bets', Buffer.from([playerIndex]))
      : null;
    const blackjackShowdownLayout = isBlackjack
      ? web3.PublicKey.findProgramAddressSync([
          Buffer.from('bj_showdown_layout'),
          Buffer.from(this.gameId),
          Buffer.from([playerIndex]),
          Buffer.from([handIndex]),
        ], this.lightPokerProgram.programId)[0]
      : null;
    const isBingo = gameKind === GameKind.Bingo;
    const bingoShowdownRows = isBingo
      ? web3.PublicKey.findProgramAddressSync([
          Buffer.from('bingo_showdown_rows'),
          Buffer.from(this.gameId),
          Buffer.from([playerIndex]),
        ], this.lightPokerProgram.programId)[0]
      : null;
    const isKeno = gameKind === GameKind.Keno;
    const kenoShowdownRows = isKeno
      ? web3.PublicKey.findProgramAddressSync([
          Buffer.from('keno_showdown_rows'),
          Buffer.from(this.gameId),
          Buffer.from([playerIndex]),
        ], this.lightPokerProgram.programId)[0]
      : null;
    // Poker: sparse in-play indices (holes + board 20..24). Casino: contiguous 0..N.
    // Blackjack verify only attaches *used* RevealedCard metas (from layout) so the
    // legacy tx stays under 1232 bytes; pad slots reuse card 0 on-chain.
    const nShareChunks = Number(gameState.nShareChunks ?? gameState.n_share_chunks ?? 1);
    let cardIndices = showdownCardIndicesForGame(
      gameKind,
      Number(gameState.numPlayers),
      gameKind === GameKind.Bingo
        ? bingoCalledBalls(nShareChunks)
        : Number(gameState.rouletteVariant ?? 0) || undefined,
    );
    if (isBlackjack && blackjackShowdownLayout) {
      const layoutAcc = await (this.lightPokerProgram.account as any)
        .blackjackShowdownLayout
        .fetch(blackjackShowdownLayout);
      const playerCards = Number(layoutAcc.playerCardCount);
      const dealerCards = Number(layoutAcc.dealerCardCount);
      const used = playerCards + dealerCards;
      const sources = Array.from(layoutAcc.sourceIndices as number[]);
      cardIndices = sources.slice(0, used);
      if (!cardIndices.includes(0)) cardIndices.push(0);
    }
    const remainingAccounts = [
      ...(await this.playerRemainingAccounts(gameState.numPlayers)),
      ...cardIndices.map((cardIndex) => ({
        pubkey: web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('RevealedCard'),
            Buffer.from(this.gameId),
            Buffer.from([playerIndex]),
            (() => {
              const bytes = Buffer.alloc(2);
              bytes.writeUInt16LE(cardIndex);
              return bytes;
            })(),
          ],
          this.pokerProgram!.programId,
        )[0],
        isSigner: false,
        isWritable: false,
      })),
    ];
    if (isBingo && bingoShowdownRows) {
      await this.stageBingoShowdownRows(
        playerIndex,
        bingoShowdownRows,
        gameStatePDA,
        playerStatePDA,
        deckStatePDA,
        showdownMaterial,
        remainingAccounts,
        authority,
      );
    }
    const seated = Number(gameState.numPlayers);
    if (isKeno && kenoShowdownRows) {
      await this.stageKenoShowdownRows(
        playerIndex,
        kenoShowdownRows,
        gameStatePDA,
        playerStatePDA,
        showdownMaterial,
        seated,
        remainingAccounts.slice(seated),
        authority,
      );
    }
    const verifyRemaining = isKeno
      ? prependVault(signer, remainingAccounts.slice(0, seated))
      : remainingAccounts;
    logHandProgress(`Showdown tx: verify_showdown_receipt sending (seat player ${playerIndex})`);
    await this.rpcAsOrLookupTable(
      (this.lightPokerProgram.methods as any)
        .verifyShowdownReceipt(
          handIndex,
          proofToBytes(proof),
          fieldToBytesBE(publicSignals[0]!) as any,
        )
        .accounts({
          signer,
          gameState: gameStatePDA,
          playerState: playerStatePDA,
          deckState: deckStatePDA,
          proofReceipt: proofReceiptPDA,
          showdownMaterial,
          sealedShowdownCoefficients,
          rouletteBetCommitment,
          blackjackShowdownLayout,
          bingoShowdownRows,
          kenoShowdownRows,
        })
        .remainingAccounts(verifyRemaining)
        .preInstructions(showdownVerifyBudgetIxs()),
      authority,
      verifyRemaining.map((account) => account.pubkey),
      `verify_showdown_receipt:p${playerIndex}`,
    );
    logHandProgress(`Showdown tx: verify_showdown_receipt confirmed (seat player ${playerIndex})`);
  }

  /**
   * @deprecated Prefer CPI via register/verify when poker bridge accounts are passed.
   * Direct consume requires the `testing` feature on poker (or the cpi_authority signer).
   */
  async consumeRegisterReceipt(playerIndex: number, outputHash: bigint): Promise<void> {
    await this.consumeRegisterReceiptBytes(playerIndex, fieldToBytesBE(outputHash));
  }

  async consumeRegisterReceiptBytes(playerIndex: number, outputHash: number[]): Promise<void> {
    if (!this.pokerProgram) throw new Error('pokerProgram is required to consume receipts');
    const gameStatePDA = this.derivePokerPDA('game_state');
    const playerStatePDA = this.derivePokerPDA('player', Buffer.from([playerIndex]));
    const proofReceiptPDA = await this.deriveProofReceipt(0, playerIndex);
    const cpiAuthority = this.deriveCpiAuthority();

    await this.pokerProgram.methods
      .consumeRegisterReceipt!(playerIndex, outputHash as any)
      .accounts({
        authority: cpiAuthority,
        payer: this.provider.wallet.publicKey,
        gameState: gameStatePDA,
        playerState: playerStatePDA,
        proofReceipt: proofReceiptPDA,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Direct poker consume when light-casino CPI bridge did not write showdown state.
   * Testing builds accept any signer; production must CPI via `finalize_showdown`.
   */
  async consumeProofReceipt(phase: number, playerIndex: number, outputHash: bigint): Promise<void> {
    if (!this.pokerProgram) throw new Error('pokerProgram is required to consume receipts');
    const gameStatePDA = this.derivePokerPDA('game_state');
    const proofReceiptPDA = await this.deriveProofReceipt(phase, playerIndex);

    await this.pokerProgram.methods
      .consumeProofReceipt!(phase, playerIndex, fieldToBytesBE(outputHash) as any)
      .accounts({
        authority: this.provider.wallet.publicKey,
        gameState: gameStatePDA,
        proofReceipt: proofReceiptPDA,
      })
      .rpc();
  }

  private formatPublicInputs(values: Array<string | bigint>): number[][] {
    return publicSignalsToBytes(values);
  }
}

export { OnchainRoomLifecycle } from './room/onchain-room-lifecycle';
export {
  PokerRoomLifecycle,
  BaccaratRoomLifecycle,
  BlackjackRoomLifecycle,
  WarRoomLifecycle,
} from './room/game-room-lifecycle';
