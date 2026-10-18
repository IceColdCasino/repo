/**
 * Per-seat hand ops — begin / register / shuffle / share / bet / showdown / advance
 * without LocalnetTableSession.
 *
 * Gameplay path: on-chain accounts + process-local `MpcKeyStore` (random X25519).
 * shared-hand.json is optional tooling mirror only — not required for WebView.
 */
import { AnchorProvider, BN, web3, type Program } from '@coral-xyz/anchor';
import {
  encryptBetPayload,
  generateTableEncryptionKey,
  type TableEncryptionKey,
} from '../bet-encryption';
import {
  InMemoryMpcKeyStore,
  MPC_KEY_PURPOSE_CODE,
  tableKeyFromRecord,
} from '../mpc-key-store';
import {
  flattenShareCiphertexts,
  toTwoPlayerRecipientCardMajorShareValues,
  shareValuesToCommitments,
  encryptCommitmentRowsForStaging,
  encryptRecipientMajorRowsForStaging,
} from './share-deck-staging';
import type { Ciphertext } from '../zk-casino';
import { pokerStreetFieldGroups, shareStreetChunkCount } from '../share-street-fields';
import { resolveEncryptedBetAmount } from './bet-amount';
import { ALLOW_SOFT_SHOWDOWN, LOCALNET_RPC_URL } from './localnet-config';
import {
  ensureSharedLocalnetRoom,
  LOCALNET_SHARED_ROOM_SEED,
} from './per-seat-client';
import { assertRpcReady } from './localnet-ready';
import { loadLightCasinoProgram, loadCasinoProgram } from './program-loader';
import { loadWhitelistAdminProvider } from './admin-provider';
import { KeypairWallet } from './keypair-wallet';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from './shared-meta-store';
import {
  PROOF_PHASE_REGISTER,
  PROOF_PHASE_SHARE,
  PROOF_PHASE_SHUFFLE,
  buildZkCryptoFromDeck,
  fetchDeckJsonFromChain,
  fetchElGamalKeysFromChain,
  clearHandCompleteMeta,
  loadHandCompleteMeta,
  resolveActiveHandFromChain,
  saveHandCompleteMeta,
  type ActiveHandContext,
} from './per-seat-chain-hand';
import { PokerRoomLifecycle } from './room/game-room-lifecycle';
import { DeckStagingHelper, RevealedCardsHelper } from './staging';
import { LightProtocolStorageHelper } from './light-storage';
import { OnchainGameLifecycle } from './onchain-game-lifecycle';
import { ArciumMPCHelper } from '../arcium/mpc';
import { ArciumPollingHelper } from '../arcium/polling';
import {
  holeCardIndices,
  dealCardCount,
  shareCardMask,
  usedCardIndices,
  visibleDealIndicesForViewerPhase,
} from '../backend/card-layout';
import {
  assertCardRevealAllowed,
  expectedRevealLimbCount,
} from '../backend/reveal-policy';
import {
  buildHandResult,
  potResultsFromWinnerMasks,
  type HandResultSnapshot,
} from '../backend/hand-result';
import type { ZkRevealSnapshot, ZkShowdownMaterials } from '../backend/zk-serialize';
import {
  applyStreetBetAction,
  clearStreetBetsMeta,
  seedStreetBetsMeta,
  streetBetForPlayer,
} from './street-bets-meta';
import {
  encryptWinnerMasksWithSealedKey,
  openSealedShowdown,
} from '../showdown-sealed-coeffs';
import { potMasksFromFolded } from '../backend/zk-crypto-context';
import { TOTAL_CARDS } from '../poker-game';
import {
  loadShareCiphertexts,
  refreshShareCiphertexts,
  entriesFromPersistedShareCiphertexts,
} from './share-ciphertexts-meta';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const ACTION_MAP: Record<string, number> = {
  fold: 0,
  check: 1,
  call: 2,
  bet: 3,
  raise: 4,
  'all-in': 5,
};

const BETTING_PHASES: Record<string, number> = {
  PreFlop: 1,
  Flop: 2,
  Turn: 3,
  River: 4,
  Showdown: 5,
};

const STREET_ACTED_META_KEY = 'street-acted';

type StreetActedMeta = {
  gameIdHex: string;
  bettingPhase: number;
  actedMask: number;
};

type ShowdownSealMeta = {
  gameIdHex: string;
  playerIndex: number;
  ciphertexts: number[][];
  nonce: string;
  key: {
    publicKey: number[];
    nonceBase: string;
  };
};

export function loadStreetActedMeta(): StreetActedMeta | null {
  const raw = readSharedMeta(STREET_ACTED_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreetActedMeta;
  } catch {
    return null;
  }
}

function saveStreetActedMeta(meta: StreetActedMeta): void {
  writeSharedMeta(STREET_ACTED_META_KEY, JSON.stringify(meta));
}

function clearStreetActedMeta(): void {
  try {
    writeSharedMeta(STREET_ACTED_META_KEY, '');
  } catch {
    // ignore
  }
}

function showdownSealMetaKey(gameIdHex: string, playerIndex: number): string {
  return `showdown-seal-${gameIdHex}-${playerIndex}`;
}

/** Native E2E IPC: host-zk writes, WebView reads. Not the public seal-meta shape. */
const E2E_SHOWDOWN_COEFFS_KEY = 'e2e-showdown-coeffs';

function pokerSealedCoefficients(coeffs: string[] | undefined): string[] | null {
  if (!coeffs || coeffs.length !== 2) {
    return null;
  }
  return coeffs.slice(0, 2);
}

function saveE2eShowdownCoeffs(
  gameIdHex: string,
  playerIndex: number,
  coeffs: string[],
  sealKey?: { publicKey: number[]; privateKey: number[]; nonceBase: string },
): void {
  const poker = pokerSealedCoefficients(coeffs);
  if (!poker) {
    return;
  }
  writeSharedMeta(
    E2E_SHOWDOWN_COEFFS_KEY,
    JSON.stringify({
      gameIdHex,
      playerIndex,
      decryptedCoefficients: poker,
      ...(sealKey ? { key: sealKey } : {}),
    }),
  );
}

function loadE2eShowdownCoeffs(
  gameIdHex: string,
  playerIndex: number,
): string[] | null {
  const raw = readSharedMeta(E2E_SHOWDOWN_COEFFS_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      gameIdHex?: string;
      playerIndex?: number;
      decryptedCoefficients?: string[];
    };
    if (parsed.gameIdHex !== gameIdHex || parsed.playerIndex !== playerIndex) {
      return null;
    }
    return pokerSealedCoefficients(parsed.decryptedCoefficients);
  } catch {
    return null;
  }
}

/** In-process seal reuse — never write private keys / coeffs to shared disk meta. */
const showdownSealMemory = new Map<string, {
  decryptedCoefficients: string[];
  privateKey?: number[];
}>();

function saveShowdownSealMeta(
  meta: ShowdownSealMeta & { decryptedCoefficients: string[]; privateKey?: number[] },
): void {
  const key = showdownSealMetaKey(meta.gameIdHex, meta.playerIndex);
  showdownSealMemory.set(key, {
    decryptedCoefficients: meta.decryptedCoefficients,
    privateKey: meta.privateKey,
  });
  // Public ciphertext metadata only (no private key / plaintext coeffs).
  writeSharedMeta(
    key,
    JSON.stringify({
      gameIdHex: meta.gameIdHex,
      playerIndex: meta.playerIndex,
      ciphertexts: meta.ciphertexts,
      nonce: meta.nonce,
      key: meta.key,
    } satisfies ShowdownSealMeta),
  );
  saveE2eShowdownCoeffs(
    meta.gameIdHex,
    meta.playerIndex,
    meta.decryptedCoefficients,
    meta.privateKey?.length
      ? {
          publicKey: meta.key.publicKey,
          privateKey: meta.privateKey,
          nonceBase: meta.key.nonceBase,
        }
      : undefined,
  );
}

async function readShowdownMaterialComplete(
  connection: web3.Connection,
  arcium: ArciumMPCHelper,
  gameId: Uint8Array,
  playerIndex: number,
): Promise<boolean> {
  const pda = arcium.deriveShowdownMaterialCommitment(gameId, new BN(0), playerIndex);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  // Layout: 8-byte discriminator + game_id + generation + recipient +
  // card_filled_bits + complete. Byte 57 is `complete`.
  return Boolean(info && info.data.length >= 58 && info.data[57] === 1);
}

function loadShowdownSealMeta(
  gameIdHex: string,
  playerIndex: number,
): (ShowdownSealMeta & { decryptedCoefficients?: string[] }) | null {
  const key = showdownSealMetaKey(gameIdHex, playerIndex);
  const mem = showdownSealMemory.get(key);
  const fromMem = pokerSealedCoefficients(mem?.decryptedCoefficients);
  if (fromMem) {
    return {
      gameIdHex,
      playerIndex,
      ciphertexts: [],
      nonce: '0',
      key: { publicKey: [], nonceBase: '0' },
      decryptedCoefficients: fromMem,
    };
  }
  const fromE2e = loadE2eShowdownCoeffs(gameIdHex, playerIndex);
  if (fromE2e) {
    return {
      gameIdHex,
      playerIndex,
      ciphertexts: [],
      nonce: '0',
      key: { publicKey: [], nonceBase: '0' },
      decryptedCoefficients: fromE2e,
    };
  }
  return null;
}

function loadShowdownSealKey(
  gameIdHex: string,
  playerIndex: number,
): TableEncryptionKey | null {
  const keyName = showdownSealMetaKey(gameIdHex, playerIndex);
  const mem = showdownSealMemory.get(keyName);
  let privateKey = mem?.privateKey;
  if (!privateKey?.length) {
    // A WebView reload drops the in-memory key. The e2e coeff file keeps it
    // so settlement can still open the seal that is already on chain.
    try {
      const raw = readSharedMeta(E2E_SHOWDOWN_COEFFS_KEY);
      const parsed = raw
        ? JSON.parse(raw) as {
            gameIdHex?: string;
            playerIndex?: number;
            key?: { privateKey?: number[] };
          }
        : null;
      if (
        parsed?.gameIdHex === gameIdHex
        && parsed.playerIndex === playerIndex
        && parsed.key?.privateKey?.length
      ) {
        privateKey = parsed.key.privateKey;
      }
    } catch {
      privateKey = undefined;
    }
  }
  if (!privateKey?.length) return null;
  const raw = readSharedMeta(keyName);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ShowdownSealMeta;
    if (parsed.gameIdHex !== gameIdHex || !parsed.key?.publicKey?.length) return null;
    return {
      publicKey: Uint8Array.from(parsed.key.publicKey),
      privateKey: Uint8Array.from(privateKey),
      nonceBase: BigInt(parsed.key.nonceBase),
    };
  } catch {
    return null;
  }
}

function clearShowdownSealMeta(gameIdHex: string, playerIndex: number): void {
  const key = showdownSealMetaKey(gameIdHex, playerIndex);
  showdownSealMemory.delete(key);
  try {
    writeSharedMeta(key, '');
  } catch {
    // ignore
  }
}

/**
 * Seed acted mask when a street opens.
 * Empty on every street — BB still has the option after a preflop call
 * (on-chain `acted_mask` is the source of truth after each bet callback).
 */
export function seedStreetActedMeta(opts: {
  gameIdHex: string;
  bettingPhase: number;
  numPlayers: number;
}): void {
  void opts.numPlayers;
  saveStreetActedMeta({
    gameIdHex: opts.gameIdHex,
    bettingPhase: opts.bettingPhase,
    actedMask: 0,
  });
}

/** True when every non-folded player has acted this street (client-tracked). */
export function isStreetBettingClosed(
  gameIdHex: string,
  bettingPhase: number,
  numPlayers: number,
  foldedMask: number,
): boolean {
  if (bettingPhase < 1 || bettingPhase > 4) return false;
  const meta = loadStreetActedMeta();
  if (!meta || meta.gameIdHex !== gameIdHex || meta.bettingPhase !== bettingPhase) {
    return false;
  }
  for (let i = 0; i < numPlayers; i += 1) {
    if ((foldedMask & (1 << i)) !== 0) continue;
    if ((meta.actedMask & (1 << i)) === 0) return false;
  }
  return true;
}

function recordStreetAction(
  gameIdHex: string,
  bettingPhase: number,
  playerIndex: number,
  action: string,
): void {
  let meta = loadStreetActedMeta();
  if (!meta || meta.gameIdHex !== gameIdHex || meta.bettingPhase !== bettingPhase) {
    meta = { gameIdHex, bettingPhase, actedMask: 0 };
  }
  if (action === 'bet' || action === 'raise' || action === 'all-in') {
    meta.actedMask = 1 << playerIndex;
  } else {
    meta.actedMask |= 1 << playerIndex;
  }
  saveStreetActedMeta(meta);
}

export type SharedHandMeta = {
  gameIdHex: string;
  tableId: string;
  roomSeed: string;
  numPlayers: number;
  /** Hand-order pubkeys (index 0 = first to act / SB side of hand_seat_order). */
  playerPubkeys: string[];
  physicalSeats: number[];
  /** Public transport metadata only — private keys stay in process MpcKeyStore. */
  tableKey: {
    publicKey: number[];
    nonceBase: string;
    purpose?: 'bet';
    generation?: string;
    playerIndex?: number;
  };
  registeredMask: number;
  /** Parallel to playerPubkeys — filled as each seat registers (for UI zk snapshot). */
  elGamalPublicKeys?: Array<[string, string] | null>;
  shuffledMask?: number;
  sharedMask?: number;
  /** Soft player-state init (betting without Groth16 register). */
  bettingOnly: boolean;
  /** poker | blackjack | war | baccarat | roulette */
  gameKind?: string;
  /** Last started betting street (PreFlop…River) for advanceStreet. */
  bettingPhase?: keyof typeof BETTING_PHASES;
  /** Set after 2p share finalize stages deck for reveal_card. */
  revealStagingNonce?: string;
};

function emptyPk(): web3.PublicKey {
  return web3.PublicKey.default;
}

function saveHandMeta(meta: SharedHandMeta): void {
  writeSharedMeta('shared-hand', JSON.stringify(meta, null, 2));
}

export function loadHandMeta(): SharedHandMeta | null {
  const raw = readSharedMeta('shared-hand');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SharedHandMeta;
  } catch {
    return null;
  }
}

export function requireHandMeta(): SharedHandMeta {
  const meta = loadHandMeta();
  if (!meta) {
    throw new Error(
      'No shared hand meta — gameplay should use on-chain resolve + local MpcKeyStore. '
      + 'This helper remains for legacy CLI tooling only.',
    );
  }
  return meta;
}

/** Process-local random MPC keys (never derived from gameId). */
const processMpcKeys = new InMemoryMpcKeyStore();
const handTableKeys = new Map<string, TableEncryptionKey>();

/** Dual-native coordination only — not SharedHandMeta (public transport). */
const MPC_TABLE_KEY_META = 'mpc-table-key';

function persistHandTableKey(gameIdHex: string, key: TableEncryptionKey): void {
  const pub = Array.from(key.publicKey);
  const sec = Array.from(key.privateKey);
  writeSharedMeta(
    MPC_TABLE_KEY_META,
    JSON.stringify({
      gameIdHex,
      publicKey: pub,
      secret: sec,
      nonceBase: key.nonceBase.toString(),
    }),
  );
}

function hydrateHandTableKey(gameId: Uint8Array): TableEncryptionKey | null {
  const hex = Buffer.from(gameId).toString('hex');
  const raw = readSharedMeta(MPC_TABLE_KEY_META);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      gameIdHex?: string;
      publicKey?: number[];
      secret?: number[];
      nonceBase?: string;
    };
    if (parsed.gameIdHex !== hex) return null;
    if (!parsed.publicKey?.length || !parsed.secret?.length || !parsed.nonceBase) {
      return null;
    }
    const tableKey: TableEncryptionKey = {
      publicKey: Uint8Array.from(parsed.publicKey),
      privateKey: Uint8Array.from(parsed.secret),
      nonceBase: BigInt(parsed.nonceBase),
    };
    handTableKeys.set(hex, tableKey);
    return tableKey;
  } catch {
    return null;
  }
}

function tableKeyForGame(gameId: Uint8Array): TableEncryptionKey {
  const hex = Buffer.from(gameId).toString('hex');
  const existing = handTableKeys.get(hex) ?? hydrateHandTableKey(gameId);
  if (!existing) {
    throw new Error(
      'local MPC key unavailable — startHand must create a random bet-purpose key in this process',
    );
  }
  return existing;
}

/** WebViews hydrate the host startHand key from `.local/mpc-table-key.json`. */
async function requireTableKey(gameId: Uint8Array): Promise<TableEncryptionKey> {
  await getSharedMetaStore().refreshFromDisk?.([MPC_TABLE_KEY_META]);
  return tableKeyForGame(gameId);
}

async function createHandBetKey(gameId: Uint8Array): Promise<{
  tableKey: TableEncryptionKey;
  generation: bigint;
  playerIndex: number;
}> {
  const playerIndex = 0;
  const record = await processMpcKeys.create(gameId, playerIndex, 'bet');
  const tableKey = tableKeyFromRecord(record);
  handTableKeys.set(record.gameIdHex, tableKey);
  persistHandTableKey(record.gameIdHex, tableKey);
  await getSharedMetaStore().flushWrites?.();
  return { tableKey, generation: record.generation, playerIndex };
}

function bettingPhaseName(bp: number): keyof typeof BETTING_PHASES | null {
  if (bp === 1) return 'PreFlop';
  if (bp === 2) return 'Flop';
  if (bp === 3) return 'Turn';
  if (bp === 4) return 'River';
  return null;
}

function gameIdFromMeta(meta: SharedHandMeta): Uint8Array {
  return hexToBytes(meta.gameIdHex);
}

function gameStatePda(programId: web3.PublicKey, gameId: Uint8Array): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('game_state'), Buffer.from(gameId)],
    programId,
  )[0];
}

function playerStatePda(
  programId: web3.PublicKey,
  gameId: Uint8Array,
  playerIndex: number,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('player'), Buffer.from(gameId), Buffer.from([playerIndex])],
    programId,
  )[0];
}

function encryptedBettingPda(programId: web3.PublicKey, gameId: Uint8Array): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('encrypted_betting'), Buffer.from(gameId)],
    programId,
  )[0];
}

function nextOffset(): BN {
  return new BN(bytesToHex(randomBytes(8)), 'hex');
}

async function adminContext(rpcUrl: string): Promise<{
  connection: web3.Connection;
  admin: AnchorProvider;
  pokerProgram: Program;
  room: PokerRoomLifecycle;
  tableId: bigint;
}> {
  await assertRpcReady(rpcUrl);
  const tableMeta = await ensureSharedLocalnetRoom(rpcUrl);
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const admin = await loadWhitelistAdminProvider(connection);
  const pokerProgram = loadCasinoProgram(admin);
  const room = new PokerRoomLifecycle(pokerProgram, admin, tableMeta.roomSeed);
  return {
    connection,
    admin,
    pokerProgram,
    room,
    tableId: BigInt(tableMeta.tableId),
  };
}

/**
 * One-shot: initialize light+poker GameState, link a table via start_hand,
 * persist tableKey + player order. Does not hold a session process.
 *
 * When `players` is provided, creates a **fresh table** and seats only those
 * keypairs (avoids leftover sitters from prior localnet runs).
 */
export async function beginSharedHand(opts?: {
  rpcUrl?: string;
  /** Skip Groth16 register — init PlayerState for bet-circuit tests. */
  bettingOnly?: boolean;
  /** Seat these keypairs on a new table before start_hand (recommended). */
  players?: Array<{ secretKey: Uint8Array; seat?: number; chips?: bigint }>;
  /** poker | blackjack | war | baccarat | roulette (also E2E_GAME_KIND). */
  gameKind?: string | number;
  /** Seated player who signs start_hand. Required when `players` is omitted. */
  starterSecretKey?: Uint8Array;
}): Promise<SharedHandMeta> {
  const rpcUrl = opts?.rpcUrl ?? LOCALNET_RPC_URL;
  const bettingOnly = opts?.bettingOnly === true;
  const { admin, pokerProgram, room, tableId: existingTableId } = await adminContext(rpcUrl);

  let tableId = existingTableId;

  if (opts?.players && opts.players.length >= 2) {
    const tableMeta = JSON.parse(readSharedMeta('shared-table') ?? '{}') as {
      roomSeed?: string;
    };
    const roomSeed = tableMeta.roomSeed ?? LOCALNET_SHARED_ROOM_SEED;
    const created = await room.createTable(admin);
    tableId = created.tableId;
    if (tableId >= 64n) {
      throw new Error(
        `Room ${roomSeed} is out of table ids (got ${tableId}); re-run ensure-room to rotate roomSeed`,
      );
    }
    const { deriveGameRoomId } = await import('../room-lifecycle');
    writeSharedMeta(
      'shared-table',
      JSON.stringify({
        roomSeed,
        tableId: tableId.toString(),
        roomIdHex: bytesToHex(deriveGameRoomId('poker', roomSeed)),
      }, null, 2),
    );

    for (let i = 0; i < opts.players.length; i++) {
      const p = opts.players[i]!;
      const kp = web3.Keypair.fromSecretKey(p.secretKey);
      const seat = p.seat ?? i;
      const chips = p.chips ?? 2_000n;
      const bal = await admin.connection.getBalance(kp.publicKey);
      if (bal < web3.LAMPORTS_PER_SOL) {
        const sig = await admin.connection.requestAirdrop(kp.publicKey, 2 * web3.LAMPORTS_PER_SOL);
        await admin.connection.confirmTransaction(sig, 'confirmed');
      }
      await room.addToWhitelist(kp.publicKey, admin).catch(() => undefined);
      await room.initRoomWallet(kp).catch(() => undefined);
      if (chips > 0n) {
        await room.faucetCreditPersonal(kp, chips);
      }
      await room.sitAtTable(tableId, seat, 0n, kp);
      if (chips > 0n) {
        await room.transferPersonalToSeat(tableId, chips, kp);
      }
    }
  } else {
    // Use currently seated players on the shared table.
    const prior = await room.fetchTable(tableId);
    if (Boolean((prior as { handInProgress?: boolean }).handInProgress
      ?? (prior as { hand_in_progress?: boolean }).hand_in_progress)) {
      throw new Error(
        `Table ${tableId} already has hand_in_progress — run ensure-room with `
        + 'E2E_FRESH_TABLE=1 (or PER_SEAT_FRESH_TABLE=1) so clients sit on a new table',
      );
    }
  }

  const gameId = crypto.getRandomValues(new Uint8Array(32));
  // New hand must not inherit prior soft-Complete meta (one WebView would show
  // Complete/Showdown while the other is still Register→streets).
  clearHandCompleteMeta();
  clearStreetActedMeta();
  clearStreetBetsMeta();
  const lightPoker = loadLightCasinoProgram(admin);
  const lifecycle = new OnchainGameLifecycle(lightPoker, admin, gameId, pokerProgram);

  const tableBefore = await room.fetchTable(tableId);
  const seatsBefore = tableBefore.seats as web3.PublicKey[];
  let occupiedCount = 0;
  for (const pk of seatsBefore) {
    if (!pk.equals(emptyPk())) occupiedCount += 1;
  }
  if (occupiedCount < 2) {
    throw new Error(
      `Need ≥2 seated players to begin hand (found ${occupiedCount}). `
      + 'Pass players: [{secretKey},…] to seat a fresh table.',
    );
  }
  const { chainInitArgsForGame } = await import('./continuous-hand-factory');
  const { parseBackendGameKind } = await import('../backend/game-kind');
  const gameKind = parseBackendGameKind(
    opts?.gameKind ?? (typeof process !== 'undefined' ? process.env.E2E_GAME_KIND : undefined),
  );
  const init = chainInitArgsForGame(gameKind, occupiedCount);
  await lifecycle.initializeGames(
    init.numPlayers,
    init.gameKind,
    init.shoeDecks,
    init.rouletteVariant,
    init.dealerIndex,
  );

  if (!opts?.starterSecretKey) {
    throw new Error('beginSharedHand needs starterSecretKey for the seated player who signs start_hand');
  }
  const starter = web3.Keypair.fromSecretKey(opts.starterSecretKey);
  const gameState = await room.startHand(tableId, gameId, starter);
  const tableAfter = await room.fetchTable(tableId);
  const numPlayers = occupiedCount;
  const playerPubkeys: string[] = [];
  const physicalSeats: number[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const phys = Number(tableAfter.handSeatOrder[i]);
    const pk = (tableAfter.seats as web3.PublicKey[])[phys]!;
    if (pk.equals(emptyPk())) {
      throw new Error(`hand_seat_order[${i}] → empty seat ${phys}`);
    }
    playerPubkeys.push(pk.toBase58());
    physicalSeats.push(phys);
  }

  // Write hand meta immediately so orchestrators can leave startHand wait and
  // WebViews can register while Arcium escrow/betting PDAs finish initializing.
  const activeRoomSeedEarly = (
    JSON.parse(readSharedMeta('shared-table') ?? '{}') as { roomSeed?: string }
  ).roomSeed ?? LOCALNET_SHARED_ROOM_SEED;
  const gameIdHexEarly = bytesToHex(gameId);
  const betKeyEarly = await createHandBetKey(gameId);
  saveHandMeta({
    gameIdHex: gameIdHexEarly,
    tableId: tableId.toString(),
    roomSeed: activeRoomSeedEarly,
    numPlayers,
    playerPubkeys,
    physicalSeats,
    tableKey: {
      publicKey: Array.from(betKeyEarly.tableKey.publicKey),
      nonceBase: betKeyEarly.tableKey.nonceBase.toString(),
      purpose: 'bet',
      generation: betKeyEarly.generation.toString(),
      playerIndex: betKeyEarly.playerIndex,
    },
    registeredMask: bettingOnly ? (1 << numPlayers) - 1 : 0,
    shuffledMask: 0,
    sharedMask: 0,
    bettingOnly,
    gameKind,
  });

  const arcium = new ArciumMPCHelper(pokerProgram, admin);
  await Promise.all(
    Array.from({ length: numPlayers }, (_, p) =>
      arcium.initPlayerGameEscrow(gameId, p).catch(() => undefined),
    ),
  );

  await (pokerProgram.methods as any)
    .initEncryptedGameBetting()
    .accounts({
      payer: admin.wallet.publicKey,
      gameState,
      encryptedGameBetting: encryptedBettingPda(pokerProgram.programId, gameId),
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc()
    .catch(() => {});

  await (pokerProgram.methods as any)
    .initBetActionLog()
    .accounts({
      payer: admin.wallet.publicKey,
      gameState,
      betActionLog: web3.PublicKey.findProgramAddressSync(
        [Buffer.from('bet_action_log'), Buffer.from(gameId)],
        pokerProgram.programId,
      )[0],
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc()
    .catch(() => {});

  if (bettingOnly) {
    for (let p = 0; p < numPlayers; p++) {
      await (pokerProgram.methods as any)
        .initPlayerState(p)
        .accounts({
          payer: admin.wallet.publicKey,
          gameState,
          playerState: playerStatePda(pokerProgram.programId, gameId, p),
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc()
        .catch(() => {});
    }
  }

  const tableKey = tableKeyForGame(gameId);
  const betGeneration = BigInt(
    (loadHandMeta()?.tableKey.generation as string | undefined) ?? '0',
  );
  const betPlayerIndex = loadHandMeta()?.tableKey.playerIndex ?? 0;
  // Legacy shared table key PDA (pubkey only).
  await (pokerProgram.methods as any)
    .initGameTableKey(Array.from(tableKey.publicKey), new BN(tableKey.nonceBase.toString()))
    .accounts({
      payer: admin.wallet.publicKey,
      gameState,
      gameTableKey: web3.PublicKey.findProgramAddressSync(
        [Buffer.from('game_table_key'), Buffer.from(gameId)],
        pokerProgram.programId,
      )[0],
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc()
    .catch(() => {});
  // Protocol V2 purpose-separated key PDA (public material only).
  const genLe = Buffer.alloc(8);
  genLe.writeBigUInt64LE(betGeneration);
  await (pokerProgram.methods as any)
    .initPlayerMpcKey(
      betPlayerIndex,
      MPC_KEY_PURPOSE_CODE.bet,
      new BN(betGeneration.toString()),
      Array.from(tableKey.publicKey),
      new BN(tableKey.nonceBase.toString()),
    )
    .accounts({
      payer: admin.wallet.publicKey,
      authority: admin.wallet.publicKey,
      gameState,
      playerMpcKey: web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('player_mpc_key'),
          Buffer.from(gameId),
          Buffer.from([betPlayerIndex]),
          Buffer.from([MPC_KEY_PURPOSE_CODE.bet]),
          genLe,
        ],
        pokerProgram.programId,
      )[0],
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc()
    .catch(() => {});

  const activeRoomSeed = (
    JSON.parse(readSharedMeta('shared-table') ?? '{}') as { roomSeed?: string }
  ).roomSeed ?? LOCALNET_SHARED_ROOM_SEED;
  // Optional tooling mirror — WebView gameplay does not read this.
  // Preserve masks if WebViews already registered while this CLI start was
  // still initializing PDAs (OR-merge so we never clobber peer progress).
  const gameIdHex = bytesToHex(gameId);
  let registeredMask = bettingOnly ? (1 << numPlayers) - 1 : 0;
  let shuffledMask = 0;
  let sharedMask = 0;
  const priorRaw = readSharedMeta('shared-hand');
  if (priorRaw && !bettingOnly) {
    try {
      const prior = JSON.parse(priorRaw) as {
        gameIdHex?: string;
        registeredMask?: number;
        shuffledMask?: number;
        sharedMask?: number;
      };
      if (prior.gameIdHex === gameIdHex) {
        registeredMask |= Number(prior.registeredMask) || 0;
        shuffledMask |= Number(prior.shuffledMask) || 0;
        sharedMask |= Number(prior.sharedMask) || 0;
      }
    } catch {
      // ignore corrupt prior
    }
  }
  const meta: SharedHandMeta = {
    gameIdHex,
    tableId: tableId.toString(),
    roomSeed: activeRoomSeed,
    numPlayers,
    playerPubkeys,
    physicalSeats,
    tableKey: {
      publicKey: Array.from(tableKey.publicKey),
      nonceBase: tableKey.nonceBase.toString(),
      purpose: 'bet',
      generation: betGeneration.toString(),
      playerIndex: betPlayerIndex,
    },
    registeredMask,
    shuffledMask,
    sharedMask,
    bettingOnly,
  };
  saveHandMeta(meta);
  return meta;
}

export async function startSharedBettingStreet(opts?: {
  rpcUrl?: string;
  phase?: keyof typeof BETTING_PHASES;
  smallBlind?: bigint;
  bigBlind?: bigint;
}): Promise<{ ok: true; phase: string; currentPlayer: number }> {
  const rpcUrl = opts?.rpcUrl ?? LOCALNET_RPC_URL;
  const phase = opts?.phase ?? 'PreFlop';
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const { admin, pokerProgram } = await adminContext(rpcUrl);
  const gameId = hand.gameId;
  const gameState = gameStatePda(pokerProgram.programId, gameId);
  const encryptedBetting = encryptedBettingPda(pokerProgram.programId, gameId);
  const sb = opts?.smallBlind ?? 0n;
  const bb = opts?.bigBlind ?? 0n;

  if (sb > 0n || bb > 0n) {
    await (pokerProgram.methods as any)
      .collectBlinds(new BN(sb.toString()), new BN(bb.toString()))
      .accountsPartial({
        authority: admin.wallet.publicKey,
        gameState,
        encryptedGameBetting: encryptedBetting,
      })
      .rpc();
  }

  if (phase === 'PreFlop') {
    await (pokerProgram.methods as any)
      .openPreflop()
      .accounts({
        authority: admin.wallet.publicKey,
        gameState,
      })
      .rpc();
  } else {
    // Flop/Turn/River/Showdown must already be reached via Enc bet callbacks.
    const arcium = new ArciumMPCHelper(pokerProgram, admin);
    const state = await arcium.fetchGameState(gameId);
    const onchain = Number(state.bettingPhase ?? state.betting_phase ?? 0);
    const want = BETTING_PHASES[phase] ?? 0;
    if (onchain !== want) {
      throw new Error(
        `startSharedBettingStreet(${phase}): on-chain betting_phase=${onchain}, ` +
          `expected ${want} from bet-callback advances (no caller-selected phase)`,
      );
    }
  }

  clearStreetActedMeta();
  const bp = BETTING_PHASES[phase] ?? 0;
  if (phase !== 'Showdown' && bp >= 1 && bp <= 4) {
    seedStreetBetsMeta({
      gameIdHex: hand.gameIdHex,
      bettingPhase: bp,
      numPlayers: hand.numPlayers,
      smallBlind: sb,
      bigBlind: bb,
    });
    seedStreetActedMeta({
      gameIdHex: hand.gameIdHex,
      bettingPhase: bp,
      numPlayers: hand.numPlayers,
    });
  } else {
    clearStreetBetsMeta();
  }
  await getSharedMetaStore().flushWrites?.();
  const arcium = new ArciumMPCHelper(pokerProgram, admin);
  const state = await arcium.fetchGameState(gameId);
  try {
    const meta = loadHandMeta();
    if (meta && meta.gameIdHex === hand.gameIdHex) {
      meta.bettingPhase = phase === 'Showdown' ? undefined : phase;
      saveHandMeta(meta);
    }
  } catch {
    // ignore optional mirror
  }
  return { ok: true, phase, currentPlayer: Number(state.currentPlayer) };
}

export type PerSeatRegisterResult = {
  ok: true;
  playerIndex: number;
  registeredMask: number;
  allRegistered: boolean;
};

/** Submit client-proven register receipt; authority = seat keypair. */
export async function registerHandKeyPerSeat(opts: {
  secretKey: Uint8Array;
  proof: object;
  publicSignals: string[];
  rpcUrl?: string;
}): Promise<PerSeatRegisterResult> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  // Hand identity from TableState + GameState — not shared-hand.json.
  const hand = await resolveActiveHandFromChain(rpcUrl);
  if (hand.phase !== PROOF_PHASE_REGISTER) {
    throw new Error(
      `Cannot register: on-chain phase=${hand.phase} (want Register=${PROOF_PHASE_REGISTER})`,
    );
  }
  const keypair = web3.Keypair.fromSecretKey(opts.secretKey);
  const playerIndex = hand.playerPubkeys.indexOf(keypair.publicKey.toBase58());
  if (playerIndex < 0) {
    throw new Error(
      `Pubkey ${keypair.publicKey.toBase58()} not in on-chain hand order `
      + `(${hand.playerPubkeys.join(',')})`,
    );
  }
  if ((hand.sharedMask & (1 << playerIndex)) !== 0) {
    throw new Error(`Player ${playerIndex} already registered on-chain`);
  }

  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const lightPoker = loadLightCasinoProgram(provider);
  const lifecycle = new OnchainGameLifecycle(
    lightPoker,
    provider,
    hand.gameId,
    pokerProgram,
  );
  await lifecycle.registerPlayer(playerIndex, opts.proof, opts.publicSignals, keypair);

  // Re-read registered bitmap / phase from poker GameState (source of truth).
  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  const state = await arcium.fetchGameState(hand.gameId);
  const phase = Number(state.phase ?? 0);
  const chainMask = Number(state.sharedMask ?? state.shared_mask ?? 0) >>> 0;
  // Last register clears shared_mask and advances phase to Shuffle.
  const allRegistered = phase !== PROOF_PHASE_REGISTER;
  const registeredMask = allRegistered
    ? (1 << hand.numPlayers) - 1
    : chainMask;

  // Best-effort legacy meta mirror (optional). Never required for WebView register.
  // OR-merge masks/keys so parallel seat writes (Node CLI or non-merging stores)
  // cannot drop a peer that registered while we were confirming.
  try {
    const existing = loadHandMeta();
    if (existing && existing.gameIdHex === hand.gameIdHex) {
      existing.registeredMask = (Number(existing.registeredMask) || 0) | registeredMask;
      const keys = existing.elGamalPublicKeys
        ? [...existing.elGamalPublicKeys]
        : Array.from({ length: hand.numPlayers }, () => null as [string, string] | null);
      while (keys.length < hand.numPlayers) keys.push(null);
      const pk0 = opts.publicSignals[0];
      const pk1 = opts.publicSignals[1];
      if (typeof pk0 === 'string' && typeof pk1 === 'string') {
        keys[playerIndex] = [pk0, pk1];
      }
      existing.elGamalPublicKeys = keys;
      saveHandMeta(existing);
      await getSharedMetaStore().flushWrites?.();
    }
  } catch {
    // ignore optional meta mirror
  }

  return {
    ok: true,
    playerIndex,
    registeredMask,
    allRegistered,
  };
}

export type PerSeatBetResult = {
  ok: true;
  playerIndex: number;
  action: string;
  amount: string;
  currentPlayer: number;
  currentBet: string;
  foldedMask: number;
  bettingPhase: number;
};

/** Rescue-encrypt + submit_bet signed by seat keypair; wait for turn advance. */
export async function placeBetPerSeat(opts: {
  secretKey: Uint8Array;
  action: string;
  amount?: bigint;
  showOnFold?: boolean;
  /** Optional overrides when client tracks stacks; else read from GameState / escrow. */
  playerBalance?: bigint;
  playerCurrentBet?: bigint;
  currentBet?: bigint;
  lastAggressorAmount?: bigint;
  rpcUrl?: string;
}): Promise<PerSeatBetResult> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const { hand, keypair, playerIndex, gameId } = await seatContext(
    opts.secretKey,
    rpcUrl,
  );
  const tableKey = await requireTableKey(gameId);

  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const room = new PokerRoomLifecycle(
    pokerProgram,
    provider,
    hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  const tableId = hand.tableId;
  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  const polling = new ArciumPollingHelper(provider);

  const state = await arcium.fetchGameState(gameId);
  const from = Number(state.currentPlayer);
  if (from !== playerIndex) {
    throw new Error(`Not your turn: current_player=${from}, you=${playerIndex}`);
  }

  let playerBalance = opts.playerBalance;
  if (playerBalance === undefined) {
    try {
      const escrow = await (pokerProgram.account as any).tableEscrow.fetch(
        room.tableEscrowPDA(keypair.publicKey, tableId),
      );
      const tableBalance = BigInt(
        escrow.balanceU64?.toString?.() ?? escrow.balance_u64?.toString?.() ?? '0',
      );
      const totals = state.playerTotalBets ?? state.player_total_bets;
      const committed = Array.isArray(totals) && totals[playerIndex] !== undefined
        ? BigInt(totals[playerIndex].toString())
        : 0n;
      playerBalance = tableBalance - committed;
    } catch (err) {
      throw new Error(
        `Failed to fetch table escrow balance for seat ${playerIndex}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const currentBet = opts.currentBet ?? BigInt(state.currentBet.toString());
  const lastAggressorAmount = opts.lastAggressorAmount
    ?? BigInt(state.lastAggressorAmount.toString());
  const bp = Number(state.bettingPhase ?? state.betting_phase ?? 0);
  // Pull peer seat's street-bets / acted mask from `.local/` before encrypting.
  await getSharedMetaStore().refreshFromDisk?.(['street-bets', 'street-acted']);
  // PreFlop: on-chain player_total_bets == street bet (blinds + calls). Prefer
  // that over stale/missing street-bets meta so we never re-call the same amount.
  let streetBet = opts.playerCurrentBet;
  if (streetBet === undefined && bp === 1) {
    const totals = state.playerTotalBets ?? state.player_total_bets;
    const raw = Array.isArray(totals) ? totals[playerIndex] : undefined;
    if (raw !== undefined) {
      streetBet = BigInt(raw.toString());
    }
  }
  if (streetBet === undefined) {
    streetBet = streetBetForPlayer(hand.gameIdHex, bp, playerIndex);
  }
  const actionAmount = resolveEncryptedBetAmount(opts.action, {
    amount: opts.amount,
    playerCurrentBet: streetBet,
    currentBet,
    playerBalance,
  });

  const actionCode = ACTION_MAP[opts.action];
  if (actionCode === undefined) throw new Error(`Unknown action: ${opts.action}`);

  const enc = await encryptBetPayload(tableKey, provider, pokerProgram.programId, {
    playerBalance,
    playerCurrentBet: streetBet,
    action: BigInt(actionCode),
    actionAmount,
    currentBet,
    lastAggressorAmount,
  });
  const [
    encryptedPlayerBalance,
    encryptedPlayerCurrentBet,
    encryptedAction,
    encryptedAmount,
    encryptedCurrentBet,
    encryptedLastAggressorAmount,
  ] = enc.ciphertexts;

  const offsetBn = nextOffset();
  const toArr = (b: Uint8Array) => Array.from(b);
  const showOnFold = opts.showOnFold === true && opts.action === 'fold';

  await (pokerProgram.methods as any)
    .submitBet(
      actionCode,
      toArr(encryptedAction!),
      toArr(encryptedAmount!),
      toArr(encryptedPlayerBalance!),
      toArr(encryptedPlayerCurrentBet!),
      toArr(encryptedCurrentBet!),
      toArr(encryptedLastAggressorAmount!),
      toArr(enc.encryptionPubkey),
      new BN(enc.nonce.toString()),
      offsetBn,
      showOnFold,
    )
    .accountsPartial({
      payer: keypair.publicKey,
      player: keypair.publicKey,
      whitelistEntry: room.whitelistPDA(keypair.publicKey),
      gameState: gameStatePda(pokerProgram.programId, gameId),
      tableState: room.tablePDA(tableId),
      playerState: playerStatePda(pokerProgram.programId, gameId, playerIndex),
      tableEscrow: room.tableEscrowPDA(keypair.publicKey, tableId),
      ...arcium.arciumQueueAccounts(offsetBn, 'validateBet'),
    })
    .preInstructions([
      web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ])
    .rpc();

  const beforeBp = bp;
  const beforeFolded = Number(state.foldedMask ?? state.folded_mask ?? 0);
  await polling.waitForCallback(
    gameStatePda(pokerProgram.programId, gameId),
    async (pda) => (pokerProgram.account as any).gameState.fetch(pda),
    (s: any) => {
      const nextBp = Number(s.bettingPhase ?? s.betting_phase ?? 0);
      const nextPlayer = Number(s.currentPlayer ?? s.current_player ?? from);
      const nextFolded = Number(s.foldedMask ?? s.folded_mask ?? 0);
      // Street advance emits PhaseAdvanced/StreetAdvanced and may keep the same
      // current_player (e.g. SB first-to-act on the next street).
      return nextBp !== beforeBp
        || nextPlayer !== from
        || nextFolded !== beforeFolded;
    },
    { timeout: 120_000, interval: 2000 },
  );

  const after = await arcium.fetchGameState(gameId);
  const afterBp = Number(after.bettingPhase ?? after.betting_phase ?? 0);
  if (afterBp !== beforeBp) {
    // On-chain closed the street — re-seed meta for the new street (or clear at showdown).
    clearStreetActedMeta();
    clearStreetBetsMeta();
    if (afterBp >= 1 && afterBp <= 4) {
      seedStreetBetsMeta({
        gameIdHex: hand.gameIdHex,
        bettingPhase: afterBp,
        numPlayers: hand.numPlayers,
        smallBlind: 0n,
        bigBlind: 0n,
      });
      seedStreetActedMeta({
        gameIdHex: hand.gameIdHex,
        bettingPhase: afterBp,
        numPlayers: hand.numPlayers,
      });
    }
    try {
      const meta = loadHandMeta();
      if (meta && meta.gameIdHex === hand.gameIdHex) {
        meta.bettingPhase = bettingPhaseName(afterBp) ?? undefined;
        saveHandMeta(meta);
      }
    } catch {
      // optional mirror
    }
  } else {
    applyStreetBetAction({
      gameIdHex: hand.gameIdHex,
      bettingPhase: beforeBp,
      numPlayers: hand.numPlayers,
      playerIndex,
      action: opts.action,
      actionAmount,
    });
    recordStreetAction(hand.gameIdHex, beforeBp, playerIndex, opts.action);
  }
  await getSharedMetaStore().flushWrites?.();
  return {
    ok: true,
    playerIndex,
    action: opts.action,
    amount: actionAmount.toString(),
    currentPlayer: Number(after.currentPlayer),
    currentBet: BigInt(after.currentBet.toString()).toString(),
    foldedMask: Number(after.foldedMask),
    bettingPhase: afterBp,
  };
}

export function playerIndexForSecret(secretKey: Uint8Array): number {
  const meta = loadHandMeta();
  if (!meta) {
    throw new Error('playerIndexForSecret requires shared-hand or use resolveActiveHandFromChain');
  }
  const kp = web3.Keypair.fromSecretKey(secretKey);
  return meta.playerPubkeys.indexOf(kp.publicKey.toBase58());
}

async function identityDeck(): Promise<bigint[][]> {
  try {
    const { buildBabyjub } = await import('circomlibjs');
    const babyjub = await buildBabyjub();
    const deck: bigint[][] = [];
    for (let i = 0; i < 52; i++) {
      const cardPoint = babyjub.mulPointEscalar(babyjub.Base8, BigInt(i + 1));
      deck.push([
        0n,
        1n,
        babyjub.F.toObject(cardPoint[0]),
        babyjub.F.toObject(cardPoint[1]),
      ]);
    }
    return deck;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('circomlibjs is not used')) throw err;
    const invoke = (globalThis as { window?: { zero?: { invoke?: Function } } }).window?.zero?.invoke;
    if (typeof invoke !== 'function') throw err;
    const result = await invoke('player', {
      op: 'calc',
      fn: 'initialDeck',
      kind: 0,
      count: 52,
      decks: 1,
    }) as { deck?: unknown };
    if (!Array.isArray(result?.deck)) throw err;
    return result.deck.map((card) => {
      if (!Array.isArray(card) || card.length !== 4) {
        throw err;
      }
      return card.map((limb) => BigInt(limb as string)) as bigint[];
    });
  }
}

async function seatContext(secretKey: Uint8Array, rpcUrl: string): Promise<{
  hand: ActiveHandContext;
  keypair: web3.Keypair;
  playerIndex: number;
  gameId: Uint8Array;
  /** Optional legacy meta (tableKey / share-ct). May be null. */
  meta: SharedHandMeta | null;
}> {
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const keypair = web3.Keypair.fromSecretKey(secretKey);
  const playerIndex = hand.playerPubkeys.indexOf(keypair.publicKey.toBase58());
  if (playerIndex < 0) {
    throw new Error(`Pubkey ${keypair.publicKey.toBase58()} not in on-chain hand`);
  }
  return { hand, keypair, playerIndex, gameId: hand.gameId, meta: loadHandMeta() };
}

export type PerSeatShuffleResult = {
  ok: true;
  playerIndex: number;
  shuffledMask: number;
  allShuffled: boolean;
};

/** Fee payer from the native launch config. The seat never deposits the float. */
async function feePayerKeypair(): Promise<web3.Keypair> {
  const launch = (globalThis as {
    window?: { __ZK_LAUNCH_CONFIG?: { feePayerSecret?: number[] } };
  }).window?.__ZK_LAUNCH_CONFIG;
  const secret = launch?.feePayerSecret;
  if (Array.isArray(secret) && secret.length > 0) {
    return web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  if ((globalThis as { window?: unknown }).window !== undefined) {
    throw new Error('fee payer secret is missing from the launch config');
  }
  const { loadMxeAuthorityKeypair } = await import('./admin-provider');
  return loadMxeAuthorityKeypair();
}

/**
 * Open this seat's rent vault and fill the poker float from the fee payer.
 * Shuffle and share lanes draw from that vault. A vault already at the float
 * is left as it is.
 */
async function stagePokerSeatFloat(
  connection: web3.Connection,
  player: web3.PublicKey,
): Promise<void> {
  const raw = readSharedMeta('shared-table');
  const meta = raw ? JSON.parse(raw) as { roomIdHex?: string } : {};
  if (!meta.roomIdHex) throw new Error('shared table is missing roomIdHex');
  const roomId = Uint8Array.from(Buffer.from(meta.roomIdHex, 'hex'));
  const admin = await loadWhitelistAdminProvider(connection);
  const payer = await feePayerKeypair();
  const payerProvider = new AnchorProvider(
    connection,
    new KeypairWallet(payer),
    { commitment: 'confirmed' },
  );
  const { shuffleCallerInputs } = await import('./shuffle-account');
  const { seatTableLamports } = await import('./table-float');
  const { stagePlayerRent, clusterRentLamportsPerByte } = await import('./rent-vault');
  const { GameKind } = await import('../game-config');
  const rate = await clusterRentLamportsPerByte(connection);
  await stagePlayerRent(
    payerProvider,
    admin,
    roomId,
    player,
    shuffleCallerInputs(GameKind.Poker, 1, 0),
    seatTableLamports(rate, { tokenAccount: false, pendingDeposit: false }),
  );
}

/** Final street-fold hash the share proof must publish. */
async function pokerShareFinalHash(
  ciphertexts: bigint[][][],
  nPlayers: number,
): Promise<bigint> {
  const invoke = (globalThis as {
    window?: { zero?: { invoke?: Function } };
  }).window?.zero?.invoke;
  const payload = {
    op: 'calc',
    fn: 'shareStreetHashes',
    kind: 0,
    nActualPlayers: nPlayers,
    ciphertexts: ciphertexts.map((row) => row.map((card) => card.map((limb) => limb.toString()))),
  };
  if (typeof invoke === 'function') {
    const result = await invoke('player', payload) as { ok?: boolean; value?: string; error?: string };
    if (!result || result.ok === false || result.value == null) {
      throw new Error(result?.error || 'shareStreetHashes failed');
    }
    return BigInt(result.value);
  }
  const { casinoShareStreets } = await import('../casino-calc');
  return casinoShareStreets(0, { ciphertexts, nActualPlayers: nPlayers }).finalHash;
}

/** Submit client-proven shuffle; seat keypair is the light-casino signer. */
export async function shuffleHandKeyPerSeat(opts: {
  secretKey: Uint8Array;
  proof: object;
  publicSignals: string[];
  /** Output deck from the shuffle proof. On-chain public inputs are this shoe. */
  shuffledDeck?: string[][];
  rpcUrl?: string;
}): Promise<PerSeatShuffleResult> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const { hand, keypair, playerIndex, gameId, meta } = await seatContext(
    opts.secretKey,
    rpcUrl,
  );
  if (meta?.bettingOnly) {
    throw new Error('Hand was started bettingOnly — shuffle disabled');
  }
  if (hand.phase !== PROOF_PHASE_SHUFFLE) {
    throw new Error(
      `Cannot shuffle: on-chain phase=${hand.phase} (want Shuffle=${PROOF_PHASE_SHUFFLE})`,
    );
  }
  if (hand.currentPlayer !== playerIndex) {
    throw new Error(
      `Shuffle out of order: current_player=${hand.currentPlayer}, you=${playerIndex}`,
    );
  }

  const connection = new web3.Connection(rpcUrl, 'confirmed');
  await stagePokerSeatFloat(connection, keypair.publicKey);
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const lightPoker = loadLightCasinoProgram(provider);
  const lifecycle = new OnchainGameLifecycle(lightPoker, provider, gameId, pokerProgram);

  const signals = opts.publicSignals.map((s) => BigInt(s));
  if (!opts.shuffledDeck?.length) {
    throw new Error('shuffledDeck is required to verify the shuffle proof');
  }
  const shoe = opts.shuffledDeck.map((card) => card.map((limb) => BigInt(limb)));
  const deckBefore = playerIndex === 0 ? await identityDeck() : undefined;
  await lifecycle.verifyShuffle(playerIndex, opts.proof, signals, shoe, deckBefore);

  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  const state = await arcium.fetchGameState(gameId);
  const phase = Number(state.phase ?? 0);
  const currentPlayer = Number(state.currentPlayer ?? state.current_player ?? 0);
  const shuffledMask =
    phase === PROOF_PHASE_SHARE
      ? (1 << hand.numPlayers) - 1
      : ((1 << currentPlayer) - 1) >>> 0;
  const allShuffled = phase === PROOF_PHASE_SHARE
    || shuffledMask === (1 << hand.numPlayers) - 1;

  // Optional meta mirror for tooling.
  try {
    if (meta && meta.gameIdHex === hand.gameIdHex) {
      meta.shuffledMask = shuffledMask;
      saveHandMeta(meta);
      await getSharedMetaStore().flushWrites?.();
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    playerIndex,
    shuffledMask,
    allShuffled,
  };
}

export type PerSeatShareResult = {
  ok: true;
  playerIndex: number;
  sharedMask: number;
  allShared: boolean;
  finalized: boolean;
};

/**
 * Submit client-proven share (Groth16 ∥ Arcis). Last sharer finalizes share phase.
 * Ciphertexts persisted under `.local/` for 2p reveal staging.
 */
export async function shareHandKeyPerSeat(opts: {
  secretKey: Uint8Array;
  proof: object;
  publicSignals: string[];
  /** Recipient-major ciphertexts as string[][][] (JSON) or bigint[][][]. */
  ciphertexts: string[][][] | bigint[][][];
  rpcUrl?: string;
}): Promise<PerSeatShareResult> {
  const { getMXEPublicKey } = await import('@arcium-hq/client');
  const { DeckStagingHelper } = await import('./staging');
  const { withRetry, isVerifyChunkStartDone } = await import('../arcium/verify-chunk-parallel');

  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const { hand, keypair, playerIndex, gameId, meta } = await seatContext(
    opts.secretKey,
    rpcUrl,
  );
  if (meta?.bettingOnly) {
    throw new Error('Hand was started bettingOnly — share disabled');
  }
  if (hand.phase !== PROOF_PHASE_SHARE) {
    throw new Error(
      `Cannot share: on-chain phase=${hand.phase} (want Share=${PROOF_PHASE_SHARE})`,
    );
  }
  if ((hand.sharedMask & (1 << playerIndex)) !== 0) {
    throw new Error(`Player ${playerIndex} already shared on-chain`);
  }

  const connection = new web3.Connection(rpcUrl, 'confirmed');
  await stagePokerSeatFloat(connection, keypair.publicKey);
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const lightPoker = loadLightCasinoProgram(provider);
  const lifecycle = new OnchainGameLifecycle(lightPoker, provider, gameId, pokerProgram);
  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  const polling = new ArciumPollingHelper(provider);
  const staging = new DeckStagingHelper(pokerProgram as any, provider);
  const room = new PokerRoomLifecycle(
    pokerProgram,
    provider,
    hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  // Provider wallet is the seated player; tableState is required for writes.
  staging.writeAuth = {
    tableState: room.tablePDA(BigInt(hand.tableId)),
    authority: keypair,
  };
  // Same random key the host minted at startHand (hydrated from mpc-table-key).
  const tableKey = await requireTableKey(gameId);

  const ciphertexts: bigint[][][] = opts.ciphertexts.map((row) =>
    row.map((ct) => ct.map((x) => (typeof x === 'string' ? BigInt(x) : x))),
  );

  const mxe = await getMXEPublicKey(provider, pokerProgram.programId);
  if (!mxe) throw new Error('MXE public key unavailable');

  const signals = opts.publicSignals.map((s) => BigInt(s));

  const recipientMajor = flattenShareCiphertexts(ciphertexts as any);

  const stagingReady = staging.createShare(gameId, playerIndex);
  const { rows, nonce } = encryptRecipientMajorRowsForStaging(
    tableKey,
    mxe,
    recipientMajor,
    hand.numPlayers,
  );
  const expectedHash = await pokerShareFinalHash(ciphertexts, hand.numPlayers);
  if (signals[0] !== expectedHash) {
    throw new Error(
      `share output hash mismatch player=${playerIndex}: proof=${signals[0]} arcis=${expectedHash}`,
    );
  }
  await stagingReady;

  // Poker binds the Groth16 output to the folded street hashes stored on the
  // receipt. The Arcis accumulator only records that every batch decrypted.
  const streets = pokerStreetFieldGroups(ciphertexts as Ciphertext[][]);
  const laneFund = lifecycle.prepareShareLanes(
    keypair,
    shareStreetChunkCount(streets),
    playerIndex,
  );
  const prior = await arcium.fetchShareVerifyAccumulator(gameId, playerIndex).catch(() => null);
  const alreadyFrozen = Boolean(prior?.verified && prior?.frozen);
  const midRound = Boolean(
    prior
    && !alreadyFrozen
    && Number(prior.verifyProgress ?? 0) > 0
    && Number(prior.verifyProgress) < Number(prior.verifyTarget ?? 0),
  );
  if (!alreadyFrozen && !midRound) {
    await arcium.beginVerifyShareHash(
      gameId,
      playerIndex,
      0n,
      0n,
      room.tablePDA(hand.tableId),
      keypair,
      {
        encryptionPubkey: tableKey.publicKey,
        nonceBase: tableKey.nonceBase,
      },
    );
  }

  const shareChunkTimeoutMs = Number(
    process.env.SHARE_VERIFY_CHUNK_TIMEOUT_MS
      ?? String(hand.numPlayers > 2 ? 900_000 : 180_000),
  );
  const arcis = alreadyFrozen ? Promise.resolve() : (async () => {
    const verifyTarget = rows.reduce((n, r) => n + r.limbCount, 0);
    for (const row of rows) {
      const rowBytes = Buffer.concat(row.ciphertexts.map((ct) => Buffer.from(ct)));
      await withRetry(
        () => staging.writeShareRange(gameId, playerIndex, row.startIndex * 32, rowBytes),
        { retries: 5, delayMs: 500 },
      );
      const queueShareChunk = async () => {
        try {
          await arcium.verifyShareHashChunk(gameId, playerIndex, nextOffset(), {
            encryptionPubkey: tableKey.publicKey,
            baseNonce: nonce,
            startIndex: row.startIndex,
            limbCount: row.limbCount,
          });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (msg.includes('InvalidVerifyProgress') || msg.includes('0x1771')) {
            const acc = await arcium.fetchShareVerifyAccumulator(gameId, playerIndex);
            if (isVerifyChunkStartDone(acc.verifyBits as any[], row.startIndex)) {
              return;
            }
          }
          throw e;
        }
      };
      let chunkDone = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const accBefore = await arcium.fetchShareVerifyAccumulator(gameId, playerIndex);
        if (isVerifyChunkStartDone(accBefore.verifyBits as any[], row.startIndex)) {
          chunkDone = true;
          break;
        }
        await withRetry(queueShareChunk, { retries: 5, delayMs: 500 });
        try {
          await polling.waitForCallback(
            arcium.deriveShareVerifyAccPDA(gameId, playerIndex),
            () => arcium.fetchShareVerifyAccumulator(gameId, playerIndex),
            (acc: any) => isVerifyChunkStartDone(acc.verifyBits as any[], row.startIndex),
            { timeout: shareChunkTimeoutMs, interval: 500 },
          );
          chunkDone = true;
          break;
        } catch (e: any) {
          const accAfter = await arcium.fetchShareVerifyAccumulator(gameId, playerIndex);
          if (isVerifyChunkStartDone(accAfter.verifyBits as any[], row.startIndex)) {
            chunkDone = true;
            break;
          }
          if (attempt === 3) throw e;
        }
      }
      if (!chunkDone) {
        throw new Error(`share verify chunk never completed player=${playerIndex}`);
      }
    }
    await arcium.syncVerifyShareHash(gameId, playerIndex);
    const acc = await arcium.fetchShareVerifyAccumulator(gameId, playerIndex);
    if (!acc.verified || Number(acc.verifyProgress) < verifyTarget) {
      throw new Error(
        `share Arcis verify failed player=${playerIndex} progress=${acc.verifyProgress}/${verifyTarget}`,
      );
    }
  })();

  await arcis;
  await laneFund.submitted;
  const frozenAcc = await arcium.fetchShareVerifyAccumulator(gameId, playerIndex);
  if (!frozenAcc.frozen || !frozenAcc.verified) {
    throw new Error(`share MPC verification did not freeze player=${playerIndex}`);
  }
  await lifecycle.verifyShare(
    playerIndex,
    opts.proof,
    signals,
    0,
    keypair,
    streets,
    laneFund,
  );

  const postShare = await arcium.fetchGameState(gameId);
  const chainSharedMask = Number(postShare.sharedMask ?? postShare.shared_mask ?? 0) >>> 0;
  const shareFinalized = Boolean(
    postShare.shareFinalized ?? postShare.share_finalized,
  );
  // Groth16 mark_share_receipt sets phase=Evaluation when the last bit lands;
  // do NOT treat phase≠Share as "everyone shared" — always trust shared_mask.
  const effectiveSharedMask = (chainSharedMask | (1 << playerIndex)) >>> 0;
  const allShared = effectiveSharedMask === (1 << hand.numPlayers) - 1;
  let finalized = shareFinalized;

  try {
    const latest = loadHandMeta();
    if (latest && latest.gameIdHex === hand.gameIdHex) {
      latest.sharedMask = effectiveSharedMask;
      saveHandMeta(latest);
      await getSharedMetaStore().flushWrites?.();
    }
  } catch {
    // ignore optional meta
  }

  if (allShared && !shareFinalized) {
    await arcium.finalizeSharePhase(gameId, hand.numPlayers);
    const state = await arcium.fetchGameState(gameId);
    if (state.verified !== true || state.shareFinalized !== true) {
      throw new Error(
        `finalize_share_phase failed: verified=${state.verified} shareFinalized=${state.shareFinalized}`,
      );
    }
    await staging.closeShare(gameId, playerIndex, keypair);
    finalized = true;
  }

  return {
    ok: true,
    playerIndex,
    sharedMask: effectiveSharedMask,
    allShared,
    finalized,
  };
}

export type PerSeatShowdownResult = {
  ok: true;
  playerIndex: number;
};

/**
 * Acknowledge hole cards — opens PreFlop when share is complete and betting
 * has not started yet (per-seat stand-in for LocalnetTableSession hole acks).
 */
export async function acknowledgeHolesPerSeat(opts?: {
  rpcUrl?: string;
}): Promise<{ ok: true; phase: string; currentPlayer: number }> {
  const rpcUrl = opts?.rpcUrl ?? LOCALNET_RPC_URL;
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const { admin, pokerProgram } = await adminContext(rpcUrl);
  const arcium = new ArciumMPCHelper(pokerProgram, admin);
  const state = await arcium.fetchGameState(hand.gameId);
  const bp = Number(state.bettingPhase ?? state.betting_phase ?? 0);
  const existing = bettingPhaseName(bp);
  if (existing) {
    return {
      ok: true,
      phase: existing,
      currentPlayer: Number(state.currentPlayer ?? state.current_player ?? 0),
    };
  }
  // Share must be done (phase advanced past PROOF_PHASE_SHARE).
  if (hand.phase === PROOF_PHASE_SHARE) {
    throw new Error('Cannot open PreFlop until all players have shared');
  }
  // Match table snapshot defaults (smallBlind=10) so auto-bet is not stuck
  // waiting for currentBet >= BB while blinds were never collected.
  return startSharedBettingStreet({
    rpcUrl,
    phase: 'PreFlop',
    smallBlind: 10n,
    bigBlind: 20n,
  });
}

function isSoftShowdownProof(proof: object): boolean {
  const p = proof as { pi_a?: string[] };
  return Array.isArray(p.pi_a) && p.pi_a[0] === '0' && p.pi_a[1] === '0';
}

/**
 * Real showdown materials for the per-seat Solana path.
 *
 * Historically this returned stub (all-zero) materials, which made
 * `previewShowdownWinnerMasks` yield an all-zero winner mask; the soft-complete
 * path then defaulted to "seat 0 wins" — showing the WRONG winner regardless of
 * the actual hands (e.g. two pair vs one pair).
 *
 * We now reconstruct the exact `ZkShowdownMaterials` the local backend uses by
 * reading on-chain state:
 *   - final deck from light-casino `deck_state`
 *   - ElGamal public keys from light-casino `PlayerState`
 *   - authenticated MPC share materials (Task 5)
 *   - pot masks from the live folded mask
 * so the winner mask is derived from the truly decrypted cards.
 */
function ciphertextPartialsFromPersistedShares(
  viewerIndex: number,
  numPlayers: number,
  viewerPadding: string[],
): string[][][] {
  const cardMask = shareCardMask(numPlayers);
  const rows: string[][][] = [];
  for (let i = 0; i < 10; i += 1) {
    if (i === viewerIndex) {
      continue;
    }
    if (i >= numPlayers) {
      rows.push(Array.from({ length: TOTAL_CARDS }, () => [...viewerPadding]));
      continue;
    }
    const shared = loadShareCiphertexts(i);
    if (!shared) {
      throw new Error(`Missing share ciphertexts for player ${i}`);
    }
    const dest = i > viewerIndex ? viewerIndex : viewerIndex - 1;
    const row = shared.ciphertexts[dest];
    if (!row) {
      throw new Error(`Player ${i} has no share row for viewer ${viewerIndex}`);
    }
    rows.push(
      row.map((ct, cardIndex) =>
        ((cardMask >> BigInt(cardIndex)) & 1n) === 0n ? [...viewerPadding] : ct,
      ),
    );
  }
  return rows;
}

export async function getShowdownMaterialsPerSeat(opts: {
  seat?: number;
  secretKey?: Uint8Array;
  rpcUrl?: string;
}): Promise<ZkShowdownMaterials> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const n = hand.numPlayers;
  if (!opts.secretKey) {
    throw new Error('secretKey required for showdown materials');
  }
  const keypair = web3.Keypair.fromSecretKey(opts.secretKey);
  const playerIndex = hand.playerPubkeys.indexOf(keypair.publicKey.toBase58());
  if (playerIndex < 0) {
    throw new Error('Showdown material signer is not in the active hand');
  }
  if (opts.seat !== undefined && hand.physicalSeats[playerIndex] !== opts.seat) {
    throw new Error('Showdown material seat does not match signer');
  }

  await getSharedMetaStore().refreshFromDisk?.([E2E_SHOWDOWN_COEFFS_KEY]);
  const earlyCoeffs = pokerSealedCoefficients(
    loadShowdownSealMeta(hand.gameIdHex, playerIndex)?.decryptedCoefficients,
  );

  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const lightProgram = loadLightCasinoProgram(provider);
  const arcium = new ArciumMPCHelper(pokerProgram, provider);

  // Live folded mask so folded players are excluded from the pot contenders.
  let foldedMask = 0;
  try {
    const state = await arcium.fetchGameState(hand.gameId);
    foldedMask = Number(state.foldedMask ?? state.folded_mask ?? 0) >>> 0;
  } catch {
    foldedMask = 0;
  }

  const keys = await fetchElGamalKeysFromChain(lightProgram, hand.gameId, n);
  const deckJson = await fetchDeckJsonFromChain(connection, lightProgram.programId, hand.gameId);
  if (!deckJson || deckJson.length < 52) {
    throw new Error('deck_state unavailable for showdown materials');
  }

  await refreshShareCiphertexts(n);
  const ownShare = loadShareCiphertexts(playerIndex);
  if (!ownShare?.padding?.length) {
    throw new Error(
      'share ciphertexts/padding missing — each seat must persist share-ciphertexts-pN after shareProve',
    );
  }
  const elGamalPublicKeys = keys.map((key) => {
    if (!key) {
      throw new Error('Missing ElGamal public key for showdown materials');
    }
    return key;
  });
  const dealCards = dealCardCount(n);
  const materials: ZkShowdownMaterials = {
    playerIndex,
    potMasks: potMasksFromFolded(foldedMask, n).map((value) => value.toString()),
    finalDeck: deckJson.slice(0, dealCards),
    ciphertextPartials: ciphertextPartialsFromPersistedShares(playerIndex, n, ownShare.padding),
    elGamalPublicKeys,
  };
  // Reuse an existing seal for this hand/player. Resealing on every materials
  // fetch (preview + prove + retries) overwrites the coeffs committed in an
  // already-accepted showdown proof and breaks compute_pots.
  const existingCoeffs = earlyCoeffs
    ?? pokerSealedCoefficients(
      loadShowdownSealMeta(hand.gameIdHex, playerIndex)?.decryptedCoefficients,
    );
  let sealedCoefficients = existingCoeffs;
  if (!sealedCoefficients) {
    const seal = await sealShowdownCoefficientsForPerSeat({
      gameId: hand.gameId,
      playerIndex,
      authority: keypair,
      tableState: new PokerRoomLifecycle(
        pokerProgram,
        provider,
        hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
      ).tablePDA(hand.tableId),
      provider,
      pokerProgram,
      arcium,
      polling: new ArciumPollingHelper(provider),
    });
    const decryptedCoefficients = seal.decryptedCoefficients.map((c) => c.toString());
    const pokerCoeffs = pokerSealedCoefficients(decryptedCoefficients) ?? decryptedCoefficients;
    saveShowdownSealMeta({
      gameIdHex: hand.gameIdHex,
      playerIndex,
      ciphertexts: seal.ciphertexts.map((c) => Array.from(c)),
      nonce: seal.nonce.toString(),
      key: {
        publicKey: Array.from(seal.key.publicKey),
        nonceBase: seal.key.nonceBase.toString(),
      },
      privateKey: Array.from(seal.key.privateKey),
      decryptedCoefficients: pokerCoeffs,
    });
    await getSharedMetaStore().flushWrites?.();
    sealedCoefficients = pokerCoeffs;
  }
  if (!(await readShowdownMaterialComplete(connection, arcium, hand.gameId, playerIndex))) {
    await prepareShowdownMaterialPerSeat({
      secretKey: opts.secretKey,
      seat: opts.seat,
      rpcUrl,
    });
  }
  return {
    ...materials,
    sealedCoefficients,
    materialComplete: await readShowdownMaterialComplete(
      connection,
      arcium,
      hand.gameId,
      playerIndex,
    ),
  };
}

function nonZeroCiphertexts(value: unknown): boolean {
  return Array.isArray(value)
    && value.some((c) => Uint8Array.from(c as ArrayLike<number>).some((b) => b !== 0));
}

async function sealShowdownCoefficientsForPerSeat(opts: {
  gameId: Uint8Array;
  playerIndex: number;
  authority: web3.Keypair;
  tableState: web3.PublicKey;
  provider: AnchorProvider;
  pokerProgram: Program;
  arcium: ArciumMPCHelper;
  polling: ArciumPollingHelper;
}): Promise<{
  ciphertexts: Uint8Array[];
  encryptionPubkey: Uint8Array;
  nonce: bigint;
  key: TableEncryptionKey;
  decryptedCoefficients: bigint[];
}> {
  const { gameId, playerIndex, authority, tableState, provider, pokerProgram, arcium, polling } = opts;
  const key = generateTableEncryptionKey();
  await arcium.sealShowdownCoefficients(
    gameId,
    nextOffset(),
    key.publicKey,
    key.nonceBase,
    playerIndex,
    tableState,
    authority,
    2,
  );
  const sealedPda = arcium.deriveSealedShowdownCoeffsPDA(authority.publicKey);
  const sealed = await polling.waitForCallback(
    sealedPda,
    () => arcium.fetchSealedShowdownCoefficients(authority.publicKey),
    (state: any) => {
      const cts = state.coefficientsCiphertext ?? state.coefficients_ciphertext;
      // The callback stores the key Arcis echoes, which is not always the
      // player X25519 we queued. Two written coefficients are the seal.
      return state.written === true
        && Number(state.nActive ?? state.n_active ?? 0) === 2
        && nonZeroCiphertexts(cts);
    },
    { timeout: 180_000, interval: 2_000 },
  );
  const ciphertexts = (sealed.coefficientsCiphertext ?? sealed.coefficients_ciphertext)
    .map((c: number[] | Uint8Array) => c instanceof Uint8Array ? c : Uint8Array.from(c));
  const nonce = BigInt(sealed.nonce.toString());
  const { getMXEPublicKey } = await import('@arcium-hq/client');
  const mxe = await getMXEPublicKey(provider, pokerProgram.programId);
  if (!mxe) throw new Error('MXE public key unavailable');
  const { coefficients } = await openSealedShowdown(key, mxe, sealed);
  return {
    ciphertexts,
    encryptionPubkey: key.publicKey,
    nonce,
    key,
    decryptedCoefficients: coefficients,
  };
}

/**
 * Decrypt showdown materials with a host-shared E2E ElGamal key and return
 * compareHands winner masks (player-index bits, SB-first).
 */
async function tryComputeWinnerMasksFromE2eKeys(
  hand: ActiveHandContext,
  rpcUrl: string,
): Promise<bigint[] | null> {
  const seatKeys = hand.physicalSeats.map((seat) => `e2e-elgamal-seat${seat}`);
  await getSharedMetaStore().refreshFromDisk?.(seatKeys);
  const { Poker } = await import('../poker');
  const poker = new Poker();
  await poker.init();

  for (const seat of hand.physicalSeats) {
    const raw = readSharedMeta(`e2e-elgamal-seat${seat}`);
    if (!raw) continue;
    let privateKey: bigint;
    try {
      const parsed = JSON.parse(raw) as { privateKey?: string };
      if (!parsed.privateKey) continue;
      privateKey = BigInt(parsed.privateKey);
    } catch {
      continue;
    }
    try {
      const materials = await getShowdownMaterialsPerSeat({ seat, rpcUrl });
      const potMasks = materials.potMasks.map((v) => BigInt(v));
      const ciphertextCards = materials.finalDeck.map(
        (card) => card.map((v) => BigInt(v)) as unknown as Ciphertext,
      );
      const ciphertextPartials = materials.ciphertextPartials.map((row) =>
        row.map((card) => card.map((v) => BigInt(v)) as unknown as Ciphertext),
      );
      const plaintext = poker.decryptCards(
        privateKey as any,
        potMasks[0]!,
        ciphertextCards,
        ciphertextPartials,
      );
      const masks = poker.compareHands(potMasks, plaintext);
      if (masks.some((m) => m !== 0n)) {
        console.log(
          `[per-seat] soft Complete winnerMasks from e2e-elgamal-seat${seat}:`,
          masks.map((m) => m.toString()).join(','),
        );
        return masks;
      }
    } catch (err) {
      console.warn(
        `[per-seat] soft Complete e2e mask compute failed seat=${seat}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}

/**
 * Persist hand-complete meta so UI reaches Complete after showdown acceptance.
 * Slim payload (no full share matrix) for solana.meta / orch disk IPC.
 */
export async function persistHandCompleteAfterShowdown(opts: {
  hand: ActiveHandContext;
  tableId: string | number | bigint;
  winnerMasks: bigint[];
  rpcUrl: string;
  pokerProgram: Program;
  admin: AnchorProvider;
}): Promise<void> {
  const { hand, tableId, winnerMasks, rpcUrl, pokerProgram, admin } = opts;
  const holeCards = new Map<number, [number, number]>();
  const seatNames = new Map<number, string>();
  for (let i = 0; i < hand.physicalSeats.length; i += 1) {
    const seat = hand.physicalSeats[i]!;
    holeCards.set(seat, holeCardIndices(i));
    seatNames.set(seat, `Seat ${seat}`);
  }
  let potAmount = 30n;
  try {
    const arcium = new ArciumMPCHelper(pokerProgram, admin);
    const state = await arcium.fetchGameState(hand.gameId);
    const totals = (state.playerTotalBets ?? state.player_total_bets ?? []) as Array<
      { toString(): string } | number | string
    >;
    if (Array.isArray(totals) && totals.length > 0) {
      const sum = totals.reduce<bigint>((acc, v) => acc + BigInt(String(v)), 0n);
      if (sum > 0n) potAmount = sum;
    } else {
      const chainPots = (state.pots ?? []) as Array<{ toString(): string } | number | string>;
      const potSum = chainPots.reduce<bigint>((acc, v) => acc + BigInt(String(v)), 0n);
      if (potSum > 0n) potAmount = potSum;
    }
  } catch {
    // keep soft default
  }

  let zkFinalDeck: string[][] | undefined;
  let zkCrypto: ReturnType<typeof buildZkCryptoFromDeck>;
  let zkReveal: ZkRevealSnapshot | undefined;
  try {
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const lightProgram = loadLightCasinoProgram(admin);
    const keys = await fetchElGamalKeysFromChain(lightProgram, hand.gameId, hand.numPlayers);
    const deck = await fetchDeckJsonFromChain(connection, lightProgram.programId, hand.gameId);
    zkFinalDeck = deck ?? undefined;
    zkCrypto = buildZkCryptoFromDeck(hand, keys, deck);
    zkReveal = {
      revealedCardIndices: [20, 21, 22, 23, 24],
      newlyRevealed: [],
      allPartialsPublic: true,
      shareComplete: true,
      holePartialsUnlocked: true,
      entries: [],
    };
  } catch (err) {
    console.warn(
      '[per-seat] hand-complete decrypt capture failed:',
      err instanceof Error ? err.message : err,
    );
    zkReveal = {
      revealedCardIndices: [20, 21, 22, 23, 24],
      newlyRevealed: [],
      allPartialsPublic: true,
      shareComplete: true,
      holePartialsUnlocked: true,
      entries: [],
    };
  }

  const handResult = {
    ...buildHandResult({
      handNumber: 1,
      reason: 'showdown',
      handNumPlayers: hand.numPlayers,
      handSeatOrder: [...hand.physicalSeats],
      foldedMask: 0,
      holeCards,
      boardCards: [20, 21, 22, 23, 24],
      pots: [{ amount: potAmount }],
      seatNames,
      usedPlaintextHand: false,
      zkFinalDeck,
    }),
    winnerMasks: winnerMasks.map((mask) => mask.toString()),
  };
  // Encrypted showdown skips plaintext hand ranking. The accepted winner masks
  // are the payout source, so the UI can credit the pot.
  if (
    handResult.potResults.length === 0
    && winnerMasks.some((mask) => mask !== 0n)
    && potAmount > 0n
  ) {
    handResult.potResults = potResultsFromWinnerMasks(
      winnerMasks,
      hand.numPlayers,
      [...hand.physicalSeats],
      [{ amount: potAmount }],
    );
  }
  saveHandCompleteMeta({
    tableId: String(tableId),
    gameIdHex: hand.gameIdHex,
    handResult,
    zkCrypto,
    zkReveal,
  });
  clearStreetActedMeta();
  clearStreetBetsMeta();
  await getSharedMetaStore().flushWrites?.();
  try {
    writeSharedMeta('shared-hand', '');
    await getSharedMetaStore().flushWrites?.();
  } catch {
    // ignore
  }
}

function resolveWinnerMasksForComplete(
  _hand: ActiveHandContext,
  _rpcUrl: string,
): Promise<bigint[]> {
  // Payout data must come from authenticated settlement, not client previews.
  return Promise.resolve(Array.from({ length: 9 }, () => 0n));
}

async function closeRetainedRevealedCardsPerSeat(opts: {
  hand: ActiveHandContext;
  playerIndex: number;
  authority: web3.Keypair;
  provider: AnchorProvider;
  pokerProgram: Program;
}): Promise<void> {
  const helper = new RevealedCardsHelper(opts.pokerProgram, opts.provider);
  const room = new PokerRoomLifecycle(
    opts.pokerProgram,
    opts.provider,
    opts.hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  const gameState = gameStatePda(opts.pokerProgram.programId, opts.hand.gameId);
  const tableState = room.tablePDA(opts.hand.tableId);
  for (let cardIndex = 0; cardIndex < dealCardCount(opts.hand.numPlayers); cardIndex += 1) {
    const pda = helper.derivePDA(opts.hand.gameId, opts.playerIndex, cardIndex);
    if (!(await opts.provider.connection.getAccountInfo(pda))) continue;
    await helper.close(
      opts.hand.gameId,
      opts.playerIndex,
      cardIndex,
      gameState,
      tableState,
      opts.authority,
    );
  }
}

async function settleShowdownPotsPerSeat(opts: {
  hand: ActiveHandContext;
  playerIndex: number;
  authority: web3.Keypair;
  provider: AnchorProvider;
  pokerProgram: Program;
  winnerMasks?: bigint[] | null;
}): Promise<void> {
  const { hand, playerIndex, authority, provider, pokerProgram } = opts;
  const gamePda = gameStatePda(pokerProgram.programId, hand.gameId);
  const state = await (pokerProgram.account as any).gameState.fetch(gamePda);
  const status = Number(state.settlementStatus ?? state.settlement_status ?? 0);
  const phase = Number(state.phase ?? 0);
  if (status === 3 || phase >= 6) {
    await closeRetainedRevealedCardsPerSeat({
      hand,
      playerIndex,
      authority,
      provider,
      pokerProgram,
    });
    return;
  }
  if (status === 4 || status === 5) {
    throw new Error('Settlement became refundable/refunded; Complete cannot be persisted');
  }
  const masks = opts.winnerMasks;
  const sealKey = loadShowdownSealKey(hand.gameIdHex, playerIndex);
  if (!masks || !masks.some((mask) => mask !== 0n) || !sealKey) {
    console.warn(
      `[per-seat] skip compute_pots p${playerIndex}: `
      + `masks=${Boolean(masks)} key=${Boolean(sealKey)}`,
    );
    return;
  }
  const room = new PokerRoomLifecycle(
    pokerProgram,
    provider,
    hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  const enc = await encryptWinnerMasksWithSealedKey(
    sealKey,
    provider,
    pokerProgram.programId,
    masks,
  );
  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  const polling = new ArciumPollingHelper(provider);
  await arcium.computePots(
    hand.gameId,
    nextOffset(),
    enc.ciphertexts,
    enc.encryptionPubkey,
    enc.nonce,
    room.tablePDA(hand.tableId),
    authority.publicKey,
  );
  await polling.waitForPhase(
    gamePda,
    (pda) => (pokerProgram.account as any).gameState.fetch(pda),
    6,
    { timeout: 180_000, interval: 2_000 },
  );
  await closeRetainedRevealedCardsPerSeat({
    hand,
    playerIndex,
    authority,
    provider,
    pokerProgram,
  });
  await arcium.reclaimFinalizedComputations();
}

/**
 * Soft E2E Complete without Groth16 verify — gated by ALLOW_SOFT_SHOWDOWN=1.
 * Normal dual-native path must submit+accept a real showdown proof instead.
 */
export async function softCompleteShowdownPerSeat(opts: {
  /** Optional — used only to resolve playerIndex when present in the hand. */
  secretKey?: Uint8Array;
  rpcUrl?: string;
  winnerMasks?: Array<string | bigint | number>;
}): Promise<PerSeatShowdownResult & { phase: 'Complete' }> {
  if (!ALLOW_SOFT_SHOWDOWN) {
    throw new Error(
      'softComplete disabled: hand is not Complete until a showdown Groth16 proof '
      + 'is submitted and accepted (set ALLOW_SOFT_SHOWDOWN=1 only for UI smoke)',
    );
  }
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const gameId = hand.gameId;
  let playerIndex = 0;
  if (opts.secretKey) {
    const kp = web3.Keypair.fromSecretKey(opts.secretKey);
    const idx = hand.playerPubkeys.indexOf(kp.publicKey.toBase58());
    if (idx >= 0) playerIndex = idx;
  }
  const { admin, pokerProgram, tableId } = await adminContext(rpcUrl);
  const gameState = gameStatePda(pokerProgram.programId, gameId);
  const hashBytes = Array.from({ length: 32 }, () => 0);
  try {
    await (pokerProgram.methods as any)
      .setShowdownHash(hashBytes)
      .accounts({
        authority: admin.wallet.publicKey,
        gameState,
      })
      .rpc();
  } catch (err) {
    console.warn(
      '[per-seat] setShowdownHash failed (Continuing soft Complete):',
      err instanceof Error ? err.message : err,
    );
  }

  const winnerMasks = await resolveWinnerMasksForComplete(hand, rpcUrl);
  if (!winnerMasks.some((m) => m !== 0n)) {
    const existing = loadHandCompleteMeta();
    if (
      existing
      && existing.gameIdHex === hand.gameIdHex
      && ((existing.handResult as HandResultSnapshot & { winnerMasks?: Array<string | number | bigint> }).winnerMasks ?? [])
        .some((m) => BigInt(m) !== 0n)
    ) {
      console.warn(
        '[per-seat] soft Complete keeping existing hand-complete winnerMasks',
      );
      return { ok: true, playerIndex, phase: 'Complete' };
    }
  }

  await persistHandCompleteAfterShowdown({
    hand,
    tableId,
    winnerMasks,
    rpcUrl,
    pokerProgram,
    admin,
  });
  return { ok: true, playerIndex, phase: 'Complete' };
}

/**
 * Submit showdown Groth16 proof; Complete only after on-chain accept + hand-complete.
 * Dummy (soft) proofs require ALLOW_SOFT_SHOWDOWN=1.
 */
function parseWinnerMasks(raw?: Array<string | bigint | number>): bigint[] | null {
  if (!raw?.length) {
    return null;
  }
  const masks = raw.map((value) => BigInt(value));
  while (masks.length < 9) {
    masks.push(0n);
  }
  return masks.some((mask) => mask !== 0n) ? masks.slice(0, 9) : null;
}

export async function showdownHandKeyPerSeat(opts: {
  secretKey: Uint8Array;
  proof: object;
  publicSignals: string[];
  winnerMasks?: Array<string | bigint | number>;
  rpcUrl?: string;
}): Promise<PerSeatShowdownResult | (PerSeatShowdownResult & { phase: 'Complete' })> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const { keypair, playerIndex, gameId } = await seatContext(opts.secretKey, rpcUrl);
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const { admin, tableId } = await adminContext(rpcUrl);
  const adminPokerProgram = loadCasinoProgram(admin);

  let alreadyFinalized = false;
  try {
    const gameAccount = await (adminPokerProgram.account as any).gameState.fetch(
      gameStatePda(adminPokerProgram.programId, hand.gameId),
    );
    alreadyFinalized = Boolean(
      gameAccount.showdownFinalized ?? gameAccount.showdown_finalized,
    );
  } catch {
    // treat as not finalized
  }

  if (isSoftShowdownProof(opts.proof)) {
    // Soft proofs are UI-smoke only — unless showdown was already accepted on-chain
    // and we are resuming settle / hand-complete after a timed-out submit.
    if (!alreadyFinalized && !ALLOW_SOFT_SHOWDOWN) {
      throw new Error(
        'soft showdown proof rejected: submit a real Groth16 showdown proof '
        + '(ALLOW_SOFT_SHOWDOWN=1 only for UI smoke)',
      );
    }
    if (!alreadyFinalized) {
      return softCompleteShowdownPerSeat({
        secretKey: opts.secretKey,
        winnerMasks: opts.winnerMasks,
        rpcUrl: opts.rpcUrl,
      });
    }
    console.log(
      `[per-seat] resuming Complete after on-chain showdown finalize p${playerIndex} `
      + `(soft resume proof)`,
    );
  } else if (!alreadyFinalized) {
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
      commitment: 'confirmed',
    });
    const pokerProgram = loadCasinoProgram(provider);
    const lightPoker = loadLightCasinoProgram(provider);
    const lifecycle = new OnchainGameLifecycle(lightPoker, provider, gameId, pokerProgram);
    const signals = opts.publicSignals.map((s) => BigInt(s));
    await lifecycle.verifyShowdown(playerIndex, opts.proof, signals);
    try {
      await lifecycle.finalizeShowdown(playerIndex, keypair);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[per-seat] finalizeShowdown p${playerIndex}: ${msg}`);
    }
    alreadyFinalized = true;
  } else {
    console.log(
      `[per-seat] showdown already finalized on-chain p${playerIndex}; `
      + `resuming settle → Complete`,
    );
  }

  const winnerMasks = parseWinnerMasks(opts.winnerMasks)
    ?? await resolveWinnerMasksForComplete(hand, rpcUrl);
  console.log(
    `[per-seat] showdown proof accepted p${playerIndex}; settling pots `
    + `masks=${winnerMasks.map((m) => m.toString()).join(',')}`,
  );
  try {
    await settleShowdownPotsPerSeat({
      hand,
      playerIndex,
      authority: keypair,
      provider: admin,
      pokerProgram: adminPokerProgram,
      winnerMasks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[per-seat] pot settlement p${playerIndex}: ${msg}`);
  }
  await persistHandCompleteAfterShowdown({
    hand,
    tableId,
    winnerMasks,
    rpcUrl,
    pokerProgram: adminPokerProgram,
    admin,
  });
  return { ok: true, playerIndex, phase: 'Complete' };
}

const STREET_ORDER = ['PreFlop', 'Flop', 'Turn', 'River'] as const;

/**
 * Sync client meta to the next street after Enc bet-callback advances.
 * Opening PreFlop uses `open_preflop`; later streets must already be on-chain.
 */
export async function advanceStreetPerSeat(opts?: {
  rpcUrl?: string;
  fromPhase?: typeof STREET_ORDER[number];
}): Promise<{ ok: true; phase: string; currentPlayer: number }> {
  const rpcUrl = opts?.rpcUrl ?? LOCALNET_RPC_URL;
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const { admin, pokerProgram } = await adminContext(rpcUrl);
  const arcium = new ArciumMPCHelper(pokerProgram, admin);
  const state = await arcium.fetchGameState(hand.gameId);
  const bp = Number(state.bettingPhase ?? state.betting_phase ?? 0);
  const chainPhase = bettingPhaseName(bp);

  // betting_phase=0 after Share/Evaluation means PreFlop is not open yet.
  // Must open PreFlop (ack-holes + blinds) — never treat this as "advance from
  // PreFlop → Flop" (that skipped PreFlop betting and raced toward Showdown).
  if (bp === 0) {
    return acknowledgeHolesPerSeat({ rpcUrl });
  }

  const from = (opts?.fromPhase
    ?? chainPhase
    ?? 'PreFlop') as typeof STREET_ORDER[number];
  const fromBp = BETTING_PHASES[from] ?? 0;

  // Bet callbacks emit StreetAdvancedEvent and bump betting_phase on-chain.
  // If the chain is already ahead of what the client thought, sync meta only.
  if (bp > fromBp || bp === 5) {
    const already = chainPhase ?? (bp === 5 ? 'Showdown' : from);
    clearStreetActedMeta();
    if (bp >= 1 && bp <= 4) {
      seedStreetBetsMeta({
        gameIdHex: hand.gameIdHex,
        bettingPhase: bp,
        numPlayers: hand.numPlayers,
        smallBlind: 0n,
        bigBlind: 0n,
      });
      seedStreetActedMeta({
        gameIdHex: hand.gameIdHex,
        bettingPhase: bp,
        numPlayers: hand.numPlayers,
      });
    } else {
      clearStreetBetsMeta();
    }
    await getSharedMetaStore().flushWrites?.();
    return {
      ok: true,
      phase: already,
      currentPlayer: Number(state.currentPlayer ?? 0),
    };
  }

  // Advance from on-chain street (authoritative), not a lagging UI label.
  const fromChain = (chainPhase ?? from) as typeof STREET_ORDER[number];
  const idx = STREET_ORDER.indexOf(fromChain);
  if (idx < 0) {
    throw new Error(`Cannot advance from phase ${fromChain}`);
  }
  if (fromChain === 'River' || idx >= STREET_ORDER.length - 1) {
    return startSharedBettingStreet({ rpcUrl, phase: 'Showdown' });
  }
  const next = STREET_ORDER[idx + 1]!;
  return startSharedBettingStreet({ rpcUrl, phase: next });
}

type RevealedCardAccountLike = {
  gameId?: number[] | Uint8Array;
  game_id?: number[] | Uint8Array;
  cardIndex?: number | { toString(): string };
  card_index?: number | { toString(): string };
  recipientIndex?: number;
  recipient_index?: number;
  count: number;
  filled: number;
  filledBits?: number | bigint | { toString(): string };
  filled_bits?: number | bigint | { toString(): string };
  partials: Array<number[] | Uint8Array>;
};

function fieldBytesToDecimal(bytes: number[] | Uint8Array): string {
  const field = Uint8Array.from(bytes);
  if (field.length !== 32) {
    throw new Error(`RevealedCard limb must be 32 bytes, got ${field.length}`);
  }
  return BigInt(`0x${Buffer.from(field).toString('hex')}`).toString();
}

export function entriesFromRevealedCard(opts: {
  gameId: Uint8Array;
  cardIndex: number;
  recipientIndex: number;
  numPlayers: number;
  account: RevealedCardAccountLike;
}): ZkRevealSnapshot['entries'] {
  const expectedCount = expectedRevealLimbCount(opts.numPlayers);
  const accountGameId = Uint8Array.from(opts.account.gameId ?? opts.account.game_id ?? []);
  const accountCardIndex = Number(opts.account.cardIndex ?? opts.account.card_index ?? -1);
  const accountRecipient = Number(
    opts.account.recipientIndex ?? opts.account.recipient_index ?? -1,
  );
  if (
    !Buffer.from(accountGameId).equals(Buffer.from(opts.gameId))
    || accountCardIndex !== opts.cardIndex
    || accountRecipient !== opts.recipientIndex
  ) {
    throw new Error('RevealedCard account metadata mismatch');
  }
  if (Number(opts.account.count) !== expectedCount) {
    throw new Error(
      `RevealedCard count ${opts.account.count} != expected ${expectedCount}`,
    );
  }
  const filledBits = BigInt(
    (opts.account.filledBits ?? opts.account.filled_bits ?? 0).toString(),
  );
  const expectedBits = (1n << BigInt(expectedCount)) - 1n;
  if (Number(opts.account.filled) !== expectedCount || filledBits !== expectedBits) {
    throw new Error(
      `RevealedCard incomplete: filled=${opts.account.filled} count=${expectedCount}`,
    );
  }
  if (opts.account.partials.length < expectedCount) {
    throw new Error(
      `RevealedCard incomplete limbs: ${opts.account.partials.length} < ${expectedCount}`,
    );
  }

  const entries: ZkRevealSnapshot['entries'] = [];
  let section = 0;
  for (let sharer = 0; sharer < opts.numPlayers; sharer += 1) {
    if (sharer === opts.recipientIndex) continue;
    const start = section * 4;
    const limbs = opts.account.partials.slice(start, start + 4);
    if (limbs.length !== 4) {
      throw new Error(`RevealedCard malformed limb section for sharer ${sharer}`);
    }
    entries.push({
      cardIndex: opts.cardIndex,
      fromPlayerIndex: sharer,
      toPlayerIndex: opts.recipientIndex,
      ciphertext: limbs.map(fieldBytesToDecimal),
    });
    section += 1;
  }
  return entries;
}

async function buildRevealSnapshotFromRevealedCards(opts: {
  pokerProgram: Program;
  hand: ActiveHandContext;
  viewerIndex: number;
  bettingPhase: number;
  verified: boolean;
  foldedMask: number;
  showOnFoldMask: number;
}): Promise<ZkRevealSnapshot> {
  const entries: ZkRevealSnapshot['entries'] = [];
  const revealedCardIndices: number[] = [];
  for (let cardIndex = 0; cardIndex < dealCardCount(opts.hand.numPlayers); cardIndex += 1) {
    try {
      assertCardRevealAllowed(
        cardIndex,
        opts.hand.numPlayers,
        opts.bettingPhase,
        opts.verified,
        {
          recipientIndex: opts.viewerIndex,
          foldedMask: opts.foldedMask,
          showOnFoldMask: opts.showOnFoldMask,
        },
      );
    } catch {
      continue;
    }

    const pda = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from('RevealedCard'),
        Buffer.from(opts.hand.gameId),
        Buffer.from([opts.viewerIndex]),
        (() => {
          const bytes = Buffer.alloc(2);
          bytes.writeUInt16LE(cardIndex);
          return bytes;
        })(),
      ],
      opts.pokerProgram.programId,
    )[0];
    const account = await (opts.pokerProgram.account as any).revealedCard.fetchNullable(pda);
    if (!account) continue;
    entries.push(...entriesFromRevealedCard({
      gameId: opts.hand.gameId,
      cardIndex,
      recipientIndex: opts.viewerIndex,
      numPlayers: opts.hand.numPlayers,
      account,
    }));
    revealedCardIndices.push(cardIndex);
  }

  return {
    revealedCardIndices,
    newlyRevealed: [],
    allPartialsPublic: false,
    shareComplete: true,
    holePartialsUnlocked: opts.bettingPhase >= 1,
    entries,
  };
}

/**
 * Fetch completed RevealedCard PDAs, then fill street-legal holes/board
 * from persisted share matrices when Arcis has not published those PDAs yet.
 */
export async function fetchRevealedPartialsPerSeat(opts: {
  secretKey: Uint8Array;
  seat?: number;
  rpcUrl?: string;
}): Promise<ZkRevealSnapshot> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const hand = await resolveActiveHandFromChain(rpcUrl);
  const keypair = web3.Keypair.fromSecretKey(opts.secretKey);
  const viewerIndex = hand.playerPubkeys.indexOf(keypair.publicKey.toBase58());
  if (viewerIndex < 0) {
    throw new Error('Pubkey not in on-chain hand for fetchRevealedPartials');
  }
  if (opts.seat !== undefined && hand.physicalSeats[viewerIndex] !== opts.seat) {
    throw new Error('fetchRevealedPartials seat does not match signer');
  }

  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const gameState = await (pokerProgram.account as any).gameState.fetch(
    gameStatePda(pokerProgram.programId, hand.gameId),
  );
  const bettingPhase = Number(gameState.bettingPhase ?? gameState.betting_phase ?? 0);
  const fromPdas = await buildRevealSnapshotFromRevealedCards({
    pokerProgram,
    hand,
    viewerIndex,
    bettingPhase,
    verified: Boolean(gameState.verified),
    foldedMask: Number(gameState.foldedMask ?? gameState.folded_mask ?? 0),
    showOnFoldMask: Number(gameState.showOnFoldMask ?? gameState.show_on_fold_mask ?? 0),
  });
  const uiPhase = bettingPhaseName(bettingPhase) ?? 'PreFlop';
  const wanted = visibleDealIndicesForViewerPhase(uiPhase, viewerIndex, hand.numPlayers);
  const have = new Set(fromPdas.entries.map((entry) => entry.cardIndex));
  const missing = wanted.filter((cardIndex) => !have.has(cardIndex));
  if (missing.length === 0) {
    return fromPdas;
  }
  await refreshShareCiphertexts(hand.numPlayers);
  const fromShare = entriesFromPersistedShareCiphertexts({
    viewerPlayerIndex: viewerIndex,
    numPlayers: hand.numPlayers,
    cardIndices: missing,
  });
  if (fromShare.length === 0) {
    return fromPdas;
  }
  return {
    ...fromPdas,
    revealedCardIndices: [...new Set([...fromPdas.revealedCardIndices, ...wanted])].sort(
      (a, b) => a - b,
    ),
    entries: [...fromPdas.entries, ...fromShare],
  };
}

async function stageCardMajorRevealStagingPerSeat(opts: {
  hand: ActiveHandContext;
  gameId: Uint8Array;
  keypair: web3.Keypair;
  provider: AnchorProvider;
  pokerProgram: Program;
  tableKey: import('../bet-encryption').TableEncryptionKey;
  cardIndices: number[];
  rpcUrl: string;
}): Promise<bigint> {
  const { hand, gameId, keypair, provider, pokerProgram, tableKey, cardIndices, rpcUrl } = opts;
  if (hand.numPlayers !== 2) {
    throw new Error(
      'Per-seat reveal staging for 3-10 players is not implemented; refusing unsafe reveal',
    );
  }
  await refreshShareCiphertexts(hand.numPlayers);
  const shares: Ciphertext[][][] = [];
  for (let player = 0; player < hand.numPlayers; player += 1) {
    const persisted = loadShareCiphertexts(player);
    if (!persisted) {
      throw new Error(`share ciphertexts missing for p${player} — cannot stage reveal`);
    }
    shares.push(
      persisted.ciphertexts.map((row) =>
        row.map((ct) => ct.map((x) => BigInt(x))),
      ) as Ciphertext[][],
    );
  }
  const values = toTwoPlayerRecipientCardMajorShareValues(shares);
  const commitments = shareValuesToCommitments(values);
  const { getMXEPublicKey } = await import('@arcium-hq/client');
  const mxe = await getMXEPublicKey(provider, pokerProgram.programId);
  if (!mxe) throw new Error('MXE public key unavailable');
  const { rows, nonce } = encryptCommitmentRowsForStaging(
    tableKey,
    mxe,
    commitments,
    cardIndices,
    hand.numPlayers,
    tableKey.nonceBase,
  );
  const staging = new DeckStagingHelper(pokerProgram, provider);
  const room = new PokerRoomLifecycle(
    pokerProgram,
    provider,
    hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  staging.writeAuth = {
    tableState: room.tablePDA(hand.tableId),
    authority: keypair,
  };
  const stagingPda = staging.derivePDA(gameId);
  const existingStaging = await provider.connection.getAccountInfo(stagingPda, 'confirmed');
  if (!existingStaging) {
    // create_deck_staging is gated to game.staging_authority (startHand payer).
    const { admin, pokerProgram: adminPoker } = await adminContext(rpcUrl);
    const adminStaging = new DeckStagingHelper(adminPoker, admin);
    await adminStaging.create(gameId);
  }
  for (const row of rows) {
    const rowBytes = Buffer.concat(row.ciphertexts.map((ct) => Buffer.from(ct)));
    console.log(
      `[per-seat] write reveal staging card=${row.cardIndex} offset=${row.startIndex * 32}`,
    );
    await staging.writeRange(gameId, row.startIndex * 32, rowBytes);
  }
  return nonce;
}

/**
 * Publish sealed reveal_card partials for a recipient (Arcis).
 * Host writes card-major `deck_staging` from persisted share matrices first —
 * reveal_card cannot decrypt empty staging.
 */
export async function revealSealedPartialsPerSeat(opts: {
  secretKey: Uint8Array;
  recipientIndex: number;
  cardIndices: number[];
  rpcUrl?: string;
}): Promise<{ ok: true; recipientIndex: number; cardIndices: number[] }> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const { hand, keypair, gameId, playerIndex } = await seatContext(opts.secretKey, rpcUrl);
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const lightProgram = loadLightCasinoProgram(provider);
  const light = new LightProtocolStorageHelper(lightProgram, provider);
  const polling = new ArciumPollingHelper(provider);
  const room = new PokerRoomLifecycle(
    pokerProgram,
    provider,
    hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  if (hand.numPlayers > 2) {
    throw new Error(
      'Per-seat reveal staging for 3-10 players is not implemented; refusing unsafe reveal',
    );
  }
  const tableKey = await requireTableKey(gameId);
  const uniqueCards = [...new Set(opts.cardIndices)].sort((a, b) => a - b);
  const baseNonce = await stageCardMajorRevealStagingPerSeat({
    hand,
    gameId,
    keypair,
    provider,
    pokerProgram,
    tableKey,
    cardIndices: uniqueCards,
    rpcUrl,
  });
  const totalCount = (hand.numPlayers - 1) * 4;
  const tableState = room.tablePDA(hand.tableId);
  if (opts.recipientIndex !== playerIndex) {
    throw new Error('recipientIndex does not match signer');
  }

  for (const cardIndex of uniqueCards) {
    const existing = await (pokerProgram.account as any).revealedCard.fetchNullable(
      arcium.deriveRevealedCardPDA(gameId, opts.recipientIndex, cardIndex),
    );
    if (existing && Number(existing.filled) === totalCount) {
      continue;
    }
    const revealedPda = arcium.deriveRevealedCardPDA(gameId, opts.recipientIndex, cardIndex);
    const completed = Promise.race([
      polling.waitForRevealCardEvent(
        pokerProgram,
        cardIndex,
        totalCount,
        opts.recipientIndex,
        { timeout: 180_000 },
      ),
      polling.waitForCallback(
        revealedPda,
        () => arcium.fetchRevealedCard(gameId, opts.recipientIndex, cardIndex),
        (state: any) => Number(state.filled) === totalCount,
        { timeout: 180_000, interval: 2_000 },
      ),
    ]);
    await arcium.revealCardPartials(gameId, cardIndex, nextOffset(), {
      encryptionPubkey: tableKey.publicKey,
      baseNonce,
      totalCount,
      recipientIndex: opts.recipientIndex,
      recipient: keypair,
      tableState,
      sourceStart: hand.numPlayers > 2 ? 0 : undefined,
    });
    await completed;
    const revealed = await arcium.fetchRevealedCard(
      gameId,
      opts.recipientIndex,
      cardIndex,
    );
    const commitments = (revealed.partials as Array<number[] | Uint8Array>)
      .slice(0, totalCount)
      .map((partial) => Uint8Array.from(partial));
    for (let offset = 0; offset < commitments.length; offset += 8) {
      const chunk = commitments.slice(offset, offset + 8);
      await light.createRevealedPartials(
        gameId,
        opts.recipientIndex,
        cardIndex * 5 + Math.floor(offset / 8),
        cardIndex * 36 + offset,
        chunk.length,
        chunk,
        keypair,
      );
    }
  }
  return {
    ok: true,
    recipientIndex: opts.recipientIndex,
    cardIndices: opts.cardIndices,
  };
}

/**
 * Host-only: publish in-play RevealedCard PDAs for the signer, then begin+sync
 * `ShowdownMaterialCommitment` so in-app Groth16 submit can pass
 * `verifyShowdown`. Must not run in WKWebView (Arcis reveal_card).
 */
export async function prepareShowdownMaterialPerSeat(opts: {
  secretKey: Uint8Array;
  seat?: number;
  rpcUrl?: string;
}): Promise<{ ok: true; playerIndex: number; cards: number[]; alreadyComplete: boolean }> {
  const rpcUrl = opts.rpcUrl ?? LOCALNET_RPC_URL;
  const { hand, keypair, gameId, playerIndex } = await seatContext(opts.secretKey, rpcUrl);
  if (opts.seat !== undefined && hand.physicalSeats[playerIndex] !== opts.seat) {
    throw new Error('prepareShowdownMaterial seat does not match signer');
  }
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
  });
  const pokerProgram = loadCasinoProgram(provider);
  const arcium = new ArciumMPCHelper(pokerProgram, provider);
  if (await readShowdownMaterialComplete(connection, arcium, gameId, playerIndex)) {
    return {
      ok: true,
      playerIndex,
      cards: usedCardIndices(hand.numPlayers),
      alreadyComplete: true,
    };
  }

  const cards = usedCardIndices(hand.numPlayers);
  console.log(
    `[per-seat] prepare showdown material p${playerIndex} cards=[${cards.join(',')}]`,
  );
  await revealSealedPartialsPerSeat({
    secretKey: opts.secretKey,
    recipientIndex: playerIndex,
    cardIndices: cards,
    rpcUrl,
  });

  const generationBn = new BN(0);
  const showdownMaterial = arcium.deriveShowdownMaterialCommitment(
    gameId,
    generationBn,
    playerIndex,
  );
  const room = new PokerRoomLifecycle(
    pokerProgram,
    provider,
    hand.roomSeed || LOCALNET_SHARED_ROOM_SEED,
  );
  const tableState = room.tablePDA(hand.tableId);
  const gameState = gameStatePda(pokerProgram.programId, gameId);

  if (!(await connection.getAccountInfo(showdownMaterial, 'confirmed'))) {
    await (pokerProgram.methods as any)
      .beginShowdownMaterial(generationBn, playerIndex)
      .accounts({
        payer: keypair.publicKey,
        gameState,
        tableState,
        showdownMaterial,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
  }

  const revealedMetas = cards.map((cardIndex) => {
    const le = Buffer.alloc(2);
    le.writeUInt16LE(cardIndex);
    return {
      pubkey: web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('RevealedCard'),
          Buffer.from(gameId),
          Buffer.from([playerIndex]),
          le,
        ],
        pokerProgram.programId,
      )[0],
      isSigner: false,
      isWritable: false,
    };
  });
  await (pokerProgram.methods as any)
    .syncShowdownMaterial(generationBn, playerIndex)
    .accounts({
      payer: keypair.publicKey,
      gameState,
      tableState,
      showdownMaterial,
    })
    .remainingAccounts(revealedMetas)
    .signers([keypair])
    .rpc();

  await getSharedMetaStore().refreshFromDisk?.([E2E_SHOWDOWN_COEFFS_KEY]);
  const coeffs = pokerSealedCoefficients(
    loadShowdownSealMeta(hand.gameIdHex, playerIndex)?.decryptedCoefficients,
  );
  if (coeffs) {
    const sealedPda = arcium.deriveSealedShowdownCoeffsPDA(keypair.publicKey);
    const sealed = await arcium.fetchSealedShowdownCoefficients(keypair.publicKey).catch(() => null);
    if (!sealed?.written) {
      console.warn(`[per-seat] seal rows missing p${playerIndex} pda=${sealedPda.toBase58()}`);
    }
  }

  if (!(await readShowdownMaterialComplete(connection, arcium, gameId, playerIndex))) {
    throw new Error('ShowdownMaterialsNotVerified');
  }
  console.log(`[per-seat] showdown material complete p${playerIndex}`);
  return { ok: true, playerIndex, cards, alreadyComplete: false };
}
