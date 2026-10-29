/**
 * Build room, table, whitelist, and SOL-float transactions.
 * The fee payer is always the whitelist admin. This module never deploys programs.
 */
import { AnchorProvider, BN, web3 } from '@coral-xyz/anchor';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
} from '@solana/spl-token';
import {
  GAME_ROOM_TYPES,
  WHITELIST_ADMIN,
  deriveGameRoomId,
  gameRoomNamespace,
  type GameRoomType,
} from '../src/room-lifecycle';
import { loadWhitelistAdminProvider } from '../src/chain/admin-provider';
import { DEVNET_ARCIUM_IN_FLIGHT, KENO_REVEAL_IN_FLIGHT } from '../src/arcium/heap';
import { rentExemptLamports, RENT_LAMPORTS_PER_BYTE } from '../src/chain/fund-sol';
import { BUNDLED_CASINO_PROGRAM_ID, loadCasinoProgram } from '../src/chain/program-loader';
import { shuffleCallerInputs } from '../src/chain/shuffle-account';
import { seatTableLamports } from '../src/chain/table-float';
import {
  ROOM_ACCOUNT_SIZE,
  bytesToHex,
  decodeRoomAccount,
  decodeTableAccount,
  hexToBytes,
  knownRoomSeeds,
  roomListLabel,
} from '../src/chain/table-catalog';
import { GameKind } from '../src/game-config';
import {
  DEPOSIT_RENT_VAULT,
  INIT_RENT_VAULT,
  RENT_VAULT_DATA_LEN,
  clusterRentLamportsPerByte,
  rentVaultFloat,
  rentVaultPda,
} from '../src/chain/rent-vault';
import { LIGHT_CASINO_PROGRAM_ID } from '../src/testing/deploy';
import { KeypairWallet } from '../src/chain/keypair-wallet';

export { GAME_ROOM_TYPES, WHITELIST_ADMIN };

export const CLUSTERS = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
} as const;

export type ClusterId = keyof typeof CLUSTERS;

const LIGHT = new web3.PublicKey(LIGHT_CASINO_PROGRAM_ID);
const CASINO = new web3.PublicKey(BUNDLED_CASINO_PROGRAM_ID);
const MAX_PLAYERS = 16;

const pendingMints = new Map<string, { keypair: web3.Keypair; expires: number }>();

function rememberMint(keypair: web3.Keypair): void {
  const now = Date.now();
  for (const [id, row] of pendingMints) {
    if (row.expires < now) pendingMints.delete(id);
  }
  pendingMints.set(keypair.publicKey.toBase58(), { keypair, expires: now + 120_000 });
}

/** Put the mint signature back if a wallet dropped the partial signature. */
function resignMint(tx: web3.Transaction): void {
  const now = Date.now();
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(web3.SystemProgram.programId)) continue;
    const created = ix.keys[1]?.pubkey;
    if (!created) continue;
    const row = pendingMints.get(created.toBase58());
    if (!row || row.expires < now) continue;
    tx.partialSign(row.keypair);
  }
}
const CREATE_ROOM = Buffer.from([130, 166, 32, 2, 247, 120, 178, 53]);
const CREATE_TABLE = Buffer.from([214, 142, 131, 250, 242, 83, 135, 185]);
const CLOSE_TABLE = Buffer.from([149, 214, 44, 14, 190, 244, 132, 48]);
const ADD_TO_WHITELIST = Buffer.from([157, 211, 52, 54, 144, 81, 5, 55]);

const GAME_KIND: Record<GameRoomType, number> = {
  poker: 0,
  baccarat: 1,
  blackjack: 2,
  war: 3,
  roulette: 4,
  craps: 5,
  keno: 6,
  slots: 7,
  bingo: 8,
};

export type PlanRequest = {
  cluster: ClusterId;
  game: GameRoomType;
  seed: string;
  smallBlind: number;
  openTable: boolean;
  createRoom: boolean;
  whitelist: boolean;
  fund: boolean;
  shoeDecks?: number;
  rouletteVariant?: number;
  players: string[];
  /** Working SOL placed in each player's rent vault. `null` uses this game's float. */
  floatLamports: number | null;
  /** Set when a listed room is selected. Skips deriving the id from the seed. */
  roomIdHex?: string;
  /** When set, the plan only closes this table. */
  closeTableId?: number | null;
};

export type Step = {
  label: string;
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

export type PlayerView = {
  address: string;
  whitelisted: boolean;
  rentVault: string;
  rentVaultLamports: number;
};

export type RoomView = {
  cluster: ClusterId;
  rpc: string;
  game: GameRoomType;
  seed: string;
  roomId: string;
  room: string;
  exists: boolean;
  authority: string | null;
  mint: string | null;
  chipVault: string | null;
  tableCount: number | null;
  smallBlind: string | null;
  rakeBps: number | null;
  tables: { tableId: string; address: string; gameKind: number | null }[];
  players: PlayerView[];
  suggestedFloatLamports: number;
};

export type PlanResult = RoomView & {
  steps: Step[];
  notes: string[];
  depositLamports: number;
};

export function isCluster(value: string): value is ClusterId {
  return value === 'localnet' || value === 'devnet';
}

export function isGame(value: string): value is GameRoomType {
  return (GAME_ROOM_TYPES as readonly string[]).includes(value);
}

export function connectionFor(cluster: ClusterId): web3.Connection {
  return new web3.Connection(CLUSTERS[cluster], 'confirmed');
}

export type FloatQuote = {
  lamports: number;
  callerInputs: number;
  computationSlots: number;
  seatLamports: number;
};

/** Seat vault for this game: shoe-sized shuffle float plus the accounts that seat opens. */
export function quoteGameFloat(
  game: GameRoomType,
  shoeDecks: number | undefined,
  rouletteVariant: number | undefined,
  lamportsPerByte: number,
): FloatQuote {
  const shape = tableShape(game, shoeDecks, rouletteVariant);
  const callerInputs = shuffleCallerInputs(shape.kind, shape.shoe, shape.variant);
  const computationSlots = shape.kind === GameKind.Keno
    ? KENO_REVEAL_IN_FLIGHT
    : DEVNET_ARCIUM_IN_FLIGHT;
  const seatLamports = game === 'poker'
    ? seatTableLamports(lamportsPerByte, { tokenAccount: false, pendingDeposit: false })
    : seatTableLamports(lamportsPerByte);
  return {
    lamports: rentVaultFloat(callerInputs, lamportsPerByte, computationSlots) + seatLamports,
    callerInputs,
    computationSlots,
    seatLamports,
  };
}

export async function quoteGameFloatOnCluster(
  cluster: ClusterId,
  game: GameRoomType,
  shoeDecks?: number,
  rouletteVariant?: number,
): Promise<FloatQuote> {
  const rate = await clusterRentLamportsPerByte(connectionFor(cluster));
  return quoteGameFloat(game, shoeDecks, rouletteVariant, rate);
}

function programFor(connection: web3.Connection) {
  const provider = new AnchorProvider(
    connection,
    new KeypairWallet(web3.Keypair.generate()),
    { commitment: 'confirmed' },
  );
  return loadCasinoProgram(provider);
}

function roomIdBytes(game: GameRoomType, seed: string): Uint8Array {
  return deriveGameRoomId(game, seed);
}

function pda(programId: web3.PublicKey, seeds: Buffer[]): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function roomAccounts(programId: web3.PublicKey, roomId: Uint8Array) {
  const id = Buffer.from(roomId);
  return {
    room: pda(programId, [Buffer.from('room'), id]),
    chipVault: pda(programId, [Buffer.from('vault'), id]),
    table(tableId: bigint): web3.PublicKey {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(tableId);
      return pda(programId, [Buffer.from('table'), id, le]);
    },
    whitelist(player: web3.PublicKey): web3.PublicKey {
      return pda(programId, [Buffer.from('whitelist'), id, player.toBuffer()]);
    },
  };
}

function tableShape(
  game: GameRoomType,
  shoeDecks: number | undefined,
  rouletteVariant: number | undefined,
): { kind: number; shoe: number; variant: number } {
  const kind = GAME_KIND[game];
  if (game === 'poker') return { kind, shoe: 1, variant: 0 };
  if (game === 'baccarat' || game === 'blackjack' || game === 'war') {
    const shoe = shoeDecks === 6 || shoeDecks === 8 ? shoeDecks : 1;
    return { kind, shoe, variant: 0 };
  }
  if (game === 'roulette') {
    return { kind, shoe: 0, variant: rouletteVariant === 38 ? 38 : 37 };
  }
  if (game === 'craps' || game === 'keno') return { kind, shoe: 0, variant: 0 };
  if (game === 'slots') return { kind, shoe: 0, variant: rouletteVariant === 5 ? 5 : 3 };
  return { kind, shoe: 0, variant: rouletteVariant === 90 ? 90 : 75 };
}

function parsePlayers(raw: string[]): web3.PublicKey[] {
  const seen = new Set<string>();
  const out: web3.PublicKey[] = [];
  for (const entry of raw) {
    const text = entry.trim();
    if (!text) continue;
    let key: web3.PublicKey;
    try {
      key = new web3.PublicKey(text);
    } catch {
      throw new Error(`Not a Solana address: ${text}`);
    }
    const id = key.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  if (out.length > MAX_PLAYERS) {
    throw new Error(`Whitelist at most ${MAX_PLAYERS} addresses at a time.`);
  }
  return out;
}

async function pack(
  connection: web3.Connection,
  ixs: web3.TransactionInstruction[],
  extra?: web3.Keypair,
): Promise<Step> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new web3.Transaction({
    feePayer: WHITELIST_ADMIN,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...ixs);
  if (extra) tx.partialSign(extra);
  return {
    label: '',
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

type RoomAccount = {
  authority: web3.PublicKey;
  mint: web3.PublicKey;
  vault: web3.PublicKey;
  tableCount: { toString(): string };
  smallBlindDefault: { toString(): string };
  rakeBps: number;
};

export async function inspectRoom(
  connection: web3.Connection,
  cluster: ClusterId,
  game: GameRoomType,
  seed: string,
  playerKeys: web3.PublicKey[],
  roomIdHex = '',
  shoeDecks?: number,
  rouletteVariant?: number,
): Promise<RoomView> {
  const program = programFor(connection);
  const roomId = roomIdHex ? hexToBytes(roomIdHex) : roomIdBytes(game, seed);
  const accounts = roomAccounts(program.programId, roomId);
  const info = await connection.getAccountInfo(accounts.room, 'confirmed');
  const players = await Promise.all(playerKeys.map(async (player) => {
    const entry = accounts.whitelist(player);
    const vault = rentVaultPda(roomId, player);
    const [entryInfo, vaultInfo] = await Promise.all([
      connection.getAccountInfo(entry, 'confirmed'),
      connection.getAccountInfo(vault, 'confirmed'),
    ]);
    return {
      address: player.toBase58(),
      whitelisted: entryInfo !== null,
      rentVault: vault.toBase58(),
      rentVaultLamports: vaultInfo?.lamports ?? 0,
    };
  }));
  const base: RoomView = {
    cluster,
    rpc: CLUSTERS[cluster],
    game,
    seed,
    roomId: Buffer.from(roomId).toString('hex'),
    room: accounts.room.toBase58(),
    exists: info !== null,
    authority: null,
    mint: null,
    chipVault: accounts.chipVault.toBase58(),
    tableCount: null,
    smallBlind: null,
    rakeBps: null,
    tables: [],
    players,
    suggestedFloatLamports: quoteGameFloat(
      game,
      shoeDecks,
      rouletteVariant,
      RENT_LAMPORTS_PER_BYTE,
    ).lamports,
  };
  if (!info) return base;
  const room = await (program.account as unknown as {
    room: { fetch(address: web3.PublicKey): Promise<RoomAccount> };
  }).room.fetch(accounts.room);
  const tableCount = Number(room.tableCount.toString());
  const tables: RoomView['tables'] = [];
  const shown = Math.min(tableCount, 12);
  for (let i = 0; i < shown; i++) {
    const address = accounts.table(BigInt(i));
    const tableInfo = await connection.getAccountInfo(address, 'confirmed');
    let gameKind: number | null = null;
    if (tableInfo && tableInfo.data.length > 8 + 32 + 8) {
      gameKind = tableInfo.data[8 + 32 + 8] ?? null;
    }
    tables.push({ tableId: String(i), address: address.toBase58(), gameKind });
  }
  return {
    ...base,
    authority: room.authority.toBase58(),
    mint: room.mint.toBase58(),
    chipVault: room.vault.toBase58(),
    tableCount,
    smallBlind: room.smallBlindDefault.toString(),
    rakeBps: Number(room.rakeBps),
    tables,
  };
}

export type RememberedRoom = {
  game: GameRoomType;
  seed: string;
  roomId: string;
};

export type ListedSeat = {
  seat: number;
  player: string | null;
  house: boolean;
  /** SOL this seat needs. The same for every seat of the table. */
  floatLamports: number;
  /** Lamports in the vault this seat draws while someone is sitting. */
  heldLamports: number;
};

export type ListedTable = {
  tableId: string;
  address: string;
  game: string;
  shoeDecks: number;
  variant: number;
  occupied: number;
  handInProgress: boolean;
  exists: boolean;
  floatLamports: number;
  seats: ListedSeat[];
};

export type ListedRoom = {
  room: string;
  roomId: string;
  game: string;
  seed: string | null;
  label: string;
  tableCount: number;
  smallBlind: string;
  floatLamports: number;
  tables: ListedTable[];
};

function matchRoomSeed(
  roomIdHex: string,
  remembered: RememberedRoom[],
): { game: GameRoomType; seed: string } | null {
  const id = roomIdHex.toLowerCase();
  for (const row of remembered) {
    if (row.roomId.toLowerCase() === id && isGame(row.game)) {
      return { game: row.game, seed: row.seed };
    }
  }
  let seeds: string[] = [];
  try {
    seeds = knownRoomSeeds();
  } catch {
    seeds = [];
  }
  for (const row of remembered) seeds.push(row.seed);
  for (const seed of seeds) {
    for (const game of GAME_ROOM_TYPES) {
      if (bytesToHex(deriveGameRoomId(game, seed)) === id) return { game, seed };
    }
  }
  return null;
}

function floatForTable(game: string, shoe: number, variant: number, rate: number): number {
  if (!isGame(game)) return 0;
  return quoteGameFloat(game, shoe, variant, rate).lamports;
}

/** Matches `GameKind::max_players`. Poker 10, blackjack 8, slots 2, otherwise 12. */
function seatCap(game: string): number {
  if (game === 'slots') return 2;
  if (game === 'blackjack') return 8;
  if (game === 'poker') return 10;
  return 12;
}

/** Last physical seat is the house, except poker and bingo. */
function houseSeat(game: string, cap: number): number | null {
  if (game === 'poker' || game === 'bingo') return null;
  if (cap < 1) return null;
  return cap - 1;
}

const TABLE_SEATS_OFFSET = 51;

function seatPlayers(data: Buffer, cap: number): (string | null)[] {
  const players: (string | null)[] = [];
  for (let seat = 0; seat < cap; seat += 1) {
    const start = TABLE_SEATS_OFFSET + seat * 32;
    const bytes = data.subarray(start, start + 32);
    const empty = bytes.every((byte) => byte === 0);
    players.push(empty ? null : new web3.PublicKey(bytes).toBase58());
  }
  return players;
}

/** Every room account on this cluster, with the seat float its largest table needs. */
export async function listClusterRooms(
  cluster: ClusterId,
  remembered: RememberedRoom[] = [],
): Promise<ListedRoom[]> {
  const connection = connectionFor(cluster);
  const programId = new web3.PublicKey(BUNDLED_CASINO_PROGRAM_ID);
  const rate = await clusterRentLamportsPerByte(connection);
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [{ dataSize: ROOM_ACCOUNT_SIZE }],
  });
  const pending: Array<{
    room: ListedRoom;
    pubkeys: web3.PublicKey[];
  }> = [];
  for (const account of accounts) {
    const decoded = decodeRoomAccount(account.account.data);
    if (!decoded) continue;
    const roomId = bytesToHex(decoded.roomId);
    const matched = matchRoomSeed(roomId, remembered);
    const namespace = gameRoomNamespace(decoded.roomId);
    const game = matched?.game ?? (isGame(namespace) ? namespace : namespace || 'room');
    const room: ListedRoom = {
      room: account.pubkey.toBase58(),
      roomId,
      game,
      seed: matched?.seed ?? null,
      label: roomListLabel(decoded.roomId, decoded.tableCount),
      tableCount: decoded.tableCount,
      smallBlind: decoded.smallBlind.toString(),
      floatLamports: isGame(game) ? quoteGameFloat(game, undefined, undefined, rate).lamports : 0,
      tables: [],
    };
    const pubkeys: web3.PublicKey[] = [];
    for (let tableId = 0; tableId < decoded.tableCount; tableId += 1) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(BigInt(tableId));
      pubkeys.push(web3.PublicKey.findProgramAddressSync(
        [Buffer.from('table'), Buffer.from(decoded.roomId), le],
        programId,
      )[0]);
    }
    pending.push({ room, pubkeys });
  }
  const flat = pending.flatMap((entry) => entry.pubkeys);
  const infos: Array<web3.AccountInfo<Buffer> | null> = [];
  for (let at = 0; at < flat.length; at += 100) {
    const slice = flat.slice(at, at + 100);
    if (slice.length === 0) continue;
    infos.push(...await connection.getMultipleAccountsInfo(slice, 'confirmed'));
  }
  let cursor = 0;
  for (const entry of pending) {
    entry.room.tables = entry.pubkeys.map((pubkey, index) => {
      const info = infos[cursor + index];
      const decoded = info ? decodeTableAccount(info.data) : null;
      const exists = info !== null && decoded !== null;
      const game = decoded?.gameKind ?? entry.room.game;
      const shoeDecks = info ? info.data[49] ?? 0 : 0;
      const variant = info ? info.data[50] ?? 0 : 0;
      const floatLamports = exists ? floatForTable(game, shoeDecks, variant, rate) : 0;
      const cap = exists ? seatCap(game) : 0;
      const house = houseSeat(game, cap);
      const players = info && exists ? seatPlayers(info.data, cap) : [];
      return {
        tableId: String(index),
        address: pubkey.toBase58(),
        game,
        shoeDecks,
        variant,
        occupied: decoded?.occupied ?? 0,
        handInProgress: decoded?.handInProgress ?? false,
        exists,
        floatLamports,
        seats: players.map((player, seat) => ({
          seat,
          player,
          house: seat === house,
          floatLamports,
          heldLamports: 0,
        })),
      };
    });
    const live = entry.room.tables.filter((table) => table.exists);
    if (live.length > 0) {
      entry.room.floatLamports = Math.max(...live.map((table) => table.floatLamports));
    }
    cursor += entry.pubkeys.length;
  }
  const seated: Array<{ roomId: Uint8Array; seat: ListedSeat }> = [];
  for (const entry of pending) {
    let roomId: Uint8Array;
    try {
      roomId = hexToBytes(entry.room.roomId);
    } catch {
      continue;
    }
    for (const table of entry.room.tables) {
      for (const seat of table.seats) {
        if (seat.player) seated.push({ roomId, seat });
      }
    }
  }
  for (let at = 0; at < seated.length; at += 100) {
    const slice = seated.slice(at, at + 100);
    const infos = await connection.getMultipleAccountsInfo(
      slice.map((row) => rentVaultPda(row.roomId, new web3.PublicKey(row.seat.player!))),
      'confirmed',
    );
    infos.forEach((info, index) => {
      const row = slice[index];
      if (row) row.seat.heldLamports = info?.lamports ?? 0;
    });
  }
  return pending
    .map((entry) => entry.room)
    .sort((a, b) => a.label.localeCompare(b.label));
}

const WHITELIST_ACCOUNT_SIZE = 72;
const WHITELIST_DISCRIMINATOR = Buffer.from([51, 70, 173, 81, 219, 192, 234, 62]);

export type ListedPlayer = {
  address: string;
};

/** Addresses allowed to sit in this room. Float lives on the seat, not here. */
export async function listRoomWhitelist(cluster: ClusterId, roomIdHex: string): Promise<ListedPlayer[]> {
  const roomId = hexToBytes(roomIdHex.trim().toLowerCase());
  const connection = connectionFor(cluster);
  const programId = new web3.PublicKey(BUNDLED_CASINO_PROGRAM_ID);
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      { dataSize: WHITELIST_ACCOUNT_SIZE },
      {
        memcmp: {
          offset: 0,
          bytes: WHITELIST_DISCRIMINATOR.toString('base64'),
          encoding: 'base64',
        },
      },
      {
        memcmp: {
          offset: 8,
          bytes: Buffer.from(roomId).toString('base64'),
          encoding: 'base64',
        },
      },
    ],
  });
  return accounts.map((account) => ({
    address: new web3.PublicKey(account.account.data.subarray(40, 72)).toBase58(),
  })).sort((a, b) => a.address.localeCompare(b.address));
}

export async function plan(req: PlanRequest): Promise<PlanResult> {
  const seed = req.seed.trim();
  const roomIdHex = (req.roomIdHex ?? '').trim().toLowerCase();
  if (!seed && !roomIdHex) throw new Error('Enter a room seed, or pick a room from the list.');
  if (roomIdHex) hexToBytes(roomIdHex);
  if (!Number.isInteger(req.smallBlind) || req.smallBlind < 0) {
    throw new Error('Small blind has to be a whole number of chips.');
  }
  const players = (req.whitelist || req.fund) ? parsePlayers(req.players) : [];
  if ((req.whitelist || req.fund) && players.length === 0) {
    throw new Error('Add at least one address to whitelist or fund.');
  }
  const connection = connectionFor(req.cluster);
  const program = programFor(connection);
  const roomId = roomIdHex ? hexToBytes(roomIdHex) : roomIdBytes(req.game, seed);
  const accounts = roomAccounts(program.programId, roomId);
  const rate = await clusterRentLamportsPerByte(connection);
  const quote = quoteGameFloat(req.game, req.shoeDecks, req.rouletteVariant, rate);
  const view = await inspectRoom(
    connection,
    req.cluster,
    req.game,
    seed,
    players,
    roomIdHex,
    req.shoeDecks,
    req.rouletteVariant,
  );
  view.suggestedFloatLamports = quote.lamports;
  const notes: string[] = [];
  const steps: Step[] = [];
  let depositLamports = 0;
  const float = req.floatLamports ?? quote.lamports;
  if (!Number.isInteger(float) || float < 0) {
    throw new Error('Float has to be a whole number of lamports.');
  }

  if (req.closeTableId !== undefined && req.closeTableId !== null) {
    if (!view.exists) throw new Error('That room is not on this cluster.');
    const tableId = req.closeTableId;
    if (!Number.isInteger(tableId) || tableId < 0 || tableId >= 64) {
      throw new Error('Pick a table to close.');
    }
    const tableState = accounts.table(BigInt(tableId));
    const info = await connection.getAccountInfo(tableState, 'confirmed');
    if (!info) throw new Error(`Table ${tableId} is already closed.`);
    const ix = await (program.methods as unknown as {
      closeTable(tableId: BN): {
        accounts(accounts: Record<string, web3.PublicKey>): {
          instruction(): Promise<web3.TransactionInstruction>;
        };
      };
    }).closeTable(new BN(tableId)).accounts({
      authority: WHITELIST_ADMIN,
      room: accounts.room,
      tableState,
    }).instruction();
    const step = await pack(connection, [ix]);
    step.label = `Close table ${tableId} at ${tableState.toBase58()}`;
    return { ...view, steps: [step], notes, depositLamports: 0 };
  }

  if (req.createRoom) {
    if (view.exists) {
      notes.push('Room account already exists. Left it in place.');
    } else {
      const mint = web3.Keypair.generate();
      rememberMint(mint);
      const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      const ixs = [
        web3.SystemProgram.createAccount({
          fromPubkey: WHITELIST_ADMIN,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint.publicKey, 6, WHITELIST_ADMIN, null),
        await (program.methods as unknown as {
          createRoom(roomId: number[], smallBlind: BN): {
            accounts(accounts: Record<string, web3.PublicKey>): {
              instruction(): Promise<web3.TransactionInstruction>;
            };
          };
        }).createRoom(Array.from(roomId), new BN(req.smallBlind))
          .accounts({
            authority: WHITELIST_ADMIN,
            room: accounts.room,
            mint: mint.publicKey,
            vault: accounts.chipVault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ];
      const step = await pack(connection, ixs, mint);
      step.label = `Create room ${accounts.room.toBase58()}`;
      steps.push(step);
      notes.push(`New chip mint ${mint.publicKey.toBase58()}.`);
    }
  }

  if ((req.openTable || req.whitelist || req.fund) && !view.exists && !req.createRoom) {
    throw new Error('Create the room before opening a table or whitelisting players.');
  }

  if (req.openTable) {
    const tableId = BigInt(view.tableCount ?? 0);
    const tableState = accounts.table(tableId);
    const shape = tableShape(req.game, req.shoeDecks, req.rouletteVariant);
    const ix = await (program.methods as unknown as {
      createTable(kind: number, shoe: number, variant: number, min: BN, max: BN, unit: BN): {
        accounts(accounts: Record<string, web3.PublicKey>): {
          instruction(): Promise<web3.TransactionInstruction>;
        };
      };
    }).createTable(
      shape.kind,
      shape.shoe,
      shape.variant,
      new BN(0),
      new BN(0),
      new BN(0),
    ).accounts({
      authority: WHITELIST_ADMIN,
      room: accounts.room,
      tableState,
      systemProgram: web3.SystemProgram.programId,
    }).instruction();
    const step = await pack(connection, [ix]);
    step.label = `Open table ${tableId.toString()} at ${tableState.toBase58()}`;
    steps.push(step);
  }

  if (req.whitelist || req.fund) {
    const lamportsPerByte = rate;
    const keep = rentExemptLamports(RENT_VAULT_DATA_LEN, lamportsPerByte) + float;
    for (const player of players) {
      const row = view.players.find((item) => item.address === player.toBase58());
      const ixs: web3.TransactionInstruction[] = [];
      const parts: string[] = [];
      if (req.whitelist && !row?.whitelisted) {
        ixs.push(await (program.methods as unknown as {
          addToWhitelist(roomId: number[]): {
            accounts(accounts: Record<string, web3.PublicKey>): {
              instruction(): Promise<web3.TransactionInstruction>;
            };
          };
        }).addToWhitelist(Array.from(roomId))
          .accounts({
            admin: WHITELIST_ADMIN,
            room: accounts.room,
            playerToWhitelist: player,
            whitelistEntry: accounts.whitelist(player),
            systemProgram: web3.SystemProgram.programId,
          })
          .instruction());
        parts.push('whitelist');
      } else if (req.whitelist) {
        notes.push(`${player.toBase58()} is already on the whitelist.`);
      }
      if (req.fund) {
        const vault = rentVaultPda(roomId, player);
        const existing = row?.rentVaultLamports ?? 0;
        if (existing === 0) {
          ixs.push(new web3.TransactionInstruction({
            programId: LIGHT,
            keys: [
              { pubkey: WHITELIST_ADMIN, isSigner: true, isWritable: true },
              { pubkey: vault, isSigner: false, isWritable: true },
              { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([INIT_RENT_VAULT, Buffer.from(roomId), player.toBuffer()]),
          }));
          if (float > 0) {
            const amount = Buffer.alloc(8);
            amount.writeBigUInt64LE(BigInt(float));
            ixs.push(new web3.TransactionInstruction({
              programId: LIGHT,
              keys: [
                { pubkey: WHITELIST_ADMIN, isSigner: true, isWritable: true },
                { pubkey: vault, isSigner: false, isWritable: true },
                { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
              ],
              data: Buffer.concat([DEPOSIT_RENT_VAULT, amount]),
            }));
            depositLamports += float;
          }
          parts.push('open float');
        } else if (existing < keep && float > 0) {
          const topUp = keep - existing;
          const amount = Buffer.alloc(8);
          amount.writeBigUInt64LE(BigInt(topUp));
          ixs.push(new web3.TransactionInstruction({
            programId: LIGHT,
            keys: [
              { pubkey: WHITELIST_ADMIN, isSigner: true, isWritable: true },
              { pubkey: vault, isSigner: false, isWritable: true },
              { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([DEPOSIT_RENT_VAULT, amount]),
          }));
          depositLamports += topUp;
          parts.push('top up float');
        } else {
          notes.push(`${player.toBase58()} float already covers ${float} lamports.`);
        }
      }
      if (ixs.length === 0) continue;
      const step = await pack(connection, ixs);
      step.label = `${player.toBase58()}: ${parts.join(', ')}`;
      steps.push(step);
    }
  }

  if (steps.length === 0) notes.push('Nothing to send.');
  return { ...view, steps, notes, depositLamports };
}

function startsWith(data: Buffer, prefix: Buffer): boolean {
  return data.length >= prefix.length && data.subarray(0, prefix.length).equals(prefix);
}

/** Refuse to sign anything other than the room, table, whitelist, and float steps. */
export function assertAdminStep(tx: web3.Transaction): void {
  if (!tx.feePayer?.equals(WHITELIST_ADMIN)) {
    throw new Error('Refusing to sign: the fee payer is not the admin key.');
  }
  if (tx.instructions.length === 0) throw new Error('Refusing to sign an empty transaction.');
  for (const ix of tx.instructions) {
    const id = ix.programId;
    if (id.equals(web3.SystemProgram.programId)) {
      if (ix.data.length < 4 || ix.data.readUInt32LE(0) !== 0) {
        throw new Error('Refusing to sign a system transfer.');
      }
      continue;
    }
    if (id.equals(TOKEN_PROGRAM_ID)) {
      if (ix.data[0] !== 0) throw new Error('Refusing to sign a token transfer.');
      continue;
    }
    if (id.equals(CASINO)) {
      const ok = startsWith(ix.data, CREATE_ROOM)
        || startsWith(ix.data, CREATE_TABLE)
        || startsWith(ix.data, CLOSE_TABLE)
        || startsWith(ix.data, ADD_TO_WHITELIST);
      if (!ok) throw new Error('Refusing to sign an unrelated casino instruction.');
      continue;
    }
    if (id.equals(LIGHT)) {
      const ok = startsWith(ix.data, INIT_RENT_VAULT) || startsWith(ix.data, DEPOSIT_RENT_VAULT);
      if (!ok) throw new Error('Refusing to sign an unrelated float instruction.');
      continue;
    }
    throw new Error(`Refusing to sign a call to ${id.toBase58()}.`);
  }
}

export async function executeLocal(cluster: ClusterId, steps: Step[]): Promise<{
  signatures: { label: string; signature: string }[];
}> {
  const connection = connectionFor(cluster);
  const admin = await loadWhitelistAdminProvider(connection, undefined, 0);
  const payer = (admin.wallet as KeypairWallet).payer;
  const signatures: { label: string; signature: string }[] = [];
  for (const step of steps) {
    const tx = web3.Transaction.from(Buffer.from(step.tx, 'base64'));
    assertAdminStep(tx);
    resignMint(tx);
    tx.partialSign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: 'confirmed',
    });
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: step.blockhash,
        lastValidBlockHeight: step.lastValidBlockHeight,
      },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(
        `${step.label} failed: ${JSON.stringify(confirmation.value.err)} (${signature})`,
      );
    }
    signatures.push({ label: step.label, signature });
  }
  return { signatures };
}

export async function sendSigned(
  cluster: ClusterId,
  txBase64: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<string> {
  const connection = connectionFor(cluster);
  const tx = web3.Transaction.from(Buffer.from(txBase64, 'base64'));
  assertAdminStep(tx);
  resignMint(tx);
  const raw = tx.serialize();
  const signature = await connection.sendRawTransaction(raw, {
    preflightCommitment: 'confirmed',
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

export function explain(err: unknown): string {
  if (err instanceof Error) {
    const logs = (err as { logs?: string[] }).logs;
    const tail = logs?.slice(-12).join('\n');
    return tail ? `${err.message}\n${tail}` : err.message;
  }
  return String(err);
}
