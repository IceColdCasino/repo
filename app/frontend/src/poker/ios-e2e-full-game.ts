/**
 * In-simulator full-hand E2E for seat 1: native witness + Groth16 via window.zero,
 * coordinated with macOS seat 0 native desktop app (all ZK via window.zero bridge).
 */
import { createPokerClient, SOLANA_TABLE_GAME_ID, LOCAL_TABLE_GAME_ID } from '../backend/client';
import type { BackendKind, GameSnapshot } from '../backend/client';
import { waitForNativeBridge } from '../zk/runtime';
import {
  type ZkHandFlowState,
  createNativeHandFlow,
  isMyZkTurn,
  maybeAdvanceZkHand,
  maybeWarmShowdownZkey,
  needsRegistration,
  syncShareSubmittedFromSnapshot,
  shouldSubmitShowdownNow,
} from './zk-hand-flow-auto';
import { formatHandLifecycleStatus } from './hand-status';
import {
  assertCompleteTableRender,
  formatTableRenderSnapshot,
  normalizeSeatKeyedRecord,
  waitForCompleteTableRender,
} from './e2e-table-render';
import { reportE2eRenderSnapshot } from './e2e-render-report';

function resolveIosE2eBackend(): BackendKind {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('backend');
    if (q === 'solana' || q === 'local' || q === 'devnet') {
      return q;
    }
    const launch = (window as Window & { __ZK_LAUNCH_CONFIG?: { backend?: string } }).__ZK_LAUNCH_CONFIG;
    if (launch?.backend === 'solana' || launch?.backend === 'local' || launch?.backend === 'devnet') {
      return launch.backend;
    }
  }
  return 'local';
}

const IOS_SEAT = 1;
const POLL_MS = 400;
/** Register/shuffle on iOS sim can exceed 30s when macOS seat 0 proves in parallel. */
const REGISTER_TIMEOUT_MS = 60_000;
const SHUFFLE_TIMEOUT_MS = 90_000;
/** Share Groth16 on iOS simulator can exceed 60s per seat (~15s each). */
const SHARE_TIMEOUT_MS = 300_000;
/** Betting streets + manualAutoBet advance. */
const PLAYTHROUGH_TIMEOUT_MS = 180_000;
/** Showdown witness+prove on iOS sim can exceed 60s. */
const SHOWDOWN_TIMEOUT_MS = 180_000;
/** Default for setup / hole ack / complete polling. */
const HEAVY_PHASE_TIMEOUT_MS = 120_000;
/** Cross-client setup (orchestrator start-hand, peer seating) — not ZK-bound. */
const SETUP_TIMEOUT_MS = 120_000;

function resolveGameId(snapshot?: GameSnapshot | null): string {
  if (snapshot?.gameId) {
    return snapshot.gameId;
  }
  return resolveIosE2eBackend() === 'solana' ? SOLANA_TABLE_GAME_ID : LOCAL_TABLE_GAME_ID;
}

let iosZkFlow: ZkHandFlowState | null = null;

async function ensureIosZkFlow(handNumber: number): Promise<ZkHandFlowState> {
  if (!iosZkFlow || iosZkFlow.handNumber !== handNumber) {
    iosZkFlow = await createNativeHandFlow(handNumber);
  }
  return iosZkFlow;
}

async function tryAdvanceIosSeatZk(
  client: ReturnType<typeof createPokerClient>,
  snapshot: GameSnapshot,
): Promise<GameSnapshot> {
  const handNumber = snapshot.handNumber ?? 1;
  const flow = await ensureIosZkFlow(handNumber);
  const gameId = resolveGameId(snapshot);
  syncShareSubmittedFromSnapshot(flow, snapshot, IOS_SEAT);
  try {
    const advanced = await maybeAdvanceZkHand(client, gameId, snapshot, IOS_SEAT, flow);
    return advanced ?? snapshot;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      snapshot.phase === 'Showdown'
      && (
        message.includes('pot win')
        || message.includes('winning player')
        || message.includes('already submitted')
        || message.includes('Winner masks mismatch')
      )
    ) {
      flow.showdownSubmitted = false;
      return fetchGameWithRetry(client, 'showdown retry after peer submit');
    }
    throw err;
  }
}

async function shouldDriveIosShowdown(
  client: ReturnType<typeof createPokerClient>,
  snapshot: GameSnapshot,
): Promise<boolean> {
  if (snapshot.phase !== 'Showdown' || !snapshot.zkShowdown?.requested) {
    return false;
  }
  if ((snapshot.zkShowdown.submittedCount ?? 0) >= (snapshot.zkShowdown.requiredCount ?? 1)) {
    return false;
  }
  const handNumber = snapshot.handNumber ?? 1;
  const flow = await ensureIosZkFlow(handNumber);
  return shouldSubmitShowdownNow(client, resolveGameId(snapshot), IOS_SEAT, flow, snapshot);
}

async function pollWithIosZkDrive(
  label: string,
  timeoutMs: number,
  predicate: (snapshot: GameSnapshot) => boolean,
  client: ReturnType<typeof createPokerClient>,
  shouldDrive: (snapshot: GameSnapshot) => boolean | Promise<boolean>,
): Promise<GameSnapshot> {
  return pollUntil(
    label,
    timeoutMs,
    predicate,
    async () => {
      let snap = await fetchGameWithRetry(client, label);
      if (await shouldDrive(snap)) {
        snap = await tryAdvanceIosSeatZk(client, snap);
      }
      await nudgeIosUi();
      return snap;
    },
  );
}

export interface IosE2eCaseResult {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

export interface IosE2eReport {
  passed: boolean;
  cases: IosE2eCaseResult[];
  complete?: boolean;
  progress?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let progressSink: ((label: string) => void) | null = null;

async function reportProgress(label: string): Promise<void> {
  console.log(`[ios-e2e] ${label}`);
  progressSink?.(label);
  const handler = (window as unknown as { webkit?: { messageHandlers?: { iosE2eProgress?: { postMessage: (body: unknown) => void } } } })
    .webkit?.messageHandlers?.iosE2eProgress;
  handler?.postMessage({ label, at: new Date().toISOString() });
}

async function fetchGameWithRetry(
  client: ReturnType<typeof createPokerClient>,
  label: string,
  attempts = 5,
): Promise<GameSnapshot> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.getGame(resolveGameId());
    } catch (err) {
      lastErr = err;
      await reportProgress(`${label}: fetch retry ${i + 1}/${attempts} (${err instanceof Error ? err.message : String(err)})`);
      await sleep(1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function publishPartialReport(cases: IosE2eCaseResult[], progress?: string): void {
  publishReport(cases, false, progress);
}

function publishFinalReport(cases: IosE2eCaseResult[]): IosE2eReport {
  return publishReport(cases, true);
}

function publishReport(cases: IosE2eCaseResult[], complete: boolean, progress?: string): IosE2eReport {
  const report: IosE2eReport = {
    passed: cases.every((entry) => entry.ok),
    cases,
    complete,
    progress,
  };
  const handler = (window as unknown as { webkit?: { messageHandlers?: { iosE2eReport?: { postMessage: (body: unknown) => void } } } })
    .webkit?.messageHandlers?.iosE2eReport;
  handler?.postMessage(report);
  return report;
}

function finishReport(cases: IosE2eCaseResult[]): IosE2eReport {
  return publishFinalReport(cases);
}

async function runCase(
  cases: IosE2eCaseResult[],
  name: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const t0 = Date.now();
  try {
    await fn();
    cases.push({ name, ok: true, detail: undefined, durationMs: Date.now() - t0 });
    publishPartialReport(cases);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cases.push({ name, ok: false, detail: message, durationMs: Date.now() - t0 });
    publishPartialReport(cases);
    return false;
  }
}

async function pollUntil(
  label: string,
  timeoutMs: number,
  predicate: (snapshot: GameSnapshot) => boolean,
  fetch: () => Promise<GameSnapshot>,
): Promise<GameSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: GameSnapshot | null = null;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    last = await fetch();
    if (predicate(last)) {
      return last;
    }
    const now = Date.now();
    if (now - lastProgressAt >= 5_000) {
      lastProgressAt = now;
      const elapsed = Math.round((now - (deadline - timeoutMs)) / 1000);
      const detail = last ? playthroughProgressDetail(last) : 'unknown';
      await reportProgress(`${label}… ${elapsed}s (${detail})`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `${label} timed out after ${timeoutMs}ms (last phase=${last?.phase ?? 'unknown'} seats=${last?.seats?.length ?? 0})`,
  );
}

function seatRegistered(snapshot: GameSnapshot, seat: number): boolean {
  const playerIndex = snapshot.playerIndexBySeat?.[seat];
  return playerIndex !== undefined && Boolean(snapshot.zk?.elGamalPublicKeys[playerIndex]);
}

function seatSharePartialSubmitted(snapshot: GameSnapshot, seat: number): boolean {
  if (snapshot.zkReveal?.shareComplete === true) {
    return true;
  }
  const playerIndex = snapshot.playerIndexBySeat?.[seat];
  return playerIndex !== undefined && snapshot.zk?.hasSharedPartial?.[playerIndex] === true;
}

async function nudgeIosUi(): Promise<void> {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('e2e-sync-game'));
    window.dispatchEvent(new CustomEvent('e2e-run-zk'));
    await sleep(400);
  }
}

function bothSharePartialsSubmitted(snapshot: GameSnapshot): boolean {
  if (snapshot.zkReveal?.shareComplete === true) {
    return true;
  }
  const zk = snapshot.zk;
  if (!zk || snapshot.phase !== 'Share') {
    return false;
  }
  const count = zk.registeredCount ?? 0;
  if (count < 2) {
    return false;
  }
  for (let i = 0; i < count; i += 1) {
    if (zk.hasSharedPartial?.[i] !== true) {
      return false;
    }
  }
  return true;
}

/** Showdown requested, proof submitted, or hand already Complete (mac may finish before we poll Showdown). */
function isShowdownReachedOrHandComplete(snapshot: GameSnapshot): boolean {
  if (snapshot.phase === 'Complete' && Boolean(snapshot.handResult)) {
    return true;
  }
  if ((snapshot.zkShowdown?.submittedCount ?? 0) >= (snapshot.zkShowdown?.requiredCount ?? 1)) {
    return true;
  }
  return snapshot.phase === 'Showdown' && Boolean(snapshot.zkShowdown?.requested);
}

function playthroughProgressDetail(snapshot: GameSnapshot): string {
  const lifecycle = formatHandLifecycleStatus(snapshot);
  const submitted = snapshot.zkShowdown?.submittedSeats ?? [];
  if (snapshot.phase === 'Complete') {
    return lifecycle || 'Phase 4: Showdown complete';
  }
  if (submitted.length > 0) {
    return `${lifecycle || snapshot.phase} (showdown seats ${submitted.join(',')})`;
  }
  return lifecycle || snapshot.phase;
}

async function advanceSeat1DuringPlaythrough(
  client: ReturnType<typeof createPokerClient>,
  snapshot: GameSnapshot,
  _flow: ZkHandFlowState | null,
): Promise<GameSnapshot> {
  let current = snapshot;
  maybeWarmShowdownZkey(current);

  if (
    current.phase === 'Showdown'
    && Boolean(current.zkShowdown?.requested)
    && (current.zkShowdown?.submittedCount ?? 0) < (current.zkShowdown?.requiredCount ?? 1)
    && await shouldDriveIosShowdown(client, current)
  ) {
    current = await tryAdvanceIosSeatZk(client, current);
  }

  if (current.bettingRoundOpen && current.currentPlayerSeat === IOS_SEAT) {
    const seatInfo = current.seats.find((s) => s.seat === IOS_SEAT);
    if (seatInfo && !seatInfo.folded) {
      const toCall = BigInt(current.currentBet) - BigInt(seatInfo.bet ?? '0');
      const gameId = resolveGameId(current);
      try {
        current = await client.placeBet(gameId, IOS_SEAT, toCall > 0n ? 'call' : 'check');
      } catch {
        current = await client.getGame(gameId);
      }
    }
  }

  return current;
}

export async function runIosE2eFullGame(apiBase: string): Promise<IosE2eReport> {
  const cases: IosE2eCaseResult[] = [];
  const { saveApiBase } = await import('../server/runtime');
  saveApiBase(apiBase);

  const backend = resolveIosE2eBackend();
  const GAME_ID = backend === 'solana' ? SOLANA_TABLE_GAME_ID : LOCAL_TABLE_GAME_ID;

  await runCase(cases, 'bridge.ready', async () => {
    const ping = await waitForNativeBridge(45_000);
    if (!ping.ok) {
      throw new Error(ping.detail ?? 'Bridge is not ready.');
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('e2e-bridge-ready', { detail: ping }));
    }
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  // Solana dual-native: mutations are executePerSeatOp → RPC. Passing apiBase
  // (Vite/static :5178) as workerUrl makes getGame fetch /api/game and fail with
  // TypeError: Load failed — assets-only servers have no table API.
  const useSolanaBridge =
    backend === 'solana'
    && (typeof window === 'undefined'
      || new URLSearchParams(window.location.search).get('noChainWorker') === '1'
      || new URLSearchParams(window.location.search).get('chainWorker') === '0');
  const client = useSolanaBridge
    ? createPokerClient('solana')
    : createPokerClient(backend, apiBase);
  let snapshot = await client.getGame(GAME_ID);

  await runCase(cases, 'table.join', async () => {
    await reportProgress('waiting for seat 1 bootstrap (Poker nativeE2e auto-play — do not join with a separate wallet)');
    snapshot = await pollUntil(
      'seat 1 seated',
      SETUP_TIMEOUT_MS,
      (s) => (s.seats ?? []).some((seat) => seat.seat === IOS_SEAT),
      async () => {
        await nudgeIosUi();
        return fetchGameWithRetry(client, 'seat 1 bootstrap poll');
      },
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.register.wait', async () => {
    await reportProgress('waiting for Register (orchestrator starts hand after table.join)');
    await pollUntil(
      'Register phase',
      SETUP_TIMEOUT_MS,
      (s) => s.phase === 'Register',
      () => client.getGame(GAME_ID),
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.register.prove', async () => {
    await reportProgress('waiting for macOS seat 0 register (sequential; iOS proves second)');
    snapshot = await pollUntil(
      'mac seat 0 registered on server',
      REGISTER_TIMEOUT_MS,
      (s) => {
        const macIndex = s.playerIndexBySeat?.[0];
        return macIndex !== undefined && Boolean(s.zk?.elGamalPublicKeys[macIndex]);
      },
      () => client.getGame(GAME_ID),
    );
    await reportProgress('iOS seat 1 native register (harness-driven ZK)');
    snapshot = await pollWithIosZkDrive(
      'seat 1 register proof on server',
      REGISTER_TIMEOUT_MS,
      (s) => seatRegistered(s, IOS_SEAT),
      client,
      (s) => s.phase === 'Register' && needsRegistration(s, IOS_SEAT),
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.proof.register', async () => {
    const playerIndex = snapshot.playerIndexBySeat?.[IOS_SEAT];
    if (playerIndex === undefined || !snapshot.zk?.elGamalPublicKeys[playerIndex]) {
      throw new Error('iOS register proof not recorded on server');
    }
  });

  await runCase(cases, 'hand.register.complete', async () => {
    snapshot = await pollUntil(
      'Shuffle phase (both registered)',
      REGISTER_TIMEOUT_MS,
      (s) => s.phase === 'Shuffle' && (s.zk?.registeredCount ?? 0) >= 2,
      () => client.getGame(GAME_ID),
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.shuffle', async () => {
    await reportProgress('sequential shuffle: mac seat 0 then iOS seat 1 (harness drives seat 1)');
    snapshot = await pollWithIosZkDrive(
      'both shuffles complete',
      SHUFFLE_TIMEOUT_MS,
      (s) => {
        const registered = s.zk?.registeredCount ?? 0;
        const shuffled = s.zk?.shuffledCount ?? 0;
        return registered >= 2 && shuffled >= registered;
      },
      client,
      (s) => s.phase === 'Shuffle' && isMyZkTurn(s, IOS_SEAT, iosZkFlow ?? undefined),
    );
    if (snapshot.phase === 'Shuffle') {
      throw new Error('shuffle phase did not advance after both shuffles');
    }
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.proof.shuffle', async () => {
    const playerIndex = snapshot.playerIndexBySeat?.[IOS_SEAT];
    if (playerIndex === undefined) {
      throw new Error('missing seat 1 player index after shuffle');
    }
    const shuffled = snapshot.zk?.shuffledCount ?? 0;
    const registered = snapshot.zk?.registeredCount ?? 0;
    if (shuffled < registered) {
      throw new Error(`shuffle incomplete on server (${shuffled}/${registered})`);
    }
  });

  await runCase(cases, 'hand.share', async () => {
    progressSink = (label) => publishPartialReport(cases, label);
    try {
      snapshot = await pollWithIosZkDrive(
        'Share phase',
        SHARE_TIMEOUT_MS,
        (s) => s.phase === 'Share',
        client,
        () => false,
      );
      await reportProgress('iOS seat 1 share partial (harness-driven ZK; mac seat 0 in parallel via desktop)');
      snapshot = await pollWithIosZkDrive(
        'seat 1 share partial on server',
        SHARE_TIMEOUT_MS,
        (s) => seatSharePartialSubmitted(s, IOS_SEAT),
        client,
        (s) => s.phase === 'Share' && isMyZkTurn(s, IOS_SEAT, iosZkFlow ?? undefined),
      );
    } finally {
      progressSink = null;
    }
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.share.both_seats', async () => {
    await reportProgress('waiting for both seats share partials (macOS seat 0 + iOS seat 1)');
    snapshot = await pollUntil(
      'Both share partials',
      SHARE_TIMEOUT_MS,
      bothSharePartialsSubmitted,
      () => fetchGameWithRetry(client, 'both share partials poll'),
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.proof.share', async () => {
    snapshot = await fetchGameWithRetry(client, 'share proof verify');
    if (snapshot.zkReveal?.shareComplete === true) {
      return;
    }
    const playerIndex = snapshot.playerIndexBySeat?.[IOS_SEAT];
    if (playerIndex === undefined || snapshot.zk?.hasSharedPartial?.[playerIndex] !== true) {
      throw new Error('iOS share proof not recorded on server');
    }
    const seat0Index = snapshot.playerIndexBySeat?.[0];
    if (seat0Index === undefined || snapshot.zk?.hasSharedPartial?.[seat0Index] !== true) {
      throw new Error('macOS share proof not recorded on server');
    }
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.share.complete', async () => {
    snapshot = await pollUntil(
      'PreFlop',
      HEAVY_PHASE_TIMEOUT_MS,
      (s) => s.zkReveal?.shareComplete === true || (s.phase === 'PreFlop' && s.zkReveal?.shareComplete === true),
      () => client.getGame(GAME_ID),
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.hole.ack', async () => {
    snapshot = await fetchGameWithRetry(client, 'hole ack precheck');
    if (snapshot.bettingRoundOpen === true || snapshot.phase !== 'PreFlop') {
      await reportProgress('hole ack skipped (betting already open or past PreFlop)');
      return;
    }
    await reportProgress('seat 1 acknowledge hole cards (macOS seat 0 via native auto-play)');
    try {
      snapshot = await client.acknowledgeHoleCards(GAME_ID, IOS_SEAT);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Betting round already open')) {
        return;
      }
      throw error;
    }
    snapshot = await pollUntil(
      'Betting round open after hole acks',
      HEAVY_PHASE_TIMEOUT_MS,
      (s) => s.bettingRoundOpen === true,
      () => fetchGameWithRetry(client, 'betting open poll'),
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.playthrough', async () => {
    await reportProgress('waiting for Showdown (server manualAutoBet + macOS native auto-play)');
    snapshot = await pollUntil(
      'Showdown',
      PLAYTHROUGH_TIMEOUT_MS,
      isShowdownReachedOrHandComplete,
      async () => {
        const s = await fetchGameWithRetry(client, 'Showdown phase poll');
        return await advanceSeat1DuringPlaythrough(client, s, null);
      },
    );
    await reportProgress(`playthrough done: ${playthroughProgressDetail(snapshot)}`);
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.proof.showdown', async () => {
    if (snapshot.phase === 'Complete' && Boolean(snapshot.handResult)) {
      await reportProgress('showdown proof skipped — hand already Complete on server');
      return;
    }
    await reportProgress('showdown proof (iOS seat 1 when eligible via harness; mac seat 0 otherwise)');
    snapshot = await pollWithIosZkDrive(
      'showdown proof on server',
      SHOWDOWN_TIMEOUT_MS,
      (s) => {
        if (s.phase === 'Complete' && Boolean(s.handResult)) {
          return true;
        }
        const submitted = s.zkShowdown?.submittedSeats ?? [];
        if (submitted.length >= 1) {
          return true;
        }
        return false;
      },
      client,
      async (s) => await shouldDriveIosShowdown(client, s),
    );
    const submittedSeats = snapshot.zkShowdown?.submittedSeats ?? [];
    if (submittedSeats.length === 0 && snapshot.phase !== 'Complete') {
      throw new Error('showdown proof not recorded on server');
    }
    await reportProgress(
      snapshot.phase === 'Complete'
        ? `showdown complete: ${playthroughProgressDetail(snapshot)}`
        : `showdown proof submitted by seat(s) ${submittedSeats.join(',')}`,
    );
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'hand.complete', async () => {
    if (snapshot.phase === 'Complete' && Boolean(snapshot.handResult)) {
      if (!snapshot.handResult.potResults?.length) {
        throw new Error('hand completed without pot results');
      }
      await reportProgress(`hand.complete: ${playthroughProgressDetail(snapshot)}`);
      return;
    }
    snapshot = await pollUntil(
      'Complete',
      PLAYTHROUGH_TIMEOUT_MS,
      (s) => s.phase === 'Complete' && Boolean(s.handResult),
      async () => {
        let s = await fetchGameWithRetry(client, 'Complete phase poll');
        s = await advanceSeat1DuringPlaythrough(client, s, null);
        return s;
      },
    );
    if (!snapshot.handResult?.potResults?.length) {
      throw new Error('hand completed without pot results');
    }
    await reportProgress(`hand.complete: ${playthroughProgressDetail(snapshot)}`);
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'ui.render.ios', async () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('e2e-sync-game'));
      await sleep(500);
    }
    const render = await waitForCompleteTableRender(IOS_SEAT, 60_000);
    await reportE2eRenderSnapshot(IOS_SEAT);
    await reportProgress(`ios render ok: ${formatTableRenderSnapshot(render)}`);
  });
  if (!cases.at(-1)?.ok) {
    return finishReport(cases);
  }

  await runCase(cases, 'ui.render.macos', async () => {
    if (backend === 'solana') {
      await reportProgress('macOS render snapshot skipped (chain worker has no e2e-render-snapshot)');
      return;
    }
    await reportProgress('waiting for macOS seat 0 render snapshot');
    let macRender: Record<string, unknown> | null = null;
    const deadline = Date.now() + PLAYTHROUGH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(
          `${apiBase}/api/admin/e2e-render-snapshot?backend=local&seat=0`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          macRender = (await res.json()) as Record<string, unknown>;
          const render = {
            seat: 0,
            phase: typeof macRender.phase === 'string' ? macRender.phase : null,
            tableVisible: macRender.tableVisible === true,
            seatedAvatars: Array.isArray(macRender.seatedAvatars)
              ? macRender.seatedAvatars.map(Number)
              : [],
            sharedCount: typeof macRender.sharedCount === 'number' ? macRender.sharedCount : 0,
            sharedFaceUp: Array.isArray(macRender.sharedFaceUp)
              ? macRender.sharedFaceUp.map(Boolean)
              : [],
            sharedUnicode: Array.isArray(macRender.sharedUnicode)
              ? macRender.sharedUnicode.map((value) => (typeof value === 'string' ? value : null))
              : [],
            holeSeats: Array.isArray(macRender.holeSeats) ? macRender.holeSeats.map(Number) : [],
            holeFaceUp: normalizeSeatKeyedRecord<[boolean, boolean]>(macRender.holeFaceUp),
            holeUnicode: normalizeSeatKeyedRecord<[string | null, string | null]>(macRender.holeUnicode),
            handResultVisible: macRender.handResultVisible === true,
            lifecycleStatus:
              typeof macRender.lifecycleStatus === 'string' ? macRender.lifecycleStatus : null,
          };
          assertCompleteTableRender(render, 0);
          const summary = typeof macRender.summary === 'string'
            ? macRender.summary
            : formatTableRenderSnapshot(render);
          await reportProgress(`macOS render ok: ${summary}`);
          return;
        }
      } catch {
        // desktop may still be posting snapshot or cards not ready yet
      }
      await sleep(500);
    }
    throw new Error('macOS seat 0 did not report a valid render snapshot');
  });

  return finishReport(cases);
}

declare global {
  interface Window {
    __iosE2eRunFullGame?: (apiBase: string) => Promise<IosE2eReport>;
  }
}

export function installIosE2eFullGameHook(): void {
  window.__iosE2eRunFullGame = runIosE2eFullGame;
}
