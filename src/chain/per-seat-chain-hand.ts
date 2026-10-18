/**
 * Resolve active ZK hand identity from on-chain TableState + GameState.
 * WebView gameplay must not depend on `.local/shared-hand.json`.
 */
import { AnchorProvider, web3, type Program } from '@coral-xyz/anchor';
import type { GameSnapshot, SeatSnapshot } from '../backend/types';
import type { ZkHandSnapshot } from '../backend/zk-serialize';
import { LOCALNET_RPC_URL } from './localnet-config';
import { assertRpcReady } from './localnet-ready';
import { LOCALNET_SHARED_ROOM_SEED } from './per-seat-client';
import { loadLightCasinoProgram, loadCasinoProgram } from './program-loader';
import { KeypairWallet } from './keypair-wallet';
import { loadWhitelistAdminProvider } from './admin-provider';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from './shared-meta-store';
import { PokerRoomLifecycle } from './room/game-room-lifecycle';
import {
  bytesToFieldBE,
  parseDeckStateAccount,
} from './onchain-game-lifecycle';
import { deckStateAccountSize } from './shuffle-account';
import { ciphertextToJson } from '../backend/zk-serialize';
import type { Ciphertext } from '../zk-casino';
import {
  boardIndicesRevealedForUiPhase,
  dealCardCount,
  holeCardIndices,
} from '../backend/card-layout';
import type { HandResultSnapshot } from '../backend/hand-result';
import type { ZkCryptoSnapshot, ZkRevealSnapshot } from '../backend/zk-serialize';
import { loadStreetBetsMeta } from './street-bets-meta';

const HAND_COMPLETE_META_KEY = 'hand-complete';

export type HandCompleteMeta = {
  tableId: string;
  gameIdHex: string;
  handResult: HandResultSnapshot;
  /** Captured before endHand so Complete can decrypt without an active chain hand. */
  zkCrypto?: ZkCryptoSnapshot;
  zkReveal?: ZkRevealSnapshot;
  /** War / Baccarat complete snapshots for the native table. */
  gameKind?: GameSnapshot['gameKind'];
};

/** Poker `PROOF_PHASE_*` — matches rust/casino/programs/casino/src/lib.rs */
export const PROOF_PHASE_REGISTER = 0;
export const PROOF_PHASE_SHUFFLE = 1;
export const PROOF_PHASE_SHARE = 2;

export type ActiveHandContext = {
  rpcUrl: string;
  roomSeed: string;
  tableId: bigint;
  gameId: Uint8Array;
  gameIdHex: string;
  numPlayers: number;
  /** Hand-order pubkeys (index 0 = SB / first in hand_seat_order). */
  playerPubkeys: string[];
  physicalSeats: number[];
  /** Poker GameState.phase */
  phase: number;
  /** Register bitmap (Register) or share bitmap (Share); cleared at Shuffle entry. */
  sharedMask: number;
  currentPlayer: number;
};

function emptyPk(): web3.PublicKey {
  return web3.PublicKey.default;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isZeroGameId(id: Uint8Array | number[]): boolean {
  for (let i = 0; i < id.length; i++) {
    if (Number(id[i]) !== 0) return false;
  }
  return true;
}

function asByteArray(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  if (raw && typeof raw === 'object' && ArrayBuffer.isView(raw)) {
    return Uint8Array.from(raw as unknown as ArrayLike<number>);
  }
  throw new Error('expected byte array');
}

function popcount(mask: number): number {
  let n = mask >>> 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

function lowestUnsetBit(mask: number, width: number): number | null {
  for (let i = 0; i < width; i += 1) {
    if ((mask & (1 << i)) === 0) return i;
  }
  return null;
}

export function gameStatePda(
  programId: web3.PublicKey,
  gameId: Uint8Array,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('game_state'), Buffer.from(gameId)],
    programId,
  )[0];
}

export function lightPlayerStatePda(
  lightProgramId: web3.PublicKey,
  gameId: Uint8Array,
  playerIndex: number,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('player'), Buffer.from(gameId), Buffer.from([playerIndex])],
    lightProgramId,
  )[0];
}

function loadSharedTableMeta(): { roomSeed: string; tableId: string } | null {
  const raw = readSharedMeta('shared-table');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { roomSeed?: string; tableId?: string };
    if (!parsed.tableId) return null;
    return {
      roomSeed: parsed.roomSeed ?? LOCALNET_SHARED_ROOM_SEED,
      tableId: String(parsed.tableId),
    };
  } catch {
    return null;
  }
}

async function readOnlyProvider(rpcUrl: string): Promise<AnchorProvider> {
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  try {
    return await loadWhitelistAdminProvider(connection);
  } catch {
    const ephemeral = web3.Keypair.generate();
    return new AnchorProvider(connection, new KeypairWallet(ephemeral), {
      commitment: 'confirmed',
    });
  }
}

/**
 * Active hand from TableState.current_game_id + poker GameState.
 * Table identity still comes from shared-table (roomSeed/tableId) — not shared-hand.
 */
export async function resolveActiveHandFromChain(
  rpcUrl = LOCALNET_RPC_URL,
): Promise<ActiveHandContext> {
  await assertRpcReady(rpcUrl);
  const tableMeta = loadSharedTableMeta();
  // Never ensureSharedLocalnetRoom from getGame/enrich — that path can create a
  // fresh table and orphan an in-progress Register hand (phase → lobby).
  if (!tableMeta || !tableMeta.tableId) {
    throw new Error(
      'No shared-table meta — call ensureRoom / startHand before resolving hand',
    );
  }

  const provider = await readOnlyProvider(rpcUrl);
  const pokerProgram = loadCasinoProgram(provider);
  const room = new PokerRoomLifecycle(pokerProgram, provider, tableMeta.roomSeed);
  const tableId = BigInt(tableMeta.tableId);
  const table = await room.fetchTable(tableId);

  const handInProgress = Boolean(
    (table as { handInProgress?: boolean }).handInProgress
      ?? (table as { hand_in_progress?: boolean }).hand_in_progress,
  );
  if (!handInProgress) {
    throw new Error(
      `Table ${tableId} has no hand_in_progress — authority must startHand on-chain first`,
    );
  }

  const gameIdRaw = asByteArray(
    (table as { currentGameId?: unknown }).currentGameId
      ?? (table as { current_game_id?: unknown }).current_game_id,
  );
  if (isZeroGameId(gameIdRaw)) {
    throw new Error(`Table ${tableId} hand_in_progress but current_game_id is zero`);
  }
  const gameId = gameIdRaw;

  const game = await (pokerProgram.account as any).gameState.fetch(
    gameStatePda(pokerProgram.programId, gameId),
  );
  const numPlayers = Number(
    (table as { handNumPlayers?: number }).handNumPlayers
      ?? (table as { hand_num_players?: number }).hand_num_players
      ?? game.numPlayers
      ?? 0,
  );
  if (numPlayers < 2) {
    throw new Error(`Invalid hand_num_players=${numPlayers}`);
  }

  const handSeatOrder = (
    (table as { handSeatOrder?: number[] }).handSeatOrder
      ?? (table as { hand_seat_order?: number[] }).hand_seat_order
      ?? []
  ) as number[];
  const seats = table.seats as web3.PublicKey[];
  const playerPubkeys: string[] = [];
  const physicalSeats: number[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const phys = Number(handSeatOrder[i]);
    const pk = seats[phys];
    if (!pk || pk.equals(emptyPk())) {
      throw new Error(`hand_seat_order[${i}] → empty seat ${phys}`);
    }
    playerPubkeys.push(pk.toBase58());
    physicalSeats.push(phys);
  }

  return {
    rpcUrl,
    roomSeed: tableMeta.roomSeed,
    tableId,
    gameId,
    gameIdHex: bytesToHex(gameId),
    numPlayers,
    playerPubkeys,
    physicalSeats,
    phase: Number(game.phase ?? 0),
    sharedMask: Number(game.sharedMask ?? game.shared_mask ?? 0) >>> 0,
    currentPlayer: Number(game.currentPlayer ?? game.current_player ?? 0),
  };
}

/** ElGamal public keys from light-casino PlayerState PDAs (full pk_x/pk_y). */
export async function fetchElGamalKeysFromChain(
  lightProgram: Program,
  gameId: Uint8Array,
  numPlayers: number,
): Promise<Array<[string, string] | null>> {
  const keys: Array<[string, string] | null> = [];
  for (let i = 0; i < numPlayers; i++) {
    try {
      const pda = lightPlayerStatePda(lightProgram.programId, gameId, i);
      const ps = await (lightProgram.account as any).playerState.fetch(pda);
      const pk = ps.publicKey ?? ps.public_key;
      if (!pk || !pk[0] || !pk[1]) {
        keys.push(null);
        continue;
      }
      const x = asByteArray(pk[0]);
      const y = asByteArray(pk[1]);
      if (isZeroGameId(x) && isZeroGameId(y)) {
        keys.push(null);
        continue;
      }
      keys.push([
        bytesToFieldBE(x).toString(),
        bytesToFieldBE(y).toString(),
      ]);
    } catch {
      keys.push(null);
    }
  }
  return keys;
}

/**
 * Align with `phaseFromChainAdvanced` in client.ts.
 * phase=3 (Evaluation) + betting_phase=0 → PreFlop (NOT Showdown).
 * Prior bug mapped phase>=3 → Showdown and skipped MPC streets.
 */
export function uiPhaseFromProofPhase(
  phase: number,
  bettingPhase?: number,
): GameSnapshot['phase'] {
  const bp = bettingPhase ?? 0;
  if (bp >= 1 && bp <= 4) {
    return (['PreFlop', 'Flop', 'Turn', 'River'] as const)[bp - 1]!;
  }
  if (bp === 5) return 'Showdown';
  if (phase === PROOF_PHASE_REGISTER) return 'Register';
  if (phase === PROOF_PHASE_SHUFFLE) return 'Shuffle';
  if (phase === PROOF_PHASE_SHARE) return 'Share';
  if (phase === 3) return 'PreFlop'; // Evaluation → hole-ack / PreFlop
  if (phase === 5) return 'Showdown';
  if (phase === 4 || phase === 6) return 'Complete';
  return 'lobby';
}

async function identityDeckJson(): Promise<string[][]> {
  try {
    const { buildBabyjub } = await import('circomlibjs');
    const babyjub = await buildBabyjub();
    const deck: string[][] = [];
    for (let i = 0; i < 52; i++) {
      const cardPoint = babyjub.mulPointEscalar(babyjub.Base8, BigInt(i + 1));
      deck.push([
        '0',
        '1',
        babyjub.F.toObject(cardPoint[0]).toString(),
        babyjub.F.toObject(cardPoint[1]).toString(),
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
      if (!Array.isArray(card) || card.length !== 4) throw err;
      return (card as unknown[]).map((limb) => String(limb));
    });
  }
}

export async function fetchDeckJsonFromChain(
  connection: web3.Connection,
  lightProgramId: web3.PublicKey,
  gameId: Uint8Array,
): Promise<string[][] | null> {
  const pda = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('deck_state'), Buffer.from(gameId)],
    lightProgramId,
  )[0];
  const info = await connection.getAccountInfo(pda, 'confirmed');
  // Poker allocates the 52-card shoe. The 8-deck ceiling is larger than that account.
  const pokerDeckBytes = deckStateAccountSize(52 * 4);
  if (!info || info.data.length < pokerDeckBytes) return null;
  const deck = parseDeckStateAccount(info.data) as Ciphertext[];
  return deck.map((card) => ciphertextToJson(card));
}

async function buildZkFromChain(
  hand: ActiveHandContext,
  keys: Array<[string, string] | null>,
  uiPhase: GameSnapshot['phase'],
  connection: web3.Connection,
  lightProgramId: web3.PublicKey,
): Promise<ZkHandSnapshot | undefined> {
  const pastShare = uiPhase === 'PreFlop'
    || uiPhase === 'Flop'
    || uiPhase === 'Turn'
    || uiPhase === 'River'
    || uiPhase === 'Showdown'
    || uiPhase === 'Complete';
  if (
    uiPhase !== 'Register'
    && uiPhase !== 'Shuffle'
    && uiPhase !== 'Share'
    && !pastShare
  ) {
    return undefined;
  }
  const n = hand.numPlayers;
  const registeredMask =
    hand.phase === PROOF_PHASE_REGISTER
      ? hand.sharedMask
      : (1 << n) - 1;
  const registeredCount =
    hand.phase === PROOF_PHASE_REGISTER
      ? popcount(registeredMask)
      : n;
  // Shuffle: current_player is next to shuffle; prior indices already done.
  const shuffledCount =
    hand.phase === PROOF_PHASE_SHUFFLE
      ? hand.currentPlayer
      : hand.phase > PROOF_PHASE_SHUFFLE
        ? n
        : 0;
  const sharedMask = hand.phase === PROOF_PHASE_SHARE ? hand.sharedMask : 0;
  const sharedCount = pastShare ? n : popcount(sharedMask);
  const currentShufflerIndex =
    uiPhase === 'Shuffle' ? hand.currentPlayer : null;
  const currentShufflerSeat =
    currentShufflerIndex !== null
      ? (hand.physicalSeats[currentShufflerIndex] ?? null)
      : null;

  let currentDeck: string[][] | null = null;
  let shareDeck: string[][] | null = null;
  if (uiPhase === 'Shuffle' || uiPhase === 'Share' || pastShare) {
    const fromChain = await fetchDeckJsonFromChain(
      connection,
      lightProgramId,
      hand.gameId,
    );
    if (fromChain) {
      currentDeck = fromChain;
      if (uiPhase === 'Share' || pastShare) shareDeck = fromChain;
    } else if (uiPhase === 'Shuffle' && hand.currentPlayer === 0) {
      // P0 shuffles the known identity deck before deck_state exists.
      currentDeck = await identityDeckJson();
    }
  }

  return {
    phase: pastShare ? 'Share' : uiPhase,
    shuffleOrder: Array.from({ length: n }, (_, i) => i),
    shuffleStep: shuffledCount,
    currentShufflerIndex,
    currentShufflerSeat,
    registeredCount,
    shuffledCount,
    sharedCount,
    requiredShares: n,
    hasSharedPartial: Array.from({ length: n }, (_, i) =>
      pastShare ? true : (sharedMask & (1 << i)) !== 0
    ),
    registerRequested: uiPhase === 'Register',
    shuffleRequested: uiPhase === 'Shuffle',
    shareRequested: uiPhase === 'Share',
    shareComplete: pastShare || (uiPhase === 'Share' && sharedCount === n),
    dealCardCount: dealCardCount(n),
    elGamalPublicKeys: keys.slice(0, n),
    cardsDealtFaceDown: pastShare,
    currentDeck,
    shareDeck,
  };
}

export function buildZkCryptoFromDeck(
  hand: ActiveHandContext,
  keys: Array<[string, string] | null>,
  deck: string[][] | null | undefined,
): ZkCryptoSnapshot | undefined {
  if (!deck || deck.length < 52) return undefined;
  const elGamalPublicKeys = keys.slice(0, hand.numPlayers).map((k) => {
    if (!k) return ['0', '0'] as [string, string];
    return k;
  });
  if (elGamalPublicKeys.some((k) => k[0] === '0' && k[1] === '0')) {
    return undefined;
  }
  return {
    handNumPlayers: hand.numPlayers,
    elGamalPublicKeys,
    finalDeck: deck,
    dealCardCount: dealCardCount(hand.numPlayers),
  };
}

/**
 * Enrich lobby/table snapshot with ZK hand fields from chain.
 * Returns null when no hand is active (caller may leave lobby).
 */
export async function enrichSnapshotFromChain(
  snap: GameSnapshot,
  rpcUrl = LOCALNET_RPC_URL,
): Promise<GameSnapshot | null> {
  let hand: ActiveHandContext;
  try {
    hand = await resolveActiveHandFromChain(rpcUrl);
  } catch {
    return enrichSnapshotFromHandComplete(snap);
  }

  // Pull peer street-acted / street-bets so dual-WebView clients agree on close.
  await getSharedMetaStore().refreshFromDisk?.(['street-acted', 'street-bets']);

  const provider = await readOnlyProvider(rpcUrl);
  const lightProgram = loadLightCasinoProgram(provider);
  const pokerProgram = loadCasinoProgram(provider);
  let bettingPhase = 0;
  let showdownFinalized = false;
  let currentBet = '0';
  let foldedMask = 0;
  let playerTotalBets: string[] = [];
  try {
    const gameAccount = await (pokerProgram.account as any).gameState.fetch(
      gameStatePda(pokerProgram.programId, hand.gameId),
    );
    bettingPhase = Number(gameAccount.bettingPhase ?? gameAccount.betting_phase ?? 0);
    hand = {
      ...hand,
      phase: Number(gameAccount.phase ?? hand.phase),
      sharedMask: Number(gameAccount.sharedMask ?? gameAccount.shared_mask ?? hand.sharedMask) >>> 0,
      currentPlayer: Number(
        gameAccount.currentPlayer ?? gameAccount.current_player ?? hand.currentPlayer,
      ),
    };
    showdownFinalized = Boolean(
      gameAccount.showdownFinalized ?? gameAccount.showdown_finalized,
    );
    currentBet = String(
      gameAccount.currentBet?.toString?.()
        ?? gameAccount.current_bet?.toString?.()
        ?? '0',
    );
    foldedMask = Number(gameAccount.foldedMask ?? gameAccount.folded_mask ?? 0);
    const totals = gameAccount.playerTotalBets ?? gameAccount.player_total_bets;
    if (Array.isArray(totals)) {
      playerTotalBets = totals
        .slice(0, hand.numPlayers)
        .map((x: { toString(): string }) => String(x?.toString?.() ?? '0'));
    }
  } catch {
    // use hand as resolved
  }

  // Hand-complete meta is written only after showdown proof accept (or
  // ALLOW_SOFT_SHOWDOWN smoke). Prefer it for this gameId even if endHand
  // flipped table state / proof phase back toward Register.
  await getSharedMetaStore().refreshFromDisk?.(['hand-complete']);
  {
    const complete = loadHandCompleteMeta();
    const metaMatchesHand = complete && complete.gameIdHex === hand.gameIdHex;
    const showdownDone = showdownFinalized
      && (hand.phase === 5 || bettingPhase === 5 || hand.phase === 6);
    if (metaMatchesHand || (showdownDone && complete?.gameIdHex === hand.gameIdHex)) {
      if (complete) {
        return applyHandCompleteToSnapshot(snap, complete);
      }
    }
  }

  const keys = await fetchElGamalKeysFromChain(lightProgram, hand.gameId, hand.numPlayers);
  const uiPhase = uiPhaseFromProofPhase(hand.phase, bettingPhase);
  const zk = await buildZkFromChain(
    hand,
    keys,
    uiPhase,
    provider.connection,
    lightProgram.programId,
  );

  const playerIndexBySeat: Record<number, number> = {};
  for (let i = 0; i < hand.physicalSeats.length; i += 1) {
    playerIndexBySeat[hand.physicalSeats[i]!] = i;
  }

  const registeredMask =
    hand.phase === PROOF_PHASE_REGISTER ? hand.sharedMask : (1 << hand.numPlayers) - 1;
  const nextRegisterIndex =
    uiPhase === 'Register'
      ? lowestUnsetBit(registeredMask, hand.numPlayers)
      : null;

  const pastShare = hand.phase > PROOF_PHASE_SHARE
    || uiPhase === 'PreFlop'
    || uiPhase === 'Flop'
    || uiPhase === 'Turn'
    || uiPhase === 'River'
    || uiPhase === 'Showdown'
    || uiPhase === 'Complete';
  const streetMeta = loadStreetBetsMeta();
  const streetBetsFromMeta =
    streetMeta
    && streetMeta.gameIdHex === hand.gameIdHex
    && streetMeta.bettingPhase === bettingPhase
      ? streetMeta.streetBets
      : null;
  // PreFlop: prefer street-bets meta; else on-chain totals only when they are
  // consistent with currentBet (max total ≤ currentBet). Inflated totals make
  // toCall negative → spurious checks while currentPlayer still owes a call.
  const curBetBi = (() => {
    try {
      return BigInt(currentBet || '0');
    } catch {
      return 0n;
    }
  })();
  const totalsLookLikeStreet =
    playerTotalBets.length >= hand.numPlayers
    && playerTotalBets.every((b) => {
      try {
        return BigInt(b) <= curBetBi;
      } catch {
        return false;
      }
    });
  const streetBets: string[] | null = streetBetsFromMeta
    ?? (bettingPhase === 1 && totalsLookLikeStreet
      ? playerTotalBets
      : bettingPhase === 1
        ? Array.from({ length: hand.numPlayers }, (_, i) =>
          (i === 0 ? '10' : i === 1 ? '20' : '0'))
        : null);

  // Betting street closure is decided atomically on-chain in validate_bet_v2_callback.
  // If betting_phase is still 1..4, the chain still has an authoritative actor;
  // local `.local` street-bets / acted metadata must not close the round early.
  const bettingOpen = bettingPhase >= 1 && bettingPhase <= 4;
  const holesViewPending = pastShare && bettingPhase === 0 && uiPhase === 'PreFlop';

  let currentPlayerSeat = snap.currentPlayerSeat;
  let currentPlayerIndex = snap.currentPlayerIndex;
  // Register is parallel — do not pin currentPlayerSeat to one unset bit.
  // That made the other seat look "not to act" in UI/effect turn tokens.
  if (uiPhase === 'Register') {
    currentPlayerSeat = null;
    currentPlayerIndex = nextRegisterIndex;
  } else if (bettingOpen) {
    currentPlayerIndex = hand.currentPlayer;
    currentPlayerSeat = hand.physicalSeats[hand.currentPlayer] ?? null;
  } else if (zk?.currentShufflerSeat != null) {
    currentPlayerSeat = zk.currentShufflerSeat;
    currentPlayerIndex = zk.currentShufflerIndex;
  }

  const holeCards: Record<number, [number, number]> = {};
  for (let i = 0; i < hand.physicalSeats.length; i++) {
    holeCards[hand.physicalSeats[i]!] = holeCardIndices(i);
  }
  const boardCards = [20, 21, 22, 23, 24];

  const seats = mergeHandSeatsForUi({
    tableSeats: snap.seats,
    physicalSeats: hand.physicalSeats,
    playerPubkeys: hand.playerPubkeys,
    playerIndexBySeat,
    streetBets,
    foldedMask,
  });

  const zkCrypto = pastShare
    ? buildZkCryptoFromDeck(hand, keys, zk?.currentDeck ?? zk?.shareDeck)
    : undefined;
  const boardRevealed = boardIndicesRevealedForUiPhase(uiPhase);
  const showdownPublic = uiPhase === 'Showdown' || uiPhase === 'Complete';

  return {
    ...snap,
    phase: uiPhase,
    handNumber: snap.handNumber ?? 1,
    actionOrder: [...hand.physicalSeats],
    playerIndexBySeat,
    smallBlindSeat: hand.physicalSeats[0] ?? snap.smallBlindSeat,
    bigBlindSeat: hand.physicalSeats[1] ?? snap.bigBlindSeat,
    currentBet: bettingOpen || holesViewPending ? currentBet : snap.currentBet,
    currentPlayerSeat,
    currentPlayerIndex,
    bettingRoundOpen: bettingOpen,
    holesViewPending,
    seats,
    holeCards: pastShare ? holeCards : snap.holeCards,
    boardCards: pastShare ? boardCards : snap.boardCards,
    zk,
    zkCrypto: zkCrypto ?? snap.zkCrypto,
    zkReveal: pastShare
      ? {
          revealedCardIndices: boardRevealed,
          newlyRevealed: [],
          allPartialsPublic: showdownPublic,
          shareComplete: true,
          holePartialsUnlocked: true,
          entries: [],
        }
      : snap.zkReveal,
    zkShowdown: uiPhase === 'Showdown'
      ? {
          requested: true,
          requiredCount: 1,
          eligibleSeats: [...hand.physicalSeats],
          submitterSeat: hand.physicalSeats[0] ?? null,
          // Keep submittedCount at 0 until hand-complete meta lands so clients
          // resume settle→Complete after a timed-out post-verify submit.
          submittedCount: 0,
          submittedSeats: [],
          outputHash: null,
          finalizedOnChain: showdownFinalized,
        }
      : snap.zkShowdown,
  };
}

export function loadHandCompleteMeta(): HandCompleteMeta | null {
  const raw = readSharedMeta(HAND_COMPLETE_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HandCompleteMeta;
  } catch {
    return null;
  }
}

/** Shared-meta JSON. Winner masks and pot amounts are bigints; Maps are seat tables. */
function jsonForSharedMeta(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Map) return Object.fromEntries(item);
      return item;
    },
    2,
  );
}

export function saveHandCompleteMeta(meta: HandCompleteMeta): void {
  writeSharedMeta(HAND_COMPLETE_META_KEY, jsonForSharedMeta(meta));
}

/** Drop prior-hand Complete so a new hand cannot flash Showdown/Complete UI. */
export function clearHandCompleteMeta(): void {
  try {
    writeSharedMeta(HAND_COMPLETE_META_KEY, '');
  } catch {
    // ignore
  }
}

/**
 * Ensure every hand participant appears in the UI seat list.
 * Table escrow snapshots can omit a peer while chain events still drive Share.
 */
export function mergeHandSeatsForUi(opts: {
  tableSeats: SeatSnapshot[];
  physicalSeats: number[];
  playerPubkeys: string[];
  playerIndexBySeat: Record<number, number>;
  streetBets: string[] | null;
  foldedMask: number;
}): SeatSnapshot[] {
  const seatsByNum = new Map(opts.tableSeats.map((s) => [s.seat, s]));
  for (let i = 0; i < opts.physicalSeats.length; i += 1) {
    const seatNum = opts.physicalSeats[i]!;
    const pk = opts.playerPubkeys[i]!;
    const existing = seatsByNum.get(seatNum);
    if (!existing) {
      seatsByNum.set(seatNum, {
        seat: seatNum,
        name: `Seat ${seatNum}`,
        publicKey: pk,
        chips: '0',
        seatEscrow: '0',
        bet: '0',
        folded: false,
        active: false,
      });
    } else if (!existing.publicKey && pk) {
      seatsByNum.set(seatNum, { ...existing, publicKey: pk });
    }
  }
  return [...seatsByNum.values()]
    .sort((a, b) => a.seat - b.seat)
    .map((seat) => {
      const pi = opts.playerIndexBySeat[seat.seat];
      const bet = pi !== undefined && opts.streetBets
        ? (opts.streetBets[pi] ?? seat.bet)
        : seat.bet;
      return {
        ...seat,
        playerIndex: pi ?? seat.playerIndex,
        bet,
        folded: pi !== undefined ? ((opts.foldedMask & (1 << pi)) !== 0) : seat.folded,
      };
    });
}

function applyHandCompleteToSnapshot(
  snap: GameSnapshot,
  complete: HandCompleteMeta,
): GameSnapshot {
  const boardRevealed = boardIndicesRevealedForUiPhase('Complete');
  const zkCrypto = complete.zkCrypto
    ?? (complete.handResult.zkFinalDeck
      ? {
          handNumPlayers: complete.handResult.handNumPlayers
            ?? complete.handResult.seatHands.length,
          elGamalPublicKeys: snap.zkCrypto?.elGamalPublicKeys ?? [],
          finalDeck: complete.handResult.zkFinalDeck,
          dealCardCount: complete.handResult.zkFinalDeck.length,
        }
      : snap.zkCrypto);
  const zkReveal: ZkRevealSnapshot = complete.zkReveal ?? {
    revealedCardIndices: boardRevealed,
    newlyRevealed: [],
    allPartialsPublic: true,
    shareComplete: true,
    holePartialsUnlocked: true,
    entries: [],
  };
  return {
    ...snap,
    gameKind: complete.gameKind ?? snap.gameKind,
    phase: 'Complete',
    handNumber: complete.handResult.handNumber,
    actionOrder: complete.handResult.actionOrder,
    playerIndexBySeat: Object.fromEntries(
      complete.handResult.seatHands.map((s) => [s.seat, s.playerIndex]),
    ),
    holeCards: Object.fromEntries(
      complete.handResult.seatHands.map((s) => [s.seat, s.holeCards]),
    ),
    boardCards: complete.handResult.boardCards,
    handResult: complete.handResult,
    zkCrypto: zkCrypto ?? snap.zkCrypto,
    zkReveal,
    bettingRoundOpen: false,
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    holesViewPending: false,
  };
}

/** Soft E2E Complete when active hand is gone but hand-complete meta remains. */
export function enrichSnapshotFromHandComplete(
  snap: GameSnapshot,
): GameSnapshot | null {
  const complete = loadHandCompleteMeta();
  if (!complete) return null;
  const tableRaw = readSharedMeta('shared-table');
  let tableId: string | null = null;
  try {
    tableId = tableRaw
      ? String((JSON.parse(tableRaw) as { tableId?: string }).tableId ?? '') || null
      : null;
  } catch {
    tableId = null;
  }
  if (tableId !== null && String(complete.tableId) !== tableId) return null;
  // Active shared-hand for a different gameId means this Complete is stale —
  // applying it made one seat jump to Complete/Showdown while the peer played.
  const handRaw = readSharedMeta('shared-hand');
  if (handRaw) {
    try {
      const active = JSON.parse(handRaw) as { gameIdHex?: string };
      if (active.gameIdHex && active.gameIdHex !== complete.gameIdHex) {
        return null;
      }
    } catch {
      // ignore malformed mirror
    }
  }
  return applyHandCompleteToSnapshot(snap, complete);
}
