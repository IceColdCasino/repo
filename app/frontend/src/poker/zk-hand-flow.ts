/**
 * Manual ZK hand flow: register → shuffle → share → streets → showdown.
 * No E2E autoplay, host-shared keys, dummy proofs, or dual-mac stagger.
 * Automation lives in `./zk-hand-flow-auto`.
 */
import { preferredShowdownSubmitterSeat, type HandResultSnapshot } from '@poker-src/backend/hand-result';
import type { GameSnapshot, ZkShowdownMaterials } from '../backend/client';
import { createZkFlow } from './zk-flow';
import { Player } from '@poker-src/poker-player';
import { preloadCircuits } from './browser-circuits';
import { Game } from '@poker-src/poker-game';
import type { Ciphertext, PublicKey } from '@poker-src/zk-casino';
import {
  ciphertextFromJson,
  ciphertextMatrixFromJson,
} from '@poker-src/backend/zk-serialize';
import { hasPlayerBridge, pingPlayerBridge } from './player-bridge';
import { logTiming, timeAsync } from '@poker-src/timing-log';
import { withProveSeat } from './prove-event-log';
import { logHandProgress } from '@poker-src/hand-progress';
import { warmShowdownZkeyPages } from '../zk/runtime';
import { agentDebugLog } from '../debug-agent-log';
import {
  padPublicKeysForShare,
  shareOthersForPlayer,
} from '@poker-src/share-common';
import { TOTAL_CARDS } from '@poker-src/poker-game';
import {
  clearZkHandKey,
  findZkHandKeyForPublicKey,
  loadZkHandKey,
  persistZkHandKey,
} from './zk-hand-key-store';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from '@poker-src/chain/shared-meta-store';
import { handPlayerCount, NEXT_HAND_DECK_KEY, type StagedDeckRecord } from './next-hand';
import {
  currentStageFlight,
  hasStagedShare,
  hasStagedShuffle,
  mixKeys,
  mixLimbs,
  noteStageFlight,
  rememberRegisterProof,
  rememberStagedShare,
  rememberStagedShuffle,
  reusableRegisterProof,
  stagedShuffleDeck,
  takeStagedShare,
  takeStagedShuffle,
} from './next-hand-stage';

export interface ZkHandClient {
  getGame(gameId: string): Promise<GameSnapshot>;
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
  submitShowdown(
    gameId: string,
    seat: number,
    proof: object,
    publicSignals: string[],
    winnerMasks?: Array<string | bigint>,
  ): Promise<GameSnapshot>;
}

export interface ZkHandFlowState {
  flow: Awaited<ReturnType<typeof createZkFlow>> | { game: Game | null; player: Player };
  player: Player;
  /** Null in browser/native-bridge flows that use server snapshot for deck/keys. */
  game: Game | null;
  handNumber: number;
  registeredPublicKey: PublicKey | null;
  currentDeck: Ciphertext[] | null;
  /**
   * Deal this seat just wrote into deck_state by the shuffle that opened Share.
   * A Share snapshot fetched in that same moment can still show the shoe this
   * seat shuffled. Proving that older shoe is what the verifier rejects.
   * Cleared on the next shuffle and whenever the account shoe has moved on.
   */
  finalShuffleDeck?: Ciphertext[] | null;
  /** First 25 cards of the shoe this seat shuffled. Identifies a stale snapshot. */
  preShareDeck?: Ciphertext[] | null;
  /**
   * Shoe this seat published while Shuffle was still open. A Share read in the
   * same moment can still be that shoe, before the last shuffle lands.
   */
  publishedShuffleDeck?: Ciphertext[] | null;
  shareSubmitted: boolean;
  showdownSubmitted: boolean;
  inFlight: boolean;
  /** Monotonic ms — delay next share attempt after bridge/prove failure. */
  shareRetryAfter?: number;
  /** Monotonic ms — non-preferred players may submit after this instant. */
  showdownPreferenceUntil?: number;
  /** One share proof for this statement. Retries resubmit it and do not prove again. */
  shareProof?: CachedShareProof;
  /** Statement whose share proof was already rebuilt after a verifier rejection. */
  shareProofRejectedKey?: string;
  /** One showdown proof for this statement. Retries resubmit it and do not prove again. */
  showdownProof?: CachedShowdownProof;
}

interface CachedShareProof {
  key: string;
  proof: object;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}

interface CachedShowdownProof {
  key: string;
  proof: object;
  publicSignals: string[];
  winnerMasks: bigint[];
}

/** How long non-winners wait before submitting showdown as fallback. */
export const SHOWDOWN_WINNER_PREFERENCE_MS =
  (typeof globalThis !== 'undefined'
    && (globalThis as { __SHOWDOWN_WINNER_PREFERENCE_MS?: number }).__SHOWDOWN_WINNER_PREFERENCE_MS)
  || 15_000;

function showdownPreferenceMs(_snapshot: GameSnapshot): number {
  return SHOWDOWN_WINNER_PREFERENCE_MS;
}

const ZK_PHASES = new Set(['Register', 'Shuffle', 'Share']);
const BETTING_STREET_PHASES = new Set(['PreFlop', 'Flop', 'Turn', 'River']);
// Only River — PreFlop warm after share freezes WKWebView (UI stuck, server continues).
const SHOWDOWN_ZKEY_WARM_PHASES = new Set(['River']);

let showdownZkeyWarmHand: number | null = null;

export function shouldWarmShowdownZkey(phase: GameSnapshot['phase']): boolean {
  return SHOWDOWN_ZKEY_WARM_PHASES.has(phase);
}

/** Start background zkey page-cache warm once per hand during River only. */
export function maybeWarmShowdownZkey(snapshot: GameSnapshot): void {
  if (!shouldWarmShowdownZkey(snapshot.phase)) {
    return;
  }
  if (!snapshot.handNumber || (!snapshot.zkCrypto && !snapshot.zk)) {
    return;
  }
  if (showdownZkeyWarmHand === snapshot.handNumber) {
    return;
  }
  showdownZkeyWarmHand = snapshot.handNumber;
  void warmShowdownZkeyPages();
}

function syntheticRegisterSignals(key: [string, string]): string[] {
  return [key[0], key[1], '0', '1', '0', '1'];
}

function deckFromSnapshot(snapshot: GameSnapshot): Ciphertext[] | null {
  const deck = snapshot.zk?.currentDeck;
  if (!deck) {
    return null;
  }
  return deck.map((card) => ciphertextFromJson(card));
}

export type EnsurePlayerKeyOptions = {
  /** Isolate sessionStorage per seat so two windows cannot clobber each other. */
  seat?: number | null;
};

/**
 * Load or mint the hand ElGamal key onto `player`.
 * - If `expectedPublicKey` is set: restore only — never mint (minting would desync).
 * - If unset (pre-register): mint once and persist immediately so concurrent
 *   `createFreshZkHandFlow` calls reuse the same key from sessionStorage.
 */
export async function ensurePlayerKeyForHand(
  player: Player,
  handNumber: number,
  expectedPublicKey?: PublicKey | null,
  options?: EnsurePlayerKeyOptions,
): Promise<PublicKey | null> {
  const seat = options?.seat ?? null;
  let stored = loadZkHandKey(handNumber, seat);
  if (stored && expectedPublicKey && !publicKeysEqual(stored.publicKey, expectedPublicKey)) {
    stored = null;
  }
  if (!stored && expectedPublicKey) {
    stored = findZkHandKeyForPublicKey(handNumber, expectedPublicKey);
  }
  if (!stored && seat !== null) {
    const { loadSeatElgamalKey } = await import('./seat-elgamal-key');
    stored = await loadSeatElgamalKey(seat, expectedPublicKey ?? null);
  }
  if (stored && expectedPublicKey && !publicKeysEqual(stored.publicKey, expectedPublicKey)) {
    stored = null;
  }
  if (stored) {
    player.loadPlayerKey(stored);
    await player.ensureKey();
    persistZkHandKey(handNumber, stored, seat);
    return stored.publicKey;
  }
  if (expectedPublicKey) {
    return null;
  }
  await player.ensureKey();
  const minted = {
    privateKey: player.elGamalPrivateKey,
    publicKey: player.publicKey,
  };
  persistZkHandKey(handNumber, minted, seat);
  return minted.publicKey;
}

function hasNativeZkBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.zero?.invoke === 'function';
}

export async function createFreshZkHandFlow(
  handNumber: number,
  expectedPublicKey?: PublicKey | null,
  options?: EnsurePlayerKeyOptions,
): Promise<ZkHandFlowState> {
  if (hasNativeZkBridge()) {
    return timeAsync(`native zk-hand-flow init hand=${handNumber}`, async () => {
      if (!hasPlayerBridge()) {
        throw new Error('native player bridge is required');
      }
      const ping = await pingPlayerBridge();
      if (!ping.ok) {
        throw new Error('native player bridge is not ready');
      }
      return createNativeHandFlow(handNumber, expectedPublicKey, options);
    });
  }
  return timeAsync(`zk-hand-flow init hand=${handNumber}`, async () => {
    const flow = await createZkFlow();
    const key = await ensurePlayerKeyForHand(
      flow.player,
      handNumber,
      expectedPublicKey,
      options,
    );
    if (!key) {
      throw new Error(
        'ElGamal key desync: cannot restore registered key for this hand '
        + '(sessionStorage missing after reload, or seat loaded the wrong key)',
      );
    }
    return {
      flow,
      player: flow.player,
      game: flow.game,
      handNumber,
      registeredPublicKey: key,
      currentDeck: null,
      finalShuffleDeck: null,
      preShareDeck: null,
      publishedShuffleDeck: null,
      shareSubmitted: false,
      showdownSubmitted: false,
      inFlight: false,
    };
  });
}

/** Native shell: one Player + bridge circuits — skip Game/circomlibjs double-init. */
export async function createNativeHandFlow(
  handNumber: number,
  expectedPublicKey?: PublicKey | null,
  options?: EnsurePlayerKeyOptions,
): Promise<ZkHandFlowState> {
  return timeAsync(`native zk-hand-flow init hand=${handNumber}`, async () => {
    const circuits = await preloadCircuits();
    const player = new Player(circuits);
    await player.initForNativeBridge();
    const key = await ensurePlayerKeyForHand(
      player,
      handNumber,
      expectedPublicKey,
      options,
    );
    if (!key) {
      throw new Error(
        'ElGamal key desync: cannot restore registered key for this hand',
      );
    }
    return {
      flow: { game: null, player },
      player,
      game: null,
      handNumber,
      registeredPublicKey: key,
      currentDeck: null,
      finalShuffleDeck: null,
      preShareDeck: null,
      publishedShuffleDeck: null,
      shareSubmitted: false,
      showdownSubmitted: false,
      inFlight: false,
    };
  });
}

export function syncShareSubmittedFromSnapshot(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): void {
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  if (playerIndex === undefined) {
    return;
  }
  if (snapshot.phase !== 'Share') {
    state.shareSubmitted = false;
    return;
  }
  if (snapshot.zk?.hasSharedPartial?.[playerIndex] === true) {
    state.shareSubmitted = true;
  } else {
    state.shareSubmitted = false;
  }
}

export async function syncRegisteredKeyFromSnapshot(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): Promise<boolean> {
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  if (playerIndex === undefined || !snapshot.zk) {
    return false;
  }
  const expectedRaw = snapshot.zk.elGamalPublicKeys[playerIndex];
  if (!expectedRaw) {
    return false;
  }
  const expected = [BigInt(expectedRaw[0]), BigInt(expectedRaw[1])] as PublicKey;
  if (publicKeysEqual(state.player.publicKey, expected)) {
    state.registeredPublicKey = expected;
    return true;
  }
  let restored = findZkHandKeyForPublicKey(state.handNumber, expected);
  if (!restored) {
    const { loadSeatElgamalKey } = await import('./seat-elgamal-key');
    restored = await loadSeatElgamalKey(localSeat, expected);
  }
  if (!restored) {
    return false;
  }
  state.player.loadPlayerKey(restored);
  await state.player.ensureKey();
  state.registeredPublicKey = expected;
  persistZkHandKey(state.handNumber, restored, localSeat);
  return true;
}

export function clearZkHandFlowState(handNumber: number): void {
  clearZkHandKey(handNumber);
  if (showdownZkeyWarmHand === handNumber) {
    showdownZkeyWarmHand = null;
  }
}

export function isHandFlowPhase(phase: GameSnapshot['phase']): boolean {
  return isZkHandPhase(phase)
    || BETTING_STREET_PHASES.has(phase)
    || phase === 'Showdown'
    || phase === 'Complete';
}

export function isZkHandPhase(phase: GameSnapshot['phase']): boolean {
  return ZK_PHASES.has(phase);
}

function keysComplete(keys: Array<[string, string] | null>): boolean {
  return keys.every((key) => key !== null);
}

function elGamalKeyFromSnapshot(snapshot: GameSnapshot, playerIndex: number): PublicKey | null {
  const key = snapshot.zk?.elGamalPublicKeys[playerIndex];
  if (!key) {
    return null;
  }
  return [BigInt(key[0]), BigInt(key[1])];
}

function gameKeysMatchSnapshot(game: Game, keys: Array<[string, string] | null>): boolean {
  if (game.nPlayers !== keys.length) {
    return false;
  }
  const publicKeys = game.publicKeys;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!key) {
      return false;
    }
    const expected = [BigInt(key[0]), BigInt(key[1])] as PublicKey;
    const actual = publicKeys[index];
    if (!actual || !actual.every((value, coord) => value === expected[coord])) {
      return false;
    }
  }
  return true;
}

function playerPublicKeyForHand(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): PublicKey {
  if (state.registeredPublicKey) {
    return state.registeredPublicKey;
  }
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  if (playerIndex !== undefined) {
    const fromSnapshot = elGamalKeyFromSnapshot(snapshot, playerIndex);
    if (fromSnapshot) {
      return fromSnapshot;
    }
  }
  return state.player.publicKey;
}

function registeredKeysFromSnapshot(snapshot: GameSnapshot): PublicKey[] {
  if (!snapshot.zk) {
    throw new Error('Missing ZK snapshot');
  }
  const count = snapshot.zk.registeredCount;
  return snapshot.zk.elGamalPublicKeys.slice(0, count).map((key, index) => {
    if (!key) {
      throw new Error(`Missing ElGamal key for player index ${index}`);
    }
    return [BigInt(key[0]), BigInt(key[1])] as PublicKey;
  });
}

function registeredKeysForShuffle(snapshot: GameSnapshot): PublicKey[] {
  return registeredKeysFromSnapshot(snapshot);
}

function shareOthersFromSnapshot(snapshot: GameSnapshot, playerIndex: number): PublicKey[] {
  return shareOthersForPlayer(registeredKeysFromSnapshot(snapshot), playerIndex);
}

async function rebuildGameFromKeys(
  state: ZkHandFlowState,
  keys: Array<[string, string] | null>,
): Promise<Game> {
  const game = new Game();
  await game.init();
  for (const key of keys) {
    if (!key) {
      throw new Error('Incomplete ElGamal key set');
    }
    game.addPlayer({} as never, syntheticRegisterSignals(key), { verified: true });
  }
  return game;
}

export async function syncGameFromSnapshot(state: ZkHandFlowState, snapshot: GameSnapshot): Promise<void> {
  const zk = snapshot.zk;
  if (!zk) {
    return;
  }

  const handPlayers = zk.elGamalPublicKeys.length;
  const keys = zk.elGamalPublicKeys.slice(0, handPlayers);
  const allRegistered = zk.registeredCount === handPlayers;

  if (allRegistered && keysComplete(keys)) {
    if (state.game) {
      const keysMismatch = !gameKeysMatchSnapshot(state.game, keys);
      if (state.game.nPlayers !== handPlayers || keysMismatch) {
        state.game = await rebuildGameFromKeys(state, keys);
      }
      if (
        state.game.phase === 'Registration'
        && (snapshot.phase === 'Register' || snapshot.phase === 'Shuffle' || snapshot.phase === 'Share')
      ) {
        state.game.start();
      }
    }
  }

  if (snapshot.phase !== 'Shuffle' && snapshot.phase !== 'Share') {
    state.finalShuffleDeck = null;
    state.preShareDeck = null;
    state.publishedShuffleDeck = null;
  }
  state.currentDeck = deckFromSnapshot(snapshot);
}

/** Prefer server pendingHandResult when populated; else client provisional result. */
export function resolveShowdownHandResult(
  snapshot: GameSnapshot,
  provisionalResult?: HandResultSnapshot | null,
): HandResultSnapshot | null {
  const pending = snapshot.pendingHandResult;
  if (pending?.potResults.length) {
    return pending;
  }
  if (provisionalResult?.potResults.length) {
    return provisionalResult;
  }
  return pending ?? provisionalResult ?? null;
}

/** Deterministic submitter from pot results; ignores server submitterSeat hint. */
export function resolveShowdownSubmitterSeat(
  snapshot: GameSnapshot,
  provisionalResult?: HandResultSnapshot | null,
): number | null {
  const sd = snapshot.zkShowdown;
  if (sd && sd.submittedCount >= sd.requiredCount) {
    return null;
  }
  const handResult = resolveShowdownHandResult(snapshot, provisionalResult);
  if (!handResult?.potResults.length) {
    return null;
  }
  return preferredShowdownSubmitterSeat(
    handResult.potResults,
    handResult.actionOrder,
    new Set(sd?.submittedSeats ?? []),
  );
}

export function showdownWinnerSeats(
  snapshot: GameSnapshot,
  provisionalResult?: HandResultSnapshot | null,
): Set<number> {
  const seats = new Set<number>();
  const handResult = resolveShowdownHandResult(snapshot, provisionalResult);
  if (handResult?.potResults.length) {
    for (const pot of handResult.potResults) {
      for (const seat of pot.winnerSeats) {
        seats.add(seat);
      }
    }
  }
  if (seats.size > 0) {
    return seats;
  }
  for (const seat of snapshot.zkShowdown?.eligibleSeats ?? []) {
    seats.add(seat);
  }
  return seats;
}

export function showdownSubmitterSeat(
  snapshot: GameSnapshot,
  provisionalResult?: HandResultSnapshot | null,
): number | null {
  return resolveShowdownSubmitterSeat(snapshot, provisionalResult);
}

export function syncShowdownSubmittedFromSnapshot(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): void {
  if (snapshot.phase !== 'Showdown') {
    state.showdownSubmitted = false;
    state.showdownPreferenceUntil = undefined;
    return;
  }
  ensureShowdownPreferenceDeadline(state, snapshot);
  const sd = snapshot.zkShowdown;
  if (!sd) {
    return;
  }
  if (sd.submittedCount >= sd.requiredCount || sd.submittedSeats.includes(localSeat)) {
    state.showdownSubmitted = true;
  }
}

function ensureShowdownPreferenceDeadline(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
): void {
  if (snapshot.phase !== 'Showdown') {
    state.showdownPreferenceUntil = undefined;
    return;
  }
  if (state.showdownPreferenceUntil === undefined) {
    state.showdownPreferenceUntil = Date.now() + showdownPreferenceMs(snapshot);
  }
}

function showdownPreferenceExpired(state?: ZkHandFlowState): boolean {
  return state?.showdownPreferenceUntil !== undefined && Date.now() >= state.showdownPreferenceUntil;
}

/** Seated players eligible to submit; server accepts any one valid proof. */
export function canAttemptShowdownSubmission(
  snapshot: GameSnapshot,
  localSeat: number | null,
  state?: ZkHandFlowState,
): boolean {
  if (localSeat === null || snapshot.phase !== 'Showdown') {
    return false;
  }
  const sd = snapshot.zkShowdown;
  if (sd && sd.requested === false) {
    return false;
  }
  const playerIndex = snapshot.seats.find((entry) => entry.seat === localSeat)?.playerIndex
    ?? snapshot.playerIndexBySeat?.[localSeat];
  if (playerIndex === undefined) {
    return false;
  }
  if (sd && (sd.submittedCount >= sd.requiredCount || sd.submittedSeats.includes(localSeat))) {
    return false;
  }
  if (state?.showdownSubmitted === true) {
    return false;
  }
  return true;
}

export function isMyShowdownTurn(
  snapshot: GameSnapshot,
  localSeat: number | null,
  state?: ZkHandFlowState,
  provisionalResult?: HandResultSnapshot | null,
): boolean {
  if (!canAttemptShowdownSubmission(snapshot, localSeat, state)) {
    return false;
  }
  if (state) {
    ensureShowdownPreferenceDeadline(state, snapshot);
  }
  const preferred = resolveShowdownSubmitterSeat(snapshot, provisionalResult);
  if (preferred === localSeat) {
    return true;
  }
  // A projected winner is known: only that seat submits. Non-winners must never
  // submit (even after the window) — the winner may still be proving on-device,
  // and a redundant submit fails on-chain (`showdown_hash` already set) and
  // spams the event log. Non-winners just show the soft result and wait.
  if (preferred !== null) {
    return false;
  }
  // Winner not ranked yet. Wait out the preference window so the winning seat
  // can start the proof first. After that, only the designated seat proves.
  if (!showdownPreferenceExpired(state)) {
    return false;
  }
  const designated = designatedShowdownSeat(snapshot);
  if (designated === localSeat) {
    return true;
  }
  if (designated !== null) {
    return false;
  }
  return true;
}

/** Seat that should Groth16-prove when pot winners are not yet known. */
export function designatedShowdownSeat(snapshot: GameSnapshot): number | null {
  const fromSnap = snapshot.zkShowdown?.submitterSeat;
  if (fromSnap !== null && fromSnap !== undefined) {
    return fromSnap;
  }
  if (snapshot.actionOrder && snapshot.actionOrder.length > 0) {
    return snapshot.actionOrder[0]!;
  }
  const seated = snapshot.seats.find((seat) => !seat.folded && seat.playerIndex !== undefined);
  return seated?.seat ?? null;
}

export function needsRegistration(snapshot: GameSnapshot, localSeat: number): boolean {
  if (snapshot.phase !== 'Register') {
    return false;
  }
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat]
    ?? snapshot.actionOrder?.indexOf(localSeat);
  // Materials lag (chain PhaseAdvanced without zk): still allow parallel register.
  // registerHandKeyPerSeat resolves playerIndex from on-chain hand_seat_order.
  if (playerIndex === undefined || playerIndex < 0) {
    return !snapshot.zk || snapshot.seats.some((s) => s.seat === localSeat);
  }
  if (!snapshot.zk) {
    return true;
  }
  // Parallel register: any seat that has not posted a key may prove + submit.
  return !snapshot.zk.elGamalPublicKeys[playerIndex];
}

/** Player index for this physical seat. Phase events often omit playerIndexBySeat. */
export function playerIndexForSeat(snapshot: GameSnapshot, localSeat: number): number | undefined {
  const mapped = snapshot.playerIndexBySeat?.[localSeat];
  if (mapped !== undefined) {
    return mapped;
  }
  const order = snapshot.actionOrder;
  if (order) {
    const idx = order.indexOf(localSeat);
    if (idx >= 0) {
      return idx;
    }
  }
  return undefined;
}

/**
 * Who shuffles next. Chain PhaseAdvanced sets currentPlayerIndex and leaves
 * zk.currentShufflerIndex null, which used to make both seats skip Shuffle.
 */
export function shuffleActorIndex(snapshot: GameSnapshot): number | null {
  const fromZk = snapshot.zk?.currentShufflerIndex;
  if (typeof fromZk === 'number') {
    return fromZk;
  }
  if (typeof snapshot.currentPlayerIndex === 'number') {
    return snapshot.currentPlayerIndex;
  }
  if ((snapshot.zk?.shuffledCount ?? 0) === 0) {
    return 0;
  }
  return null;
}

export function isMyZkTurn(snapshot: GameSnapshot, localSeat: number | null, state?: ZkHandFlowState): boolean {
  if (localSeat === null) {
    return false;
  }
  // Register must not require `zk` materials — chain PhaseAdvanced often lands
  // before enriched getGame; needsRegistration already handles that lag.
  if (snapshot.phase === 'Register') {
    return needsRegistration(snapshot, localSeat);
  }
  if (snapshot.phase === 'Shuffle') {
    const myIndex = playerIndexForSeat(snapshot, localSeat);
    if (myIndex === undefined) {
      return false;
    }
    return shuffleActorIndex(snapshot) === myIndex;
  }
  if (!snapshot.zk) {
    return false;
  }
  const myIndex = snapshot.playerIndexBySeat?.[localSeat];
  if (myIndex === undefined) {
    return false;
  }
  if (snapshot.phase === 'Share') {
    // On-chain share is parallel (shared_mask); any seat that has not shared may submit.
    if (snapshot.zk.hasSharedPartial?.[myIndex] === true) {
      return false;
    }
    if (state?.shareRetryAfter !== undefined && Date.now() < state.shareRetryAfter) {
      return false;
    }
    return state?.shareSubmitted !== true;
  }
  return false;
}

/** Identity catalog from the native player (no circomlib wasm on the WebView thread). */
async function loadNativeIdentityDeck(): Promise<Ciphertext[]> {
  const invoke = typeof window !== 'undefined' ? window.zero?.invoke : undefined;
  if (typeof invoke !== 'function') {
    throw new Error('Missing shuffle deck — native player bridge is required');
  }
  const result = await invoke('player', {
    op: 'calc',
    fn: 'initialDeck',
    kind: 0,
    count: 52,
    decks: 1,
  }) as { ok?: boolean; deck?: unknown; error?: string };
  if (!result || result.ok === false || !Array.isArray(result.deck)) {
    throw new Error(result?.error || 'native initialDeck failed');
  }
  return result.deck.map((card) => ciphertextFromJson(card as string[]));
}

function shuffleDeckInput(state: ZkHandFlowState, snapshot: GameSnapshot): Ciphertext[] {
  if (state.currentDeck) {
    return state.currentDeck;
  }
  const fromSnapshot = deckFromSnapshot(snapshot);
  if (fromSnapshot) {
    return fromSnapshot;
  }
  if (state.game) {
    return state.game.deck;
  }
  // P0 Solana path: identity deck is a known constant until deck_state exists.
  if (
    snapshot.phase === 'Shuffle'
    && (snapshot.zk?.currentShufflerIndex === 0 || snapshot.zk?.shuffledCount === 0)
  ) {
    throw new Error(
      'Missing shuffle deck for P0 — getGame should enrich identity/currentDeck from chain',
    );
  }
  throw new Error('Missing shuffle deck (no snapshot deck and no local game)');
}

function shareDeckFromSnapshot(snapshot: GameSnapshot): Ciphertext[] {
  const deck = snapshot.zk?.shareDeck ?? snapshot.zk?.currentDeck;
  if (!deck) {
    throw new Error('Missing ZK shareDeck for share phase');
  }
  return shareDealDeck(deck.map((card) => ciphertextFromJson(card)));
}

/** Share proofs cover the 25-card deal. Shuffle staging keeps the full 52-card shoe. */
export function shareDealDeck(deck: readonly Ciphertext[]): Ciphertext[] {
  return deck.slice(0, TOTAL_CARDS).map((card) => card.map((limb) => limb));
}

/** Stable id for a prove statement. A tx retry with the same id reuses the proof. */
function mixCiphertexts(cards: Ciphertext[]): string {
  let mix = 2166136261n;
  const mask = (1n << 64n) - 1n;
  for (const card of cards) {
    for (const limb of card) {
      mix = ((mix ^ limb) * 16777619n) & mask;
    }
  }
  return `${cards.length}:${mix}`;
}

function mixPublicKeys(keys: PublicKey[]): string {
  let mix = 2166136261n;
  const mask = (1n << 64n) - 1n;
  for (const key of keys) {
    mix = ((mix ^ key[0] ^ key[1]) * 16777619n) & mask;
  }
  return mix.toString();
}

function shareProofKey(
  gameId: string,
  playerIndex: number,
  deck: Ciphertext[],
  nActualPlayers: number,
  ownKey: PublicKey,
  shareKeys: PublicKey[],
): string {
  return `${gameId}:${playerIndex}:${nActualPlayers}:${mixCiphertexts(deck)}:${mixPublicKeys([ownKey, ...shareKeys])}`;
}

function publicKeysEqual(a: PublicKey, b: PublicKey): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

async function assertElGamalKeyMatchesSnapshot(
  state: ZkHandFlowState,
  player: Player,
  snapshot: GameSnapshot,
  localSeat: number,
): Promise<void> {
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  if (playerIndex === undefined || !snapshot.zk) {
    return;
  }
  const expected = snapshot.zk.elGamalPublicKeys[playerIndex];
  if (!expected) {
    return;
  }
  const registered = [BigInt(expected[0]), BigInt(expected[1])] as PublicKey;
  if (!publicKeysEqual(player.publicKey, registered)) {
    if (await syncRegisteredKeyFromSnapshot(state, snapshot, localSeat)) {
      return;
    }
    const msg =
      'ElGamal key desync: client key does not match server registration '
      + '(WebView may have reloaded mid-hand, or a new key was minted after register)';
    console.error(`[zk] ${msg}`, {
      localSeat,
      playerIndex,
      client: player.publicKey.map(String),
      registered: registered.map(String),
      handNumber: state.handNumber,
    });
    throw new Error(msg);
  }
  state.registeredPublicKey = registered;
}

let nextHandStageEnabled: () => boolean = () => false;

/** Poker.svelte turns this on when the player opts into the next hand. */
export function setNextHandStageEnabled(fn: () => boolean): void {
  nextHandStageEnabled = fn;
}

export async function submitRegistration(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
): Promise<GameSnapshot> {
  return timeAsync(`register seat=${localSeat}`, async () => {
    agentDebugLog('H4', 'zk-hand-flow.ts:submitRegistration', 'register start', { localSeat, gameId });
    let fresh = await client.getGame(gameId);
    const playerIndexEarly = fresh.playerIndexBySeat?.[localSeat];
    // Only skip when *our* key is already posted. Do NOT treat raw `lobby`
    // (unenriched getGame) as "already done" — that aborted registerProve forever.
    if (playerIndexEarly !== undefined && fresh.zk?.elGamalPublicKeys[playerIndexEarly]) {
      agentDebugLog('H3', 'zk-hand-flow.ts:submitRegistration', 'skip registerProve (already registered)', {
        localSeat,
        playerIndex: playerIndexEarly,
        phase: fresh.phase,
      });
      if (!await syncRegisteredKeyFromSnapshot(state, fresh, localSeat)) {
        throw new Error(
          'ElGamal key desync: cannot restore registered key for this hand '
          + '(sessionStorage missing after reload, or seat loaded the wrong key)',
        );
      }
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }
    const playerCount = handPlayerCount(fresh);
    const reusable = reusableRegisterProof(playerCount, state.player.publicKey);
    if (reusable) {
      try {
        logHandProgress(
          `Register skipped (same key, ${playerCount} players, seat ${localSeat})`,
          'info',
        );
        const snapshot = await client.registerHandKey(
          gameId,
          localSeat,
          reusable.proof,
          reusable.publicSignals,
        );
        state.registeredPublicKey = [...state.player.publicKey] as PublicKey;
        persistZkHandKey(state.handNumber, {
          privateKey: state.player.elGamalPrivateKey,
          publicKey: state.player.publicKey,
        }, localSeat);
        await syncGameFromSnapshot(state, snapshot);
        return snapshot;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logHandProgress(`Register reuse rejected (seat ${localSeat}): ${message}`, 'info');
      }
    }
    const proveT0 = Date.now();
    const { proof, publicSignals } = await withProveSeat(localSeat, () =>
      state.player.registerProve(),
    );
    rememberRegisterProof(playerCount, state.player.publicKey, proof, publicSignals);
    agentDebugLog('H1', 'zk-hand-flow.ts:submitRegistration', 'registerProve done', {
      localSeat,
      ms: Date.now() - proveT0,
    });
    fresh = await client.getGame(gameId);
    const playerIndex = fresh.playerIndexBySeat?.[localSeat];
    if (playerIndex !== undefined && fresh.zk?.elGamalPublicKeys[playerIndex]) {
      agentDebugLog('H3', 'zk-hand-flow.ts:submitRegistration', 'skip POST registerHandKey', {
        localSeat,
        playerIndex,
        phase: fresh.phase,
        keySet: true,
        registeredCount: fresh.zk?.registeredCount ?? null,
      });
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }
    agentDebugLog('H5', 'zk-hand-flow.ts:submitRegistration', 'POST registerHandKey', {
      localSeat,
      playerIndex,
    });
    console.log(`[zk-hand] registerHandKey submit seat=${localSeat}`);
    const snapshot = await client.registerHandKey(gameId, localSeat, proof, publicSignals);
    console.log(
      `[zk-hand] registerHandKey ok seat=${localSeat} registered=${snapshot.zk?.registeredCount ?? '?'} phase=${snapshot.phase}`,
    );
    agentDebugLog('H5', 'zk-hand-flow.ts:submitRegistration', 'POST registerHandKey ok', {
      localSeat,
      registeredCount: snapshot.zk?.registeredCount ?? null,
      phase: snapshot.phase,
    });
    state.registeredPublicKey = [...state.player.publicKey] as PublicKey;
    const registeredKey = {
      privateKey: state.player.elGamalPrivateKey,
      publicKey: state.player.publicKey,
    };
    persistZkHandKey(state.handNumber, registeredKey, localSeat);
    await syncGameFromSnapshot(state, snapshot);
    return snapshot;
  });
}

export async function submitShuffle(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
  _snapshot: GameSnapshot,
): Promise<GameSnapshot> {
  return timeAsync(`shuffle seat=${localSeat}`, async () => {
    await state.player.ensureNativeCircuitsForPhase('Shuffle');
    let fresh = await client.getGame(gameId);
    // A timed-out getGame comes back as lobby / without a shuffler index.
    // The phase-event snapshot already says whose shuffle this is.
    if (
      _snapshot.phase === 'Shuffle'
      && (fresh.phase !== 'Shuffle' || shuffleActorIndex(fresh) === null)
    ) {
      fresh = {
        ...fresh,
        phase: 'Shuffle',
        currentPlayerIndex: fresh.currentPlayerIndex ?? _snapshot.currentPlayerIndex,
        playerIndexBySeat: fresh.playerIndexBySeat ?? _snapshot.playerIndexBySeat,
        actionOrder: fresh.actionOrder ?? _snapshot.actionOrder,
        zk: fresh.zk?.currentShufflerIndex != null ? fresh.zk : (_snapshot.zk ?? fresh.zk),
      };
    }
    const playerIndex = playerIndexForSeat(fresh, localSeat);
    if (playerIndex === undefined) {
      throw new Error(`No player index for seat ${localSeat}`);
    }
    if (fresh.phase !== 'Shuffle' || shuffleActorIndex(fresh) !== playerIndex) {
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }

    await syncGameFromSnapshot(state, fresh);
    await assertElGamalKeyMatchesSnapshot(state, state.player, fresh, localSeat);

    let deck: Ciphertext[];
    try {
      deck = shuffleDeckInput(state, fresh);
    } catch (err) {
      const actor = shuffleActorIndex(fresh);
      if (actor !== 0 && (fresh.zk?.shuffledCount ?? 0) !== 0) {
        throw err;
      }
      deck = await loadNativeIdentityDeck();
      state.currentDeck = deck;
    }
    // A zeroed deck_state is an allocation, not the identity shoe. Proving
    // that blank deck publishes zeros while the circuit hashes a real shuffle.
    if (
      playerIndex === 0
      && deck.length > 0
      && deck.every((card) => card.every((limb) => limb === 0n))
    ) {
      deck = await loadNativeIdentityDeck();
      state.currentDeck = deck;
    }
    const publicKeys = registeredKeysForShuffle(fresh);
    // This shuffle publishes a new shoe. Drop a deck remembered from an earlier hand.
    state.finalShuffleDeck = null;
    state.preShareDeck = copyDeck(deck);
    const stagedShuffle = await takeStagedShuffle(playerIndex, deck, publicKeys);
    const shuffledBefore = fresh.zk?.shuffledCount ?? 0;
    const proved = stagedShuffle
      ? {
        proof: stagedShuffle.proof,
        publicSignals: stagedShuffle.publicSignals,
        deck: stagedShuffle.shuffledDeck.map((card) => card.map((limb) => BigInt(limb))),
      }
      : await (async () => {
        state.player.preloadShuffle(deck, publicKeys);
        return withProveSeat(localSeat, () => state.player.shuffleProve(deck, publicKeys));
      })();
    if (stagedShuffle) {
      logHandProgress(`Using staged shuffle (seat ${localSeat})`, 'info');
    }
    const { proof, publicSignals } = proved;
    const shuffledDeck = proved.deck.map((card) => card.map((limb) => limb.toString()));

    fresh = await client.getGame(gameId);
    if (fresh.phase !== 'Shuffle' && fresh.phase !== 'Share') {
      fresh = {
        ...fresh,
        phase: 'Shuffle',
        currentPlayerIndex: fresh.currentPlayerIndex ?? playerIndex,
        playerIndexBySeat: fresh.playerIndexBySeat ?? _snapshot.playerIndexBySeat,
        zk: fresh.zk ?? _snapshot.zk,
      };
    }
    if (fresh.phase !== 'Shuffle') {
      if ((fresh.zk?.shuffledCount ?? 0) > shuffledBefore) {
        rememberShuffleResult(state, fresh, proved.deck);
      }
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }
    const actorAfter = shuffleActorIndex(fresh);
    if (actorAfter !== null && actorAfter !== playerIndex) {
      rememberShuffleResult(state, fresh, proved.deck);
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }
    if ((fresh.zk?.shuffledCount ?? 0) > shuffledBefore) {
      rememberShuffleResult(state, fresh, proved.deck);
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }

    try {
      const next = await client.submitShuffle(gameId, localSeat, proof, publicSignals, shuffledDeck);
      rememberShuffleResult(state, next, proved.deck);
      await syncGameFromSnapshot(state, next);
      return next;
    } catch (err) {
      const after = await client.getGame(gameId);
      if ((after.zk?.shuffledCount ?? 0) > shuffledBefore) {
        rememberShuffleResult(state, after, proved.deck);
        await syncGameFromSnapshot(state, after);
        return after;
      }
      throw err;
    }
  });
}

function copyDeck(deck: Ciphertext[]): Ciphertext[] {
  return deck.slice(0, TOTAL_CARDS).map((card) => card.map((limb) => limb));
}

function decksEqual(left: Ciphertext[], right: Ciphertext[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (!a || !b || a.length !== b.length) return false;
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== b[j]) return false;
    }
  }
  return true;
}

/** Keep the shoe this seat just published. Only the shuffle that opens Share is final. */
function rememberFinalShuffleDeck(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  deck: Ciphertext[],
): void {
  if (snapshot.phase !== 'Share' || deck.length === 0) {
    return;
  }
  state.finalShuffleDeck = copyDeck(deck);
  state.publishedShuffleDeck = null;
}

/** Remember this seat's output. Share reads can lag one confirmation behind it. */
function rememberShuffleResult(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  deck: Ciphertext[],
): void {
  if (snapshot.phase === 'Share') {
    rememberFinalShuffleDeck(state, snapshot, deck);
    return;
  }
  if (snapshot.phase === 'Shuffle' && deck.length > 0) {
    state.publishedShuffleDeck = copyDeck(deck);
  }
}

function shareReadIsStale(state: ZkHandFlowState, snapshot: GameSnapshot): boolean {
  const published = state.publishedShuffleDeck;
  if (!published || published.length === 0 || state.finalShuffleDeck?.length) return false;
  const chain = chainShareDeck(snapshot);
  return chain !== null && decksEqual(chain, published);
}

function chainShareDeck(snapshot: GameSnapshot): Ciphertext[] | null {
  try {
    const deck = shareDeckFromSnapshot(snapshot);
    return deck.length > 0 ? deck : null;
  } catch {
    return null;
  }
}

function shareDeckForProve(state: ZkHandFlowState, snapshot: GameSnapshot): Ciphertext[] {
  const chain = chainShareDeck(snapshot);
  const remembered = state.finalShuffleDeck && state.finalShuffleDeck.length > 0
    ? state.finalShuffleDeck.slice(0, TOTAL_CARDS)
    : null;
  if (remembered && chain) {
    if (decksEqual(remembered, chain)) return chain;
    // The account read can still be the shoe this seat shuffled. That read is
    // stale; the deck this shuffle published is the one the verifier will use.
    if (state.preShareDeck && decksEqual(chain, state.preShareDeck)) return remembered;
    return chain;
  }
  if (chain) return chain;
  if (remembered) return remembered;
  return shareDeckFromSnapshot(snapshot);
}

function markShareSubmittedFromServer(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): void {
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  state.shareSubmitted =
    playerIndex !== undefined && snapshot.zk?.hasSharedPartial?.[playerIndex] === true;
}

export async function submitSharePartials(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
  _snapshot: GameSnapshot,
): Promise<GameSnapshot> {
  return timeAsync(`share seat=${localSeat}`, async () => {
    await state.player.ensureNativeCircuitsForPhase('Share');
    let fresh = await client.getGame(gameId);
    const playerIndex = fresh.playerIndexBySeat?.[localSeat];
    if (playerIndex === undefined) {
      throw new Error(`No player index for seat ${localSeat}`);
    }
    if (fresh.phase !== 'Share') {
      markShareSubmittedFromServer(state, fresh, localSeat);
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }

    if (fresh.zk?.hasSharedPartial?.[playerIndex] === true) {
      state.shareSubmitted = true;
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }

    await syncGameFromSnapshot(state, fresh);
    await assertElGamalKeyMatchesSnapshot(state, state.player, fresh, localSeat);

    fresh = await client.getGame(gameId);
    const shoeDeadline = Date.now() + 8_000;
    let announcedStaleShoe = false;
    while (shareReadIsStale(state, fresh) && Date.now() < shoeDeadline) {
      if (!announcedStaleShoe) {
        announcedStaleShoe = true;
        logHandProgress(
          `Waiting for the last shuffle to land before proving (seat ${localSeat})`,
          'info',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      fresh = await client.getGame(gameId);
      if (fresh.phase !== 'Share') {
        markShareSubmittedFromServer(state, fresh, localSeat);
        await syncGameFromSnapshot(state, fresh);
        return fresh;
      }
    }
    if (shareReadIsStale(state, fresh)) {
      throw new Error('Share shoe is still this seat\'s shuffle. Waiting for the last shuffle.');
    }
    if (fresh.playerIndexBySeat?.[localSeat] === undefined) {
      throw new Error(`No player index for seat ${localSeat}`);
    }
    const shareDeck = shareDeckForProve(state, fresh);
    const publishedShoe = state.finalShuffleDeck
      && state.finalShuffleDeck.length > 0
      && decksEqual(shareDeck, state.finalShuffleDeck);
    logHandProgress(
      publishedShoe
        ? `Share deck is the shoe this seat just shuffled (seat ${localSeat})`
        : `Share deck is the on-chain shoe (seat ${localSeat})`,
      'info',
    );
    const shareKeys = shareOthersFromSnapshot(fresh, playerIndex);
    const nActualPlayers = fresh.zk?.registeredCount && fresh.zk.registeredCount > 1
      ? fresh.zk.registeredCount
      : fresh.zk?.elGamalPublicKeys?.filter((k) => k !== null).length
        ?? shareKeys.length + 1;
    if (fresh.zk?.hasSharedPartial?.[playerIndex] === true) {
      state.shareSubmitted = true;
      state.shareProof = undefined;
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }
    if (fresh.phase !== 'Share') {
      markShareSubmittedFromServer(state, fresh, localSeat);
      await syncGameFromSnapshot(state, fresh);
      return fresh;
    }
    const proofKey = shareProofKey(
      gameId,
      playerIndex,
      shareDeck,
      nActualPlayers,
      state.player.publicKey,
      shareKeys,
    );
    const stagedShare = await takeStagedShare(
      playerIndex,
      shareDeck,
      [state.player.publicKey, ...shareKeys],
      nActualPlayers,
    );
    const cached = stagedShare
      ? {
        key: proofKey,
        proof: stagedShare.proof,
        publicSignals: stagedShare.publicSignals,
        ciphertexts: stagedShare.ciphertexts,
      }
      : state.shareProof?.key === proofKey
        ? state.shareProof
        : undefined;
    if (stagedShare) {
      logHandProgress(`Using staged share (seat ${localSeat})`, 'info');
    }
    let proof: object;
    let publicSignals: string[];
    let ciphertexts: Ciphertext[][];
    if (cached) {
      logHandProgress(`Reusing share proof (seat ${localSeat})`, 'info');
      proof = cached.proof;
      publicSignals = cached.publicSignals;
      ciphertexts = cached.ciphertexts;
    } else {
      state.player.preloadShare(shareDeck, shareKeys, nActualPlayers);
      logHandProgress(`Share witness generation starting (seat ${localSeat})`, 'zk');
      const proveStartedAt = Date.now();
      // Paint the status line before the native prove call.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const proved = await withProveSeat(localSeat, () =>
        state.player.shareProve(shareDeck, shareKeys, nActualPlayers),
      );
      const proveSeconds = ((Date.now() - proveStartedAt) / 1000).toFixed(1);
      logHandProgress(`Share proof finished (seat ${localSeat}, ${proveSeconds}s)`, 'zk');
      state.shareProof = {
        key: proofKey,
        proof: proved.proof,
        publicSignals: proved.publicSignals,
        ciphertexts: proved.ciphertexts,
      };
      proof = proved.proof;
      publicSignals = proved.publicSignals;
      ciphertexts = proved.ciphertexts;
    }
    const json = ciphertexts.map((row) =>
      row.map((cell) => cell.map((value) => value.toString())),
    );
    try {
      const { persistShareCiphertexts } = await import('@poker-src/chain/share-ciphertexts-meta');
      persistShareCiphertexts({
        playerIndex,
        ciphertexts: json,
        padding: state.player.padding.map((value) => value.toString()),
      });
      await getSharedMetaStore().flushWrites?.();
    } catch {
      // Meta optional in browser unit tests.
    }

    // Always attempt on-chain submit after a successful prove. Phase may already
    // be PreFlop/Evaluation if the peer's Groth16 receipt advanced the mask —
    // submitShare is idempotent enough to surface AlreadyShared / finalize.
    try {
      console.info(
        `[zk-hand] submitShare start seat=${localSeat} playerIndex=${playerIndex} phase=${fresh.phase}`,
      );
      logHandProgress(`Share tx: sending transactions (seat ${localSeat})`, 'info');
      const next = await client.submitShare(gameId, localSeat, proof, publicSignals, json);
      state.shareSubmitted = true;
      state.shareProof = undefined;
      state.shareProofRejectedKey = undefined;
      state.shareRetryAfter = undefined;
      console.info(`[zk-hand] submitShare ok seat=${localSeat}`);
      await syncGameFromSnapshot(state, next);
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.shareRetryAfter = Date.now() + 15_000;
      if (
        message.includes('Partials already submitted')
        || message.includes('already shared')
        || message.includes('AlreadyShared')
        || message.includes('Player already shared')
      ) {
        state.shareSubmitted = true;
        state.shareRetryAfter = undefined;
        await syncGameFromSnapshot(state, fresh);
        return fresh;
      }
      // Peer finalized while we proved — treat Evaluation/PreFlop as done only
      // when enrichment no longer requests share for this seat.
      fresh = await client.getGame(gameId);
      if (
        fresh.phase !== 'Share'
        && fresh.zk?.shareRequested !== true
        && (fresh.zk?.hasSharedPartial?.[playerIndex] === true
          || fresh.phase === 'PreFlop'
          || fresh.phase === 'Flop'
          || fresh.phase === 'Turn'
          || fresh.phase === 'River'
          || fresh.phase === 'Showdown'
          || fresh.phase === 'Complete')
      ) {
        console.warn(
          `[zk-hand] submitShare raced past Share seat=${localSeat}: ${message}; treating as submitted`,
        );
        state.shareSubmitted = true;
        state.shareRetryAfter = undefined;
        await syncGameFromSnapshot(state, fresh);
        return fresh;
      }
      console.error(`[zk-hand] submitShare failed seat=${localSeat}:`, message);
      // Groth16 `invalid program argument` rejects this proof. Replaying the
      // cached bytes cannot succeed, so every rejection proves again.
      if (message.includes('invalid program argument')) {
        state.shareProofRejectedKey = proofKey;
        state.shareProof = undefined;
        logHandProgress(
          `Share proof rejected by the verifier. Proving again (seat ${localSeat})`,
          'info',
        );
      }
      throw err;
    }
  });
}

function paddedPublicKeys(keys: Array<[string, string]>): PublicKey[] {
  const registered = keys.map((key) => [BigInt(key[0]), BigInt(key[1])] as PublicKey);
  return padPublicKeysForShare(registered);
}

function materialsToInputs(materials: ZkShowdownMaterials) {
  return {
    playerIndex: materials.playerIndex,
    publicKeys: paddedPublicKeys(materials.elGamalPublicKeys),
    potMasks: materials.potMasks.map((value) => BigInt(value)),
    ciphertextCards: materials.finalDeck.map((card) => ciphertextFromJson(card)),
    ciphertextPartials: ciphertextMatrixFromJson(materials.ciphertextPartials),
  };
}

function showdownProofKey(
  gameId: string,
  inputs: ReturnType<typeof materialsToInputs>,
  coefficients: readonly string[],
): string {
  let mix = mixCiphertexts(inputs.ciphertextCards);
  for (const row of inputs.ciphertextPartials) {
    mix += `:${mixCiphertexts(row)}`;
  }
  return `${gameId}:${inputs.playerIndex}:${coefficients.join('.')}:${mix}`;
}

async function resolvePreferredShowdownSubmitter(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  provisionalResult?: HandResultSnapshot | null,
): Promise<number | null> {
  const fromHandResult = resolveShowdownSubmitterSeat(snapshot, provisionalResult);
  if (fromHandResult !== null) {
    return fromHandResult;
  }

  // Winner selection stays opaque until an authenticated settlement consumes
  // the receipt. The existing timeout fallback prevents a stalled showdown.
  void client;
  void gameId;
  void localSeat;
  void state;
  void snapshot;
  return null;
}

export async function shouldSubmitShowdownNow(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  provisionalResult?: HandResultSnapshot | null,
): Promise<boolean> {
  if (!canAttemptShowdownSubmission(snapshot, localSeat, state)) {
    return false;
  }
  ensureShowdownPreferenceDeadline(state, snapshot);

  const preferred = await resolvePreferredShowdownSubmitter(
    client,
    gameId,
    localSeat,
    state,
    snapshot,
    provisionalResult,
  );
  if (preferred === localSeat) {
    return true;
  }
  // Known winner → only that seat submits; a non-winner never does (avoids the
  // redundant on-chain submit + proof error in the event log). See isMyShowdownTurn.
  if (preferred !== null) {
    return false;
  }
  if (!showdownPreferenceExpired(state)) {
    return false;
  }
  const designated = designatedShowdownSeat(snapshot);
  if (designated === localSeat) {
    return true;
  }
  if (designated !== null) {
    return false;
  }
  return true;
}

export function isShowdownAlreadySettledError(message: string): boolean {
  return (
    /already submitted|not in showdown|already finalized/i.test(message)
    || /all-seat settlement/i.test(message)
    || /Only the designated winning player/i.test(message)
    || /Only a winning player/i.test(message)
  );
}

/** Retry without a red Event-log line — host material / prove races. */
export function isShowdownRetryQuietlyError(message: string): boolean {
  return (
    /ShowdownMaterialsNotVerified/i.test(message)
    || /seal not ready/i.test(message)
    || /Transaction simulation failed/i.test(message)
    || /invalid program argument/i.test(message)
    || /ProveBusy/i.test(message)
    || /already in use/i.test(message)
    || /InitShowdownReceipt/i.test(message)
    || /timed out/i.test(message)
  );
}

export async function submitShowdownProof(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
  snapshotHint?: GameSnapshot,
): Promise<GameSnapshot> {
  return timeAsync(`showdown seat=${localSeat}`, async () => {
    const pending = client.getGame(gameId);
    const fresh = await Promise.resolve(pending).catch(() => snapshotHint ?? null) ?? snapshotHint;
    if (!fresh) {
      throw new Error('showdown snapshot unavailable');
    }

    // Materials first (host must already have sealed). Loading the showdown
    // zkey before that used to burn ~40s per retry and freeze both WebViews.
    await syncRegisteredKeyFromSnapshot(state, fresh, localSeat);
    await assertElGamalKeyMatchesSnapshot(state, state.player, fresh, localSeat);

    let materials = await timeAsync(`showdown-materials seat=${localSeat}`, async () => {
      const deadline = Date.now() + 180_000;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          return await client.getShowdownMaterials(gameId, localSeat);
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!/seal not ready/i.test(msg)) {
            throw err;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error('showdown seal not ready — host must seal coefficients first');
    });
    await state.player.ensureNativeCircuitsForPhase?.('Showdown');
    const inputs = materialsToInputs(materials);
    if (materials.sealedCoefficients?.length !== 2) {
      throw new Error('showdown coefficients must come from the host');
    }
    state.player.setSealedCoefficients(materials.sealedCoefficients.map((value) => BigInt(value)));

    const proofKey = showdownProofKey(gameId, inputs, materials.sealedCoefficients);
    const cached = state.showdownProof?.key === proofKey ? state.showdownProof : undefined;
    // Card reveals are still publishing. The first prove overlaps that wait;
    // a failed submit reuses this proof instead of running Groth16 again.
    const proveStartedAt = Date.now();
    const provePromise = cached
      ? Promise.resolve(cached)
      : (async () => {
        state.player.preloadShowdown(
          inputs.playerIndex,
          inputs.publicKeys,
          inputs.potMasks,
          inputs.ciphertextCards,
          inputs.ciphertextPartials,
        );
        logHandProgress(`Showdown witness generation starting (seat ${localSeat})`, 'zk');
        const proved = await withProveSeat(localSeat, () =>
          state.player.showdownProve(
            inputs.playerIndex,
            inputs.publicKeys,
            inputs.potMasks,
            inputs.ciphertextCards,
            inputs.ciphertextPartials,
          ),
        );
        const proveSeconds = ((Date.now() - proveStartedAt) / 1000).toFixed(1);
        logHandProgress(`Showdown proof finished (seat ${localSeat}, ${proveSeconds}s)`, 'zk');
        const stored: CachedShowdownProof = {
          key: proofKey,
          proof: proved.proof,
          publicSignals: proved.publicSignals,
          winnerMasks: proved.winnerMasks,
        };
        state.showdownProof = stored;
        return stored;
      })();
    if (cached) {
      logHandProgress(`Reusing showdown proof (seat ${localSeat})`, 'info');
    }
    try {
      if (materials.materialComplete === false) {
        materials = await timeAsync(`showdown-material-pda seat=${localSeat}`, async () => {
          const deadline = Date.now() + 360_000;
          let last = materials;
          while (Date.now() < deadline) {
            last = await client.getShowdownMaterials(gameId, localSeat);
            if (last.materialComplete !== false) {
              return last;
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          throw new Error('ShowdownMaterialsNotVerified');
        });
      }
    } catch (err) {
      await provePromise.catch(() => undefined);
      throw err;
    }
    const { proof, publicSignals, winnerMasks } = await provePromise;
    console.log(`[zk-hand] showdown prove seat=${localSeat} → submit`);
    if (nextHandStageEnabled()) {
      void stageNextHandCriticalPath(state, fresh, localSeat);
    }
    const next = await client.submitShowdown(
      gameId,
      localSeat,
      proof,
      publicSignals,
      winnerMasks,
    );
    state.showdownSubmitted = true;
    state.showdownProof = undefined;
    return next;
  });
}

async function publishStagedDeck(
  shufflerIndex: number,
  playerCount: number,
  keysMix: string,
  deck: string[][],
): Promise<void> {
  const record: StagedDeckRecord = { shufflerIndex, playerCount, keysMix, deck };
  writeSharedMeta(NEXT_HAND_DECK_KEY, JSON.stringify(record));
  await getSharedMetaStore().flushWrites?.();
}

async function readStagedDeck(): Promise<StagedDeckRecord | null> {
  try {
    const { refreshWebViewMetaCache } = await import('../backend/solana-meta-bridge');
    await refreshWebViewMetaCache([NEXT_HAND_DECK_KEY]);
  } catch {
    // Browser tests have no meta bridge.
  }
  const raw = readSharedMeta(NEXT_HAND_DECK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StagedDeckRecord;
    if (!Array.isArray(parsed.deck) || !Number.isInteger(parsed.shufflerIndex)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function runNextHandStage(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): Promise<void> {
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  if (playerIndex === undefined || playerIndex < 0) return;
  const playerCount = handPlayerCount(snapshot);
  if (playerCount < 2) return;
  let publicKeys: PublicKey[];
  try {
    publicKeys = registeredKeysFromSnapshot(snapshot);
  } catch {
    return;
  }
  if (publicKeys.length !== playerCount) return;
  const keysMix = mixKeys(publicKeys);

  if (playerIndex === 0 && !hasStagedShuffle(0)) {
    logHandProgress(`Staging next-hand shuffle (seat ${localSeat})`, 'info');
    const deck = await loadNativeIdentityDeck();
    state.player.preloadShuffle(deck, publicKeys);
    const proved = await withProveSeat(localSeat, () => state.player.shuffleProve(deck, publicKeys));
    const shuffledDeck = proved.deck.map((card) => card.map((limb) => limb.toString()));
    rememberStagedShuffle({
      playerIndex: 0,
      deckMix: mixLimbs(deck),
      keysMix,
      proof: proved.proof,
      publicSignals: proved.publicSignals,
      shuffledDeck,
    });
    await publishStagedDeck(0, playerCount, keysMix, shuffledDeck);
    logHandProgress(`Next-hand shuffle staged (seat ${localSeat})`, 'info');
  }

  if (playerIndex > 0 && !hasStagedShuffle(playerIndex)) {
    const prior = await readStagedDeck();
    if (
      prior
      && prior.shufflerIndex === playerIndex - 1
      && prior.playerCount === playerCount
      && prior.keysMix === keysMix
    ) {
      logHandProgress(
        `Staging next-hand shuffle ${playerIndex + 1}/${playerCount} (seat ${localSeat})`,
        'info',
      );
      const deck = prior.deck.map((card) => ciphertextFromJson(card));
      state.player.preloadShuffle(deck, publicKeys);
      const proved = await withProveSeat(localSeat, () => state.player.shuffleProve(deck, publicKeys));
      const shuffledDeck = proved.deck.map((card) => card.map((limb) => limb.toString()));
      rememberStagedShuffle({
        playerIndex,
        deckMix: mixLimbs(deck),
        keysMix,
        proof: proved.proof,
        publicSignals: proved.publicSignals,
        shuffledDeck,
      });
      await publishStagedDeck(playerIndex, playerCount, keysMix, shuffledDeck);
      logHandProgress(`Next-hand shuffle staged (seat ${localSeat})`, 'info');
    }
  }

  if (hasStagedShare(playerIndex)) return;
  let shareDeckJson: string[][] | null = null;
  if (playerIndex === playerCount - 1) {
    shareDeckJson = stagedShuffleDeck(playerIndex);
  } else {
    const published = await readStagedDeck();
    if (
      published
      && published.shufflerIndex === playerCount - 1
      && published.playerCount === playerCount
      && published.keysMix === keysMix
    ) {
      shareDeckJson = published.deck;
    }
  }
  if (!shareDeckJson) return;
  const shareDeck = shareDealDeck(shareDeckJson.map((card) => ciphertextFromJson(card)));
  const shareKeys = shareOthersForPlayer(publicKeys, playerIndex);
  logHandProgress(`Staging next-hand share (seat ${localSeat})`, 'info');
  state.player.preloadShare(shareDeck, shareKeys, playerCount);
  const proved = await withProveSeat(localSeat, () =>
    state.player.shareProve(shareDeck, shareKeys, playerCount),
  );
  rememberStagedShare({
    playerIndex,
    deckMix: mixLimbs(shareDeck),
    keysMix: mixKeys([state.player.publicKey, ...shareKeys]),
    playerCount,
    proof: proved.proof,
    publicSignals: proved.publicSignals,
    ciphertexts: proved.ciphertexts,
  });
  logHandProgress(`Next-hand share staged (seat ${localSeat})`, 'info');
}

/**
 * Prepare the next hand's shuffle and share.
 * Showdown stages only when the player opted into the next hand.
 * An uncontested fold passes `force` so the same proofs run once the hand is over.
 */
export async function stageNextHandCriticalPath(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
  force = false,
): Promise<void> {
  if (!force && !nextHandStageEnabled()) return;
  const existing = currentStageFlight();
  if (existing) return existing;
  const flight = runNextHandStage(state, snapshot, localSeat)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logHandProgress(`Next-hand stage failed (seat ${localSeat}): ${message}`, 'info');
    })
    .finally(() => noteStageFlight(null));
  noteStageFlight(flight);
  return flight;
}

export async function maybeAdvanceZkHand(
  client: ZkHandClient,
  gameId: string,
  snapshot: GameSnapshot,
  localSeat: number | null,
  state: ZkHandFlowState | null,
  provisionalResult?: HandResultSnapshot | null,
): Promise<GameSnapshot | null> {
  if (!state || localSeat === null || state.inFlight) {
    return null;
  }

  const registerDue = snapshot.phase === 'Register' && needsRegistration(snapshot, localSeat);
  const zkTurn = snapshot.phase === 'Register' ? registerDue : isMyZkTurn(snapshot, localSeat, state);
  const showdownTurn =
    snapshot.phase === 'Showdown'
      ? await shouldSubmitShowdownNow(client, gameId, localSeat, state, snapshot, provisionalResult)
      : isMyShowdownTurn(snapshot, localSeat, state, provisionalResult);
  if (!registerDue && !showdownTurn && !zkTurn) {
    return null;
  }

  logTiming(`maybeAdvanceZkHand phase=${snapshot.phase} seat=${localSeat}`);
  state.inFlight = true;
  try {
    await syncGameFromSnapshot(state, snapshot);
    if (snapshot.phase === 'Register') {
      return await submitRegistration(client, gameId, localSeat, state);
    }
    if (snapshot.phase === 'Shuffle') {
      return await submitShuffle(client, gameId, localSeat, state, snapshot);
    }
    if (snapshot.phase === 'Share') {
      return await submitSharePartials(client, gameId, localSeat, state, snapshot);
    }
    if (snapshot.phase === 'Showdown') {
      return await submitShowdownProof(client, gameId, localSeat, state, snapshot);
    }
    return null;
  } finally {
    state.inFlight = false;
  }
}
