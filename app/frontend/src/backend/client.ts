export type BackendKind = 'local' | 'solana' | 'devnet';

import { Connection } from '@solana/web3.js';
import { getLocalSecretKeyBytes } from '../identity/player-key';
import { resolveApiBase } from '../server/runtime';
import {
  ActionKind,
  actionKindToBettingPhaseLabel,
  formatSolanaChainEvent,
  parseEventsFromLogs,
  subscribePokerProgramEvents,
  type BetEvent,
  type PhaseAdvancedEvent,
  type PlayerActionRequired,
  type StreetAdvancedEvent,
} from '@poker-src/chain/player-action-events';
import { boardIndicesRevealedForUiPhase } from '@poker-src/backend/card-layout';
import { hasSolanaOpBridge } from './solana-bridge';
// Browser-safe constant — do NOT import localnet-config (touches process.env).
const CHAIN_CASINO_PROGRAM_ID = '4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY';

/** Ops that sign on-chain with this window's room session key. */
export const SEATING_OPS = new Set([
  'joinGame',
  'join',
  'standUp',
  'stand',
  'faucetCreditPersonal',
  'faucet',
  'transferPersonalToSeat',
  'transferToSeat',
  'transferSeatToPersonal',
  'transferToPersonal',
  'registerHandKey',
  'register',
  'submitShuffle',
  'shuffle',
  'submitShare',
  'share',
  'placeBet',
  'action',
  'submitShowdown',
  'showdown',
  'getShowdownMaterials',
  'startHand',
  'start',
  'beginHand',
  'showdownMaterials',
  'advanceStreet',
  'advance',
  'revealSealedPartials',
  'fetchRevealedPartials',
  'revealedPartials',
  'acknowledgeHoleCards',
  'ackHoles',
]);

/** Lifecycle ranks — chain phase must not be overwritten by a lagging worker. */
export const SOLANA_PHASE_RANK: Record<string, number> = {
  lobby: 0,
  Register: 1,
  Shuffle: 2,
  Share: 3,
  PreFlop: 4,
  Flop: 5,
  Turn: 6,
  River: 7,
  Showdown: 8,
  Complete: 9,
};

/** True when `next` is a forward advance or an allowed hand reset. */
export function isChainPhaseForward(
  prev: BettingPhase | undefined,
  next: BettingPhase,
): boolean {
  if (!prev || prev === 'lobby') {
    return true;
  }
  // Per-seat getGame raw table snapshot is always `lobby`. Treating that as
  // forward wiped Register/Shuffle and blocked registerProve forever.
  if (next === 'lobby') {
    return prev === 'Complete' || prev === 'lobby';
  }
  if (next === 'Register' && (prev === 'Complete' || prev === 'Register')) {
    return true;
  }
  const prevRank = SOLANA_PHASE_RANK[prev];
  const nextRank = SOLANA_PHASE_RANK[next];
  if (prevRank === undefined || nextRank === undefined) {
    return true;
  }
  return nextRank >= prevRank;
}

/**
 * Merge optional worker materials into a chain-cursor snapshot.
 * Worker may enrich seats/zk/chips; it must not regress phase/turn vs chain.
 */
export function mergeWorkerIntoChainSnapshot(
  chainBase: GameSnapshot,
  worker: GameSnapshot,
): GameSnapshot {
  const workerPhase = worker.phase;
  const chainPhase = chainBase.phase;
  const workerOk = isChainPhaseForward(chainPhase, workerPhase);
  // Prefer worker when equal/ahead (materials + phase). Keep chain cursor when worker lags.
  const phase = workerOk ? workerPhase : chainPhase;
  const keepChainTurn = !workerOk || workerPhase === chainPhase;
  const currentPlayerIndex = keepChainTurn
    ? (chainBase.currentPlayerIndex ?? worker.currentPlayerIndex)
    : (worker.currentPlayerIndex ?? chainBase.currentPlayerIndex);
  const currentPlayerSeat = keepChainTurn
    ? (chainBase.currentPlayerSeat ?? worker.currentPlayerSeat)
    : (worker.currentPlayerSeat ?? chainBase.currentPlayerSeat);
  // Once chain opened betting (PlayerActionRequired Bet), do not let a lagging
  // worker snap it shut. Worker may still open betting when materials catch up.
  const bettingRoundOpen = workerOk
    ? (worker.bettingRoundOpen || chainBase.bettingRoundOpen)
    : (chainBase.bettingRoundOpen || worker.bettingRoundOpen);

  // When worker phase is rejected (e.g. raw lobby), do not spread worker over
  // chain — that wiped zk / playerIndexBySeat and stalled Register.
  if (!workerOk) {
    return {
      ...chainBase,
      phase,
      currentPlayerIndex,
      currentPlayerSeat,
      bettingRoundOpen,
      seats: worker.seats.length > 0
        ? worker.seats.map((seat) => ({
          ...seat,
          active: currentPlayerSeat !== null && seat.seat === currentPlayerSeat,
        }))
        : chainBase.seats,
      handNumber: chainBase.handNumber ?? worker.handNumber,
      zk: chainBase.zk ?? worker.zk,
      playerIndexBySeat: chainBase.playerIndexBySeat ?? worker.playerIndexBySeat,
      actionOrder: chainBase.actionOrder ?? worker.actionOrder,
    };
  }

  return {
    ...worker,
    phase,
    currentPlayerIndex,
    currentPlayerSeat,
    bettingRoundOpen,
    seats: worker.seats.length > 0
      ? worker.seats.map((seat) => ({
        ...seat,
        active: currentPlayerSeat !== null && seat.seat === currentPlayerSeat,
      }))
      : chainBase.seats,
    handNumber: worker.handNumber ?? chainBase.handNumber,
    zk: worker.zk ?? chainBase.zk,
    playerIndexBySeat: worker.playerIndexBySeat ?? chainBase.playerIndexBySeat,
    actionOrder: worker.actionOrder ?? chainBase.actionOrder,
  };
}

/**
 * Map on-chain GameState.phase / betting_phase → UI BettingPhase.
 *
 * After the last share receipt, chain sets phase=3 (Evaluation /
 * PROOF_PHASE_SHOWDOWN) with betting_phase=0. That means “share done —
 * hole cards + PreFlop betting next”, NOT UI Showdown. Jumping to
 * Showdown here skips MPC streets (Event log: Share → Showdown).
 *
 * UI Showdown is phase=5 or betting_phase=5 (start_betting_round(5)).
 */
export function phaseFromChainAdvanced(ev: PhaseAdvancedEvent): BettingPhase {
  if (ev.bettingPhase >= 1 && ev.bettingPhase <= 4) {
    const labels = ['PreFlop', 'Flop', 'Turn', 'River'] as const;
    return labels[ev.bettingPhase - 1]!;
  }
  if (ev.bettingPhase === 5) {
    return 'Showdown';
  }
  switch (ev.phase) {
    case 0:
      return 'Register';
    case 1:
      return 'Shuffle';
    case 2:
      return 'Share';
    case 3:
      // Evaluation: share complete, await hole-ack + PreFlop MPC.
      return 'PreFlop';
    case 4:
      return 'Complete';
    case 5:
      return 'Showdown';
    case 6:
      return 'Complete';
    default:
      return 'lobby';
  }
}

function applyPhaseAdvancedToSnapshot(
  snapshot: GameSnapshot,
  ev: PhaseAdvancedEvent,
): GameSnapshot {
  const nextPhase = phaseFromChainAdvanced(ev);
  if (!isChainPhaseForward(snapshot.phase, nextPhase) && nextPhase !== 'Register') {
    // Ignore stale/out-of-order PhaseAdvanced (keep materials).
    return snapshot;
  }
  const seatFromIndex =
    snapshot.actionOrder?.[ev.currentPlayer]
    ?? (snapshot.playerIndexBySeat
      ? Number(
        Object.entries(snapshot.playerIndexBySeat).find(
          ([, idx]) => idx === ev.currentPlayer,
        )?.[0],
      )
      : NaN);
  const currentPlayerSeat = Number.isFinite(seatFromIndex)
    ? seatFromIndex
    : snapshot.currentPlayerSeat;
  // Share→Evaluation lands as PreFlop with betting_phase=0. Chain events omit
  // holesViewPending/zkReveal — without them native autoplay never ack-holes
  // or open PreFlop betting (stalls on Evaluation PhaseAdvanced spam).
  const enteringHoleAck =
    nextPhase === 'PreFlop'
    && (ev.bettingPhase ?? 0) === 0
    && (snapshot.phase === 'Share' || snapshot.phase === 'PreFlop' || snapshot.phase === 'Shuffle');
  const holesViewPending = enteringHoleAck
    ? true
    : (ev.bettingPhase ?? 0) >= 1
      ? false
      : snapshot.holesViewPending;
  const streetBoardIndices = boardIndicesRevealedForUiPhase(nextPhase);
  const revealedCardIndices = [
    ...new Set([
      ...(snapshot.zkReveal?.revealedCardIndices ?? []),
      ...streetBoardIndices,
    ]),
  ].sort((a, b) => a - b);
  const zkReveal = enteringHoleAck || streetBoardIndices.length > 0
    ? {
      revealedCardIndices,
      newlyRevealed: streetBoardIndices.filter(
        (idx) => !(snapshot.zkReveal?.revealedCardIndices ?? []).includes(idx),
      ),
      allPartialsPublic: nextPhase === 'Showdown' || nextPhase === 'Complete'
        ? true
        : (snapshot.zkReveal?.allPartialsPublic ?? false),
      shareComplete: true,
      holePartialsUnlocked: true,
      entries: snapshot.zkReveal?.entries ?? [],
    }
    : snapshot.zkReveal;
  const zk = snapshot.zk && nextPhase === 'Shuffle'
    ? {
        ...snapshot.zk,
        currentShufflerIndex: ev.currentPlayer,
        currentShufflerSeat: Number.isFinite(seatFromIndex) ? seatFromIndex : null,
        shuffledCount: ev.currentPlayer,
      }
    : snapshot.zk;
  return {
    ...snapshot,
    phase: nextPhase,
    zk,
    // Chain events do not carry handNumber; keep/default so ZK flow can start.
    handNumber: snapshot.handNumber ?? (nextPhase === 'lobby' ? snapshot.handNumber : 1),
    currentPlayerIndex: ev.currentPlayer,
    currentPlayerSeat,
    holesViewPending,
    zkReveal,
    bettingRoundOpen: (ev.bettingPhase ?? 0) >= 1 && (ev.bettingPhase ?? 0) <= 4
      ? true
      : enteringHoleAck
        ? false
        : snapshot.bettingRoundOpen,
    seats: snapshot.seats.map((seat) => ({
      ...seat,
      active: seat.seat === currentPlayerSeat,
    })),
  };
}

export { ActionKind };
/** Optional chain worker (localnet bootstrap / CompDefs) — not required for event-driven play. */
export const DEFAULT_CHAIN_WORKER_URL = 'http://127.0.0.1:3850';

/** Default Solana JSON-RPC for event subscription + health. */
export const DEFAULT_SOLANA_RPC_URL = 'http://127.0.0.1:8899';

/** Devnet MXE this app plays on. */
export const DEVNET_CLUSTER_OFFSET = 456;

const BACKEND_STORAGE_KEY = 'poker-backend';

export function storedChainBackend(): 'solana' | 'devnet' | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const stored = localStorage.getItem(BACKEND_STORAGE_KEY);
    if (stored === 'solana' || stored === 'devnet') return stored;
  } catch {
    // private mode
  }
  return null;
}

function isLoopbackRpc(rpc: string): boolean {
  return rpc.includes('127.0.0.1') || rpc.includes('localhost');
}

/** Status text that does not include a remote RPC address. */
export function chainRpcLabel(rpcUrl: string): string {
  return isLoopbackRpc(rpcUrl) ? '127.0.0.1:8899' : 'devnet';
}

export const CASINO_PROGRAM_ID = CHAIN_CASINO_PROGRAM_ID;

/** Matches `SOLANA_TABLE_GAME_ID` — shared localnet table id string. */
export const SOLANA_TABLE_GAME_ID = 'solana-local-table';

type LaunchConfigWindow = Window & {
  __ZK_LAUNCH_CONFIG?: {
    apiBase?: string;
    chainWorker?: string;
    solanaRpc?: string;
    clusterOffset?: number;
    backend?: 'local' | 'solana' | string;
  };
};

/**
 * Optional dedicated chain-worker URL (:3850). Returns null unless explicitly
 * opted in via `?chainWorker=` / launch-config `chainWorker` / env.
 * Solana gameplay defaults to same-origin Vite `/api/game*` instead.
 */
export function resolveOptionalChainWorkerBase(): string | null {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    // Explicit opt-out
    if (params.get('chainWorker') === '0' || params.get('noChainWorker') === '1') {
      return null;
    }
    const queryBase =
      params.get('chainWorker')
      ?? params.get('chainWorkerBase');
    if (queryBase?.trim()) {
      return queryBase.trim().replace(/\/$/, '');
    }
    const launch = (window as LaunchConfigWindow).__ZK_LAUNCH_CONFIG;
    if (typeof launch?.chainWorker === 'string' && launch.chainWorker.trim()) {
      return launch.chainWorker.trim().replace(/\/$/, '');
    }
    const envBase = import.meta.env.VITE_CHAIN_WORKER_URL;
    if (typeof envBase === 'string' && envBase.trim()) {
      return envBase.trim().replace(/\/$/, '');
    }
  }
  return null;
}

/**
 * HTTP base for Solana table mutations — only when explicitly opted in
 * (`?chainWorker=` / `?tableApi=`). Default Solana gameplay uses native
 * `solana.op` bridge → player CLI → RPC (no Vite `/api/game*`).
 */
export function resolveSolanaTableApiBase(): string | null {
  const explicitWorker = resolveOptionalChainWorkerBase();
  if (explicitWorker) {
    return explicitWorker;
  }
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('chainWorker') === '0' || params.get('noChainWorker') === '1') {
      return null;
    }
    const tableApi =
      params.get('tableApi')
      ?? params.get('solanaTableApi');
    if (tableApi?.trim()) {
      return tableApi.trim().replace(/\/$/, '');
    }
    // Opt-in legacy Vite middleware (dev only).
    if (params.get('viteTableApi') === '1' || import.meta.env.VITE_SOLANA_TABLE_API === '1') {
      if (window.location?.origin && window.location.origin.startsWith('http')) {
        return window.location.origin.replace(/\/$/, '');
      }
    }
  }
  return null;
}

/** @deprecated Prefer resolveOptionalChainWorkerBase — kept for tests / explicit worker tooling. */
export function resolveChainWorkerBase(baseUrl = DEFAULT_CHAIN_WORKER_URL): string {
  return (resolveOptionalChainWorkerBase() ?? baseUrl).replace(/\/$/, '');
}

export function resolveSolanaRpcUrl(fallback = DEFAULT_SOLANA_RPC_URL): string {
  const kind = storedChainBackend();
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const query =
      params.get('solanaRpc')
      ?? params.get('rpcUrl')
      ?? params.get('rpc');
    if (query?.trim() && (kind !== 'devnet' || !isLoopbackRpc(query))) {
      return query.trim().replace(/\/$/, '');
    }
    if (kind === 'solana') {
      return DEFAULT_SOLANA_RPC_URL;
    }
    const launch = (window as LaunchConfigWindow).__ZK_LAUNCH_CONFIG;
    if (typeof launch?.solanaRpc === 'string' && launch.solanaRpc.trim()) {
      const url = launch.solanaRpc.trim().replace(/\/$/, '');
      if (kind !== 'devnet' || !isLoopbackRpc(url)) {
        return url;
      }
    }
    const envRpc = import.meta.env.VITE_SOLANA_RPC;
    if (typeof envRpc === 'string' && envRpc.trim()) {
      const url = envRpc.trim().replace(/\/$/, '');
      if (kind !== 'devnet' || !isLoopbackRpc(url)) {
        return url;
      }
    }
  }
  if (kind === 'devnet') {
    return '';
  }
  return fallback.replace(/\/$/, '');
}

export interface ChainWorkerHealth {
  ok: boolean;
  worker?: boolean;
  /** True when Solana RPC responds (primary health signal). */
  rpcReady?: boolean;
  port?: number;
  rpcUrl?: string;
  localnetReady?: boolean;
  sessionReady?: boolean;
  attachError?: string | null;
  hint?: string;
  /** True when optional HTTP worker is configured and reachable. */
  workerOptional?: boolean;
}

async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return trimmed;
  }
  try {
    const body = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') {
      return body.error;
    }
    if (typeof body.message === 'string') {
      return body.message;
    }
  } catch {
    // fall through
  }
  return trimmed;
}

function emptySolanaSnapshot(gameId = SOLANA_TABLE_GAME_ID): GameSnapshot {
  return {
    gameId,
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
    pots: [],
  };
}

function applyPlayerActionToSnapshot(
  snapshot: GameSnapshot,
  action: PlayerActionRequired,
): GameSnapshot {
  const phaseLabel = actionKindToBettingPhaseLabel(
    action.actionKind,
    action.bettingPhase,
    action.phase,
  );
  const proposed = (phaseLabel === 'lobby' ? snapshot.phase : phaseLabel) as BettingPhase;
  // Turn prompts are authoritative; phase label must not regress vs chain cursor.
  const phase = isChainPhaseForward(snapshot.phase, proposed)
    ? proposed
    : snapshot.phase;
  const seatFromIndex =
    snapshot.actionOrder?.[action.playerIndex]
    ?? (snapshot.playerIndexBySeat
      ? Number(
        Object.entries(snapshot.playerIndexBySeat).find(
          ([, idx]) => idx === action.playerIndex,
        )?.[0],
      )
      : NaN);
  const currentPlayerSeat = Number.isFinite(seatFromIndex) ? seatFromIndex : snapshot.currentPlayerSeat;
  // Chain bet prompts can arrive before the worker publishes blinds. Opening
  // bettingRoundOpen on a pre-blind snapshot makes auto-play check into the BB.
  const bettingRoundOpen = action.actionKind === ActionKind.Bet
    ? !snapshot.holesViewPending
    : snapshot.bettingRoundOpen;

  return {
    ...snapshot,
    phase,
    currentPlayerIndex: action.playerIndex,
    currentPlayerSeat,
    bettingRoundOpen,
    seats: snapshot.seats.map((seat) => ({
      ...seat,
      active: seat.seat === currentPlayerSeat,
    })),
  };
}

/**
 * Apply a `BetEvent` to the local snapshot immediately so the next player's
 * client reflects the new street bet / pot / current bet without waiting for the
 * materials poll. Turn advance still comes from `PlayerActionRequired`.
 */
export function applyBetEventToSnapshot(
  snapshot: GameSnapshot,
  bet: BetEvent,
): GameSnapshot {
  const shouldApplyStreetBet =
    snapshot.phase === 'PreFlop'
    || snapshot.phase === 'Flop'
    || snapshot.phase === 'Turn'
    || snapshot.phase === 'River';
  const seatFromIndex =
    snapshot.actionOrder?.[bet.playerIndex]
    ?? (snapshot.playerIndexBySeat
      ? Number(
        Object.entries(snapshot.playerIndexBySeat).find(
          ([, idx]) => idx === bet.playerIndex,
        )?.[0],
      )
      : NaN);
  const actorSeat = Number.isFinite(seatFromIndex) ? seatFromIndex : null;

  let currentBet = snapshot.currentBet;
  const seats = snapshot.seats.map((seat) => {
    if (actorSeat === null || seat.seat !== actorSeat) {
      return seat;
    }
    let nextBet = seat.bet;
    if (shouldApplyStreetBet && bet.amount > 0n) {
      let prev = 0n;
      try {
        prev = BigInt(seat.bet || '0');
      } catch {
        prev = 0n;
      }
      const updated = prev + bet.amount;
      nextBet = updated.toString();
      // Bet/raise (3/4) or all-in that grows the street bet raises the table bet.
      if (bet.action === 3 || bet.action === 4 || bet.action === 5) {
        try {
          if (updated > BigInt(currentBet || '0')) {
            currentBet = updated.toString();
          }
        } catch {
          currentBet = updated.toString();
        }
      }
    }
    return {
      ...seat,
      bet: nextBet,
      folded: bet.isFold ? true : seat.folded,
    };
  });

  const pots = snapshot.pots.length > 0 && bet.amount > 0n
    ? snapshot.pots.map((pot, index) => {
      if (index !== 0) return pot;
      const amount = (() => {
        try {
          return BigInt(pot.amount || '0') + bet.amount;
        } catch {
          return bet.amount;
        }
      })();
      return {
        ...pot,
        amount: amount.toString(),
        lastBet: bet.amount.toString(),
      };
    })
    : snapshot.pots;

  return { ...snapshot, currentBet, seats, pots };
}

/**
 * Apply a `StreetAdvancedEvent`: advance to the next street and reset per-seat
 * street bets so the next round of check/bet starts clean — immediately, with no
 * poll delay. Reuses the PhaseAdvanced apply for phase/turn/board reveal.
 */
export function applyStreetAdvancedToSnapshot(
  snapshot: GameSnapshot,
  street: StreetAdvancedEvent,
): GameSnapshot {
  const advanced = applyPhaseAdvancedToSnapshot(snapshot, {
    gameId: street.gameId,
    phase: street.phase,
    bettingPhase: street.bettingPhase,
    currentPlayer: street.currentPlayer,
  });
  if (street.bettingPhase === 5 || advanced.phase === 'Showdown') {
    return {
      ...advanced,
      bettingRoundOpen: false,
      currentBet: '0',
      seats: advanced.seats.map((seat) => ({ ...seat, bet: '0' })),
    };
  }
  // Only reset street bets when the street actually changed forward (1..4).
  if (
    advanced.phase === snapshot.phase
    || street.bettingPhase < 1
    || street.bettingPhase > 4
  ) {
    return advanced;
  }
  return {
    ...advanced,
    currentBet: '0',
    seats: advanced.seats.map((seat) => ({ ...seat, bet: '0' })),
  };
}

export type BetAction = 'fold' | 'check' | 'call' | 'raise';

export type BettingPhase =
  | 'lobby'
  | 'Register'
  | 'Shuffle'
  | 'Share'
  | 'PreFlop'
  | 'Flop'
  | 'Turn'
  | 'River'
  | 'Showdown'
  | 'Complete';

export interface ZkHandSnapshot {
  phase: 'Register' | 'Shuffle' | 'Share' | null;
  shuffleOrder: number[];
  shuffleStep: number;
  currentShufflerIndex: number | null;
  currentShufflerSeat: number | null;
  registeredCount: number;
  shuffledCount: number;
  sharedCount: number;
  requiredShares?: number;
  hasSharedPartial?: boolean[];
  registerRequested?: boolean;
  shuffleRequested?: boolean;
  shareRequested?: boolean;
  shareComplete?: boolean;
  dealCardCount?: number;
  elGamalPublicKeys: Array<[string, string] | null>;
  cardsDealtFaceDown: boolean;
  currentDeck: string[][] | null;
  shareDeck?: string[][] | null;
}

export interface ZkRevealedPartialEntry {
  cardIndex: number;
  fromPlayerIndex: number;
  toPlayerIndex: number;
  ciphertext: string[];
}

export interface ZkRevealSnapshot {
  revealedCardIndices: number[];
  newlyRevealed: number[];
  allPartialsPublic: boolean;
  shareComplete: boolean;
  holePartialsUnlocked?: boolean;
  entries: ZkRevealedPartialEntry[];
}

export interface ZkCryptoSnapshot {
  handNumPlayers: number;
  elGamalPublicKeys: Array<[string, string]>;
  finalDeck: string[][];
  dealCardCount?: number;
}

export interface ZkShowdownSnapshot {
  requested: boolean;
  requiredCount: number;
  eligibleSeats: number[];
  submitterSeat: number | null;
  submittedCount: number;
  submittedSeats: number[];
  outputHash: string | null;
  /** Poker `showdown_finalized` — proof accepted; settle/Complete may still be pending. */
  finalizedOnChain?: boolean;
}

export interface ZkShowdownMaterials {
  playerIndex: number;
  potMasks: string[];
  finalDeck: string[][];
  ciphertextPartials: string[][][];
  elGamalPublicKeys: Array<[string, string]>;
  sealedCoefficients?: string[];
  /** True once `ShowdownMaterialCommitment.complete` is on-chain for this player. */
  materialComplete?: boolean;
}

export interface SeatSnapshot {
  seat: number;
  name: string;
  publicKey: string;
  playerIndex?: number;
  chips: string;
  personalEscrow?: string;
  seatEscrow?: string;
  seatLocked?: boolean;
  bet: string;
  folded: boolean;
  active: boolean;
}

export interface PotSnapshot {
  amount: string;
  lastBet: string;
}

export interface PotResultSnapshot {
  potIndex: number;
  amount: string;
  winnerSeats: number[];
}

export interface SeatHandSnapshot {
  seat: number;
  playerIndex: number;
  name: string;
  folded: boolean;
  holeCards: [number, number];
  handDescription?: string;
}

export interface HandResultSnapshot {
  handNumber: number;
  reason: 'fold' | 'showdown';
  potResults: PotResultSnapshot[];
  boardCards: number[];
  seatHands: SeatHandSnapshot[];
  actionOrder: number[];
  zkFinalDeck?: string[][];
  handNumPlayers?: number;
}

export interface GameSnapshot {
  gameId: string;
  backend: BackendKind;
  phase: BettingPhase;
  dealerSeat: number;
  /** Extra dealer buttons (War / Baccarat / Roulette / multi-dealer BJ). */
  dealerSeats?: number[];
  /** Optional UI game kind when the table is not Hold'em. */
  gameKind?: 'poker' | 'blackjack' | 'war' | 'baccarat' | 'roulette';
  /** Visible roulette chips: type/modifier match `src/roulette.ts` PackBet. */
  rouletteBets?: Array<{ type: number; modifier: number; seat: number; amount?: string }>;
  smallBlindSeat: number;
  bigBlindSeat: number;
  smallBlind: string;
  currentBet: string;
  currentPlayerSeat: number | null;
  currentPlayerIndex: number | null;
  bettingRoundOpen: boolean;
  actionOrder?: number[];
  playerIndexBySeat?: Record<number, number>;
  handNumber?: number;
  seats: SeatSnapshot[];
  pots: PotSnapshot[];
  holeCards?: Record<number, [number, number]>;
  boardCards?: number[];
  zk?: ZkHandSnapshot;
  zkCrypto?: ZkCryptoSnapshot;
  zkShowdown?: ZkShowdownSnapshot;
  zkReveal?: ZkRevealSnapshot;
  handResult?: HandResultSnapshot;
  /** Winner layout shown during Showdown before chips are paid out. */
  pendingHandResult?: HandResultSnapshot;
  /** E2E visual tests: deal index → shuffled card value (0–51). */
  e2eDealValues?: Record<number, number>;
  holesViewPending?: boolean;
  /** Solana: `arcium-mpc` (default) or `soft` when ALLOW_SOFT_BETTING=1. */
  bettingMode?: 'arcium-mpc' | 'soft';
  /** Solana: true once a bet went through Arcium validate_bet_v2 this hand. */
  mpcBettingUsed?: boolean;
  /** Minimum total bet to raise (current actor). */
  minRaiseTo?: string;
  /** Additional chips for minimum raise (current actor). */
  minRaiseAdd?: string;
}

export interface PokerClient {
  /** Solana: RPC (+ optional worker) health. */
  healthCheck?(): Promise<ChainWorkerHealth>;
  createGame(smallBlind?: string, options?: { gameKind?: string }): Promise<GameSnapshot>;
  getDefaultGame(): Promise<GameSnapshot>;
  subscribeGame(gameId: string, onSnapshot: (snapshot: GameSnapshot) => void): () => void;
  joinGame(gameId: string, seat: number, publicKey: string, chips?: string): Promise<GameSnapshot>;
  standUp(gameId: string, publicKey: string): Promise<GameSnapshot>;
  addChips(gameId: string, seat: number, amount: string): Promise<GameSnapshot>;
  /** Solana: faucet → personal escrow (localnet testing). */
  faucetCreditPersonal?(gameId: string, publicKey: string, amount: string): Promise<GameSnapshot>;
  /** Solana: personal → seat escrow. */
  transferPersonalToSeat?(gameId: string, publicKey: string, amount: string): Promise<GameSnapshot>;
  /** Solana: seat → personal (blocked mid-hand). */
  transferSeatToPersonal?(gameId: string, publicKey: string, amount: string): Promise<GameSnapshot>;
  startHand(gameId: string, options?: { gameKind?: string }): Promise<GameSnapshot>;
  registerHandKey(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
  ): Promise<GameSnapshot>;
  submitShuffle(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    shuffledDeck?: string[][],
  ): Promise<GameSnapshot>;
  submitShare(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    ciphertexts: string[][][],
  ): Promise<GameSnapshot>;
  getShowdownMaterials(gameId: string, seat: number): Promise<ZkShowdownMaterials>;
  fetchRevealedPartials(gameId: string, seat: number): Promise<ZkRevealSnapshot>;
  submitShowdown(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    winnerMasks?: Array<string | bigint>,
  ): Promise<GameSnapshot>;
  getGame(gameId: string): Promise<GameSnapshot>;
  acknowledgeHoleCards(gameId: string, seat: number): Promise<GameSnapshot>;
  placeBet(gameId: string, seat: number, action: BetAction, amount?: string): Promise<GameSnapshot>;
  advanceStreet(gameId: string, fromPhase?: BettingPhase): Promise<GameSnapshot>;
  /** Clears the local table (testing only — requires server admin reset). */
  resetTable?(): Promise<GameSnapshot>;
}

const DEFAULT_BASE = 'http://127.0.0.1:3847';

/** Matches `LOCAL_TABLE_GAME_ID` on the local server — one shared table per process. */
export const LOCAL_TABLE_GAME_ID = 'local-table';

function apiBase(baseUrl: string): string {
  return resolveApiBase(baseUrl);
}

export class HttpPokerClient implements PokerClient {
  constructor(
    private readonly backend: BackendKind,
    private readonly baseUrl = DEFAULT_BASE,
  ) {}

  private url(path: string): string {
    return `${apiBase(this.baseUrl)}${path}?backend=${this.backend}`;
  }

  async createGame(smallBlind?: string, options?: { gameKind?: string }): Promise<GameSnapshot> {
    const res = await fetch(this.url('/api/games'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(smallBlind ? { smallBlind } : {}),
        ...(options?.gameKind ? { gameKind: options.gameKind } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async getDefaultGame(): Promise<GameSnapshot> {
    const res = await fetch(this.url('/api/games/default'));
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  subscribeGame(gameId: string, onSnapshot: (snapshot: GameSnapshot) => void): () => void {
    let source: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) {
        return;
      }
      source = new EventSource(this.url(`/api/games/${encodeURIComponent(gameId)}/events`));
      source.onmessage = (event) => {
        onSnapshot(JSON.parse(event.data) as GameSnapshot);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!closed) {
          retry = setTimeout(connect, 1000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry !== null) {
        clearTimeout(retry);
      }
      source?.close();
    };
  }

  async joinGame(gameId: string, seat: number, publicKey: string, chips?: string): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/join`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat, publicKey, chips }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async standUp(gameId: string, publicKey: string): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/stand`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async addChips(gameId: string, seat: number, amount: string): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/add-chips`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat, amount }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async startHand(gameId: string, options?: { gameKind?: string }): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/start`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options?.gameKind ? { gameKind: options.gameKind } : {}),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async registerHandKey(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
  ): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/register`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat, proof, publicSignals }),
    });
    if (!res.ok) {
      const errText = await readApiError(res);
      throw new Error(errText);
    }
    return res.json();
  }

  async submitShuffle(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    shuffledDeck?: string[][],
  ): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/shuffle`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat, proof, publicSignals, shuffledDeck }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async submitShare(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    ciphertexts: string[][][],
  ): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/share`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat, proof, publicSignals, ciphertexts }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async getShowdownMaterials(gameId: string, seat: number): Promise<ZkShowdownMaterials> {
    const res = await fetch(this.url(`/api/games/${gameId}/showdown-materials/${seat}`));
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async fetchRevealedPartials(gameId: string, seat: number): Promise<ZkRevealSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/revealed-partials/${seat}`));
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async submitShowdown(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    winnerMasks?: Array<string | bigint>,
  ): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/showdown`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seat,
        proof,
        publicSignals,
        ...(winnerMasks
          ? { winnerMasks: winnerMasks.map((value) => value.toString()) }
          : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async getGame(gameId: string): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}`));
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async acknowledgeHoleCards(gameId: string, seat: number): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/ack-holes`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async placeBet(gameId: string, seat: number, action: BetAction, amount?: string): Promise<GameSnapshot> {
    const res = await fetch(this.url(`/api/games/${gameId}/action`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat, action, amount }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async advanceStreet(gameId: string, fromPhase?: BettingPhase): Promise<GameSnapshot> {
    void fromPhase;
    const res = await fetch(this.url(`/api/games/${gameId}/advance`), { method: 'POST' });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }

  async resetTable(): Promise<GameSnapshot> {
    const res = await fetch(this.url('/api/admin/reset'), { method: 'POST' });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return res.json();
  }
}

export type SolanaPokerClientOptions = {
  /** Solana JSON-RPC (default :8899). Primary path for events / health. */
  rpcUrl?: string;
  /**
   * Table mutation HTTP base (Vite preview same-origin, or optional :3850 worker).
   * When null, mutations throw; turn state still comes from RPC onLogs.
   */
  workerUrl?: string | null;
};

/**
 * Solana-mode client: turn state from on-chain `PlayerActionRequired` events
 * (RPC websocket / onLogs). Table mutations use native `solana.op` bridge
 * (Zig → player CLI → RPC). Optional HTTP (`?chainWorker=` / `?viteTableApi=1`)
 * remains for tooling only.
 */
export class SolanaPokerClient implements PokerClient {
  readonly rpcUrl: string;
  /** Null when using native solana.op (default). Set only for explicit HTTP tooling. */
  readonly workerUrl: string | null;
  private connection: Connection | null = null;
  private lastSnapshot: GameSnapshot = emptySolanaSnapshot();
  private readonly chainEventListeners = new Set<(message: string, signature: string) => void>();

  constructor(opts?: string | SolanaPokerClientOptions) {
    if (typeof opts === 'string') {
      // Legacy: string arg was worker URL (tests / E2E). Keep RPC default.
      this.workerUrl = opts.replace(/\/$/, '');
      this.rpcUrl = resolveSolanaRpcUrl();
    } else {
      this.rpcUrl = (opts?.rpcUrl ?? resolveSolanaRpcUrl()).replace(/\/$/, '');
      if (opts && 'workerUrl' in opts) {
        this.workerUrl = opts.workerUrl?.replace(/\/$/, '') ?? null;
      } else {
        this.workerUrl = resolveSolanaTableApiBase();
      }
    }
  }

  /**
   * Subscribe to decoded on-chain poker program events (PlayerActionRequired,
   * HandStartedEvent, PhaseAdvancedEvent, EscrowFundedEvent) as log lines.
   */
  onChainEvent(listener: (message: string, signature: string) => void): () => void {
    this.chainEventListeners.add(listener);
    return () => {
      this.chainEventListeners.delete(listener);
    };
  }

  private emitChainEvent(message: string, signature: string): void {
    console.log(`[solana-event] ${message}`);
    for (const listener of this.chainEventListeners) {
      try {
        listener(message, signature);
      } catch {
        // UI listeners must not break the RPC subscription.
      }
    }
  }

  get hasOptionalWorker(): boolean {
    return this.workerUrl !== null;
  }

  /**
   * In-process WebView/browser Solana ops (executePerSeatOp → RPC).
   * Fall back to explicit HTTP table API when workerUrl is set.
   */
  private get useBridge(): boolean {
    return this.workerUrl === null;
  }

  private workerPath(path: string): string {
    if (!this.workerUrl) {
      throw new Error(
        'Solana table HTTP is not configured. '
        + 'Native apps run per-seat ops in WebView JS → RPC (no HTTP). '
        + 'For tooling only: ?chainWorker=… or ?viteTableApi=1.',
      );
    }
    return `${this.workerUrl}${path}`;
  }

  private async tableOp<T extends GameSnapshot | object>(
    op: string,
    body: Record<string, unknown> = {},
    http?: { method?: string; path: string; jsonBody?: unknown },
  ): Promise<T> {
    if (this.useBridge) {
      const withKey = SEATING_OPS.has(op)
        ? { ...body, secretKey: getLocalSecretKeyBytes() }
        : body;
      const { invokeSolanaOp } = await import('./solana-bridge');
      const result = await invokeSolanaOp<T>({ op, ...withKey });
      if (result && typeof result === 'object' && 'gameId' in result) {
        return this.adoptWorkerSnapshot(result as GameSnapshot) as T;
      }
      return result;
    }
    if (!http) {
      throw new Error(`Solana op "${op}" requires native solana.op bridge or ?chainWorker=`);
    }
    const res = await fetch(this.workerPath(http.path), {
      method: http.method ?? 'POST',
      headers: http.jsonBody !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: http.jsonBody !== undefined ? JSON.stringify(http.jsonBody) : undefined,
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    const json = (await res.json()) as T;
    if (json && typeof json === 'object' && 'gameId' in json) {
      return this.adoptWorkerSnapshot(json as GameSnapshot) as T;
    }
    return json;
  }

  private getConnection(): Connection {
    if (!this.connection) {
      this.connection = new Connection(this.rpcUrl, 'confirmed');
    }
    return this.connection;
  }

  /**
   * Adopt a worker HTTP snapshot without regressing the chain-driven phase/turn
   * cursor already applied from onLogs / PhaseAdvanced.
   */
  private adoptWorkerSnapshot(worker: GameSnapshot): GameSnapshot {
    const merged = mergeWorkerIntoChainSnapshot(this.lastSnapshot, worker);
    // Re-fold against the latest cursor: onLogs may advance lastSnapshot while
    // a worker fetch was in flight; never publish a stale merge over chain.
    const final = mergeWorkerIntoChainSnapshot(this.lastSnapshot, merged);
    this.lastSnapshot = final;
    return final;
  }

  /** Primary: Solana RPC. Bridge/HTTP health is optional enrichment. */
  async healthCheck(): Promise<ChainWorkerHealth> {
    let rpcReady = false;
    try {
      await this.getConnection().getVersion();
      rpcReady = true;
    } catch {
      rpcReady = false;
    }

    if (this.useBridge) {
      try {
        const { invokeSolanaOp } = await import('./solana-bridge');
        const body = await invokeSolanaOp<ChainWorkerHealth>({ op: 'health' });
        return {
          ...body,
          ok: Boolean(body.ok) || rpcReady,
          rpcReady,
          rpcUrl: body.rpcUrl ?? this.rpcUrl,
          worker: false,
          workerOptional: true,
          hint: rpcReady
            ? 'Connected to Solana RPC (in-WebView per-seat ops)'
            : `Solana RPC not reachable (${chainRpcLabel(this.rpcUrl)})`,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn('[SolanaPokerClient] health via executePerSeatOp failed:', detail);
        return {
          ok: rpcReady,
          rpcReady,
          rpcUrl: this.rpcUrl,
          localnetReady: rpcReady,
          worker: false,
          workerOptional: true,
          hint: rpcReady
            ? `Solana RPC ready; in-WebView ops not ready yet (${detail})`
            : `Solana RPC not reachable (${chainRpcLabel(this.rpcUrl)})`,
        };
      }
    }

    if (!this.workerUrl) {
      return {
        ok: rpcReady,
        rpcReady,
        rpcUrl: this.rpcUrl,
        localnetReady: rpcReady,
        worker: false,
        workerOptional: true,
        hint: rpcReady
          ? (hasSolanaOpBridge()
            ? 'Connected to Solana RPC (native solana.op)'
            : 'Connected to Solana RPC — native solana.op bridge required for mutations')
          : `Solana RPC not reachable (${chainRpcLabel(this.rpcUrl)})`,
      };
    }

    try {
      const res = await fetch(this.workerPath('/api/health'));
      if (res.ok) {
        const body = (await res.json()) as ChainWorkerHealth;
        return {
          ...body,
          ok: Boolean(body.ok) || rpcReady,
          rpcReady,
          rpcUrl: body.rpcUrl ?? this.rpcUrl,
          workerOptional: true,
        };
      }
    } catch {
      // Worker down is fine when RPC is up.
    }

    return {
      ok: rpcReady,
      rpcReady,
      rpcUrl: this.rpcUrl,
      localnetReady: rpcReady,
      worker: false,
      workerOptional: true,
      hint: rpcReady
        ? 'Solana RPC ready; optional HTTP table API unreachable'
        : `Solana RPC not reachable (${chainRpcLabel(this.rpcUrl)})`,
    };
  }

  async createGame(smallBlind?: string, options?: { gameKind?: string }): Promise<GameSnapshot> {
    return this.tableOp('createGame', { smallBlind, gameKind: options?.gameKind }, {
      method: 'POST',
      path: '/api/games',
      jsonBody: {
        ...(smallBlind ? { smallBlind } : {}),
        ...(options?.gameKind ? { gameKind: options.gameKind } : {}),
      },
    });
  }

  async getDefaultGame(): Promise<GameSnapshot> {
    if (this.useBridge) {
      return this.tableOp('getDefaultGame', {}, { method: 'GET', path: '/api/games/default' });
    }
    if (!this.workerUrl) {
      return this.lastSnapshot.gameId
        ? this.lastSnapshot
        : emptySolanaSnapshot();
    }
    const res = await fetch(this.workerPath('/api/games/default'));
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return this.adoptWorkerSnapshot(await res.json());
  }

  /**
   * Drive UI from on-chain PlayerActionRequired / PhaseAdvanced logs.
   * Bridge/HTTP poll may enrich seats/zk materials but cannot regress chain phase.
   */
  subscribeGame(gameId: string, onSnapshot: (snapshot: GameSnapshot) => void): () => void {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubLogs: (() => void) | null = null;
    const pollMaterials = this.useBridge || this.workerUrl !== null;

    const publish = (snapshot: GameSnapshot) => {
      this.lastSnapshot = snapshot;
      if (!cancelled) {
        onSnapshot(snapshot);
      }
    };

    const applyChainEvents = (events: Array<{
      playerAction?: PlayerActionRequired;
      phaseAdvanced?: PhaseAdvancedEvent;
      streetAdvanced?: StreetAdvancedEvent;
      bet?: BetEvent;
    }>) => {
      let snap = this.lastSnapshot;
      for (const ev of events) {
        if (ev.bet) {
          snap = applyBetEventToSnapshot(snap, ev.bet);
        }
      }
      for (const ev of events) {
        // StreetAdvanced carries a bundled phaseAdvanced; apply the street variant
        // (resets per-seat bets) instead of the raw phaseAdvanced to avoid double apply.
        if (ev.streetAdvanced) {
          snap = applyStreetAdvancedToSnapshot(snap, ev.streetAdvanced);
        } else if (ev.phaseAdvanced) {
          snap = applyPhaseAdvancedToSnapshot(snap, ev.phaseAdvanced);
        }
        if (ev.playerAction) {
          snap = applyPlayerActionToSnapshot(snap, ev.playerAction);
        }
      }
      publish(snap);
    };

    let refreshInFlight = false;
    // Kick an immediate materials refresh after a chain event so the next player
    // sees fresh chips/pot/materials without waiting for the 1500ms poll tick.
    const refreshNow = async () => {
      if (cancelled || !pollMaterials || refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      try {
        await this.getGame(gameId);
        if (!cancelled) {
          onSnapshot(this.lastSnapshot);
        }
      } catch {
        // Event already advanced the cursor; poll will retry materials.
      } finally {
        refreshInFlight = false;
      }
    };

    try {
      unsubLogs = subscribePokerProgramEvents(
        this.getConnection(),
        (ev, signature) => {
          const message = formatSolanaChainEvent(ev, signature);
          this.emitChainEvent(message, signature);
          if (ev.playerAction || ev.phaseAdvanced || ev.streetAdvanced || ev.bet) {
            applyChainEvents([ev]);
            void refreshNow();
          }
        },
        {
          programId: CASINO_PROGRAM_ID,
          onBatch: (events, signature) => {
            let actionable = false;
            for (const ev of events) {
              const message = formatSolanaChainEvent(ev, signature);
              this.emitChainEvent(message, signature);
              actionable ||= Boolean(ev.playerAction || ev.phaseAdvanced || ev.streetAdvanced || ev.bet);
            }
            if (actionable) {
              applyChainEvents(events);
              void refreshNow();
            }
          },
        },
      );
    } catch {
      // Websocket may fail in some test environments.
    }

    const poll = async () => {
      if (cancelled || !pollMaterials) {
        return;
      }
      try {
        await this.getGame(gameId);
        if (!cancelled) {
          onSnapshot(this.lastSnapshot);
        }
      } catch {
        // Keep listening — daemon may be mid-attach.
      }
      if (!cancelled && pollMaterials) {
        timer = setTimeout(poll, 1500);
      }
    };

    if (pollMaterials) {
      void poll();
    } else {
      publish(this.lastSnapshot.gameId === gameId ? this.lastSnapshot : emptySolanaSnapshot(gameId));
    }

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      unsubLogs?.();
    };
  }

  /** Latest action from a raw log list (tests / tooling). */
  applyLogsToSnapshot(logs: readonly string[]): GameSnapshot {
    const events = parseEventsFromLogs(logs);
    let snap = this.lastSnapshot;
    for (const ev of events) {
      this.emitChainEvent(formatSolanaChainEvent(ev), '');
    }
    for (const ev of events) {
      if (ev.bet) {
        snap = applyBetEventToSnapshot(snap, ev.bet);
      }
    }
    for (const ev of events) {
      if (ev.streetAdvanced) {
        snap = applyStreetAdvancedToSnapshot(snap, ev.streetAdvanced);
      } else if (ev.phaseAdvanced) {
        snap = applyPhaseAdvancedToSnapshot(snap, ev.phaseAdvanced);
      }
      if (ev.playerAction) {
        snap = applyPlayerActionToSnapshot(snap, ev.playerAction);
      }
    }
    this.lastSnapshot = snap;
    return snap;
  }

  async joinGame(gameId: string, seat: number, publicKey: string, chips?: string): Promise<GameSnapshot> {
    void gameId;
    return this.tableOp('joinGame', { seat, publicKey, chips }, {
      path: '/api/game/join',
      jsonBody: { seat, publicKey, chips },
    });
  }

  async standUp(gameId: string, publicKey: string): Promise<GameSnapshot> {
    void gameId;
    return this.tableOp('standUp', { publicKey }, {
      path: '/api/game/stand',
      jsonBody: { publicKey },
    });
  }

  async addChips(gameId: string, seat: number, amount: string): Promise<GameSnapshot> {
    void gameId;
    // Soft addChips only exists on HTTP worker path; Solana escrow uses faucet+transfer.
    if (this.useBridge) {
      throw new Error(
        'addChips is disabled in Solana escrow mode — use faucetCreditPersonal then transferPersonalToSeat',
      );
    }
    return this.tableOp('addChips', { seat, amount }, {
      path: '/api/game/add-chips',
      jsonBody: { seat, amount },
    });
  }

  async faucetCreditPersonal(
    gameId: string,
    publicKey: string,
    amount: string,
  ): Promise<GameSnapshot> {
    void gameId;
    return this.tableOp('faucetCreditPersonal', { publicKey, amount }, {
      path: '/api/game/faucet',
      jsonBody: { publicKey, amount },
    });
  }

  async transferPersonalToSeat(
    gameId: string,
    publicKey: string,
    amount: string,
  ): Promise<GameSnapshot> {
    void gameId;
    return this.tableOp('transferPersonalToSeat', { publicKey, amount }, {
      path: '/api/game/transfer-to-seat',
      jsonBody: { publicKey, amount },
    });
  }

  async transferSeatToPersonal(
    gameId: string,
    publicKey: string,
    amount: string,
  ): Promise<GameSnapshot> {
    void gameId;
    return this.tableOp('transferSeatToPersonal', { publicKey, amount }, {
      path: '/api/game/transfer-to-personal',
      jsonBody: { publicKey, amount },
    });
  }

  async startHand(gameId: string, options?: { gameKind?: string }): Promise<GameSnapshot> {
    void gameId;
    await this.tableOp('startHand', { gameKind: options?.gameKind }, {
      path: '/api/game/start',
      jsonBody: options?.gameKind ? { gameKind: options.gameKind } : {},
    });
    return this.getDefaultGame();
  }

  async registerHandKey(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
  ): Promise<GameSnapshot> {
    void gameId;
    await this.tableOp('registerHandKey', { seat, proof, publicSignals }, {
      path: '/api/game/register',
      jsonBody: { seat, proof, publicSignals },
    });
    // Register tx already landed — do not fail the whole submit if the follow-up
    // snapshot hangs (dual-mac RPC load). Retry getGame once, then lastSnapshot.
    try {
      return await this.getDefaultGame();
    } catch {
      try {
        return await this.getGame(gameId);
      } catch {
        return this.lastSnapshot;
      }
    }
  }

  async submitShuffle(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    shuffledDeck?: string[][],
  ): Promise<GameSnapshot> {
    void gameId;
    await this.tableOp('submitShuffle', { seat, proof, publicSignals, shuffledDeck }, {
      path: '/api/game/shuffle',
      jsonBody: { seat, proof, publicSignals, shuffledDeck },
    });
    return this.getDefaultGame();
  }

  async submitShare(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    ciphertexts: string[][][],
  ): Promise<GameSnapshot> {
    void gameId;
    await this.tableOp('submitShare', { seat, proof, publicSignals, ciphertexts }, {
      path: '/api/game/share',
      jsonBody: { seat, proof, publicSignals, ciphertexts },
    });
    return this.getDefaultGame();
  }

  async getShowdownMaterials(gameId: string, seat: number): Promise<ZkShowdownMaterials> {
    void gameId;
    return this.tableOp('getShowdownMaterials', { seat }, {
      method: 'GET',
      path: `/api/game/showdown-materials/${seat}`,
    });
  }

  async fetchRevealedPartials(gameId: string, seat: number): Promise<ZkRevealSnapshot> {
    void gameId;
    return this.tableOp('fetchRevealedPartials', { seat }, {
      method: 'GET',
      path: `/api/game/revealed-partials/${seat}`,
    });
  }

  async submitShowdown(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    winnerMasks?: Array<string | bigint>,
  ): Promise<GameSnapshot> {
    void gameId;
    const masks = winnerMasks?.map((value) => value.toString());
    await this.tableOp(
      'submitShowdown',
      { seat, proof, publicSignals, ...(masks ? { winnerMasks: masks } : {}) },
      {
        path: '/api/game/showdown',
        jsonBody: {
          seat,
          proof,
          publicSignals,
          ...(masks ? { winnerMasks: masks } : {}),
        },
      },
    );
    return this.getDefaultGame();
  }

  async getGame(gameId: string): Promise<GameSnapshot> {
    void gameId;
    if (this.useBridge) {
      try {
        return await this.tableOp('getGame', {}, { method: 'GET', path: '/api/game' });
      } catch {
        // Event-driven play can continue on lastSnapshot when meta/admin/RPC
        // snapshot is unavailable (unit tests, cold start before ensure-room).
        return this.lastSnapshot;
      }
    }
    if (!this.workerUrl) {
      return this.lastSnapshot;
    }
    const res = await fetch(this.workerPath('/api/game'));
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    return this.adoptWorkerSnapshot(await res.json());
  }

  async acknowledgeHoleCards(gameId: string, seat: number): Promise<GameSnapshot> {
    void gameId;
    void seat;
    await this.tableOp('acknowledgeHoleCards', { seat }, {
      path: '/api/game/ack-holes',
      jsonBody: { seat },
    });
    return this.getDefaultGame();
  }

  async placeBet(gameId: string, seat: number, action: BetAction, amount?: string): Promise<GameSnapshot> {
    void gameId;
    await this.tableOp('placeBet', { seat, action, amount }, {
      path: '/api/game/action',
      jsonBody: { seat, action, amount },
    });
    return this.getDefaultGame();
  }

  async advanceStreet(gameId: string, fromPhase?: BettingPhase): Promise<GameSnapshot> {
    void gameId;
    await this.tableOp('advanceStreet', {
      action: fromPhase && ['PreFlop', 'Flop', 'Turn', 'River'].includes(fromPhase)
        ? fromPhase
        : undefined,
    }, { path: '/api/game/advance' });
    return this.getDefaultGame();
  }

  async resetTable(): Promise<GameSnapshot> {
    return this.tableOp('resetTable', {}, { path: '/api/admin/reset' });
  }
}

export function createPokerClient(backend: BackendKind, baseUrl?: string): PokerClient {
  if (backend === 'local') {
    return new HttpPokerClient(backend, baseUrl ?? resolveApiBase());
  }
  if (backend === 'devnet' || backend === 'solana') {
    try {
      localStorage.setItem(BACKEND_STORAGE_KEY, backend);
    } catch {
      // private mode
    }
  }
  // Explicit baseUrl → optional HTTP table API; else native solana.op (workerUrl null).
  if (baseUrl !== undefined) {
    return new SolanaPokerClient({
      rpcUrl: resolveSolanaRpcUrl(),
      workerUrl: baseUrl,
    });
  }
  return new SolanaPokerClient({
    rpcUrl: resolveSolanaRpcUrl(),
    workerUrl: resolveSolanaTableApiBase(),
  });
}
