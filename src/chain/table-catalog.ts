/**
 * On-chain room and table lists for the seat toolbar.
 * Labels use the room id, never the room seed.
 */
import { utils, web3 } from '@coral-xyz/anchor';
import { deriveGameRoomId, gameRoomNamespace } from '../room-lifecycle';
import { LOCALNET_RPC_URL } from './localnet-config';
import { assertRpcReady } from './localnet-ready';
import { BUNDLED_CASINO_PROGRAM_ID } from './program-loader';
import { LOCALNET_SHARED_ROOM_SEED, type SharedTableMeta } from './per-seat-client';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from './shared-meta-store';

/** Anchor account discriminator for `Room`. */
export const ROOM_DISCRIMINATOR = Uint8Array.from([156, 199, 67, 27, 222, 23, 185, 94]);

/** `8 + InitSpace(Room)`. */
export const ROOM_ACCOUNT_SIZE = 186;

const ROOM_ID_OFFSET = 8;
const TABLE_COUNT_OFFSET = 8 + 32 + 32 + 32 + 32;
const SMALL_BLIND_OFFSET = TABLE_COUNT_OFFSET + 8;

const TABLE_ID_OFFSET = 8 + 32;
const GAME_KIND_OFFSET = TABLE_ID_OFFSET + 8;
const SEATS_OFFSET = GAME_KIND_OFFSET + 3;
const SEAT_COUNT = 12;
const DEALER_SEAT_OFFSET = SEATS_OFFSET + SEAT_COUNT * 32;
const HAND_IN_PROGRESS_OFFSET = DEALER_SEAT_OFFSET + 1;

const GAME_KIND_NAMES = [
  'poker',
  'baccarat',
  'blackjack',
  'war',
  'roulette',
  'craps',
  'keno',
  'slots',
  'bingo',
] as const;

export type CatalogTable = {
  tableId: string;
  gameKind: string;
  occupied: number;
  handInProgress: boolean;
  label: string;
};

export type CatalogRoom = {
  roomIdHex: string;
  /** Present when this room id matches a seed the client can open. */
  roomSeed: string | null;
  label: string;
  tableCount: number;
  smallBlind: string;
  tables: CatalogTable[];
};

export type TableCatalog = {
  rooms: CatalogRoom[];
  selectedRoomIdHex: string | null;
  selectedTableId: string | null;
};

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('room id must be 32 bytes of hex');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

export function decodeRoomAccount(data: Uint8Array): {
  roomId: Uint8Array;
  tableCount: number;
  smallBlind: bigint;
} | null {
  if (data.length < ROOM_ACCOUNT_SIZE) return null;
  if (!ROOM_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return null;
  const roomId = data.slice(ROOM_ID_OFFSET, ROOM_ID_OFFSET + 32);
  const tableCount = Number(readU64LE(data, TABLE_COUNT_OFFSET));
  const smallBlind = readU64LE(data, SMALL_BLIND_OFFSET);
  if (!Number.isSafeInteger(tableCount) || tableCount < 0 || tableCount > 64) return null;
  return { roomId, tableCount, smallBlind };
}

export function decodeTableAccount(data: Uint8Array): {
  tableId: bigint;
  gameKind: string;
  occupied: number;
  handInProgress: boolean;
} | null {
  if (data.length < HAND_IN_PROGRESS_OFFSET + 1) return null;
  const tableId = readU64LE(data, TABLE_ID_OFFSET);
  const kindByte = data[GAME_KIND_OFFSET] ?? 0;
  const gameKind = GAME_KIND_NAMES[kindByte] ?? `kind ${kindByte}`;
  let occupied = 0;
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const at = SEATS_OFFSET + seat * 32;
    let empty = true;
    for (let b = 0; b < 32; b += 1) {
      if (data[at + b] !== 0) {
        empty = false;
        break;
      }
    }
    if (!empty) occupied += 1;
  }
  return {
    tableId,
    gameKind,
    occupied,
    handInProgress: data[HAND_IN_PROGRESS_OFFSET] === 1,
  };
}

export function roomListLabel(roomId: Uint8Array, tableCount: number): string {
  const ns = gameRoomNamespace(roomId) || 'room';
  const tail = bytesToHex(roomId).slice(-6);
  const tables = tableCount === 1 ? '1 table' : `${tableCount} tables`;
  return `${ns} · ${tail} · ${tables}`;
}

export function tableListLabel(table: {
  tableId: string;
  gameKind: string;
  occupied: number;
  handInProgress: boolean;
}): string {
  const seated = table.occupied === 1 ? '1 seated' : `${table.occupied} seated`;
  const hand = table.handInProgress ? ' · hand open' : '';
  return `Table ${table.tableId} · ${table.gameKind} · ${seated}${hand}`;
}

/** Seeds whose derived room id we can attach to a scanned account. */
export function knownRoomSeeds(): string[] {
  const seeds = [LOCALNET_SHARED_ROOM_SEED];
  for (let generation = 1; generation <= 8; generation += 1) {
    seeds.push(`${LOCALNET_SHARED_ROOM_SEED}-g${generation}`);
  }
  const meta = readTableMeta();
  if (meta?.roomSeed) seeds.push(meta.roomSeed);
  const launch = (globalThis as {
    window?: { __ZK_LAUNCH_CONFIG?: { roomSeed?: string } };
  }).window?.__ZK_LAUNCH_CONFIG?.roomSeed;
  if (typeof launch === 'string' && launch.length > 0) seeds.push(launch);
  return [...new Set(seeds)];
}

export function roomSeedForId(roomIdHex: string, seeds: readonly string[]): string | null {
  for (const seed of seeds) {
    if (bytesToHex(deriveGameRoomId('poker', seed)) === roomIdHex) return seed;
  }
  return null;
}

function tablePda(programId: web3.PublicKey, roomId: Uint8Array, tableId: number): web3.PublicKey {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(tableId));
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('table'), Buffer.from(roomId), idBuf],
    programId,
  )[0];
}

function readTableMeta(): SharedTableMeta | null {
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

function selectedMeta(): { roomIdHex: string | null; tableId: string | null } {
  const meta = readTableMeta();
  return {
    roomIdHex: meta?.roomIdHex ?? null,
    tableId: meta?.tableId ?? null,
  };
}

export async function listTableCatalog(rpcUrl = LOCALNET_RPC_URL): Promise<TableCatalog> {
  await assertRpcReady(rpcUrl);
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const programId = new web3.PublicKey(BUNDLED_CASINO_PROGRAM_ID);
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [{ dataSize: ROOM_ACCOUNT_SIZE }],
  });
  const seeds = knownRoomSeeds();
  const rooms: CatalogRoom[] = [];
  const pending: Array<{ room: CatalogRoom; roomId: Uint8Array; pubkeys: web3.PublicKey[] }> = [];

  for (const account of accounts) {
    const decoded = decodeRoomAccount(account.account.data);
    if (!decoded) continue;
    const roomIdHex = bytesToHex(decoded.roomId);
    const room: CatalogRoom = {
      roomIdHex,
      roomSeed: roomSeedForId(roomIdHex, seeds),
      label: roomListLabel(decoded.roomId, decoded.tableCount),
      tableCount: decoded.tableCount,
      smallBlind: decoded.smallBlind.toString(),
      tables: [],
    };
    const pubkeys: web3.PublicKey[] = [];
    for (let tableId = 0; tableId < decoded.tableCount; tableId += 1) {
      pubkeys.push(tablePda(programId, decoded.roomId, tableId));
    }
    rooms.push(room);
    pending.push({ room, roomId: decoded.roomId, pubkeys });
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
    entry.room.tables = entry.pubkeys.map((_, index) => {
      const info = infos[cursor + index];
      const tableId = String(index);
      const decoded = info ? decodeTableAccount(info.data) : null;
      const row = {
        tableId,
        gameKind: decoded?.gameKind ?? 'poker',
        occupied: decoded?.occupied ?? 0,
        handInProgress: decoded?.handInProgress ?? false,
        label: '',
      };
      row.label = tableListLabel(row);
      return row;
    });
    cursor += entry.pubkeys.length;
  }

  rooms.sort((a, b) => {
    if (a.roomSeed && !b.roomSeed) return -1;
    if (!a.roomSeed && b.roomSeed) return 1;
    return a.label.localeCompare(b.label);
  });

  const selected = selectedMeta();
  return {
    rooms,
    selectedRoomIdHex: selected.roomIdHex,
    selectedTableId: selected.tableId,
  };
}

export async function selectSharedTable(
  roomIdHex: string,
  tableId: string,
  rpcUrl = LOCALNET_RPC_URL,
): Promise<SharedTableMeta> {
  const catalog = await listTableCatalog(rpcUrl);
  const room = catalog.rooms.find((entry) => entry.roomIdHex === roomIdHex.toLowerCase());
  if (!room) throw new Error('That room is not on this chain');
  const table = room.tables.find((entry) => entry.tableId === tableId);
  if (!table) throw new Error('That table is not in this room');
  const previous = readTableMeta();
  const meta: SharedTableMeta = {
    roomSeed: room.roomSeed ?? `room-${room.roomIdHex.slice(0, 8)}`,
    tableId: table.tableId,
    roomIdHex: room.roomIdHex,
  };
  const changed = !previous
    || previous.roomIdHex !== meta.roomIdHex
    || previous.tableId !== meta.tableId;
  writeSharedMeta('shared-table', JSON.stringify(meta, null, 2));
  if (changed) {
    const store = getSharedMetaStore();
    store.remove?.('shared-hand');
    store.remove?.('hand-complete');
  }
  return meta;
}

/** Base58 of the room discriminator, useful if a caller wants a memcmp filter. */
export function roomDiscriminatorBase58(): string {
  return utils.bytes.bs58.encode(Buffer.from(ROOM_DISCRIMINATOR));
}
