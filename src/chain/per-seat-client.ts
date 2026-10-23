/**
 * Per-seat Solana client — no shared LocalnetTableSession.
 *
 * Each caller supplies its own keypair; join/faucet/transfer submit Anchor ixs
 * signed by that seat against a well-known localnet room/table.
 *
 * Browser/WebView safe when meta store + admin secret are configured
 * (see shared-meta-store / admin-provider).
 */
import { AnchorProvider, web3 } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import type { GameSnapshot, SeatSnapshot } from '../backend/types';
import { deriveGameRoomId } from '../room-lifecycle';
import {
  LOCALNET_RPC_URL,
  SOLANA_TABLE_GAME_ID,
  ALLOW_SOFT_BETTING,
} from './localnet-config';
import { assertRpcReady } from './localnet-ready';
import { loadCasinoProgram } from './program-loader';
import { loadWhitelistAdminProvider } from './admin-provider';
import { KeypairWallet } from './keypair-wallet';
import { PokerRoomLifecycle } from './room/game-room-lifecycle';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from './shared-meta-store';
import { isLocalCluster } from './fund-sol';
import { ensureSeatLamports, releasePlayerShareStake } from './share-stake';
import { hasSitChips, MIN_SIT_CHIPS } from './sit-minimum';
import { seatTableLamports } from './table-float';

/**
 * Deterministic room for dual-native / multi-client localnet play.
 * Bumped to v2 after v1 exhausted on-chain table_count past MAX_TABLES_PER_ROOM.
 */
export const LOCALNET_SHARED_ROOM_SEED = 'zk-poker-share-localnet-v2';

/** Matches `poker::room::MAX_TABLES_PER_ROOM` — sit uses a u64 bitfield. */
export const MAX_TABLES_PER_ROOM = 64;

export type SharedTableMeta = {
  roomSeed: string;
  tableId: string;
  roomIdHex: string;
};

function roomIdBytes(roomSeed: string): Uint8Array {
  return deriveGameRoomId('poker', roomSeed);
}

function nextRoomSeed(seed: string): string {
  const m = /^(.*)-g(\d+)$/.exec(seed);
  if (m) return `${m[1]}-g${Number(m[2]) + 1}`;
  return `${seed}-g1`;
}

function isUsableTableId(tableId: string | number | bigint): boolean {
  try {
    const n = typeof tableId === 'bigint' ? tableId : BigInt(tableId);
    return n >= 0n && n < BigInt(MAX_TABLES_PER_ROOM);
  } catch {
    return false;
  }
}

function tableHandInProgress(table: { handInProgress?: boolean; hand_in_progress?: boolean }): boolean {
  return Boolean(table.handInProgress ?? table.hand_in_progress);
}

function emptySeatPk(): web3.PublicKey {
  return web3.PublicKey.default;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function devnetFeePayer(): Promise<web3.Keypair | null> {
  const launch = (globalThis as { window?: { __ZK_LAUNCH_CONFIG?: { feePayerSecret?: number[] } } }).window
    ?.__ZK_LAUNCH_CONFIG;
  const secret = launch?.feePayerSecret;
  if (Array.isArray(secret) && secret.length > 0) {
    return web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  if ((globalThis as { window?: unknown }).window !== undefined) return null;
  try {
    const { loadMxeAuthorityKeypair } = await import('./admin-provider');
    return loadMxeAuthorityKeypair();
  } catch {
    return null;
  }
}

async function ensureAirdrop(
  connection: web3.Connection,
  pubkey: web3.PublicKey,
  minLamports = web3.LAMPORTS_PER_SOL,
): Promise<void> {
  const bal = await connection.getBalance(pubkey);
  if (bal >= minLamports) return;
  if (!isLocalCluster(connection.rpcEndpoint)) {
    const payer = await devnetFeePayer();
    if (!payer) {
      throw new Error(`Seat ${pubkey.toBase58()} needs ${minLamports} lamports and no devnet payer is configured`);
    }
    if (payer.publicKey.equals(pubkey)) return;
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pubkey,
        lamports: minLamports - bal,
      }),
    );
    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, 'confirmed');
    return;
  }
  const sig = await connection.requestAirdrop(pubkey, 2 * web3.LAMPORTS_PER_SOL);
  // confirmTransaction has hung indefinitely in WKWebView; bound + poll balance.
  try {
    await Promise.race([
      connection.confirmTransaction(sig, 'confirmed'),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('airdrop confirm timed out')), 15_000);
      }),
    ]);
  } catch {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await connection.getBalance(pubkey)) >= minLamports) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`Airdrop did not fund ${pubkey.toBase58()} in time`);
  }
}

function hexToRoomId(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Open the room recorded in shared-table.
 * A selected room id overrides the seed so a scanned room still resolves.
 */
export function openPokerRoom(
  pokerProgram: Program,
  provider: AnchorProvider,
  roomSeed?: string,
): PokerRoomLifecycle {
  const meta = loadTableMeta();
  const seed = roomSeed || meta?.roomSeed || LOCALNET_SHARED_ROOM_SEED;
  const room = new PokerRoomLifecycle(pokerProgram, provider, seed);
  const roomId = meta?.roomIdHex ? hexToRoomId(meta.roomIdHex) : null;
  if (roomId) room.roomId = roomId;
  return room;
}

function loadTableMeta(): SharedTableMeta | null {
  const raw = readSharedMeta('shared-table');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SharedTableMeta;
    if (!parsed?.tableId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read-only table identity — never creates rooms/tables (WebView join/register path). */
export function requireSharedTableMeta(): SharedTableMeta {
  const meta = loadTableMeta();
  if (!meta?.tableId) {
    throw new Error(
      'No shared-table meta — run solana-player-cli ensure-room (orchestrator) first',
    );
  }
  return meta;
}

function saveTableMeta(meta: SharedTableMeta): void {
  writeSharedMeta('shared-table', JSON.stringify(meta, null, 2));
}

/**
 * Admin bootstrap: create fixed room + first table if missing.
 * Not a gameplay session — idempotent one-shot for dual clients.
 *
 * On-chain rooms only support table ids `[0, MAX_TABLES_PER_ROOM)`. When the
 * room is full (or meta points at a stale high id), rotate `roomSeed` (`-gN`)
 * and open a new room so sit/join keep working across many E2E_FRESH_TABLE runs.
 */
export async function ensureSharedLocalnetRoom(
  rpcUrl = LOCALNET_RPC_URL,
  opts?: { forceFresh?: boolean },
): Promise<SharedTableMeta> {
  await assertRpcReady(rpcUrl);
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const adminProvider = await loadWhitelistAdminProvider(connection);
  const pokerProgram = loadCasinoProgram(adminProvider);

  const existing = loadTableMeta();
  if (
    !opts?.forceFresh
    && existing?.roomIdHex
    && isUsableTableId(existing.tableId)
    && (typeof process === 'undefined' || process.env?.PER_SEAT_FRESH_TABLE !== '1')
  ) {
    try {
      const selected = openPokerRoom(pokerProgram, adminProvider, existing.roomSeed);
      await selected.fetchTable(BigInt(existing.tableId));
      return existing;
    } catch {
      // The selected room is gone. Allocate the shared room below.
    }
  }
  // Only honor explicit opts / PER_SEAT_FRESH_TABLE — never ambient E2E_FRESH_TABLE.
  // Vite preview inherits E2E_* from the orch and would otherwise create a new
  // table on every ensureSharedLocalnetRoom (wiping seats under native clients).
  const forceFresh = opts?.forceFresh === true
    || (typeof process !== 'undefined' && process.env?.PER_SEAT_FRESH_TABLE === '1');

  let roomSeed =
    existing?.roomSeed
    && (existing.roomSeed === LOCALNET_SHARED_ROOM_SEED
      || existing.roomSeed.startsWith(`${LOCALNET_SHARED_ROOM_SEED}-g`)
      // Accept prior v1 generations so we can detect exhaustion and rotate.
      || existing.roomSeed.startsWith('zk-poker-share-localnet-v1'))
      ? existing.roomSeed
      : LOCALNET_SHARED_ROOM_SEED;

  // Migrate off exhausted v1 rooms immediately.
  if (roomSeed === 'zk-poker-share-localnet-v1'
    || roomSeed.startsWith('zk-poker-share-localnet-v1-')) {
    roomSeed = LOCALNET_SHARED_ROOM_SEED;
  }

  if (
    !forceFresh
    && existing
    && existing.roomSeed === roomSeed
    && isUsableTableId(existing.tableId)
  ) {
    try {
      const room = new PokerRoomLifecycle(pokerProgram, adminProvider, roomSeed);
      await room.fetchTable(BigInt(existing.tableId));
      return existing;
    } catch {
      // recreate below
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const room = new PokerRoomLifecycle(pokerProgram, adminProvider, roomSeed);

    let roomExists = true;
    try {
      await (pokerProgram.account as any).room.fetch(room.roomPDA());
    } catch {
      roomExists = false;
    }

    if (!roomExists) {
      const mint = await room.createSplMint();
      await room.createRoom(mint, adminProvider, room.defaultSmallBlind());
    }

    const roomAccount = await (pokerProgram.account as any).room.fetch(room.roomPDA());
    const tableCount = Number(roomAccount.tableCount ?? roomAccount.table_count ?? 0);

    let tableId: bigint;
    if (tableCount === 0 || forceFresh) {
      // forceFresh always allocates a new empty table — never adopt a live hand
      // (stale Ger/ET7 seats were orphaning new WebView wallets → Register noSeat).
      if (tableCount >= MAX_TABLES_PER_ROOM) {
        roomSeed = nextRoomSeed(roomSeed);
        continue;
      }
      const created = await room.createTable(adminProvider);
      tableId = created.tableId;
      if (!isUsableTableId(tableId)) {
        roomSeed = nextRoomSeed(roomSeed);
        continue;
      }
    } else {
      tableId = BigInt(tableCount - 1);
      if (!isUsableTableId(tableId)) {
        roomSeed = nextRoomSeed(roomSeed);
        continue;
      }
      const latest = await room.fetchTable(tableId);
      // Adopt in-progress hand only when NOT force-fresh (gameplay getGame path).
      if (tableHandInProgress(latest as { handInProgress?: boolean })) {
        // adopt tableId (= tableCount - 1)
      }
    }

    const meta: SharedTableMeta = {
      roomSeed,
      tableId: tableId.toString(),
      roomIdHex: bytesToHex(roomIdBytes(roomSeed)),
    };
    saveTableMeta(meta);
    // Drop hand meta from a prior table so lobby snapshots stay in lobby.
    if (forceFresh || !existing || existing.tableId !== meta.tableId || existing.roomSeed !== meta.roomSeed) {
      getSharedMetaStore().remove?.('shared-hand');
    }
    return meta;
  }

  throw new Error(
    `Unable to allocate a localnet table under ${MAX_TABLES_PER_ROOM} ids `
    + `(last roomSeed=${roomSeed})`,
  );
}

async function buildSnapshot(
  room: PokerRoomLifecycle,
  pokerProgram: Program,
  tableId: bigint,
): Promise<GameSnapshot> {
  const table = await room.fetchTable(tableId);
  const seatsRaw = table.seats as web3.PublicKey[];
  const seats: SeatSnapshot[] = [];

  for (let i = 0; i < seatsRaw.length; i++) {
    const pk = seatsRaw[i]!;
    if (pk.equals(emptySeatPk())) continue;

    let personal = 0n;
    let seatBal = 0n;
    let locked = false;
    try {
      const rw = await room.fetchRoomWallet(pk);
      personal = BigInt(rw.balanceU64?.toString?.() ?? rw.balance_u64?.toString?.() ?? '0');
    } catch {
      /* no room wallet yet */
    }
    try {
      const escrow = await (pokerProgram.account as any).tableEscrow.fetch(
        room.tableEscrowPDA(pk, tableId),
      );
      seatBal = BigInt(
        escrow.balanceU64?.toString?.() ?? escrow.balance_u64?.toString?.() ?? '0',
      );
    } catch {
      /* no escrow */
    }
    try {
      const rw = await room.fetchRoomWallet(pk);
      locked = Boolean(rw.lockedAtTable ?? rw.locked_at_table);
    } catch {
      /* ignore */
    }

    seats.push({
      seat: i,
      name: `Seat ${i}`,
      publicKey: pk.toBase58(),
      chips: seatBal.toString(),
      personalEscrow: personal.toString(),
      seatEscrow: seatBal.toString(),
      seatLocked: locked,
      bet: '0',
      folded: false,
      active: true,
    });
  }

  const dealerRaw = Number(table.dealerSeat ?? table.dealer_seat ?? 0);

  return {
    gameId: SOLANA_TABLE_GAME_ID,
    backend: 'solana',
    phase: 'lobby',
    dealerSeat: Number.isFinite(dealerRaw) && dealerRaw >= 0 ? dealerRaw : 0,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '10',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats,
    pots: [{ amount: '0', lastBet: '0' }],
    bettingMode: ALLOW_SOFT_BETTING ? 'soft' : 'arcium-mpc',
    mpcBettingUsed: false,
  };
}

export class PerSeatClient {
  private constructor(
    readonly rpcUrl: string,
    readonly keypair: web3.Keypair,
    readonly provider: AnchorProvider,
    readonly pokerProgram: Program,
    readonly room: PokerRoomLifecycle,
    readonly tableId: bigint,
  ) {}

  static async create(
    secretKey: Uint8Array,
    rpcUrl = LOCALNET_RPC_URL,
  ): Promise<PerSeatClient> {
    await assertRpcReady(rpcUrl);
    // Never ensureSharedLocalnetRoom here — a cache-miss ensure adopted stale
    // roomSeed v2 / table 63 and overwrote the orch's fresh g3 table, so new
    // wallets saw Ger/ET7 seats and Register stayed noSeat.
    const meta = requireSharedTableMeta();
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const keypair = web3.Keypair.fromSecretKey(secretKey);
    await ensureAirdrop(connection, keypair.publicKey);
    const provider = new AnchorProvider(
      connection,
      new KeypairWallet(keypair),
      { commitment: 'confirmed' },
    );
    const pokerProgram = loadCasinoProgram(provider);
    const room = openPokerRoom(pokerProgram, provider, meta.roomSeed);
    return new PerSeatClient(
      rpcUrl,
      keypair,
      provider,
      pokerProgram,
      room,
      BigInt(meta.tableId),
    );
  }

  get publicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  async snapshot(): Promise<GameSnapshot> {
    const snap = await buildSnapshot(this.room, this.pokerProgram, this.tableId);
    return this.withPersonalBalance(snap);
  }

  private async personalBalance(): Promise<bigint> {
    try {
      const rw = await this.room.fetchRoomWallet(this.keypair.publicKey);
      return BigInt(rw.balanceU64?.toString?.() ?? rw.balance_u64?.toString?.() ?? '0');
    } catch {
      return 0n;
    }
  }

  private async withPersonalBalance(snap: GameSnapshot): Promise<GameSnapshot> {
    const balance = await this.personalBalance();
    return { ...snap, callerPersonalEscrow: balance.toString() };
  }

  private async ensureWhitelisted(): Promise<void> {
    const entry = this.room.whitelistPDA(this.keypair.publicKey);
    const info = await this.provider.connection.getAccountInfo(entry);
    if (info) return;
    const admin = await loadWhitelistAdminProvider(this.provider.connection);
    await this.room.addToWhitelist(this.keypair.publicKey, admin);
  }

  private async ensureRoomWallet(): Promise<void> {
    const pda = this.room.roomWalletPDA(this.keypair.publicKey);
    const info = await this.provider.connection.getAccountInfo(pda);
    if (info) return;
    await this.room.initRoomWallet(this.keypair);
  }

  /**
   * Sit at physical seat. The personal account must already hold the minimum
   * chips, which are moved onto the seat. Passing `chips` faucets that amount
   * first for automated setup.
   */
  async join(seat: number, chips?: bigint): Promise<GameSnapshot> {
    if (seat < 0 || seat > 9) {
      throw new Error(`Invalid seat ${seat}`);
    }
    await this.ensureWhitelisted();
    await this.ensureRoomWallet();
    await ensureSeatLamports(
      this.provider.connection,
      this.keypair,
      seatTableLamports(undefined, { tokenAccount: false, pendingDeposit: false }) + 50_000,
    );

    const table = await this.room.fetchTable(this.tableId);
    const seats = table.seats as web3.PublicKey[];
    const occupied = seats[seat];
    if (occupied && !occupied.equals(emptySeatPk())
      && !occupied.equals(this.keypair.publicKey)) {
      throw new Error(`Seat ${seat} occupied by ${occupied.toBase58()}`);
    }

    let bring = 0n;
    if (chips !== undefined && chips > 0n) {
      if (!hasSitChips(chips)) {
        throw new Error(`Sit requires at least ${MIN_SIT_CHIPS} chips`);
      }
      await this.faucet(chips);
      bring = chips;
    } else if (!occupied || occupied.equals(emptySeatPk())) {
      bring = await this.personalBalance();
      if (!hasSitChips(bring)) {
        throw new Error(
          `Sit requires at least ${MIN_SIT_CHIPS} chips in your account. Use the faucet first.`,
        );
      }
    }

    if (!occupied || occupied.equals(emptySeatPk())) {
      await this.room.sitAtTable(this.tableId, seat, 0n, this.keypair);
    }

    if (bring > 0n) {
      await this.transferToSeat(bring);
    }
    return this.snapshot();
  }

  /**
   * Leave the seat. `leave_table` refuses a non-zero seat balance, so chips
   * move back to the personal account first.
   */
  async stand(): Promise<GameSnapshot> {
    const seatChips = await this.seatEscrowBalance();
    if (seatChips > 0n) {
      await this.room.transferSeatToPersonal(this.tableId, seatChips, this.keypair);
    }
    await this.room.leaveTable(this.tableId, this.keypair.publicKey);
    await releasePlayerShareStake(this.provider.connection, this.keypair).catch(() => undefined);
    return this.snapshot();
  }

  private async seatEscrowBalance(): Promise<bigint> {
    try {
      const escrow = await (this.pokerProgram.account as any).tableEscrow.fetch(
        this.room.tableEscrowPDA(this.keypair.publicKey, this.tableId),
      );
      return BigInt(
        escrow.balanceU64?.toString?.() ?? escrow.balance_u64?.toString?.() ?? '0',
      );
    } catch {
      return 0n;
    }
  }

  /** Keep the seat and chips, and drop the in-hand flag between hands. */
  async sitOut(): Promise<GameSnapshot> {
    await this.room.sitOut(this.tableId, this.keypair);
    return this.snapshot();
  }

  async faucet(amount: bigint): Promise<GameSnapshot> {
    await this.ensureWhitelisted();
    await this.ensureRoomWallet();
    await this.room.faucetCreditPersonal(this.keypair, amount);
    return this.snapshot();
  }

  async transferToSeat(amount: bigint): Promise<GameSnapshot> {
    await this.room.transferPersonalToSeat(this.tableId, amount, this.keypair);
    return this.snapshot();
  }

  async transferToPersonal(amount: bigint): Promise<GameSnapshot> {
    await this.room.transferSeatToPersonal(this.tableId, amount, this.keypair);
    return this.snapshot();
  }
}

/** Empty lobby when shared-table is not ready yet (bootstrap before ensureRoom). */
function emptyLobbySnapshot(): GameSnapshot {
  return {
    gameId: SOLANA_TABLE_GAME_ID,
    backend: 'solana',
    phase: 'lobby',
    dealerSeat: 0,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '10',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [],
    pots: [{ amount: '0', lastBet: '0' }],
    bettingMode: ALLOW_SOFT_BETTING ? 'soft' : 'arcium-mpc',
    mpcBettingUsed: false,
  };
}

/** Read-only table snapshot (any connection; no seat key required). */
export async function fetchSharedTableSnapshot(
  rpcUrl = LOCALNET_RPC_URL,
): Promise<GameSnapshot> {
  // Prefer existing shared-table meta — never ensure()/createTable from getGame.
  // A cache-miss ensure mid-Register orphans the hand (shared-table → N+1, lobby).
  const meta = loadTableMeta();
  if (!meta || !isUsableTableId(meta.tableId)) {
    return emptyLobbySnapshot();
  }
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  // Read-only: do not require whitelist admin (launch-config may be wiped by vite build).
  // Prefer admin when available so account layouts match; else use an ephemeral wallet.
  let provider: AnchorProvider;
  try {
    provider = await loadWhitelistAdminProvider(connection);
  } catch {
    const ephemeral = web3.Keypair.generate();
    provider = new AnchorProvider(connection, new KeypairWallet(ephemeral), {
      commitment: 'confirmed',
    });
  }
  const pokerProgram = loadCasinoProgram(provider);
  const room = openPokerRoom(pokerProgram, provider, meta.roomSeed);
  return buildSnapshot(room, pokerProgram, BigInt(meta.tableId));
}

export function parseSecretKey(raw: unknown): Uint8Array {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      return Uint8Array.from(JSON.parse(trimmed) as number[]);
    }
    throw new Error('secretKey must be a JSON number array');
  }
  if (Array.isArray(raw)) {
    return Uint8Array.from(raw as number[]);
  }
  throw new Error('secretKey required (number[])');
}
