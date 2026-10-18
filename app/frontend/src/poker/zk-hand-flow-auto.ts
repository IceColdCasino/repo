/**
 * Automated ZK hand flow (native E2E / e2eAutoPlay).
 *
 * Interactive play must import `./zk-hand-flow` instead. This file owns host-shared
 * ElGamal keys, visual dummy showdown, and dual-mac register stagger.
 */
import type { HandResultSnapshot } from '@poker-src/backend/hand-result';
import type { GameSnapshot } from '../backend/client';
import type { PublicKey } from '@poker-src/zk-casino';
import { Player } from '@poker-src/poker-player';
import { persistZkHandKey } from './zk-hand-key-store';
import {
  isNativeE2e,
  loadE2eSeatHandKey,
  persistE2eSeatHandKey,
} from './e2e-seat-hand-key';
import {
  type EnsurePlayerKeyOptions as ManualKeyOptions,
  type ZkHandClient,
  type ZkHandFlowState,
  createFreshZkHandFlow as createManualZkHandFlow,
  createNativeHandFlow as createManualNativeHandFlow,
  ensurePlayerKeyForHand as ensureManualPlayerKeyForHand,
  maybeAdvanceZkHand as maybeAdvanceManualZkHand,
  needsRegistration,
  shouldSubmitShowdownNow,
  submitRegistration as submitManualRegistration,
  submitShowdownProof as submitManualShowdownProof,
  syncGameFromSnapshot,
  syncRegisteredKeyFromSnapshot as syncManualRegisteredKeyFromSnapshot,
} from './zk-hand-flow';

export {
  type ZkHandClient,
  type ZkHandFlowState,
  SHOWDOWN_WINNER_PREFERENCE_MS,
  shouldWarmShowdownZkey,
  clearZkHandFlowState,
  isHandFlowPhase,
  isZkHandPhase,
  syncShareSubmittedFromSnapshot,
  syncGameFromSnapshot,
  resolveShowdownHandResult,
  resolveShowdownSubmitterSeat,
  showdownWinnerSeats,
  showdownSubmitterSeat,
  syncShowdownSubmittedFromSnapshot,
  canAttemptShowdownSubmission,
  isMyShowdownTurn,
  designatedShowdownSeat,
  needsRegistration,
  isMyZkTurn,
  submitShuffle,
  submitSharePartials,
  shouldSubmitShowdownNow,
  isShowdownAlreadySettledError,
  isShowdownRetryQuietlyError,
} from './zk-hand-flow';

const REGISTER_STAGGER_MS_PER_SEAT = 8_000;

export const E2E_VISUAL_SHOWDOWN_PROOF = {
  pi_a: ['0', '0'],
  pi_b: [['0', '0'], ['0', '0']],
  pi_c: ['0', '0'],
};

export type EnsurePlayerKeyOptions = ManualKeyOptions & {
  /**
   * When true, may load the shared E2E seat0 key file. Never enable for seat 1+
   * or both clients can adopt the same ElGamal key / overwrite each other.
   * @deprecated Prefer `seat` / `e2eSeat`.
   */
  allowE2eSeat0Fallback?: boolean;
  /** Native dual-mac E2E seat. Loads/persists `.local/e2e-elgamal-seatN`. */
  e2eSeat?: number | null;
};

function resolveSeat(options?: EnsurePlayerKeyOptions): number | null {
  return options?.seat
    ?? options?.e2eSeat
    ?? (options?.allowE2eSeat0Fallback ? 0 : null);
}

function publicKeysEqual(a: PublicKey, b: PublicKey): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function isE2eVisualShowdown(snapshot: GameSnapshot): boolean {
  return snapshot.phase === 'Showdown' && Boolean(snapshot.e2eDealValues);
}

/** Automation never page-caches the showdown zkey (freezes dual WKWebViews). */
export function maybeWarmShowdownZkey(_snapshot: GameSnapshot): void {}

async function prefetchHostSharedKey(
  handNumber: number,
  seat: number | null,
  expectedPublicKey?: PublicKey | null,
): Promise<void> {
  if (!isNativeE2e() || seat === null) {
    return;
  }
  const key = await loadE2eSeatHandKey(handNumber, seat);
  if (!key) {
    return;
  }
  if (expectedPublicKey && !publicKeysEqual(key.publicKey, expectedPublicKey)) {
    return;
  }
  persistZkHandKey(handNumber, key, seat);
}

function persistHostSharedKey(seat: number | null, key: {
  privateKey: bigint;
  publicKey: PublicKey;
}): void {
  if (!isNativeE2e() || seat === null) {
    return;
  }
  void persistE2eSeatHandKey(seat, key);
}

export async function ensurePlayerKeyForHand(
  player: Player,
  handNumber: number,
  expectedPublicKey?: PublicKey | null,
  options?: EnsurePlayerKeyOptions,
): Promise<PublicKey | null> {
  const seat = resolveSeat(options);
  await prefetchHostSharedKey(handNumber, seat, expectedPublicKey);
  const key = await ensureManualPlayerKeyForHand(player, handNumber, expectedPublicKey, { seat });
  if (key) {
    persistHostSharedKey(seat, {
      privateKey: player.elGamalPrivateKey,
      publicKey: player.publicKey,
    });
    return key;
  }
  if (expectedPublicKey && isNativeE2e() && seat !== null) {
    const stored = await loadE2eSeatHandKey(handNumber, seat);
    if (stored && publicKeysEqual(stored.publicKey, expectedPublicKey)) {
      player.loadPlayerKey(stored);
      await player.ensureKey();
      persistZkHandKey(handNumber, stored, seat);
      persistHostSharedKey(seat, stored);
      return stored.publicKey;
    }
  }
  return null;
}

export async function createFreshZkHandFlow(
  handNumber: number,
  expectedPublicKey?: PublicKey | null,
  options?: EnsurePlayerKeyOptions,
): Promise<ZkHandFlowState> {
  const seat = resolveSeat(options);
  await prefetchHostSharedKey(handNumber, seat, expectedPublicKey);
  return createManualZkHandFlow(handNumber, expectedPublicKey, { seat });
}

export async function createNativeHandFlow(
  handNumber: number,
  expectedPublicKey?: PublicKey | null,
  options?: EnsurePlayerKeyOptions,
): Promise<ZkHandFlowState> {
  const seat = resolveSeat(options);
  await prefetchHostSharedKey(handNumber, seat, expectedPublicKey);
  return createManualNativeHandFlow(handNumber, expectedPublicKey, { seat });
}

export async function syncRegisteredKeyFromSnapshot(
  state: ZkHandFlowState,
  snapshot: GameSnapshot,
  localSeat: number,
): Promise<boolean> {
  if (await syncManualRegisteredKeyFromSnapshot(state, snapshot, localSeat)) {
    persistHostSharedKey(localSeat, {
      privateKey: state.player.elGamalPrivateKey,
      publicKey: state.player.publicKey,
    });
    return true;
  }
  const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
  const expectedRaw = playerIndex !== undefined
    ? snapshot.zk?.elGamalPublicKeys[playerIndex]
    : undefined;
  if (!expectedRaw) {
    return false;
  }
  const expected = [BigInt(expectedRaw[0]), BigInt(expectedRaw[1])] as PublicKey;
  const fromHost = await loadE2eSeatHandKey(state.handNumber, localSeat);
  if (!fromHost || !publicKeysEqual(fromHost.publicKey, expected)) {
    return false;
  }
  state.player.loadPlayerKey(fromHost);
  await state.player.ensureKey();
  state.registeredPublicKey = expected;
  persistZkHandKey(state.handNumber, fromHost, localSeat);
  persistHostSharedKey(localSeat, fromHost);
  return true;
}

export async function submitRegistration(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
): Promise<GameSnapshot> {
  const snapshot = await submitManualRegistration(client, gameId, localSeat, state);
  persistHostSharedKey(localSeat, {
    privateKey: state.player.elGamalPrivateKey,
    publicKey: state.player.publicKey,
  });
  return snapshot;
}

export async function submitShowdownProof(
  client: ZkHandClient,
  gameId: string,
  localSeat: number,
  state: ZkHandFlowState,
  snapshotHint?: GameSnapshot,
): Promise<GameSnapshot> {
  const fresh = snapshotHint ?? await client.getGame(gameId);
  if (fresh.e2eDealValues) {
    const next = await client.submitShowdown(
      gameId,
      localSeat,
      E2E_VISUAL_SHOWDOWN_PROOF,
      ['0', '0'],
    );
    state.showdownSubmitted = true;
    return next;
  }
  await prefetchHostSharedKey(state.handNumber, localSeat);
  await syncRegisteredKeyFromSnapshot(state, fresh, localSeat);
  return submitManualShowdownProof(client, gameId, localSeat, state, fresh);
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

  if (isE2eVisualShowdown(snapshot)) {
    const due = await shouldSubmitShowdownNow(
      client,
      gameId,
      localSeat,
      state,
      snapshot,
      provisionalResult,
    );
    if (!due) {
      return null;
    }
    state.inFlight = true;
    try {
      return await submitShowdownProof(client, gameId, localSeat, state, snapshot);
    } finally {
      state.inFlight = false;
    }
  }

  if (snapshot.phase === 'Register' && needsRegistration(snapshot, localSeat) && localSeat > 0) {
    state.inFlight = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, localSeat * REGISTER_STAGGER_MS_PER_SEAT));
      const latest = await client.getGame(gameId);
      if (!needsRegistration(latest, localSeat)) {
        await syncGameFromSnapshot(state, latest);
        return latest;
      }
      return await submitRegistration(client, gameId, localSeat, state);
    } finally {
      state.inFlight = false;
    }
  }

  if (snapshot.phase === 'Showdown') {
    await prefetchHostSharedKey(state.handNumber, localSeat);
    await syncRegisteredKeyFromSnapshot(state, snapshot, localSeat);
  }

  const next = await maybeAdvanceManualZkHand(
    client,
    gameId,
    snapshot,
    localSeat,
    state,
    provisionalResult,
  );
  if (next && snapshot.phase === 'Register') {
    persistHostSharedKey(localSeat, {
      privateKey: state.player.elGamalPrivateKey,
      publicKey: state.player.publicKey,
    });
  }
  return next;
}
