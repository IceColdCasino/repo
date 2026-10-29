<script lang="ts">
  import { onMount } from 'svelte';
  import PlayerCards from './PlayerCards.svelte';
  import SharedCards from './SharedCards.svelte';
  import TableSeats from './TableSeats.svelte';
  import DealerButtons from './DealerButtons.svelte';
  import RouletteBoard from './RouletteBoard.svelte';
  import {
    createClient,
    resolveBackendKind,
    saveBackendKind,
    SolanaPokerClient,
    isChainPhaseForward,
    mergeWorkerIntoChainSnapshot,
    type BackendKind,
    type GameSnapshot,
  } from './backend';
  import HandResultPanel from './HandResultPanel.svelte';
  import CardHoverPreview from './CardHoverPreview.svelte';
  import AvatarHoverPreview from './AvatarHoverPreview.svelte';
  import {
    displayHandLifecycleStatus,
    formatHandLifecycleStatus,
    formatTableStatus,
    isHandLifecycleComplete,
    renderTableStatus,
  } from './poker/hand-status';
  import { shouldAutoCheckBeforeDeadline } from './poker/turn-clock';
  import { requiredShareStake } from '@poker-src/poker-share-penalty';
  import {
    appendHandEvents,
    createHandEvent,
    formatEventLogTime,
    reduceHandEventLog,
    type HandEventLogEntry,
  } from './poker/event-log';
  import { dumpHandEventLog } from './poker/event-log-dump';
  import {
    formatProveEventMessage,
    setProveEventLogListener,
  } from './poker/prove-event-log';
  import { setHandProgressListener } from '@poker-src/hand-progress';
  import { buildProvisionalShowdownResult } from './poker/provisional-showdown';
  import type { HandResultSnapshot } from '@poker-src/backend/hand-result';
  import { buildHandResultView, type HandResultView } from './poker/hand-result-view';
  import {
    callAmountForSeat,
    selectableSeats,
    shuffleFinished,
    snapshotFromServer,
    usesZkCardDecryption,
  } from './poker/server-view';
  import {
    resolveUiGameKind,
    saveUiGameKind,
    seatCountForGame,
    UI_GAME_KIND_OPTIONS,
    usesBlackjackLayout,
    usesRouletteLayout,
    usesVersusDealerCards,
    type UiGameKind,
  } from './poker/game-kind';
  import { presentTableView } from './poker/table-view-adapt';
  import { chooseAutoBetAction, shouldAutoAdvanceStreet, shouldOpenPreflop } from './poker/autoplay-betting';
  import {
    BLIND_POSTS_KEY,
    blindsReady,
    blindOwners,
    mergeBlindPosts,
    blindRoleForSeat,
    blindAmounts,
    claimHeldByOther,
    describeBlindPrompt,
    loadAutoCollectBlinds,
    noteClaim,
    notePosted,
    parseBlindPosts,
    saveAutoCollectBlinds,
    type BlindPostRecord,
  } from './poker/blind-post';
  import {
    anySeatSittingOut,
    initialNextHandBlindGate,
    loadOptInNextHand,
    nextHandBlindsAllowed,
    nextHandReadyToOpen,
    NEXT_HAND_SITOUT_KEY,
    noteSitOut,
    parseSitOutRecord,
    reduceNextHandBlindGate,
    saveOptInNextHand,
    shouldSitOutNextHand,
    uncontestedFoldFinish,
    type SitOutRecord,
  } from './poker/next-hand';
  import { tableShowsDecryptedFaces } from './poker/decrypt-to-faces';
  import {
    HOLES_REVEALED_KEY,
    allHoleCardsRevealed,
    claimPreflopOpen,
    localHolesFaceUp,
    mergeHolesRevealed,
    noteHolesRevealed,
    parseHolesRevealed,
  } from './poker/holes-revealed';
  import {
    shouldDeferNativeDecrypt,
    shouldPaintNativeDecrypt,
    shouldRunNativeDecryptWasm,
  } from './poker/decrypt-gate';
  import { PartialStore } from './poker/partial-store';
  import {
    PHASE_LABEL,
    seatLabel,
    tableLayoutFor,
  } from './poker/table-layout';
  import {
    dockedAvatarHoverPreviewLayout,
    dockedCardHoverPreviewLayout,
    TABLE_BELOW_BAND_PX,
  } from './poker/card-hover-preview-layout';
  import { getActivePublicKey, getOrCreateLocalPublicKey, hydrateE2eWalletFromMeta, createNewLocalWallet, shortPublicKey } from './identity';
  import { usesLocalSeatKey } from './identity/player-key';
  import { canBeginHand } from './poker/manual-start';
  import { MIN_SIT_CHIPS } from '@poker-src/chain/sit-minimum';
  import type { TableView, CardView } from './poker/view-model';
  import { pingZkRuntime, resetZkRuntime, tryRefreshNativeBridge } from './zk';
  import { agentDebugLog } from './debug-agent-log';
  import { logTiming, timeAsync } from '@poker-src/timing-log';
  import {
    isIosE2eFullGameHarness,
    reportZkHandError,
  } from './poker/zk-e2e-diagnostics';
  import type { ZkHandFlowState } from './poker/zk-hand-flow';
  import {
    fetchServerHealth,
    fetchChainWorkerHealth,
    type ServerConnectionStatus,
  } from './server';

  // Module-eval hook (after imports — Svelte requires imports first)
  try {
    const t0 = (typeof performance !== 'undefined' && performance.now ? performance.now().toFixed(1) : '?');
    console.log('[BRIDGE module-eval] Poker.svelte module evaluated at +' + t0 + 'ms after early script');
    const D = (window as Window & { __zkBridgeDebug?: { events?: Array<{ t: string; label: string; msg?: string }> } }).__zkBridgeDebug;
    if (D?.events) {
      D.events.push({ t: t0 + 'ms', label: 'module-eval', msg: 'Poker.svelte top level' });
    }
  } catch {}

  let backendKind = $state<BackendKind>('local');

  function shareBondSol(): string {
    const seated = gameState?.seats.length ?? 0;
    const players = Math.max(2, Math.min(10, seated));
    const lamports = requiredShareStake(players);
    const whole = lamports / 1_000_000_000n;
    const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0').slice(0, 5);
    return `${whole}.${frac}`;
  }

  function onChain(kind: BackendKind = backendKind): boolean {
    return kind === 'solana' || kind === 'devnet';
  }
  let client = $state(createClient('local'));
  let gameKind = $state<UiGameKind>('poker');
  let gameId = $state<string | null>(null);
  let gameState = $state<GameSnapshot | null>(null);
  let view = $state<TableView>(snapshotFromServer(null));
  const tableLayout = $derived(tableLayoutFor(gameKind));
  const phaseLabelY = $derived(gameKind === 'poker' ? PHASE_LABEL.y : 138);

  function paintTableView(
    snapshot: GameSnapshot | null,
    decrypted?: Map<number, number>,
    result?: HandResultView | null,
  ): void {
    view = presentTableView(
      snapshotFromServer(snapshot, localSeat, decrypted, result),
      gameKind,
      snapshot,
    );
  }

  function switchGameKind(kind: UiGameKind): void {
    gameKind = kind;
    saveUiGameKind(kind);
    if (gameState?.phase === 'lobby' || gameState?.phase === 'Complete' || !gameState) {
      void client.createGame(undefined, { gameKind: kind }).then((next) => {
        applySnapshot(next);
      }).catch(() => {
        paintTableView(gameState, lastDecryptedCards, handResultView);
      });
      return;
    }
    paintTableView(gameState, lastDecryptedCards, handResultView);
  }

  let localSeat = $state<number | null>(null);
  let selectedSeat = $state('');
  let playerPublicKey = $state('');
  let walletLabel = $state('');
  let walletChoices = $state<{ name: string }[]>([]);
  let walletMenuOpen = $state(false);
  let stopWallets: (() => void) | undefined;
  let raiseAmount = $state(40);
  let addChipsAmount = $state(1000);
  let personalChips = $state(0);
  const minSitChips = Number(MIN_SIT_CHIPS);
  let statusMessage = $state('');
  /** Append-only history for the current hand (cleared on new handNumber). */
  let handEventLog = $state<HandEventLogEntry[]>([]);
  let eventLogPrevSnapshot: GameSnapshot | null = null;
  let eventLogScrollEl = $state<HTMLDivElement | null>(null);
  /** When false, new events must not yank scroll away from history the user is reading. */
  let eventLogStickToBottom = true;
  let zkStatus = $state('');
  let zkBridgeOk = $state(false);
  let zkHandFlow = $state<ZkHandFlowState | null>(null);
  let zkHandFlowNumber = $state<number | null>(null);
  let zkBusy = $state(false);
  let busy = $state(false);
  let statusNow = $state(Date.now());
  let statusKey = $state('');
  let statusStartedAt = $state(Date.now());
  let autoCollectBlinds = $state(loadAutoCollectBlinds());
  let optInNextHand = $state(loadOptInNextHand());
  let blindGate = $state(initialNextHandBlindGate());
  let sittingOutNextHand = $state(false);
  let sitOutRecord = $state<SitOutRecord | null>(null);
  let sitOutChainSent = false;
  let sitOutTransferAttempted = false;
  /** Native launch automation: auto check/call and hole-card ack without manual clicks. */
  let nativeAutoPlay = $state(false);
  void loadZkHandFlowModule().then((mod) => {
    mod.setNextHandStageEnabled(() => optInNextHand && !sittingOutNextHand);
  });
  let blindPosts = $state<BlindPostRecord | null>(null);
  let blindCollectLock = 0;
  const blindPrompt = $derived(describeBlindPrompt({
    snapshot: gameState,
    localSeat,
    autoCollect: autoCollectBlinds || nativeAutoPlay,
    record: blindPosts,
    previousHandSettled: nextHandBlindsAllowed(blindGate),
  }));
  const blindHold = $derived(
    Boolean(gameState && shouldOpenPreflop(gameState) && !nextHandBlindsAllowed(blindGate)),
  );
  const tableStatus = $derived(formatTableStatus({
    snapshot: gameState,
    localSeat,
    zkBusy,
    busy,
    statusMessage,
    blindPrompt: blindPrompt?.text ?? null,
    blindPromptTone: blindPrompt?.tone,
  }));
  const tableStatusLine = $derived(
    renderTableStatus(tableStatus, Math.max(0, statusNow - statusStartedAt)),
  );
  let serverStatus = $state<ServerConnectionStatus>('checking');
  let serverDetail = $state('');
  let serverBootId = $state<string | null>(null);
  let serverPollTimer: ReturnType<typeof setInterval> | null = null;
  let zkPollTimer: ReturnType<typeof setInterval> | null = null;
  let bridgeProbeTimer: ReturnType<typeof setInterval> | null = null;
  let waitingForBridge = $state(false);
  let unsubscribeTable: (() => void) | null = null;
  let unsubscribeChainEvents: (() => void) | null = null;
  let tableConnected = $state(false);
  let catalogRooms = $state<Array<{
    roomIdHex: string;
    label: string;
    tables: Array<{ tableId: string; label: string }>;
  }>>([]);
  let selectedRoomId = $state('');
  let selectedTableId = $state('');
  let catalogTimer: ReturnType<typeof setInterval> | null = null;
  let partialStore = $state(new PartialStore());
  let partialCount = $state(0);
  /** Once Complete faces decrypt, stop polling; until then keep retrying sync+decrypt. */
  let completeFacesReady = false;
  let holesAcked = $state(false);
  let holesAckHandNumber = $state<number | null>(null);
  let deferredDecryptTimer: ReturnType<typeof setTimeout> | null = null;

  function isNativeAutoPlay(): boolean {
    if (nativeAutoPlay) {
      return true;
    }
    if (typeof window === 'undefined') {
      return false;
    }
    const params = new URLSearchParams(window.location.search);
    return params.get('e2eAutoPlay') === '1' || params.get('nativeE2e') === '1';
  }

  function loadZkHandFlowModule() {
    return isNativeAutoPlay()
      ? import('./poker/zk-hand-flow-auto')
      : import('./poker/zk-hand-flow');
  }

  function nativeDecryptOptions(snapshot: GameSnapshot) {
    return {
      phase: snapshot.phase,
      nativeAutoPlay: isNativeAutoPlay(),
      holesAcked,
      hasE2eDealValues: Boolean(snapshot.e2eDealValues),
      showdownSubmitted: Boolean(zkHandFlow?.showdownSubmitted),
    };
  }

  function nativeDecryptDeferred(snapshot: GameSnapshot | null = gameState): boolean {
    if (!snapshot) {
      return false;
    }
    return shouldDeferNativeDecrypt(nativeDecryptOptions(snapshot));
  }

  function nativeDecryptPaintable(snapshot: GameSnapshot | null = gameState): boolean {
    if (!snapshot) {
      return false;
    }
    return shouldPaintNativeDecrypt(nativeDecryptOptions(snapshot));
  }

  function scheduleDeferredDecrypt(): void {
    // Keep decrypt off the ack/bet/prove path; paint faces in the background.
    if (zkBusy) {
      return;
    }
    if (!nativeDecryptPaintable()) {
      return;
    }
    if (gameState && !shouldRunNativeDecryptWasm(nativeDecryptOptions(gameState))) {
      return;
    }
    if (deferredDecryptTimer) {
      return;
    }
    deferredDecryptTimer = setTimeout(() => {
      deferredDecryptTimer = null;
      const snapshot = gameState;
      if (zkBusy || !snapshot || !nativeDecryptPaintable(snapshot)) {
        return;
      }
      void syncPartials(snapshot).then(() => refreshViewWithDecryption());
    }, 250);
  }

  function reportUi(snapshot: GameSnapshot | null = gameState, kind: 'heartbeat' | 'phase' = 'phase'): void {
    void import('./poker/e2e-ui-report').then(({ reportNativeUiState }) => {
      void reportNativeUiState(localSeat, {
        holesAcked,
        zkBusy,
        shareComplete: Boolean(snapshot?.zkReveal?.shareComplete),
        kind,
      });
    });
  }
  let handResultView = $state<HandResultView | null>(null);
  let lastDecryptedCards: Map<number, number> | undefined;

  function mergeDecryptedCardMaps(
    previous: Map<number, number> | undefined,
    next: Map<number, number>,
  ): Map<number, number> {
    if (!previous || previous.size === 0) {
      return next;
    }
    const merged = new Map(previous);
    for (const [dealIndex, value] of next) {
      merged.set(dealIndex, value);
    }
    return merged;
  }
  let provisionalHandResult = $state<HandResultSnapshot | null>(null);
  let hoveredCard = $state<CardView | null>(null);
  let hoveredAvatar = $state<{ avatarId: number; name: string; seat: number } | null>(null);
  const cardPreviewLayout = dockedCardHoverPreviewLayout();
  const avatarPreviewLayout = dockedAvatarHoverPreviewLayout();
  let cardPreviewW = $state(cardPreviewLayout.width);
  let cardPreviewH = $state(cardPreviewLayout.height);
  let cardPreviewFont = $state(cardPreviewLayout.fontSize);
  let avatarPreviewSize = $state(avatarPreviewLayout.width);
  let tableRootEl = $state<HTMLDivElement | null>(null);
  let tableSvgEl = $state<SVGSVGElement | null>(null);
  /** Live instrumentation for bridge detection events (visible + console + __zkBridgeDebug). */
  let bridgeEvents = $state<Array<{ t: string; msg: string }>>([]);
  let handStartRequested = false;
  /** Native WebView on phone-sized screens — use stacked layout so the table stays visible. */
  let compactNativeLayout = $state(false);
  let autoBetLock = 0;
  /** Back off auto-bet after failures so Event log is not flooded with identical errors. */
  let autoBetRetryAfter = 0;
  /** Stop infinite retry loops after repeated identical placeBet failures. */
  let autoBetFailCount = 0;
  let autoBetLastError = '';
  /**
   * Hard auto-play caps — successful check/call loops must not run forever when
   * street-close meta is stale. Heads-up needs at most call+check per street.
   */
  const MAX_AUTO_ACTIONS_PER_STREET = 4;
  const MAX_AUTO_ACTIONS_PER_HAND = 16;
  const MAX_IDENTICAL_SUCCESS = 2;
  let autoBetStreetKey = '';
  let autoBetStreetCount = 0;
  let autoBetHandNumber: number | null = null;
  let autoBetHandCount = 0;
  let autoBetLastSuccessKey = '';
  let autoBetSuccessRepeat = 0;
  let autoBetHardStopped = '';
  let lastEventLogError = '';
  let lastEventLogErrorAt = 0;
  const seenChainEventSigs = new Set<string>();
  function syncCompactNativeLayout() {
    if (typeof window === 'undefined') {
      return;
    }
    const nativeBridge = typeof (window as Window & { zero?: { invoke?: unknown } }).zero?.invoke === 'function';
    compactNativeLayout = nativeBridge && window.innerWidth < 900;
  }
  function logBridge(msg: string) {
    const t = (typeof performance !== 'undefined' && performance.now ? performance.now().toFixed(1) : String(Date.now())) + 'ms';
    const entry = { t, msg };
    bridgeEvents = [...bridgeEvents.slice(-39), entry];
    try { console.log('[BRIDGE]', msg); } catch {}
    try {
      const D = (window as any).__zkBridgeDebug;
      if (D && Array.isArray(D.events)) {
        D.events.push({ t, label: 'Poker.svelte', msg });
      }
    } catch {}
  }
  /** Snapshot current bridge presence for the debug panel. */
  function currentBridgeSnapshot() {
    try {
      const hasWin = typeof window !== 'undefined';
      const z = hasWin ? (window as Window & { zero?: { invoke?: unknown } }).zero : undefined;
      return {
        hasWin,
        hasZero: !!z,
        invoke: z ? typeof z.invoke : 'n/a',
        keys: z ? Object.keys(z as object) : [],
      };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function earlyBridgeDebug() {
    try {
      const D = (window as Window & {
        __zkBridgeDebug?: { firstSeenAt?: string; events?: unknown[] };
      }).__zkBridgeDebug;
      return {
        firstSeenAt: D?.firstSeenAt ?? null,
        eventsCount: D?.events?.length ?? 0,
      };
    } catch {
      return { firstSeenAt: null, eventsCount: 0 };
    }
  }

  const bridgeDebugEarly = $derived(earlyBridgeDebug());
  /** Prevents overlapping maybeRunZkHand calls (losing call must not clear zkBusy early). */
  let zkHandLock = 0;
  let showdownPrep = false;

  function handleCardHover(card: CardView | null): void {
    hoveredAvatar = null;
    hoveredCard = card;
  }

  function handleAvatarHover(info: { avatarId: number; name: string; seat: number } | null): void {
    hoveredCard = null;
    hoveredAvatar = info;
  }

  function isActiveZkPhase(phase: GameSnapshot['phase']): boolean {
    return phase === 'Register' || phase === 'Shuffle' || phase === 'Share' || phase === 'Showdown';
  }

  function onEventLogScroll() {
    const el = eventLogScrollEl;
    if (!el) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    eventLogStickToBottom = distanceFromBottom < 48;
  }

  function scrollEventLogIfSticky() {
    queueMicrotask(() => {
      if (eventLogScrollEl && eventLogStickToBottom) {
        eventLogScrollEl.scrollTop = eventLogScrollEl.scrollHeight;
      }
    });
  }

  function persistEventLogDump() {
    dumpHandEventLog(handEventLog, localSeat);
  }

  function ingestSnapshotEvents(snapshot: GameSnapshot) {
    if (
      eventLogPrevSnapshot
      && snapshot.handNumber != null
      && eventLogPrevSnapshot.handNumber != null
      && snapshot.handNumber !== eventLogPrevSnapshot.handNumber
    ) {
      seenChainEventSigs.clear();
    }
    const reduced = reduceHandEventLog(handEventLog, eventLogPrevSnapshot, snapshot);
    handEventLog = reduced.log;
    eventLogPrevSnapshot = reduced.prev;
    scrollEventLogIfSticky();
    persistEventLogDump();
  }

  function pushEventLog(
    kind: HandEventLogEntry['kind'],
    message: string,
    handNumber: number | null = gameState?.handNumber ?? null,
  ) {
    // Collapse ciphertext dumps / Anchor arg spam into a short stable line.
    let text = message;
    if (text.includes('provided too many arguments') && text.includes('submitBet')) {
      text = 'submitBet arg mismatch vs on-chain IDL (too many arguments)';
    } else if (text.length > 420) {
      // Keep the program error at the end (0x1777 / invalid argument).
      text = `${text.slice(0, 180)} … ${text.slice(-200)}`;
    }
    // Street-advance race: chain still prompts a seat that worker already closed.
    if (kind === 'error' && /cannot act now/i.test(text)) {
      return;
    }
    if (kind === 'error') {
      const now = Date.now();
      if (text === lastEventLogError && now - lastEventLogErrorAt < 15_000) {
        return;
      }
      lastEventLogError = text;
      lastEventLogErrorAt = now;
    }
    handEventLog = appendHandEvents(handEventLog, [
      createHandEvent(kind, text, handNumber),
    ]);
    scrollEventLogIfSticky();
    persistEventLogDump();
  }

  // Native witness+Groth16 (zk.prove) → Event log start/end for every circuit.
  setProveEventLogListener((payload) => {
    pushEventLog(
      payload.phase === 'failed' ? 'error' : 'zk',
      formatProveEventMessage(payload),
    );
  });
  setHandProgressListener((message) => {
    pushEventLog('info', message);
  });

  function newHandDropsFaces(prev: GameSnapshot | null, next: GameSnapshot): boolean {
    if (!prev) return false;
    if (
      next.handNumber != null
      && prev.handNumber != null
      && next.handNumber !== prev.handNumber
    ) {
      return true;
    }
    return next.phase === 'Register' && prev.phase !== 'Register' && prev.phase !== 'Shuffle';
  }

  async function publishSitOut(snapshot: GameSnapshot, sittingOut: boolean): Promise<void> {
    if (localSeat === null) return;
    const { writeSharedMeta, getSharedMetaStore, readSharedMeta } = await import('@poker-src/chain/shared-meta-store');
    const { refreshWebViewMetaCache } = await import('./backend/solana-meta-bridge');
    await refreshWebViewMetaCache([NEXT_HAND_SITOUT_KEY]).catch(() => undefined);
    const current = parseSitOutRecord(readSharedMeta(NEXT_HAND_SITOUT_KEY), snapshot.gameId);
    const next = noteSitOut(current, localSeat, sittingOut, Date.now());
    writeSharedMeta(NEXT_HAND_SITOUT_KEY, JSON.stringify(next));
    await getSharedMetaStore().flushWrites?.();
    sitOutRecord = next;
    sittingOutNextHand = sittingOut;
  }

  async function refreshSitOutRecord(snapshot: GameSnapshot): Promise<void> {
    const { readSharedMeta } = await import('@poker-src/chain/shared-meta-store');
    const { refreshWebViewMetaCache } = await import('./backend/solana-meta-bridge');
    await refreshWebViewMetaCache([NEXT_HAND_SITOUT_KEY]).catch(() => undefined);
    const record = parseSitOutRecord(readSharedMeta(NEXT_HAND_SITOUT_KEY), snapshot.gameId);
    sitOutRecord = record;
    if (localSeat !== null) {
      const mine = record.seats[String(localSeat)];
      if (mine) sittingOutNextHand = mine.sittingOut;
    }
  }

  let syncingNextHand = false;
  /** One settlement per fold. Cleared when the table leaves Complete. */
  let foldFinishKey: string | null = null;
  let foldFinishError = '';

  function foldFinishToken(snapshot: GameSnapshot): string {
    const live = (snapshot.actionOrder ?? [])
      .filter((seat) => snapshot.seats.some((row) => row.seat === seat && !row.folded))
      .join(',');
    return `${snapshot.gameId}:${snapshot.handNumber ?? 0}:${live}`;
  }

  async function finishUncontestedFold(snapshot: GameSnapshot): Promise<void> {
    if (
      !uncontestedFoldFinish(snapshot)
      || localSeat === null
      || !gameId
      || !client.settleUncontestedFold
    ) {
      return;
    }
    const token = foldFinishToken(snapshot);
    if (foldFinishKey === token || foldFinishKey === `busy:${token}`) return;
    foldFinishKey = `busy:${token}`;
    try {
      if (zkHandFlow && !sittingOutNextHand) {
        const flow = zkHandFlow;
        const seat = localSeat;
        const mod = await loadZkHandFlowModule();
        void mod.stageNextHandCriticalPath(flow, snapshot, seat, true);
      }
      const settled = await client.settleUncontestedFold(gameId, localSeat);
      if (settled === 'wait') {
        foldFinishKey = null;
        setTimeout(() => {
          const latest = gameState;
          if (latest && uncontestedFoldFinish(latest)) void finishUncontestedFold(latest);
        }, 800);
        return;
      }
      if (settled) {
        foldFinishKey = token;
        foldFinishError = '';
        applySnapshot(settled);
        return;
      }
      foldFinishKey = token;
    } catch (err) {
      foldFinishKey = null;
      const message = err instanceof Error ? err.message : 'fold settlement failed';
      if (message !== foldFinishError) {
        foldFinishError = message;
        pushEventLog('error', `Fold settlement failed: ${message}`);
      }
      setTimeout(() => {
        const latest = gameState;
        if (latest && uncontestedFoldFinish(latest)) void finishUncontestedFold(latest);
      }, 1500);
    }
  }

  async function syncNextHand(snapshot: GameSnapshot): Promise<void> {
    if (syncingNextHand || gameKind !== 'poker' || localSeat === null) return;
    syncingNextHand = true;
    try {
    await refreshSitOutRecord(snapshot);
    const seat = snapshot.seats.find((entry) => entry.seat === localSeat);
    let stack = 0n;
    try {
      stack = BigInt(seat?.chips || '0');
    } catch {
      stack = 0n;
    }
    const big = blindAmounts(snapshot).big;
    const { showdownWinnerSeats } = await loadZkHandFlowModule();
    const winners = showdownWinnerSeats(snapshot, provisionalHandResult);
    const winnersKnown = winners.size > 0 || Boolean(snapshot.handResult);
    const sit = shouldSitOutNextHand({
      stack,
      bigBlind: big,
      winnersKnown,
      won: winners.has(localSeat),
    });
    if (stack >= big && sittingOutNextHand) {
      await publishSitOut(snapshot, false);
    } else if (winnersKnown && sit !== sittingOutNextHand) {
      await publishSitOut(snapshot, sit);
    }
    const handClosed = snapshot.phase === 'Complete' || snapshot.phase === 'lobby';
    if (sittingOutNextHand && handClosed && !sitOutChainSent && client.sitOut) {
      sitOutChainSent = true;
      try {
        const next = await client.sitOut(snapshot.gameId);
        applySnapshot(next);
        pushEventLog('info', `Sitting out — stack is below the big blind (${big})`);
      } catch (err) {
        sitOutChainSent = false;
        const message = err instanceof Error ? err.message : String(err);
        pushEventLog('error', `sit out failed: ${message}`);
      }
    }
    if (!sittingOutNextHand) {
      sitOutChainSent = false;
      sitOutTransferAttempted = false;
    } else if (
      handClosed
      && !sitOutTransferAttempted
      && playerPublicKey
      && client.transferPersonalToSeat
      && stack < big
    ) {
      const personal = BigInt(Math.max(0, Math.floor(personalChips)));
      if (stack + personal >= big) {
        sitOutTransferAttempted = true;
        try {
          const next = await client.transferPersonalToSeat(
            snapshot.gameId,
            playerPublicKey,
            (big - stack).toString(),
          );
          applySnapshot(next);
          await publishSitOut(snapshot, false);
          pushEventLog('info', 'Chips moved to the seat — back in for the next hand');
        } catch (err) {
          sitOutTransferAttempted = false;
          const message = err instanceof Error ? err.message : String(err);
          pushEventLog('error', `move chips to seat failed: ${message}`);
        }
      }
    }
    if (
      optInNextHand
      && !sittingOutNextHand
      && !anySeatSittingOut(sitOutRecord)
      && zkHandFlow
      && (snapshot.phase === 'Showdown' || nextHandReadyToOpen(blindGate))
    ) {
      const flow = zkHandFlow;
      const seat = localSeat;
      void loadZkHandFlowModule().then((mod) => {
        mod.setNextHandStageEnabled(() => optInNextHand && !sittingOutNextHand);
        if (snapshot.phase === 'Showdown' && !zkBusy) {
          return mod.stageNextHandCriticalPath(flow, snapshot, seat);
        }
        return undefined;
      });
    }
    if (
      optInNextHand
      && !sittingOutNextHand
      && !anySeatSittingOut(sitOutRecord)
      && nextHandReadyToOpen(blindGate)
      && (snapshot.phase === 'Complete' || snapshot.phase === 'lobby')
      && !(uncontestedFoldFinish(snapshot) && !snapshot.handResult)
      && canStartHand
      && !handStartRequested
    ) {
      await startHand();
    }
    } finally {
      syncingNextHand = false;
    }
  }

  function applySnapshot(incoming: GameSnapshot) {
    // Solana: never let a lagging worker/HTTP response regress UI phase vs chain cursor.
    let snapshot = incoming;
    if (
      snapshot.backend === 'solana'
      && gameState
      && gameState.backend === 'solana'
      && !isChainPhaseForward(gameState.phase, snapshot.phase)
    ) {
      snapshot = mergeWorkerIntoChainSnapshot(gameState, snapshot);
    }
    if (snapshot.handNumber !== holesAckHandNumber) {
      holesAckHandNumber = snapshot.handNumber ?? null;
      holesAcked = false;
    }
    if (snapshot.phase === 'lobby' || snapshot.phase === 'Complete') {
      holesAcked = false;
    }
    if (zkHandFlow && localSeat !== null) {
      syncShareSubmittedFromSnapshot(snapshot, zkHandFlow);
      void loadZkHandFlowModule().then(({ syncShowdownSubmittedFromSnapshot }) => {
        syncShowdownSubmittedFromSnapshot(zkHandFlow!, snapshot, localSeat);
      });
    }
    ingestSnapshotEvents(snapshot);
    if (newHandDropsFaces(gameState, snapshot)) {
      lastDecryptedCards = undefined;
    }
    if (snapshot.phase !== 'Complete') {
      foldFinishKey = null;
      foldFinishError = '';
    }
    blindGate = reduceNextHandBlindGate(
      blindGate,
      snapshot.phase,
      Boolean(zkHandFlow?.showdownSubmitted)
        || Boolean(
          snapshot.zkShowdown
          && snapshot.zkShowdown.submittedCount >= snapshot.zkShowdown.requiredCount,
        ),
      snapshot.handResult?.reason === 'fold',
    );
    if (snapshot.callerPersonalEscrow !== undefined) {
      const nextPersonal = Number(snapshot.callerPersonalEscrow);
      if (Number.isFinite(nextPersonal)) personalChips = nextPersonal;
    }
    gameState = snapshot;
    gameId = snapshot.gameId;
    if (snapshot.gameKind && snapshot.gameKind !== gameKind) {
      gameKind = snapshot.gameKind;
      saveUiGameKind(snapshot.gameKind);
    }
    if (snapshot.zkReveal?.entries.length) {
      partialStore.merge(snapshot.zkReveal);
      partialCount = partialStore.entryCount();
    }
    // Paint phase/street immediately from the event. Reuse last faces so a
    // street/showdown snapshot does not flash the board back to card backs.
    paintTableView(snapshot, lastDecryptedCards, handResultView);
    syncLocalSeatFromState();
    if (
      snapshot.phase === 'Register'
      || snapshot.phase === 'Shuffle'
      || snapshot.phase === 'Share'
    ) {
      pinE2eLocalSeatIfNeeded(snapshot);
    }
    updateZkStatus(snapshot);
    // Register/Shuffle/Share must not wait on decrypt/partials (those can await
    // Poker.init and starve prove for minutes with no Event log).
    if (
      snapshot.phase === 'Register'
      || snapshot.phase === 'Shuffle'
      || snapshot.phase === 'Share'
      || snapshot.phase === 'Showdown'
    ) {
      void runZkHandIfMyTurn(snapshot);
    }
    reportUi(snapshot, 'phase');
    void (async () => {
      // Pay the fold and stage the next shuffle before the next hand can open.
      await finishUncontestedFold(snapshot);
      // Ack / auto-bet / street advance must not wait on decrypt. After Share,
      // dual WKWebView Poker.init can hang for minutes — the acting seat then
      // never call/checks, and the peer sits forever waiting for their turn.
      await maybeAcknowledgeHoleCards(snapshot);
      await maybeAutoBet(snapshot);
      await maybeAutoAdvanceStreet(snapshot);
      if (nativeDecryptDeferred(snapshot)) {
        scheduleDeferredDecrypt();
      } else {
        await syncPartials(snapshot);
        await refreshHandResultView(snapshot);
        await refreshViewWithDecryption();
      }
      updateZkStatus(gameState ?? snapshot);
      void runZkHandIfMyTurn(gameState ?? snapshot);
      const current = gameState ?? snapshot;
      await maybeAcknowledgeHoleCards(current);
      await maybeAutoBet(gameState ?? current);
      await maybeAutoAdvanceStreet(gameState ?? current);
      reportUi(current, 'phase');
      void syncNextHand(current);
      if (current.phase === 'Complete' && current.handResult) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const { reportE2eRenderSnapshot } = await import('./poker/e2e-render-report');
        await reportE2eRenderSnapshot(localSeat);
        reportUi(current, 'phase');
      }
    })();
  }

  async function pollZkHandState(): Promise<void> {
    if (!gameId || !tableConnected) {
      return;
    }
    const e2eAuto =
      typeof window !== 'undefined'
      && (
        nativeAutoPlay
        || new URLSearchParams(window.location.search).get('e2eAutoPlay') === '1'
        || new URLSearchParams(window.location.search).get('nativeE2e') === '1'
      );
    const bridgeReady =
      zkBridgeOk
      || (e2eAuto && typeof window !== 'undefined' && typeof (window as any).zero?.invoke === 'function');
    if (!bridgeReady) {
      return;
    }
    const phase = gameState?.phase;
    const zkHandActive = Boolean(gameState?.handNumber && gameState?.zkCrypto);
    // Keep polling at Complete until fetched partials decrypt into faces —
    // otherwise a single failed decrypt leaves permanent 1F0A0 backs.
    const completeNeedsDecryptRetry = phase === 'Complete'
      && Boolean(gameState?.zkCrypto || gameState?.zkReveal)
      && !completeFacesReady;
    // Solana: orchestrator may beginHand via CLI while this client is still
    // `lobby` (missed HandStarted websocket). Poll enriched getGame so we
    // discover Register from shared-hand meta and start registerProve.
    const solanaLobbyNeedsHandPoll = onChain()
      && (phase === 'lobby' || phase === undefined || phase === null);
    // Native E2E auto-bet: keep polling betting streets even when zkCrypto is
    // briefly missing — otherwise PreFlop stalls with currentPlayerSeat set.
    const bettingStreetNeedsPoll = e2eAuto
      && ['PreFlop', 'Flop', 'Turn', 'River', 'Evaluation', 'Showdown'].includes(String(phase));
    const showdownNeedsDecryptRetry = phase === 'Showdown'
      && Boolean(gameState?.zkCrypto || gameState?.zkReveal)
      && (!lastDecryptedCards || lastDecryptedCards.size === 0);
    if (
      phase === 'Complete'
      && gameState
      && uncontestedFoldFinish(gameState)
      && foldFinishKey !== foldFinishToken(gameState)
    ) {
      void finishUncontestedFold(gameState);
    }
    if (
      !phase
      || (phase === 'lobby' && !solanaLobbyNeedsHandPoll)
      || (phase === 'Complete' && !completeNeedsDecryptRetry)
      || (!isActiveZkPhase(phase) && !zkHandActive && !completeNeedsDecryptRetry
        && !showdownNeedsDecryptRetry
        && !solanaLobbyNeedsHandPoll && !bettingStreetNeedsPoll)
    ) {
      return;
    }
    try {
      let snapshot = await client.getGame(gameId);
      if (zkBusy) {
        // Keep snapshot fresh while a long native prove runs (still chain-gated).
        if (
          snapshot.backend === 'solana'
          && gameState
          && gameState.backend === 'solana'
          && !isChainPhaseForward(gameState.phase, snapshot.phase)
        ) {
          snapshot = mergeWorkerIntoChainSnapshot(gameState, snapshot);
        }
        ingestSnapshotEvents(snapshot);
        gameState = snapshot;
        gameId = snapshot.gameId;
        void maybeExpireBettingTurn(snapshot);
        paintTableView(snapshot, lastDecryptedCards, handResultView);
        syncLocalSeatFromState();
        updateZkStatus(snapshot);
        if (zkHandFlow && localSeat !== null) {
          syncShareSubmittedFromSnapshot(snapshot, zkHandFlow);
          const { syncShowdownSubmittedFromSnapshot } = await loadZkHandFlowModule();
          syncShowdownSubmittedFromSnapshot(zkHandFlow, snapshot, localSeat);
        }
        reportUi(snapshot, 'phase');
        void (async () => {
          await maybeAcknowledgeHoleCards(snapshot);
          await maybeAutoBet(snapshot);
          await maybeAutoAdvanceStreet(snapshot);
          if (nativeDecryptDeferred(snapshot)) {
            scheduleDeferredDecrypt();
            return;
          }
          await syncPartials(snapshot);
          await refreshHandResultView(snapshot);
          await refreshViewWithDecryption();
        })();
        return;
      }
      applySnapshot(snapshot);
      void maybeExpireBettingTurn(snapshot);
      // A raw table read is `lobby` even while a hand is still open. Only an
      // explicit e2eStartHand launch may deal; the Start button is the manual path.
      const explicitStart = new URLSearchParams(window.location.search).get('e2eStartHand') === '1';
      if (
        explicitStart
        && e2eAuto
        && localSeat === 0
        && (snapshot.phase === 'lobby' || snapshot.phase == null)
        && (snapshot.seats?.length ?? 0) >= 2
        && !handStartRequested
      ) {
        handStartRequested = true;
        void startHand();
      }
    } catch {
      // Ignore transient poll failures during native E2E.
    }
  }

  function stopZkPollTimer(): void {
    if (zkPollTimer) {
      clearInterval(zkPollTimer);
      zkPollTimer = null;
    }
  }

  function stopBridgeProbeTimer(): void {
    if (bridgeProbeTimer) {
      clearInterval(bridgeProbeTimer);
      bridgeProbeTimer = null;
    }
    waitingForBridge = false;
  }

  function ensureZkPollTimer(): void {
    if (zkPollTimer || !tableConnected || !gameId) {
      return;
    }
    zkPollTimer = setInterval(() => {
      void pollZkHandState();
    }, 1500);
  }

  async function sharePartialEntriesForStreet(
    snapshot: GameSnapshot,
    viewerIndex: number,
  ): Promise<import('./backend/client').ZkRevealSnapshot['entries']> {
    if (snapshot.backend !== 'solana') {
      return [];
    }
    try {
      const { holeCardIndices, visibleDealIndicesForViewerPhase } = await import('@poker-src/backend/card-layout');
      const {
        refreshShareCiphertexts,
        entriesFromPersistedShareCiphertexts,
      } = await import('@poker-src/chain/share-ciphertexts-meta');
      const numPlayers = snapshot.zkCrypto?.handNumPlayers
        ?? snapshot.actionOrder?.length
        ?? snapshot.seats.filter((seat) => seat.playerIndex !== undefined).length
        ?? 2;
      await refreshShareCiphertexts(numPlayers);
      const requested = snapshot.handResult?.reason === 'fold'
        ? [
            ...new Set([
              ...holeCardIndices(viewerIndex),
              ...(snapshot.zkReveal?.revealedCardIndices ?? snapshot.handResult.boardCards ?? [])
                .filter((index) => index >= 20 && index <= 24),
            ]),
          ]
        : visibleDealIndicesForViewerPhase(snapshot.phase, viewerIndex, numPlayers);
      const cardIndices = requested.filter((index) => {
        if (index >= 20) return true;
        const owner = Math.floor(index / 2);
        if (owner === viewerIndex) return true;
        const seat = snapshot.seats.find((entry) => entry.playerIndex === owner);
        return !seat?.folded;
      });
      return entriesFromPersistedShareCiphertexts({
        viewerPlayerIndex: viewerIndex,
        numPlayers,
        cardIndices,
      });
    } catch {
      return [];
    }
  }

  async function syncPartials(snapshot: GameSnapshot) {
    if (snapshot.phase === 'lobby') {
      partialStore.clear();
      partialCount = 0;
      return;
    }
    if (snapshot.phase === 'Register') {
      partialStore.clear();
      partialCount = 0;
    }
    if (!gameId || localSeat === null) {
      partialCount = partialStore.entryCount();
      return;
    }
    // Soft Complete may embed reveal entries in the snapshot after endHand.
    if (
      (snapshot.phase === 'Complete' || snapshot.phase === 'Showdown')
      && (snapshot.zkReveal?.entries.length ?? 0) > 0
      && partialStore.entryCount() === 0
    ) {
      partialStore.merge(snapshot.zkReveal);
      partialCount = partialStore.entryCount();
    }
    const viewerIndex = snapshot.playerIndexBySeat?.[localSeat]
      ?? snapshot.handResult?.seatHands.find((seat) => seat.seat === localSeat)?.playerIndex
      ?? snapshot.seats.find((seat) => seat.seat === localSeat)?.playerIndex;
    try {
      const reveal = await client.fetchRevealedPartials(gameId, localSeat);
      const includeAllPartials = snapshot.handResult?.reason === 'fold'
        ? false
        : snapshot.phase === 'Showdown'
          || snapshot.phase === 'Complete'
          || snapshot.zkReveal?.allPartialsPublic === true;
      let entries = includeAllPartials || viewerIndex === undefined
        ? reveal.entries
        : reveal.entries.filter(
            (entry) => entry.toPlayerIndex === viewerIndex && entry.fromPlayerIndex !== viewerIndex,
          );
      // Streets often have no RevealedCard PDAs yet — fill any missing deal
      // indices from share matrices (do not wait for an empty PDA fetch;
      // hole-only PDAs would otherwise drop the board at Showdown).
      if (viewerIndex !== undefined) {
        const fromShare = await sharePartialEntriesForStreet(snapshot, viewerIndex);
        if (fromShare.length > 0) {
          const have = new Set(entries.map((entry) => entry.cardIndex));
          entries = [
            ...entries,
            ...fromShare.filter((entry) => !have.has(entry.cardIndex)),
          ];
        }
      }
      // Replace only after a successful fetch so a concurrent Complete refresh
      // cannot observe an empty store mid-sync.
      partialStore.clear();
      partialStore.merge({ ...reveal, entries });
      partialCount = partialStore.entryCount();
    } catch {
      if (viewerIndex !== undefined) {
        const fromShare = await sharePartialEntriesForStreet(snapshot, viewerIndex);
        if (fromShare.length > 0) {
          partialStore.clear();
          partialStore.merge({ ...snapshot.zkReveal, entries: fromShare });
        }
      }
      partialCount = partialStore.entryCount();
    }
  }

  function expectedElGamalPublicKey(
    snapshot: GameSnapshot,
    seat: number,
  ): import('@poker-src/zk-casino').PublicKey | null {
    const playerIndex = snapshot.playerIndexBySeat?.[seat]
      ?? snapshot.handResult?.seatHands.find((entry) => entry.seat === seat)?.playerIndex
      ?? snapshot.seats.find((entry) => entry.seat === seat)?.playerIndex;
    if (playerIndex === undefined) {
      return null;
    }
    const key = snapshot.zk?.elGamalPublicKeys[playerIndex]
      ?? snapshot.zkCrypto?.elGamalPublicKeys?.[playerIndex];
    if (!key) {
      return null;
    }
    return [BigInt(key[0]), BigInt(key[1])];
  }

  async function ensureZkHandFlowForResult(
    handNumber: number,
    expectedPublicKey: import('@poker-src/zk-casino').PublicKey | null = null,
  ): Promise<ZkHandFlowState | null> {
    const { createFreshZkHandFlow, ensurePlayerKeyForHand } = await loadZkHandFlowModule();
    if (localSeat === null) {
      return null;
    }
    const keyMatches = (pk: import('@poker-src/zk-casino').PublicKey) =>
      Boolean(
        expectedPublicKey
        && pk[0] === expectedPublicKey[0]
        && pk[1] === expectedPublicKey[1],
      );

    if (zkHandFlowNumber !== handNumber || !zkHandFlow) {
      // Restore the registered ElGamal key (sessionStorage) — never mint a
      // fresh key here or Complete-phase decryption will silently yield backs.
      zkHandFlow = await createFreshZkHandFlow(handNumber, expectedPublicKey, {
        seat: localSeat,
      });
      zkHandFlowNumber = handNumber;
    } else if (expectedPublicKey && !keyMatches(zkHandFlow.player.publicKey)) {
      // Flow survived from an earlier failed restore — reload the registered key.
      const restored = await ensurePlayerKeyForHand(
        zkHandFlow.player,
        handNumber,
        expectedPublicKey,
        { seat: localSeat },
      );
      if (!restored) {
        zkHandFlow = await createFreshZkHandFlow(handNumber, expectedPublicKey, {
          seat: localSeat,
        });
        zkHandFlowNumber = handNumber;
      }
    }

    // Refuse to decrypt with a mismatched key (would return empty map → backs).
    if (expectedPublicKey && zkHandFlow && !keyMatches(zkHandFlow.player.publicKey)) {
      return null;
    }
    return zkHandFlow;
  }

  function expectedKeyForHandResult(
    snapshot: GameSnapshot | null,
    result: NonNullable<GameSnapshot['handResult'] | GameSnapshot['pendingHandResult']>,
  ): import('@poker-src/zk-casino').PublicKey | null {
    if (localSeat === null) {
      return null;
    }
    const fromZk = snapshot ? expectedElGamalPublicKey(snapshot, localSeat) : null;
    if (fromZk) {
      return fromZk;
    }
    const playerIndex = result.seatHands.find((seat) => seat.seat === localSeat)?.playerIndex;
    const key = playerIndex !== undefined
      ? snapshot?.zkCrypto?.elGamalPublicKeys?.[playerIndex]
      : undefined;
    if (!key) {
      return null;
    }
    return [BigInt(key[0]), BigInt(key[1])];
  }

  async function decryptCardsForHandResult(
    result: NonNullable<GameSnapshot['handResult'] | GameSnapshot['pendingHandResult']>,
    snapshot: GameSnapshot | null = gameState,
  ): Promise<Map<number, number> | undefined> {
    if (!result.zkFinalDeck || localSeat === null || partialStore.entryCount() === 0) {
      return undefined;
    }
    const seatHand = result.seatHands.find((seat) => seat.seat === localSeat);
    const expectedKey = expectedKeyForHandResult(snapshot, result);
    const flow = await ensureZkHandFlowForResult(result.handNumber, expectedKey);
    if (!flow || !seatHand || seatHand.playerIndex === undefined) {
      return undefined;
    }
    try {
      const { decryptDealCards } = await import('./poker/decrypt-deal-cards');
      const handNumPlayers = result.handNumPlayers
        ?? snapshot?.zkCrypto?.handNumPlayers
        ?? result.seatHands.length;
      const foldBoard = result.reason === 'fold'
        ? result.boardCards.filter((index) => index >= 20 && index <= 24)
        : null;
      const decrypted = await decryptDealCards({
        zkCrypto: {
          handNumPlayers,
          elGamalPublicKeys: snapshot?.zkCrypto?.elGamalPublicKeys ?? [],
          finalDeck: result.zkFinalDeck,
          dealCardCount: snapshot?.zkCrypto?.dealCardCount ?? result.zkFinalDeck.length,
        },
        partialEntries: partialStore.entries,
        privateKey: flow.player.elGamalPrivateKey,
        viewerPlayerIndex: seatHand.playerIndex,
        onlyDealIndices: foldBoard
          ? [...seatHand.holeCards, ...foldBoard]
          : undefined,
      });
      // Empty map means wrong key / incomplete partials — treat as failure so UI retries.
      return decrypted.size > 0 ? decrypted : undefined;
    } catch {
      return undefined;
    }
  }

  async function buildHandResultViewForSnapshot(
    snapshot: GameSnapshot,
    result: GameSnapshot['handResult'] | GameSnapshot['pendingHandResult'],
  ): Promise<HandResultView | null> {
    if (!result) {
      return null;
    }
    const resultDecryption = await decryptCardsForHandResult(result, snapshot);
    return buildHandResultView(result, resultDecryption);
  }

  async function refreshHandResultView(snapshot: GameSnapshot) {
    if (snapshot.handResult) {
      provisionalHandResult = null;
      const next = await buildHandResultViewForSnapshot(snapshot, snapshot.handResult);
      if (next) {
        handResultView = next;
      }
      return;
    }
    if (snapshot.phase === 'Showdown') {
      const decrypted = await resolveDecryptedCards(snapshot);
      const provisional = decrypted
        ? buildProvisionalShowdownResult(snapshot, decrypted)
        : null;
      provisionalHandResult = provisional;
      if (provisional?.potResults.length) {
        handResultView = buildHandResultView(provisional, decrypted);
        return;
      }
      if (snapshot.pendingHandResult?.potResults.length) {
        handResultView = await buildHandResultViewForSnapshot(snapshot, snapshot.pendingHandResult);
        return;
      }
    } else {
      provisionalHandResult = null;
    }
    if (snapshot.phase === 'Complete') {
      return;
    }
    handResultView = null;
  }

  async function decryptShowdownRankingCards(
    snapshot: GameSnapshot,
  ): Promise<Map<number, number> | undefined> {
    if (localSeat === null || !snapshot.zkCrypto) {
      return lastDecryptedCards;
    }
    const viewerPlayerIndex = snapshot.playerIndexBySeat?.[localSeat]
      ?? snapshot.seats.find((seat) => seat.seat === localSeat)?.playerIndex;
    if (viewerPlayerIndex === undefined) {
      return lastDecryptedCards;
    }
    const numPlayers = snapshot.zkCrypto.handNumPlayers
      ?? snapshot.actionOrder?.length
      ?? snapshot.seats.filter((seat) => seat.playerIndex !== undefined).length
      ?? 2;
    const { visibleDealIndicesForViewerPhase } = await import('@poker-src/backend/card-layout');
    const onlyDealIndices = visibleDealIndicesForViewerPhase('Showdown', viewerPlayerIndex, numPlayers)
      .filter((index) => {
        if (index >= 20) return true;
        const owner = Math.floor(index / 2);
        if (owner === viewerPlayerIndex) return true;
        const seat = snapshot.seats.find((entry) => entry.playerIndex === owner);
        return !seat?.folded;
      });
    if (
      lastDecryptedCards
      && onlyDealIndices.length > 0
      && onlyDealIndices.every((dealIndex) => lastDecryptedCards!.has(dealIndex))
    ) {
      return lastDecryptedCards;
    }
    await syncPartials(snapshot);
    if (partialStore.entryCount() === 0) {
      return lastDecryptedCards;
    }
    const flow = await ensureZkHandFlow(snapshot);
    if (!flow) {
      return lastDecryptedCards;
    }
    try {
      const { decryptDealCards } = await import('./poker/decrypt-deal-cards');
      const decrypted = await decryptDealCards({
        zkCrypto: snapshot.zkCrypto,
        partialEntries: partialStore.entries,
        privateKey: flow.player.elGamalPrivateKey,
        viewerPlayerIndex,
        onlyDealIndices,
      });
      if (decrypted.size > 0) {
        return mergeDecryptedCardMaps(lastDecryptedCards, decrypted);
      }
    } catch {
      // Opponent holes stay sealed until share partials are public.
    }
    return lastDecryptedCards;
  }

  async function resolveDecryptedCards(snapshot: GameSnapshot | null): Promise<Map<number, number> | undefined> {
    if (!snapshot) {
      return undefined;
    }
    if (snapshot.e2eDealValues) {
      return new Map(
        Object.entries(snapshot.e2eDealValues).map(([dealIndex, cardValue]) => [
          Number(dealIndex),
          Number(cardValue),
        ]),
      );
    }
    if (snapshot.phase === 'Showdown') {
      const ranked = await decryptShowdownRankingCards(snapshot);
      if (ranked && ranked.size > 0) {
        return ranked;
      }
    }
    if (!nativeDecryptPaintable(snapshot)) {
      return lastDecryptedCards;
    }
    if (!shouldRunNativeDecryptWasm(nativeDecryptOptions(snapshot))) {
      return lastDecryptedCards;
    }
    if (snapshot.phase === 'Complete' && snapshot.handResult) {
      return decryptCardsForHandResult(snapshot.handResult, snapshot);
    }
    if (
      (snapshot.phase === 'Showdown' || snapshot.zkReveal?.allPartialsPublic === true)
      && snapshot.zkCrypto
      && snapshot.playerIndexBySeat
      && localSeat !== null
      && partialStore.entryCount() > 0
    ) {
      const viewerPlayerIndex = snapshot.playerIndexBySeat[localSeat];
      if (viewerPlayerIndex !== undefined) {
        const flow = await ensureZkHandFlow(snapshot);
        if (flow) {
          try {
            const { decryptDealCards } = await import('./poker/decrypt-deal-cards');
            const decrypted = await decryptDealCards({
              zkCrypto: snapshot.zkCrypto,
              partialEntries: partialStore.entries,
              privateKey: flow.player.elGamalPrivateKey,
              viewerPlayerIndex,
            });
            if (decrypted.size > 0) {
              return mergeDecryptedCardMaps(lastDecryptedCards, decrypted);
            }
          } catch {
            // Decryption may fail until ZK runtime is ready.
          }
        }
      }
    }
    if (
      snapshot.zkCrypto
      && snapshot.playerIndexBySeat
      && localSeat !== null
      && partialStore.entryCount() > 0
    ) {
      const viewerPlayerIndex = snapshot.playerIndexBySeat[localSeat];
      if (viewerPlayerIndex !== undefined) {
        const flow = await ensureZkHandFlow(snapshot);
        if (flow) {
          try {
            const { decryptDealCards } = await import('./poker/decrypt-deal-cards');
            const viewerHoles = snapshot.holeCards?.[localSeat]
              ?? (viewerPlayerIndex !== undefined
                ? [viewerPlayerIndex * 2, viewerPlayerIndex * 2 + 1]
                : []);
            const onlyDealIndices = [
              ...streetBoardDealIndices(snapshot),
              ...viewerHoles,
            ];
            const decrypted = await decryptDealCards({
              zkCrypto: snapshot.zkCrypto,
              partialEntries: partialStore.entries,
              privateKey: flow.player.elGamalPrivateKey,
              viewerPlayerIndex,
              onlyDealIndices: onlyDealIndices.length > 0 ? onlyDealIndices : undefined,
            });
            if (decrypted.size > 0) {
              return mergeDecryptedCardMaps(lastDecryptedCards, decrypted);
            }
          } catch {
            // Decryption may fail until ZK runtime is ready.
          }
        }
      }
    }
    return undefined;
  }

  function streetBoardDealIndices(snapshot: GameSnapshot): number[] {
    if (snapshot.handResult?.reason === 'fold') {
      const source = snapshot.zkReveal?.revealedCardIndices ?? snapshot.handResult.boardCards ?? [];
      return source.filter((index) => index >= 20 && index <= 24);
    }
    switch (snapshot.phase) {
      case 'Flop':
        return [20, 21, 22];
      case 'Turn':
        return [20, 21, 22, 23];
      case 'River':
      case 'Showdown':
      case 'Complete':
        return [20, 21, 22, 23, 24];
      default:
        return [];
    }
  }

  function needsDecryptResync(
    snapshot: GameSnapshot,
    decrypted: Map<number, number> | undefined,
  ): boolean {
    if (!usesZkCardDecryption(snapshot) || !snapshot.zkReveal) {
      return false;
    }
    if (snapshot.phase === 'Complete' || snapshot.phase === 'Showdown') {
      return !decrypted || decrypted.size === 0;
    }
    // Street advance unlocks board 20–22 / +23 / +24 — re-fetch if those faces are missing.
    const boardNeeded = streetBoardDealIndices(snapshot);
    if (boardNeeded.length > 0) {
      return boardNeeded.some((dealIndex) => !decrypted?.has(dealIndex));
    }
    // PreFlop: local holes should decrypt after unlock.
    if (
      snapshot.phase === 'PreFlop'
      && snapshot.zkReveal.holePartialsUnlocked
      && localSeat !== null
    ) {
      const hole = snapshot.holeCards?.[localSeat];
      if (!hole) {
        return !decrypted || decrypted.size === 0;
      }
      return hole.some((dealIndex) => !decrypted?.has(dealIndex));
    }
    return false;
  }

  async function refreshViewWithDecryption() {
    syncLocalSeatFromState();
    let decryptedCards = await resolveDecryptedCards(gameState);
    // Partials may have been fetched while the ElGamal key was wrong / store empty,
    // or before street unlock added board indices. Re-sync then decrypt again.
    if (gameState && needsDecryptResync(gameState, decryptedCards)) {
      await syncPartials(gameState);
      decryptedCards = await resolveDecryptedCards(gameState);
    }
    let resultView = handResultView;
    if (gameState?.phase === 'Complete' && gameState.handResult) {
      resultView = await buildHandResultViewForSnapshot(gameState, gameState.handResult);
      handResultView = resultView;
    } else if (gameState?.phase === 'Showdown') {
      resultView = handResultView;
    }
    if (decryptedCards && decryptedCards.size > 0) {
      lastDecryptedCards = mergeDecryptedCardMaps(lastDecryptedCards, decryptedCards);
      decryptedCards = lastDecryptedCards;
    }
    paintTableView(gameState, decryptedCards ?? lastDecryptedCards, resultView);
    if (gameState?.phase === 'Complete') {
      if (!usesZkCardDecryption(gameState)) {
        completeFacesReady = true;
      } else {
        const holeSeats = gameState.seats
          .filter((seat) => !seat.folded)
          .map((seat) => seat.seat);
        completeFacesReady = tableShowsDecryptedFaces(view, { holeSeats });
      }
    } else {
      completeFacesReady = false;
    }
    if (gameState) {
      updateZkStatus(gameState);
      await maybeAcknowledgeHoleCards(gameState);
    }
  }

  /** Single-flight: concurrent Register polls must not mint two different ElGamal keys. */
  let ensureZkHandFlowInflight: Promise<ZkHandFlowState | null> | null = null;
  let ensureZkHandFlowInflightHand: number | null = null;

  async function ensureZkHandFlow(snapshot: GameSnapshot): Promise<ZkHandFlowState | null> {
    const {
      isHandFlowPhase,
      createFreshZkHandFlow,
      syncRegisteredKeyFromSnapshot,
    } = await loadZkHandFlowModule();
    // Chain PhaseAdvanced often sets phase=Register without handNumber/zk materials.
    // Per-seat Solana still needs a flow so registerProve can run after the next getGame.
    const handNumber = snapshot.handNumber
      ?? (isHandFlowPhase(snapshot.phase) ? 1 : null);
    if (!handNumber || localSeat === null || !isHandFlowPhase(snapshot.phase)) {
      return null;
    }
    if (zkHandFlowNumber === handNumber && zkHandFlow) {
      const expected = expectedElGamalPublicKey(snapshot, localSeat);
      if (expected) {
        await syncRegisteredKeyFromSnapshot(zkHandFlow, snapshot, localSeat);
      }
      return zkHandFlow;
    }
    if (ensureZkHandFlowInflight && ensureZkHandFlowInflightHand === handNumber) {
      return ensureZkHandFlowInflight;
    }
    ensureZkHandFlowInflightHand = handNumber;
    ensureZkHandFlowInflight = (async () => {
      try {
        const expected = expectedElGamalPublicKey(snapshot, localSeat);
        logBridge(`ensureZkHandFlow: creating flow hand=${handNumber} seat=${localSeat}`);
        zkHandFlow = await createFreshZkHandFlow(handNumber, expected, {
          seat: localSeat,
        });
        zkHandFlowNumber = handNumber;
        logBridge(`ensureZkHandFlow: ready hand=${handNumber}`);
        return zkHandFlow;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logBridge(`ensureZkHandFlow: FAILED ${message}`);
        pushEventLog('error', `ZK hand setup: ${message}`);
        zkStatus = message;
        return null;
      } finally {
        ensureZkHandFlowInflight = null;
        ensureZkHandFlowInflightHand = null;
      }
    })();
    return ensureZkHandFlowInflight;
  }

  function syncShareSubmittedFromSnapshot(snapshot: GameSnapshot, flow: ZkHandFlowState) {
    if (localSeat === null) {
      return;
    }
    const playerIndex = snapshot.playerIndexBySeat?.[localSeat];
    if (playerIndex === undefined) {
      return;
    }
    if (snapshot.phase !== 'Share') {
      flow.shareSubmitted = false;
      return;
    }
    if (snapshot.zk?.hasSharedPartial?.[playerIndex] === true) {
      flow.shareSubmitted = true;
    }
  }

  let lastRegisterGateLogAt = 0;
  let registerBusySince: number | null = null;

  let lastRegisterTurnLogAt = 0;
  let lastShuffleSkipLogAt = 0;

  function pinE2eLocalSeatIfNeeded(snapshot?: GameSnapshot): void {
    if (localSeat !== null || typeof window === 'undefined') {
      return;
    }
    const raw = new URLSearchParams(window.location.search).get('e2eSeat')
      ?? new URLSearchParams(window.location.search).get('seat');
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 9) {
      return;
    }
    // Prefer storage (post e2e-wallet hydrate) over a stale onMount pubkey.
    const pk = getOrCreateLocalPublicKey() || playerPublicKey;
    if (pk && pk !== playerPublicKey) {
      playerPublicKey = pk;
    }
    const snap = snapshot ?? gameState;
    const mine = snap?.seats?.find((s) => s.seat === n && s.publicKey === pk);
    if (mine) {
      localSeat = n;
      pushEventLog('info', `Pinned localSeat=${n} (pubkey matches table)`);
      return;
    }
    // Native E2E: pin URL seat so Register is not stuck on noSeat when seat
    // sync lags (hydrate/join race). Reject only on hard pubkey mismatch.
    const autoPlay = new URLSearchParams(window.location.search).get('e2eAutoPlay') === '1';
    const occupant = snap?.seats?.find((s) => s.seat === n);
    if (autoPlay && (!occupant || !pk || occupant.publicKey === pk)) {
      localSeat = n;
      pushEventLog('info', `Pinned localSeat=${n} (e2eAutoPlay)`);
    }
  }

  async function runZkHandIfMyTurn(snapshot: GameSnapshot) {
    if (isIosE2eFullGameHarness()) {
      return;
    }
    const kind = snapshot.gameKind ?? gameKind;
    if (kind === 'war' || kind === 'baccarat') {
      // Groth16+Arcis for these games runs in Bun startHand (host / per-seat).
      // A 6-deck shuffle must not start inside WKWebView.
      return;
    }
    if (kind !== 'poker') {
      return;
    }
    // Native E2E: never stall Register because seat sync lagged behind PhaseAdvanced.
    // Register / Shuffle / Share / Showdown always run in-app via the ZK bridge
    // (host Bun may seat/orchestrate streets, but must not skip in-app shuffle).
    if (
      snapshot.phase === 'Register'
      || snapshot.phase === 'Shuffle'
      || snapshot.phase === 'Share'
    ) {
      pinE2eLocalSeatIfNeeded(snapshot);
      if (
        !zkBridgeOk
        && typeof window !== 'undefined'
        && typeof (window as any).zero?.invoke === 'function'
      ) {
        zkBridgeOk = true;
      }
      if (
        !nativeAutoPlay
        && typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('e2eAutoPlay') === '1'
      ) {
        nativeAutoPlay = true;
      }
    }
    const bridgeReady =
      zkBridgeOk
      || (typeof window !== 'undefined' && typeof (window as any).zero?.invoke === 'function')
      || (nativeAutoPlay && typeof window !== 'undefined' && typeof (window as any).zero?.invoke === 'function');
    const e2eVisualShowdown =
      snapshot.phase === 'Showdown' && Boolean(snapshot.e2eDealValues);
    if (
      zkHandLock > 0
      || zkBusy
      || (backendKind !== 'local' && !onChain())
      || (!bridgeReady && !e2eVisualShowdown)
      || !gameId
      || localSeat === null
      || !tableConnected
    ) {
      if (snapshot.phase === 'Register') {
        const now = Date.now();
        const inFlight = zkBusy || zkHandLock > 0;
        // In-flight prove/submit is expected — do not spam "blocked" or reconnect.
        if (inFlight) {
          if (registerBusySince === null) {
            registerBusySince = now;
          } else if (now - registerBusySince > 240_000) {
            // register_main on macOS is often 70–140s; 30s clears aborted live proves
            // and spawned duplicate register_main (ProveBusy / registeredCount stuck).
            pushEventLog('error', 'Register: clearing stuck zkBusy/lock after 240s');
            zkBusy = false;
            zkHandLock = 0;
            registerBusySince = null;
          }
          return;
        }
        registerBusySince = null;
        if (now - lastRegisterGateLogAt > 3_000) {
          lastRegisterGateLogAt = now;
          const reasons: string[] = [];
          if (backendKind !== 'local' && !onChain()) {
            reasons.push(`backend=${backendKind}`);
          }
          if (!bridgeReady) reasons.push('noBridge');
          if (!gameId) reasons.push('noGameId');
          if (localSeat === null) reasons.push('noSeat');
          if (!tableConnected) reasons.push('noTable');
          if (reasons.length > 0) {
            pushEventLog('error', `Register blocked: ${reasons.join(',')}`);
          }
        }
        if (!tableConnected && onChain()) {
          void connectToTable().then((ok) => {
            if (ok && gameState?.phase === 'Register') {
              void runZkHandIfMyTurn(gameState);
            }
          });
        }
      }
      return;
    }
    registerBusySince = null;
    if (!isActiveZkPhase(snapshot.phase)) {
      return;
    }
    // Dual-mac Register: seat N>0 waits for a peer key before starting the
    // native player flow so both WebViews do not prove register at once.
    if (
      snapshot.phase === 'Register'
      && localSeat !== null
      && localSeat > 0
      && !(snapshot.zk?.elGamalPublicKeys ?? []).some(Boolean)
    ) {
      if (Date.now() - lastRegisterGateLogAt > 3_000) {
        lastRegisterGateLogAt = Date.now();
        pushEventLog('info', `Register: seat ${localSeat} waiting for peer key before Poker.init`);
      }
      setTimeout(() => {
        const latest = gameState;
        if (latest?.phase === 'Register') {
          void runZkHandIfMyTurn(latest);
        }
      }, 2000);
      return;
    }

    // Rank the showdown before anyone proves. A PhaseAdvanced snapshot often
    // has no pot winner, so the small blind used to take the Groth16 lock
    // (or nobody did, because zkShowdown.requested was missing). Limited
    // hole+board decrypt names the winner; only that seat continues.
    if (snapshot.phase === 'Showdown') {
      if (showdownPrep) {
        return;
      }
      showdownPrep = true;
      let proveThisSeat = false;
      try {
        let active = snapshot;
        try {
          let refreshed = await client.getGame(gameId);
          if (
            gameState
            && gameState.backend === 'solana'
            && refreshed.backend === 'solana'
            && !isChainPhaseForward(gameState.phase, refreshed.phase)
          ) {
            refreshed = mergeWorkerIntoChainSnapshot(gameState, refreshed);
          }
          if (refreshed.phase === 'Showdown' || refreshed.phase === 'Complete') {
            active = refreshed;
            ingestSnapshotEvents(active);
            gameState = active;
            syncLocalSeatFromState();
            updateZkStatus(active);
          }
        } catch {
          active = snapshot;
        }
        if (!zkHandFlow && active.phase === 'Showdown') {
          await ensureZkHandFlow(active);
        }
        const winnerNamed = Boolean(
          provisionalHandResult?.potResults.some((pot) => pot.winnerSeats.length > 0),
        );
        if (active.phase === 'Showdown' && !winnerNamed) {
          await refreshHandResultView(active);
        }
        const { isMyShowdownTurn } = await loadZkHandFlowModule();
        proveThisSeat = isMyShowdownTurn(
          active,
          localSeat,
          zkHandFlow ?? undefined,
          provisionalHandResult,
        );
        if (!proveThisSeat) {
          const ranked = Boolean(
            provisionalHandResult?.potResults.some((pot) => pot.winnerSeats.length > 0),
          );
          if (!ranked) {
            setTimeout(() => {
              const latest = gameState;
              if (latest?.phase === 'Showdown') {
                void runZkHandIfMyTurn(latest);
              }
            }, 1500);
          }
          return;
        }
        snapshot = gameState ?? active;
      } catch {
        proveThisSeat = false;
        return;
      } finally {
        if (!proveThisSeat) {
          showdownPrep = false;
        }
      }
    }

    // Take the lock BEFORE ensureZkHandFlow / getGame — concurrent Register polls
    // otherwise each mint a register_main prove (3× proves, one on-chain key).
    if (zkHandLock > 0 || zkBusy) {
      showdownPrep = false;
      return;
    }
    const lock = ++zkHandLock;
    showdownPrep = false;
    zkBusy = true;
    if (snapshot.phase === 'Showdown' && gameId && localSeat !== null && client.settleUncontestedFold) {
      try {
        const settled = await client.settleUncontestedFold(gameId, localSeat);
        if (settled === 'wait') {
          if (lock === zkHandLock) {
            zkHandLock = 0;
            zkBusy = false;
            registerBusySince = null;
          }
          setTimeout(() => {
            const latest = gameState;
            if (latest?.phase === 'Showdown') void runZkHandIfMyTurn(latest);
          }, 1000);
          return;
        }
        if (settled) {
          pushEventLog('action', 'Last player wins the pot');
          applySnapshot(settled);
          if (lock === zkHandLock) {
            zkHandLock = 0;
            zkBusy = false;
            registerBusySince = null;
          }
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushEventLog('error', message);
        if (lock === zkHandLock) {
          zkHandLock = 0;
          zkBusy = false;
          registerBusySince = null;
        }
        return;
      }
    }
    if (snapshot.phase === 'Register') {
      registerBusySince = Date.now();
    }

    let zkModule;
    try {
      zkModule = await loadZkHandFlowModule();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      zkStatus = message;
      pushEventLog('error', message);
      await reportZkHandError({
        source: 'zk.import',
        phase: null,
        message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (lock === zkHandLock) {
        zkHandLock = 0;
        zkBusy = false;
        registerBusySince = null;
      }
      return;
    }

    const {
      isZkHandPhase,
      isMyZkTurn,
      isMyShowdownTurn,
      maybeAdvanceZkHand,
    } = zkModule;
    const zkPhase = isZkHandPhase(snapshot.phase) || snapshot.phase === 'Showdown';
    if (!zkPhase) {
      if (lock === zkHandLock) {
        zkHandLock = 0;
        zkBusy = false;
        registerBusySince = null;
      }
      return;
    }

    if (snapshot.phase === 'Register' && localSeat !== null) {
      const now = Date.now();
      if (now - lastRegisterTurnLogAt > 2_000) {
        lastRegisterTurnLogAt = now;
        pushEventLog('info', `Register turn seat=${localSeat} — ensuring ZK flow…`);
      }
    }
    let flow;
    try {
      flow = await ensureZkHandFlow(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushEventLog('error', `ZK hand setup: ${message}`);
      if (lock === zkHandLock) {
        zkHandLock = 0;
        zkBusy = false;
        registerBusySince = null;
      }
      if (snapshot.phase === 'Register') {
        setTimeout(() => {
          const latest = gameState;
          if (latest?.phase === 'Register') {
            void runZkHandIfMyTurn(latest);
          }
        }, 2000);
      }
      return;
    }
    if (flow) {
      syncShareSubmittedFromSnapshot(snapshot, flow);
    }
    let activeSnapshot = snapshot;
    if (
      snapshot.phase === 'Register'
      || snapshot.phase === 'Shuffle'
      || snapshot.phase === 'Share'
    ) {
      try {
        let refreshed = await client.getGame(gameId);
        // Raw per-seat getGame is `lobby` without hand meta — never wipe Register.
        if (
          gameState
          && gameState.backend === 'solana'
          && refreshed.backend === 'solana'
          && !isChainPhaseForward(gameState.phase, refreshed.phase)
        ) {
          refreshed = mergeWorkerIntoChainSnapshot(gameState, refreshed);
        }
        activeSnapshot = refreshed;
        ingestSnapshotEvents(activeSnapshot);
        gameState = activeSnapshot;
        syncLocalSeatFromState();
        updateZkStatus(activeSnapshot);
      } catch {
        activeSnapshot = snapshot;
      }
    }
    // Do not decrypt before the showdown turn check — WASM decrypt after share
    // freezes WKWebView (event log stuck on "share finalized", no prove).
    const provisionalResult = provisionalHandResult;
    const myTurn = flow
      ? isMyZkTurn(activeSnapshot, localSeat, flow)
        || isMyShowdownTurn(activeSnapshot, localSeat, flow, provisionalResult)
      : false;
    if (!flow || !myTurn) {
      if (activeSnapshot.phase === 'Register' && localSeat !== null) {
        pushEventLog(
          'info',
          `Register skip seat=${localSeat} flow=${flow ? 'ok' : 'null'} turn=${myTurn}`,
        );
      }
      if (activeSnapshot.phase === 'Shuffle' && localSeat !== null) {
        const now = Date.now();
        if (now - lastShuffleSkipLogAt > 2_000) {
          lastShuffleSkipLogAt = now;
          const actor = activeSnapshot.zk?.currentShufflerIndex
            ?? activeSnapshot.currentPlayerIndex
            ?? 'none';
          pushEventLog(
            'info',
            `Shuffle skip seat=${localSeat} flow=${flow ? 'ok' : 'null'} turn=${myTurn} actor=${actor} idx=${activeSnapshot.playerIndexBySeat?.[localSeat] ?? 'none'}`,
          );
        }
      }
      if (lock === zkHandLock) {
        zkHandLock = 0;
        zkBusy = false;
        registerBusySince = null;
      }
      // Poker.init still pending → flow=null; retry so seat eventually proves.
      if (!flow && activeSnapshot.phase === 'Register') {
        setTimeout(() => {
          const latest = gameState;
          if (latest?.phase === 'Register') {
            void runZkHandIfMyTurn(latest);
          }
        }, 2000);
      }
      if (activeSnapshot.phase === 'Showdown') {
        const preferred = zkModule.resolveShowdownSubmitterSeat(
          activeSnapshot,
          provisionalResult,
        );
        if (preferred === null || preferred === localSeat) {
          setTimeout(() => {
            const latest = gameState;
            if (latest?.phase === 'Showdown') {
              void runZkHandIfMyTurn(latest);
            }
          }, 2000);
        }
      }
      return;
    }
    let nextSnapshot: GameSnapshot | null = null;
    try {
      if (activeSnapshot.phase === 'Register') {
        pushEventLog('zk', `Register prove starting (seat ${localSeat})`);
      }
      if (activeSnapshot.phase === 'Shuffle') {
        pushEventLog('zk', `Shuffle prove starting (seat ${localSeat})`);
      }
      if (activeSnapshot.phase === 'Showdown') {
        pushEventLog('zk', `Showdown prove starting (seat ${localSeat})`);
      }
      nextSnapshot = await timeAsync(
        `zk-hand phase=${activeSnapshot.phase} seat=${localSeat}`,
        () => maybeAdvanceZkHand(client, gameId, activeSnapshot, localSeat, flow, provisionalResult),
      );
      if (activeSnapshot.phase === 'Register' && nextSnapshot) {
        pushEventLog(
          'zk',
          `Register submit ok (seat ${localSeat}) registered=${nextSnapshot.zk?.registeredCount ?? '?'} phase=${nextSnapshot.phase}`,
        );
      }
      if (activeSnapshot.phase === 'Shuffle' && nextSnapshot) {
        pushEventLog(
          'zk',
          `Shuffle step seat=${localSeat} phase=${nextSnapshot.phase} shuffled=${nextSnapshot.zk?.shuffledCount ?? '?'}`,
        );
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      let displayMessage = rawMessage;
      try {
        const body = JSON.parse(rawMessage.trim()) as { error?: string };
        if (typeof body.error === 'string') {
          displayMessage = body.error;
        }
      } catch {
        // plain text error
      }
      if (flow && activeSnapshot.phase === 'Share') {
        if (displayMessage.includes('last shuffle')) {
          setTimeout(() => {
            const latest = gameState;
            if (latest?.phase === 'Share') {
              void runZkHandIfMyTurn(latest);
            }
          }, 1000);
          displayMessage = '';
        } else if (
          displayMessage.includes('Partials already submitted')
          || displayMessage.includes('already submitted')
        ) {
          flow.shareSubmitted = true;
          flow.shareRetryAfter = undefined;
        } else if (
          displayMessage.includes('timed out')
          || displayMessage.includes('ElGamal key desync')
          || displayMessage.includes('hash mismatch')
          || displayMessage.includes('Invalid share')
        ) {
          flow.shareRetryAfter = Date.now() + 15_000;
        }
      }
      if (flow && activeSnapshot.phase === 'Showdown') {
        if (zkModule.isShowdownAlreadySettledError(displayMessage)) {
          flow.showdownSubmitted = true;
          pushEventLog('info', 'Showdown proof accepted');
          displayMessage = '';
        } else if (zkModule.isShowdownRetryQuietlyError(displayMessage)) {
          flow.showdownSubmitted = false;
          setTimeout(() => {
            const latest = gameState;
            if (latest?.phase === 'Showdown') {
              void runZkHandIfMyTurn(latest);
            }
          }, 1500);
          displayMessage = '';
        }
      }
      if (flow && activeSnapshot.phase === 'Register') {
        // ProveBusy / tx races: retry after the peer prove finishes.
        const retryMs = displayMessage.includes('ProveBusy') ? 2500 : 1500;
        setTimeout(() => {
          const latest = gameState;
          if (latest?.phase === 'Register') {
            void runZkHandIfMyTurn(latest);
          }
        }, retryMs);
      }
      if (flow && activeSnapshot.phase === 'Shuffle') {
        if (displayMessage.includes('ElGamal key desync')) {
          // Drop bad flow so ensureZkHandFlow reloads the registered key from storage.
          zkHandFlow = null;
          zkHandFlowNumber = null;
        }
        setTimeout(() => {
          const latest = gameState;
          if (latest?.phase === 'Shuffle') {
            void runZkHandIfMyTurn(latest);
          }
        }, 1500);
      }
      if (displayMessage) {
        zkStatus = displayMessage;
        pushEventLog('error', displayMessage, activeSnapshot.handNumber ?? null);
        await reportZkHandError({
          source: 'zk.hand',
          phase: activeSnapshot.phase,
          message: rawMessage,
          stack: err instanceof Error ? err.stack : undefined,
          detail: { localSeat, handNumber: activeSnapshot.handNumber },
        });
      }
    } finally {
      if (lock === zkHandLock) {
        zkHandLock = 0;
        zkBusy = false;
      }
    }
    if (nextSnapshot) {
      applySnapshot(nextSnapshot);
    }
  }

  function updateZkStatus(snapshot: GameSnapshot | null) {
    if (!snapshot) {
      if (!zkBusy) {
        zkStatus = '';
      }
      return;
    }
    const next = formatHandLifecycleStatus(snapshot);
    if (next || !zkBusy) {
      zkStatus = next;
    }
  }

  function stopCatalogRefresh() {
    if (catalogTimer) {
      clearInterval(catalogTimer);
      catalogTimer = null;
    }
  }

  async function refreshCatalog() {
    if (!onChain() || !client.listTableCatalog) return;
    try {
      const catalog = await client.listTableCatalog();
      catalogRooms = catalog.rooms.map((room) => ({
        roomIdHex: room.roomIdHex,
        label: room.label,
        tables: room.tables.map((table) => ({ tableId: table.tableId, label: table.label })),
      }));
      const roomId = catalog.selectedRoomIdHex
        && catalogRooms.some((room) => room.roomIdHex === catalog.selectedRoomIdHex)
        ? catalog.selectedRoomIdHex
        : catalogRooms[0]?.roomIdHex ?? '';
      selectedRoomId = roomId;
      const tables = catalogRooms.find((room) => room.roomIdHex === roomId)?.tables ?? [];
      selectedTableId = catalog.selectedTableId
        && tables.some((table) => table.tableId === catalog.selectedTableId)
        ? catalog.selectedTableId
        : tables[0]?.tableId ?? '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!catalogRooms.length) statusMessage = message;
    }
  }

  function startCatalogRefresh() {
    stopCatalogRefresh();
    void refreshCatalog();
    catalogTimer = setInterval(() => {
      if (!busy && !zkBusy && onChain() && tableConnected) void refreshCatalog();
    }, 12_000);
  }

  async function openSelectedTable(roomIdHex: string, tableId: string) {
    if (!client.selectTable || !roomIdHex || !tableId || handInProgress) return;
    await runAction('Opening table...', async () => {
      const snapshot = await client.selectTable!(roomIdHex, tableId);
      lastDecryptedCards = undefined;
      gameState = null;
      return snapshot;
    });
    await refreshCatalog();
  }

  function disconnectTable() {
    stopCatalogRefresh();
    unsubscribeTable?.();
    unsubscribeTable = null;
    unsubscribeChainEvents?.();
    unsubscribeChainEvents = null;
    stopZkPollTimer();
    stopBridgeProbeTimer();
    tableConnected = false;
    gameId = null;
    gameState = null;
    localSeat = null;
    handEventLog = [];
    eventLogPrevSnapshot = null;
    seenChainEventSigs.clear();
    eventLogStickToBottom = true;
    refreshView();
  }

  async function connectToTable(): Promise<boolean> {
    if (tableConnected) {
      return true;
    }
    if (backendKind === 'local') {
      const health = await fetchServerHealth();
      if (!health?.ok) {
        return false;
      }
      handleServerBoot(health.bootId);
    } else if (onChain()) {
      const health = await client.healthCheck?.() ?? await fetchChainWorkerHealth();
      if (!health?.ok) {
        return false;
      }
      if (health.localnetReady === false && (health as { rpcReady?: boolean }).rpcReady === false) {
        statusMessage = health.hint
          ?? (backendKind === 'devnet'
            ? 'Devnet is not ready. Check the RPC, then Connect.'
            : 'Solana localnet is not ready. Start it on the host, then Connect.');
        return false;
      }
    } else {
      return false;
    }
    try {
      // Solana in-WebView: getGame is bounded (~20s) in solana-bridge; keep a
      // slightly larger race so bootstrap can retry instead of waiting a minute.
      const tableLoadMs = onChain() ? 25_000 : 8_000;
      const snapshot = await Promise.race([
        client.getDefaultGame(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Timed out loading table state (${tableLoadMs / 1000}s)`)),
            tableLoadMs,
          );
        }),
      ]);
      applySnapshot(snapshot);
      unsubscribeTable = client.subscribeGame(snapshot.gameId, applySnapshot);
      unsubscribeChainEvents?.();
      unsubscribeChainEvents = null;
      if (client instanceof SolanaPokerClient) {
        unsubscribeChainEvents = client.onChainEvent((message, signature) => {
          if (signature) {
            if (seenChainEventSigs.has(signature)) {
              return;
            }
            seenChainEventSigs.add(signature);
          }
          pushEventLog('chain', message, snapshot.handNumber ?? gameState?.handNumber ?? null);
        });
        pushEventLog('info', 'Listening for on-chain Solana poker program events…');
      }
      tableConnected = true;
      if (onChain()) startCatalogRefresh();
      logBridge('connectToTable: success, tableConnected=true, subscribed');
      ensureZkPollTimer();
      return true;
    } catch (err) {
      statusMessage = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  function handleServerBoot(bootId: string | undefined) {
    if (!bootId) {
      return;
    }
    if (serverBootId !== null && serverBootId !== bootId) {
      disconnectTable();
    }
    serverBootId = bootId;
  }

  async function connectSolanaRpc() {
    if (busy) {
      return;
    }
    busy = true;
    serverStatus = 'starting';
    serverDetail = backendKind === 'devnet'
      ? 'Connecting to devnet...'
      : 'Connecting to Solana RPC (event-driven turns)...';
    try {
      // Primary: Solana RPC. Table mutations use Vite same-origin /api/game*
      // (or optional ?chainWorker=) — do not spawn :3850 for gameplay.
      const health = await client.healthCheck?.() ?? null;

      if (!health?.ok) {
        serverStatus = 'disconnected';
        serverDetail = health?.hint
          ?? (backendKind === 'devnet'
            ? 'Devnet RPC is not ready. Relaunch with SOLANA_RPC_URL set.'
            : 'Solana RPC is not ready at 127.0.0.1:8899. Start localnet on the host.');
        return;
      }

      if (health.localnetReady === false && health.rpcReady === false) {
        serverStatus = 'disconnected';
        serverDetail = health.hint
          ?? (backendKind === 'devnet'
            ? 'Devnet is not ready. Check the RPC, then Connect.'
            : 'Solana localnet is not ready. Start it on the host, then Connect.');
        statusMessage = serverDetail;
        return;
      }

      serverStatus = 'connected';
      serverDetail = health.hint
        ?? 'Connected to Solana RPC — turns via on-chain events';
      logBridge('connectSolanaRpc: connected, now connecting table');
      await connectToTable();
    } catch (err) {
      serverStatus = 'disconnected';
      serverDetail = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function connectServer() {
    if (onChain()) {
      await connectSolanaRpc();
      return;
    }
    if (busy) {
      return;
    }
    busy = true;
    serverStatus = 'starting';
    serverDetail = 'Connecting to local server at 127.0.0.1:3847...';
    try {
      const health = await fetchServerHealth();
      if (!health?.ok) {
        serverStatus = 'disconnected';
        serverDetail = 'Game server is not running. Start it on the host, then Connect.';
        return;
      }

      handleServerBoot(health.bootId);
      serverStatus = 'connected';
      serverDetail = 'Connected to local server at 127.0.0.1:3847';
      logBridge('connectServer: local server connected, now connecting table');
      await connectToTable();
    } catch (err) {
      serverStatus = 'disconnected';
      serverDetail = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function refreshServerStatus() {
    if (serverStatus === 'starting') {
      return;
    }
    if (onChain()) {
      const health = await client.healthCheck?.() ?? await fetchChainWorkerHealth();
      if (health?.ok) {
        if (health.localnetReady === false && health.rpcReady === false) {
          if (tableConnected) {
            disconnectTable();
          }
          serverStatus = 'disconnected';
          serverDetail = health.hint
            ?? (backendKind === 'devnet'
            ? 'Devnet is not ready. Check the RPC, then Connect.'
            : 'Solana localnet is not ready. Start it on the host, then Connect.');
          return;
        }
        serverStatus = 'connected';
        serverDetail = health.hint
          ?? (health.worker
            ? 'Connected to Solana RPC (+ optional chain worker)'
            : 'Connected to Solana RPC — turns via on-chain events');
        if (!tableConnected) {
          await connectToTable();
        }
        return;
      }
      if (tableConnected) {
        disconnectTable();
      }
      serverStatus = 'disconnected';
      serverDetail = 'Solana RPC is not ready. Start localnet on the host.';
      return;
    }
    const health = await fetchServerHealth();
    if (health?.ok) {
      handleServerBoot(health.bootId);
      serverStatus = 'connected';
      serverDetail = 'Connected to local server at 127.0.0.1:3847';
      if (!tableConnected) {
        await connectToTable();
      }
      return;
    }
    if (tableConnected && gameState?.handNumber) {
      return;
    }
    if (tableConnected) {
      disconnectTable();
    }
    serverStatus = 'disconnected';
    serverDetail = 'Game server is not running. Start it on the host, then Connect.';
  }

  async function rotateWallet() {
    if (backendKind !== 'local' && !onChain()) {
      return;
    }
    if (gameId && playerPublicKey && localSeat !== null) {
      await runAction('Standing up...', () => client.standUp(gameId!, playerPublicKey));
    }
    playerPublicKey = createNewLocalWallet();
    localSeat = null;
    refreshView();
  }

  const localServerReady = $derived(
    serverStatus === 'connected' && tableConnected,
  );
  const showConnectServer = $derived(
    (backendKind === 'local' || onChain()) && !localServerReady,
  );
  const chainSeatsReady = $derived(
    !onChain()
    || (
      localSeat !== null
      && canBeginHand(playerPublicKey, gameState?.seats ?? [])
    ),
  );
  const handFinished = $derived(
    gameState?.phase === 'Complete'
    || Boolean(gameState?.handResult)
    || (
      gameState?.phase === 'Showdown'
      && isHandLifecycleComplete(gameState)
    ),
  );
  const canStartHand = $derived(
    Boolean(gameId)
    && (backendKind !== 'local' || localServerReady)
    && (!onChain() || localServerReady)
    && chainSeatsReady
    && !busy
    && !sittingOutNextHand
    && !anySeatSittingOut(sitOutRecord)
    && (
      gameState?.phase === 'lobby'
      || handFinished
    ),
  );
  const canStartNewHand = $derived(
    Boolean(gameId)
    && (backendKind !== 'local' || localServerReady)
    && (!onChain() || localServerReady)
    && chainSeatsReady
    && handFinished,
  );

  function pinSeatInUrl(seat: number) {
    if (typeof window === 'undefined' || !Number.isInteger(seat) || seat < 0) {
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get('seat') === String(seat)) {
      return;
    }
    url.searchParams.set('seat', String(seat));
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function syncLocalSeatFromState() {
    if (!gameState || !playerPublicKey) {
      return;
    }
    const mine = gameState.seats.find((seat) => seat.publicKey === playerPublicKey);
    if (mine) {
      localSeat = mine.seat;
      pinSeatInUrl(mine.seat);
      return;
    }
    // Do not clear seat mid-hand when a chain event snapshot briefly omits seats.
    if (
      gameState.phase === 'lobby'
      || (gameState.phase === 'Complete' && Boolean(gameState.handResult))
    ) {
      localSeat = null;
    }
  }

  async function publishHoleReveal(
    snapshot: GameSnapshot,
    seat: number,
  ): Promise<boolean> {
    const handNumber = snapshot.handNumber ?? 1;
    const inHand = snapshot.seats
      .filter((entry) => entry.playerIndex !== undefined && !entry.folded)
      .map((entry) => entry.seat);
    const { writeSharedMeta, getSharedMetaStore, readSharedMeta } = await import('@poker-src/chain/shared-meta-store');
    const { refreshWebViewMetaCache } = await import('./backend/solana-meta-bridge');
    let stored = noteHolesRevealed(
      parseHolesRevealed(null, snapshot.gameId, handNumber),
      seat,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await refreshWebViewMetaCache([HOLES_REVEALED_KEY]);
      const disk = parseHolesRevealed(
        readSharedMeta(HOLES_REVEALED_KEY),
        snapshot.gameId,
        handNumber,
      );
      let next = mergeHolesRevealed(disk, noteHolesRevealed(disk, seat));
      if (allHoleCardsRevealed(next, inHand)) {
        next = claimPreflopOpen(next, seat);
      }
      writeSharedMeta(HOLES_REVEALED_KEY, JSON.stringify(next));
      await getSharedMetaStore().flushWrites?.();
      await refreshWebViewMetaCache([HOLES_REVEALED_KEY]);
      stored = parseHolesRevealed(
        readSharedMeta(HOLES_REVEALED_KEY),
        snapshot.gameId,
        handNumber,
      );
      if (stored.seats.includes(seat)) break;
    }
    return stored.opener === seat && allHoleCardsRevealed(stored, inHand);
  }

  async function maybeAcknowledgeHoleCards(snapshot: GameSnapshot) {
    // Solana: Share→Evaluation often arrives via PhaseAdvanced without zkReveal.
    const solanaHoleAck =
      snapshot.backend === 'solana'
      && snapshot.phase === 'PreFlop'
      && !snapshot.bettingRoundOpen
      && (snapshot.holesViewPending === true
        || snapshot.zkReveal?.shareComplete === true);
    if (
      holesAcked
      || !gameId
      || localSeat === null
      || snapshot.phase !== 'PreFlop'
      || snapshot.bettingRoundOpen
      || !(
        solanaHoleAck
        || (
          snapshot.holesViewPending
          && snapshot.zkReveal?.shareComplete
          && snapshot.zkReveal.holePartialsUnlocked
        )
      )
    ) {
      return;
    }
    const mine = snapshot.seats.find((seat) => seat.seat === localSeat);
    const playerIndex = mine?.playerIndex
      ?? snapshot.playerIndexBySeat?.[localSeat];
    if (!mine || playerIndex === undefined || mine.folded) {
      return;
    }
    if (!isNativeAutoPlay()) {
      if (!localHolesFaceUp(view.playerCards[localSeat])) return;
      const open = await publishHoleReveal(snapshot, localSeat);
      if (!open) return;
    } else if (snapshot.playerIndexBySeat?.[localSeat] !== 0) {
      return;
    }
    holesAcked = true;
    try {
      const updated = await client.acknowledgeHoleCards(gameId, localSeat);
      applySnapshot(updated);
      pushEventLog('action', 'Preflop betting open');
    } catch (err) {
      holesAcked = false;
      const message = err instanceof Error ? err.message : String(err);
      pushEventLog('error', `ack-holes seat=${localSeat} failed: ${message}`);
    }
  }

  let autoAdvanceLock = 0;
  let autoAdvanceRetryAfter = 0;

  function setAutoCollectBlinds(on: boolean) {
    autoCollectBlinds = on;
    saveAutoCollectBlinds(on);
    if (gameState) void maybeAutoAdvanceStreet(gameState);
  }

  function setOptInNextHand(on: boolean) {
    optInNextHand = on;
    saveOptInNextHand(on);
    void loadZkHandFlowModule().then((mod) => {
      mod.setNextHandStageEnabled(() => optInNextHand && !sittingOutNextHand);
    });
    if (gameState) void syncNextHand(gameState);
  }

  async function readBlindPostRecord(snapshot: GameSnapshot): Promise<BlindPostRecord> {
    const { refreshWebViewMetaCache } = await import('./backend/solana-meta-bridge');
    await refreshWebViewMetaCache([BLIND_POSTS_KEY]);
    const { readSharedMeta } = await import('@poker-src/chain/shared-meta-store');
    return parseBlindPosts(
      readSharedMeta(BLIND_POSTS_KEY),
      snapshot.gameId,
      snapshot.handNumber ?? null,
    );
  }

  async function writeBlindPostRecord(record: BlindPostRecord): Promise<BlindPostRecord> {
    const { writeSharedMeta, getSharedMetaStore, readSharedMeta } = await import('@poker-src/chain/shared-meta-store');
    const { refreshWebViewMetaCache } = await import('./backend/solana-meta-bridge');
    let stored = record;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await refreshWebViewMetaCache([BLIND_POSTS_KEY]);
      const disk = parseBlindPosts(readSharedMeta(BLIND_POSTS_KEY), record.gameId, record.handNumber);
      stored = mergeBlindPosts(disk, record);
      writeSharedMeta(BLIND_POSTS_KEY, JSON.stringify(stored));
      await getSharedMetaStore().flushWrites?.();
      await refreshWebViewMetaCache([BLIND_POSTS_KEY]);
      const after = parseBlindPosts(readSharedMeta(BLIND_POSTS_KEY), record.gameId, record.handNumber);
      const covered = Object.entries(record.posted).every(([seat, at]) => (after.posted[seat] ?? 0) >= at)
        && Object.entries(record.auto).every(([seat, stamp]) => {
          const current = after.auto[seat];
          return current != null && current.at >= stamp.at && current.on === stamp.on;
        });
      if (covered) {
        blindPosts = after;
        return after;
      }
    }
    blindPosts = stored;
    return stored;
  }

  async function publishBlindChoice(snapshot: GameSnapshot): Promise<BlindPostRecord | null> {
    if (nativeAutoPlay || localSeat === null || !shouldOpenPreflop(snapshot)) {
      blindPosts = null;
      return null;
    }
    const owners = blindOwners(snapshot);
    if (!owners || !blindRoleForSeat(owners, localSeat)) {
      const record = await readBlindPostRecord(snapshot);
      blindPosts = record;
      return record;
    }
    const current = await readBlindPostRecord(snapshot);
    const prev = current.auto[String(localSeat)];
    if (prev && prev.on === autoCollectBlinds) {
      blindPosts = current;
      return current;
    }
    const next = {
      ...current,
      auto: { ...current.auto, [String(localSeat)]: { on: autoCollectBlinds, at: Date.now() } },
    };
    await writeBlindPostRecord(next);
    return next;
  }

  function bothBlindsAutomatic(snapshot: GameSnapshot, record: BlindPostRecord): boolean {
    const owners = blindOwners(snapshot);
    if (!owners) return false;
    return [owners.smallSeat, owners.bigSeat].every((seat) => record.auto[String(seat)]?.on === true);
  }

  /** Player index 0 sends the one collect transaction once every blind seat has posted. */
  async function maybeSendPostedBlinds(snapshot: GameSnapshot, record: BlindPostRecord) {
    if (
      !gameId
      || localSeat === null
      || snapshot.playerIndexBySeat?.[localSeat] !== 0
      || blindCollectLock > 0
      || autoAdvanceLock > 0
    ) {
      return;
    }
    const owners = blindOwners(snapshot);
    if (!owners || !blindsReady(record, owners)) return;
    if (claimHeldByOther(record, localSeat, Date.now())) return;
    const claimed = noteClaim(record, localSeat, Date.now());
    blindCollectLock += 1;
    busy = true;
    statusMessage = 'Posting blind…';
    try {
      const stored = await writeBlindPostRecord(claimed);
      if (stored.claim?.seat !== localSeat) return;
      await new Promise((resolve) => setTimeout(resolve, 350));
      const latest = await readBlindPostRecord(snapshot);
      blindPosts = latest;
      if (latest.claim?.seat !== localSeat) return;
      const next = await client.advanceStreet(gameId, 'PreFlop');
      applySnapshot(next);
      statusMessage = '';
      pushEventLog('action', 'Blinds posted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusMessage = message;
      pushEventLog('error', message);
    } finally {
      busy = false;
      blindCollectLock -= 1;
    }
  }

  async function postBlind() {
    if (!gameState || localSeat === null || busy || !blindPrompt?.canPost) return;
    if (!nextHandBlindsAllowed(blindGate)) return;
    const owners = blindOwners(gameState);
    const role = owners ? blindRoleForSeat(owners, localSeat) : null;
    if (!owners || !role) return;
    busy = true;
    statusMessage = 'Posting blind…';
    try {
      const current = await readBlindPostRecord(gameState);
      const posted = await writeBlindPostRecord(notePosted(current, localSeat, Date.now()));
      const amount = role === 'small' ? owners.smallAmount : owners.bigAmount;
      pushEventLog('action', `Seat ${localSeat} posted the ${role} blind (${amount})`);
      statusMessage = '';
      if (blindsReady(posted, owners)) {
        await maybeSendPostedBlinds(gameState, posted);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusMessage = message;
      pushEventLog('error', message);
    } finally {
      busy = false;
    }
  }

  async function maybeAutoAdvanceStreet(snapshot: GameSnapshot) {
    if (
      !gameId
      || localSeat === null
      || busy
      || (zkBusy && isActiveZkPhase(snapshot.phase))
      || autoAdvanceLock > 0
      || Date.now() < autoAdvanceRetryAfter
    ) {
      return;
    }
    const openPreflop = shouldOpenPreflop(snapshot);
    if (openPreflop && !nextHandBlindsAllowed(blindGate)) {
      return;
    }
    if (openPreflop && !nativeAutoPlay) {
      const record = await publishBlindChoice(snapshot);
      if (!record || !bothBlindsAutomatic(snapshot, record)) {
        if (record) await maybeSendPostedBlinds(snapshot, record);
        return;
      }
    }
    if (!openPreflop && !shouldAutoAdvanceStreet(snapshot)) {
      return;
    }
    // One seat posts the street transaction. The other window follows the snapshot.
    if (snapshot.playerIndexBySeat?.[localSeat] !== 0) {
      return;
    }
    autoAdvanceLock += 1;
    busy = true;
    statusMessage = 'Advancing street…';
    try {
      const fromPhase = ['PreFlop', 'Flop', 'Turn', 'River'].includes(snapshot.phase)
        ? snapshot.phase
        : undefined;
      const next = await client.advanceStreet(gameId, fromPhase);
      applySnapshot(next);
      statusMessage = '';
      autoAdvanceRetryAfter = 0;
      autoBetHardStopped = '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusMessage = message;
      pushEventLog('error', message);
      autoAdvanceRetryAfter = Date.now() + 5_000;
    } finally {
      busy = false;
      autoAdvanceLock -= 1;
    }
  }

  function stopAutoBet(reason: string) {
    if (autoBetHardStopped === reason) {
      return;
    }
    autoBetHardStopped = reason;
    pushEventLog('error', `Auto-play stopped: ${reason}`);
    statusMessage = `Auto-play stopped: ${reason}`;
  }

  async function maybeAutoBet(snapshot: GameSnapshot) {
    if (
      !nativeAutoPlay
      || !snapshot.bettingRoundOpen
      || snapshot.holesViewPending
      || busy
      || (zkBusy && isActiveZkPhase(snapshot.phase))
      || localSeat === null
      || snapshot.currentPlayerSeat !== localSeat
      || autoBetLock > 0
      || Date.now() < autoBetRetryAfter
      || autoBetFailCount >= 6
      || autoBetHardStopped !== ''
    ) {
      return;
    }
    // Reset per-hand / per-street counters when the street or hand changes.
    const handNum = snapshot.handNumber ?? null;
    if (handNum !== autoBetHandNumber) {
      autoBetHandNumber = handNum;
      autoBetHandCount = 0;
      autoBetStreetKey = '';
      autoBetStreetCount = 0;
      autoBetLastSuccessKey = '';
      autoBetSuccessRepeat = 0;
      autoBetHardStopped = '';
    }
    const streetKey = `${handNum ?? 'x'}:${snapshot.phase}:${snapshot.currentBet}`;
    if (streetKey !== autoBetStreetKey) {
      autoBetStreetKey = streetKey;
      autoBetStreetCount = 0;
      autoBetLastSuccessKey = '';
      autoBetSuccessRepeat = 0;
      // Chain StreetAdvanced / PhaseAdvanced opened a new street — resume auto-bet.
      autoBetHardStopped = '';
    }
    if (autoBetStreetCount >= MAX_AUTO_ACTIONS_PER_STREET) {
      stopAutoBet(
        `max ${MAX_AUTO_ACTIONS_PER_STREET} auto-actions on ${snapshot.phase}`,
      );
      return;
    }
    if (autoBetHandCount >= MAX_AUTO_ACTIONS_PER_HAND) {
      stopAutoBet(`max ${MAX_AUTO_ACTIONS_PER_HAND} auto-actions this hand`);
      return;
    }
    // PreFlop: wait until blinds are reflected so we never check into the BB
    // off a chain-event snapshot that still has currentBet=0. If blinds never
    // land (currentBet stays 0), proceed with check/call so E2E is not stuck.
    if (snapshot.phase === 'PreFlop') {
      const bb = BigInt(snapshot.smallBlind || '0') * 2n;
      const cur = BigInt(snapshot.currentBet || '0');
      if (bb > 0n && cur > 0n && cur < bb) {
        return;
      }
    }
    const mine = snapshot.seats.find((seat) => seat.seat === localSeat);
    if (!mine || mine.folded) {
      return;
    }
    if (!gameId) {
      return;
    }
    const decision = chooseAutoBetAction(snapshot, localSeat);
    if (decision.kind !== 'act') {
      return;
    }
    const { action, toCall, amount } = decision;
    autoBetLock += 1;
    busy = true;
    statusMessage = action;
    try {
      // Call client directly (runAction swallows errors → would retry-spam Event log).
      const next = await client.placeBet(
        gameId,
        localSeat,
        action,
        amount !== undefined ? amount.toString() : undefined,
      );
      applySnapshot(next);
      statusMessage = '';
      autoBetRetryAfter = 0;
      autoBetFailCount = 0;
      autoBetLastError = '';
      autoBetStreetCount += 1;
      autoBetHandCount += 1;
      const successKey = `${action}:${toCall.toString()}`;
      if (successKey === autoBetLastSuccessKey) {
        autoBetSuccessRepeat += 1;
      } else {
        autoBetLastSuccessKey = successKey;
        autoBetSuccessRepeat = 1;
      }
      if (autoBetSuccessRepeat >= MAX_IDENTICAL_SUCCESS) {
        stopAutoBet(
          `same ${action}×${toCall} succeeded ${autoBetSuccessRepeat} times`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusMessage = message;
      pushEventLog('error', message);
      if (message === autoBetLastError) {
        autoBetFailCount += 1;
      } else {
        autoBetLastError = message;
        autoBetFailCount = 1;
      }
      // Exponential backoff; hard-stop after 6 identical failures.
      const backoffMs = Math.min(60_000, 8_000 * autoBetFailCount);
      autoBetRetryAfter = Date.now() + backoffMs;
      if (autoBetFailCount >= 6) {
        stopAutoBet(`after ${autoBetFailCount} failures: ${message}`);
      }
    } finally {
      busy = false;
      autoBetLock -= 1;
    }
  }
  function refreshView() {
    void refreshViewWithDecryption();
  }

  const catalogTables = $derived(
    catalogRooms.find((room) => room.roomIdHex === selectedRoomId)?.tables ?? [],
  );
  const seatOptions = $derived(selectableSeats(gameState, seatCountForGame(gameKind)));
  const isSeated = $derived(localSeat !== null);
  const handInProgress = $derived(
    gameState !== null &&
    gameState.phase !== 'lobby' &&
    gameState.phase !== 'Complete',
  );
  const canPickSeat = $derived(
    (backendKind === 'local' || onChain()) &&
    !isSeated &&
    (!gameState || gameState.phase === 'lobby' || gameState.phase === 'Complete'),
  );
  const seatSelectDisabled = $derived(
    !localServerReady || busy || seatOptions.length === 0,
  );
  const sitDisabled = $derived(
    seatSelectDisabled
    || selectedSeat === ''
    || (onChain() && personalChips < minSitChips),
  );
  const dealReady = $derived(gameState ? shuffleFinished(gameState) : false);
  const canStandUp = $derived(
    (backendKind === 'local' || onChain()) &&
    localServerReady &&
    isSeated &&
    (!handInProgress || !dealReady),
  );

  $effect(() => {
    const key = tableStatus.key;
    if (key !== statusKey) {
      statusKey = key;
      statusStartedAt = Date.now();
      statusNow = statusStartedAt;
    }
  });

  $effect(() => {
    if (!tableStatus.timed) return;
    const id = setInterval(() => {
      statusNow = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  $effect(() => {
    if (!canPickSeat || seatOptions.length === 0) {
      return;
    }
    const seat = Number(selectedSeat);
    if (selectedSeat !== '' && !seatOptions.includes(seat)) {
      selectedSeat = '';
    }
  });

  /** Re-run ZK when server turn advances or showdown submitter becomes known. */
  $effect(() => {
    const snapshot = gameState;
    const seat = localSeat;
    const busy = zkBusy;
    const lock = zkHandLock;
    const provisional = provisionalHandResult;
    if (!snapshot || seat === null || busy || lock > 0 || !gameId || !tableConnected) {
      return;
    }
    const bridgeReady =
      zkBridgeOk
      || (nativeAutoPlay && typeof window !== 'undefined' && typeof (window as any).zero?.invoke === 'function');
    if (!bridgeReady && !(snapshot.phase === 'Showdown' && snapshot.e2eDealValues)) {
      return;
    }
    if (!isActiveZkPhase(snapshot.phase)) {
      return;
    }
    const zk = snapshot.zk;
    const sd = snapshot.zkShowdown;
    const showdownToken = snapshot.phase === 'Showdown' && sd?.requested
      ? [
          sd.submittedCount,
          sd.submittedSeats.join(','),
          provisional?.potResults.map((pot) => pot.winnerSeats.join('+')).join('|') ?? '',
        ].join(':')
      : '';
    const turnToken = [
      snapshot.handNumber ?? 0,
      snapshot.phase,
      zk?.currentShufflerIndex ?? -1,
      zk?.shuffledCount ?? -1,
      zk?.sharedCount ?? -1,
      seat,
      showdownToken,
    ].join(':');
    void turnToken;
    void runZkHandIfMyTurn(snapshot);
  });

  /** Re-fetch partials and decrypt whenever the backend reveals a new street. */
  $effect(() => {
    const snapshot = gameState;
    if (!snapshot || !tableConnected || !gameId) {
      return;
    }
    const revealToken = [
      snapshot.phase,
      snapshot.zkReveal?.revealedCardIndices.join(',') ?? '',
      snapshot.zkReveal?.allPartialsPublic ? '1' : '0',
      snapshot.zkReveal?.entries.length ?? 0,
      snapshot.handResult ? '1' : '0',
    ].join(':');
    void revealToken;
    void (async () => {
      if (nativeDecryptDeferred(snapshot)) {
        scheduleDeferredDecrypt();
        return;
      }
      await syncPartials(snapshot);
      await refreshHandResultView(snapshot);
      await refreshViewWithDecryption();
    })();
  });

  async function sitDown() {
    const seat = Number(selectedSeat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= 10) {
      return;
    }
    await onSeatSelected(seat);
  }

  async function runAction(label: string, fn: () => Promise<GameSnapshot | void>) {
    busy = true;
    statusMessage = label;
    try {
      const next = await fn();
      if (next) {
        applySnapshot(next);
      }
      statusMessage = '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusMessage = message;
      pushEventLog('error', message);
    } finally {
      busy = false;
    }
  }

  function walletCluster(): 'devnet' | 'localnet' | 'any' {
    if (backendKind === 'devnet') return 'devnet';
    if (backendKind === 'solana') return 'localnet';
    return 'any';
  }

  async function refreshConnectedWallet(): Promise<void> {
    if (usesLocalSeatKey()) return;
    const { connectedAddress, startWalletStandard } = await import('./identity/wallet-standard');
    if (!stopWallets) {
      stopWallets = startWalletStandard((next) => {
        walletLabel = next.name;
        playerPublicKey = next.address;
      });
    }
    playerPublicKey = connectedAddress();
  }

  async function openWalletMenu(): Promise<void> {
    const { listWalletChoices } = await import('./identity/wallet-standard');
    const choices = listWalletChoices();
    if (choices.length === 1 && choices[0]) {
      await chooseWallet(choices[0].name);
      return;
    }
    walletChoices = choices;
    walletMenuOpen = true;
    statusMessage = choices.length === 0
      ? 'No Solana wallet is available in this browser.'
      : '';
  }

  async function chooseWallet(name: string): Promise<void> {
    const { connectWallet } = await import('./identity/wallet-standard');
    try {
      const next = await connectWallet(name, walletCluster());
      playerPublicKey = next.address;
      walletLabel = next.name;
      walletMenuOpen = false;
      statusMessage = '';
    } catch (err) {
      statusMessage = err instanceof Error ? err.message : String(err);
    }
  }

  async function disconnectPlayerWallet(): Promise<void> {
    const { disconnectWallet } = await import('./identity/wallet-standard');
    await disconnectWallet();
    playerPublicKey = '';
    walletLabel = '';
    walletMenuOpen = false;
  }

  function switchBackend(kind: BackendKind) {
    disconnectTable();
    backendKind = kind;
    saveBackendKind(kind);
    client = createClient(kind);
    gameId = null;
    gameState = null;
    localSeat = null;
    serverStatus = 'checking';
    refreshView();
    if (kind === 'local') {
      if (usesLocalSeatKey()) playerPublicKey = getOrCreateLocalPublicKey();
      else void refreshConnectedWallet();
      void connectServer();
    } else if (onChain(kind)) {
      if (usesLocalSeatKey()) playerPublicKey = getOrCreateLocalPublicKey();
      else void refreshConnectedWallet();
      void connectSolanaRpc();
    }
  }

  async function onSeatSelected(seat: number) {
    if (!canPickSeat || seatSelectDisabled || isSeated || !seatOptions.includes(seat)) {
      agentDebugLog('H4', 'Poker.svelte:onSeatSelected', 'blocked', {
        seat,
        canPickSeat,
        seatSelectDisabled,
        isSeated,
        inOptions: seatOptions.includes(seat),
        localServerReady,
        serverStatus,
        tableConnected,
      });
      return;
    }

    // Prefer storage (e2e hydrate) over a stale in-memory key from onMount.
    const publicKey = getActivePublicKey(backendKind) || playerPublicKey;
    playerPublicKey = publicKey;

    if (
      gameState?.seats.some(
        (occupied) => occupied.publicKey === publicKey && occupied.seat === seat,
      )
    ) {
      localSeat = seat;
      pinSeatInUrl(seat);
      refreshView();
      return;
    }

    if (!gameId) {
      const connected = await connectToTable();
      if (!connected) {
        await connectServer();
      }
    }
    if (!gameId) {
      return;
    }

    if (onChain() && personalChips < minSitChips) {
      statusMessage = `Sit requires at least ${minSitChips} chips. Use the faucet first.`;
      return;
    }

    await runAction(`Joining ${seatLabel(seat)}...`, () =>
      client.joinGame(gameId!, seat, publicKey),
    );
    if (localSeat === null) {
      localSeat = seat;
    }
    pinSeatInUrl(seat);
  }

  async function standUp() {
    if (!gameId || !playerPublicKey || !canStandUp) {
      return;
    }
    await runAction('Standing up...', async () => {
      const next = await client.standUp(gameId!, playerPublicKey);
      localSeat = null;
      return next;
    });
  }

  async function startHand() {
    if (!gameId || !canStartHand) {
      handStartRequested = false;
      return;
    }
    handStartRequested = true;
    const completedHandNumber = gameState?.handNumber;
    zkHandFlow = null;
    zkHandFlowNumber = null;
    handResultView = null;
    completeFacesReady = false;
    partialStore.clear();
    partialCount = 0;
    if (completedHandNumber !== undefined) {
      const { clearZkHandFlowState } = await loadZkHandFlowModule();
      clearZkHandFlowState(completedHandNumber);
    }
    const startingLabel = gameKind === 'war' || gameKind === 'baccarat'
      ? `Playing ${gameKind === 'war' ? 'War' : 'Baccarat'} on Arcis...`
      : 'Starting hand...';
    await runAction(startingLabel, async () => {
      try {
        return await client.startHand(gameId!, { gameKind });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushEventLog('error', message);
        throw err;
      }
    });
    if (statusMessage) handStartRequested = false;
    if (onChain()) void refreshCatalog();
  }

  async function bet(action: 'fold' | 'check' | 'call' | 'raise', amount?: string) {
    if (!gameId || localSeat === null) {
      return;
    }
    await runAction(action, () => client.placeBet(gameId!, localSeat, action, amount));
  }

  function logFaucetReceived(amount: string, pk: string, seat: number | null) {
    const short = pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
    const seatBit = seat !== null ? ` seat ${seat}` : '';
    const msg = `Faucet received: +${amount} → personal escrow (${short}${seatBit})`;
    console.log(`[faucet] ${msg}`);
    pushEventLog('info', msg);
  }

  async function addChips() {
    if (!gameId) {
      return;
    }
    if (onChain()) {
      const pk = playerPublicKey;
      if (!pk || !client.faucetCreditPersonal) {
        return;
      }
      const amount = String(addChipsAmount);
      const credit = Number(addChipsAmount);
      if (!Number.isFinite(credit) || credit <= 0) return;
      const toSeat = localSeat !== null && Boolean(client.transferPersonalToSeat);
      try {
        const funded = await client.faucetCreditPersonal(gameId, pk, amount);
        if (toSeat) {
          let next = funded;
          try {
            next = await client.transferPersonalToSeat!(gameId, pk, amount);
          } catch (err) {
            if (funded) applySnapshot(funded);
            throw err;
          }
          const short = pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
          pushEventLog('info', `Faucet received: +${amount} → seat stack (${short} seat ${localSeat})`);
          if (next) applySnapshot(next);
        } else if (funded) {
          applySnapshot(funded);
          const reported = Number(funded.callerPersonalEscrow);
          if (Number.isFinite(reported)) personalChips = reported;
          logFaucetReceived(amount, pk, localSeat);
        }
        statusMessage = '';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusMessage = message;
        pushEventLog('error', message);
      }
      return;
    }
    if (localSeat === null) {
      return;
    }
    await runAction('Adding chips...', () =>
      client.addChips(gameId!, localSeat, String(addChipsAmount)),
    );
  }

  async function resetServerTable() {
    if (backendKind !== 'local' || serverStatus !== 'connected' || !client.resetTable) {
      return;
    }
    await runAction('Resetting table...', async () => {
      zkHandFlow = null;
      zkHandFlowNumber = null;
      zkStatus = '';
      handResultView = null;
      localSeat = null;
      selectedSeat = '';
      return client.resetTable!();
    });
  }

  const showResetTable = $derived(backendKind === 'local' && serverStatus === 'connected');
  const showBridgeDebug = $derived(
    typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('debugBridge') === '1',
  );

  let clockNow = $state(Math.floor(Date.now() / 1000));
  let expireInFlight = false;
  let expireRetryAt = 0;
  let autoCheckedDeadline = 0;
  let autoCheckInFlight = false;
  $effect(() => {
    const id = setInterval(() => {
      clockNow = Math.floor(Date.now() / 1000);
    }, 1000);
    return () => clearInterval(id);
  });

  const turnClockLabel = $derived.by(() => {
    const deadline = gameState?.actDeadlineUnix ?? 0;
    if (!deadline || !gameState?.bettingRoundOpen) return '';
    const left = Math.max(0, deadline - clockNow);
    const minutes = Math.floor(left / 60);
    const seconds = left % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });

  async function maybeExpireBettingTurn(snapshot: GameSnapshot) {
    if (snapshot.backend !== 'solana' && snapshot.backend !== 'devnet') return;
    if (!snapshot.bettingRoundOpen || localSeat === null) return;
    const deadline = snapshot.actDeadlineUnix ?? 0;
    if (deadline <= 0 || clockNow <= deadline || autoCheckInFlight) return;
    if (expireInFlight || Date.now() < expireRetryAt) return;
    expireInFlight = true;
    try {
      const next = await client.expireBetTurn?.(snapshot.gameId);
      if (next) applySnapshot(next);
    } catch {
      expireRetryAt = Date.now() + 5_000;
    } finally {
      expireInFlight = false;
    }
  }

  const canAct = $derived(
    localSeat !== null &&
    gameState?.bettingRoundOpen === true &&
    gameState?.currentPlayerSeat === localSeat,
  );

  const callAmount = $derived(
    gameState && localSeat !== null ? callAmountForSeat(gameState, localSeat) : 0,
  );

  $effect(() => {
    const deadline = gameState?.actDeadlineUnix ?? 0;
    if (!shouldAutoCheckBeforeDeadline({
      canAct,
      callAmount,
      busy,
      deadlineUnix: deadline,
      nowUnix: clockNow,
      alreadySentForDeadline: autoCheckedDeadline,
    })) return;
    autoCheckedDeadline = deadline;
    autoCheckInFlight = true;
    pushEventLog('action', 'Auto-check with 3 seconds left');
    void bet('check').finally(() => {
      autoCheckInFlight = false;
    });
  });

  const minRaiseAdd = $derived(
    canAct && gameState?.minRaiseAdd ? Number(gameState.minRaiseAdd) : 0,
  );

  const raiseDisabled = $derived(
    busy || !canAct || (minRaiseAdd > 0 && raiseAmount < minRaiseAdd),
  );

  async function bootstrapJoinSeat(seat: number) {
    agentDebugLog('H3', 'Poker.svelte:bootstrapJoinSeat', 'start', { seat, gameId, tableConnected, serverStatus });
    if (!gameId) {
      if (!tableConnected) {
        await connectServer();
      } else {
        await connectToTable();
      }
    }
    if (!gameId) {
      throw new Error('[native-e2e] bootstrapJoinSeat: no gameId after connect');
    }
    const publicKey = playerPublicKey || getOrCreateLocalPublicKey();
    playerPublicKey = publicKey;
    selectedSeat = String(seat);
    const next = await client.joinGame(gameId, seat, publicKey);
    applySnapshot(next);
    localSeat = seat;
    agentDebugLog('H3', 'Poker.svelte:bootstrapJoinSeat', 'done', { seat, localSeat, seats: next.seats?.length ?? 0 });
  }

  async function bootstrapDepositChips(amount: number) {
    if (!gameId || localSeat === null) {
      throw new Error(`[native-e2e] bootstrapDepositChips blocked gameId=${gameId ?? 'null'} localSeat=${localSeat ?? 'null'}`);
    }
    if (onChain()) {
      const pk = playerPublicKey;
      if (!pk || !client.faucetCreditPersonal || !client.transferPersonalToSeat) {
        throw new Error('[native-e2e] solana escrow faucet/transfer unavailable');
      }
      await client.faucetCreditPersonal(gameId, pk, String(amount));
      logFaucetReceived(String(amount), pk, localSeat);
      const next = await client.transferPersonalToSeat(gameId, pk, String(amount));
      applySnapshot(next);
    } else {
      const next = await client.addChips(gameId, localSeat, String(amount));
      applySnapshot(next);
    }
    agentDebugLog('H3', 'Poker.svelte:bootstrapDepositChips', 'done', { localSeat, amount, backendKind });
  }

  async function maybeRunNativeE2eBootstrap() {
    logBridge('maybeRunNativeE2eBootstrap: entered');
    const { resolveNativeE2eBootstrap, runNativeE2eBootstrap } = await import('./poker/native-e2e-bootstrap');
    const config = await resolveNativeE2eBootstrap();
    const bridgeSnapAtRead = currentBridgeSnapshot();
    logBridge(`maybeRunNativeE2eBootstrap: read returned ${config ? 'config seat='+config.seat : 'null'} zkBridgeOk=${zkBridgeOk} atRead hasZero=${bridgeSnapAtRead.hasZero} invoke=${bridgeSnapAtRead.invoke}`);
    if (!config) {
      logBridge('maybeRunNativeE2eBootstrap: early return (no native bootstrap config)');
      return;
    }
    nativeAutoPlay = config.autoPlay;
    // Seating/chips only need HTTP + native server bridge; ZK phases wait on zkBridgeOk separately.
    if (!zkBridgeOk && bridgeSnapAtRead.hasZero) {
      resetZkRuntime();
      const p = await tryRefreshNativeBridge(2000);
      if (p.ok) {
        zkBridgeOk = true;
        waitingForBridge = false;
        logBridge('maybeRunNativeE2eBootstrap: bridge ping ok before bootstrap');
      }
    }
    if (config.autoPlay) {
      addChipsAmount = 5000;
    }
    logBridge('maybeRunNativeE2eBootstrap: starting runNativeE2eBootstrap');
    await runNativeE2eBootstrap({
      config,
      connectServer: connectServer,
      waitForReady: async () => {
        // Solana: first connect can take tens of seconds (module init + ensureRoom).
        const maxAttempts = onChain() ? 120 : 40;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (localServerReady) {
            return;
          }
          if (!busy) {
            await connectServer();
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(
          `[native-e2e] timed out waiting for ${backendKind} ready `
          + `(serverStatus=${serverStatus} tableConnected=${tableConnected}`
          + `${statusMessage ? ` status=${statusMessage}` : ''})`,
        );
      },
      rotateWallet: rotateWallet,
      selectSeat: (seat) => {
        selectedSeat = String(seat);
      },
      sitDown,
      addChips,
      joinSeat: bootstrapJoinSeat,
      depositChips: bootstrapDepositChips,
      fundPersonal: onChain()
        ? async (amount: number) => {
          const pk = playerPublicKey || getOrCreateLocalPublicKey();
          playerPublicKey = pk;
          if (!gameId || !client.faucetCreditPersonal) {
            throw new Error('[native-e2e] faucet unavailable before sit');
          }
          const next = await client.faucetCreditPersonal(gameId, pk, String(amount));
          applySnapshot(next);
          logFaucetReceived(String(amount), pk, null);
        }
        : undefined,
      startHand,
      isSeatedAtTarget: () => {
        // Hydrate may have replaced the onMount key — refresh before seat sync.
        if (backendKind === 'local' || onChain()) {
          playerPublicKey = getOrCreateLocalPublicKey();
        }
        syncLocalSeatFromState();
        return localSeat === config.seat;
      },
    });
    // Bootstrap hydrates `.local/e2e-wallet-seatN` after onMount minted/cached a key.
    if (backendKind === 'local' || onChain()) {
      playerPublicKey = getOrCreateLocalPublicKey();
    }
    syncLocalSeatFromState();
    pinE2eLocalSeatIfNeeded(gameState ?? undefined);
    if (config.autoPlay && localSeat === null) {
      localSeat = config.seat;
      pushEventLog('info', `Set localSeat=${config.seat} after native E2E bootstrap`);
    }
    logBridge(
      `maybeRunNativeE2eBootstrap: completed localSeat=${localSeat} pk=${playerPublicKey?.slice(0, 8) ?? 'null'}`,
    );
  }

  onMount(async () => {
    logBridge('onMount: entered');
    syncCompactNativeLayout();
    window.addEventListener('resize', syncCompactNativeLayout);
    // Capture very early view of globals right at onMount start (after previous awaits in Svelte mount)
    try {
      const earlySnap = (window as any).__zkBridgeDebug?.lastSnapshot || currentBridgeSnapshot();
      const earlyEventsLen = (window as any).__zkBridgeDebug?.events?.length ?? 'n/a';
      const earlyFirst = (window as any).__zkBridgeDebug?.firstSeenAt ?? null;
      logBridge(`onMount: early globals hasZero=${(earlySnap as any).hasZero ?? '??'} invoke=${(earlySnap as any).invoke ?? '??'} earlyEvents=${earlyEventsLen} firstSeen=${earlyFirst}`);
    } catch (e) { logBridge('onMount: early snap error ' + String(e)); }

    backendKind = resolveBackendKind();
    saveBackendKind(backendKind);
    gameKind = resolveUiGameKind();
    saveUiGameKind(gameKind);
    client = createClient(backendKind);
    if (backendKind === 'local' || onChain()) {
      if (usesLocalSeatKey()) {
        playerPublicKey = (await hydrateE2eWalletFromMeta()) || getOrCreateLocalPublicKey();
      } else {
        await refreshConnectedWallet();
      }
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const presetSeat = params.get('seat') ?? params.get('e2eSeat');
      if (presetSeat !== null && presetSeat !== '' && Number.isInteger(Number(presetSeat))) {
        selectedSeat = presetSeat;
      }
    }
    refreshView();

    // Brief wait for window.zero before server I/O (native / E2E only — skip in plain browser).
    let expectNativeBridge = false;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      expectNativeBridge =
        window.location.protocol === 'zero:'
        || typeof (window as any).zero?.invoke === 'function'
        || params.get('nativeE2e') === '1'
        || params.get('manualSetup') === '1'
        || params.get('iosE2eFullGame') === '1';
      if (expectNativeBridge) {
        for (let bridgeWait = 0; bridgeWait < 50; bridgeWait += 1) {
          if (typeof (window as any).zero?.invoke === 'function') {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }

    // === SERVER FIRST: connect before ZK ping/warmup (ping can block the bridge) ===
    logBridge(`onMount: pre-server backend=${backendKind}`);
    await refreshServerStatus();
    logBridge(`onMount: after refreshServerStatus status=${serverStatus}`);
    if ((backendKind === 'local' || onChain()) && !tableConnected) {
      logBridge(`onMount: calling connectServer() for backend=${backendKind}`);
      await connectServer();
      logBridge(`onMount: after connectServer tableConnected=${tableConnected} serverStatus=${serverStatus}`);
    } else if (
      (backendKind === 'local' || onChain())
      && serverStatus === 'connected'
      && !tableConnected
    ) {
      logBridge('onMount: calling connectToTable()');
      await connectToTable();
      logBridge(`onMount: after connectToTable tableConnected=${tableConnected}`);
    }
    serverPollTimer = setInterval(() => {
      void refreshServerStatus();
    }, 2000);

    // === BOOTSTRAP FIRST: seating/chips only need HTTP; ZK ping can hang on bridge invoke ===
    logBridge('onMount: bootstrap-before-ping (server connected)');
    agentDebugLog('H1', 'Poker.svelte:onMount', 'bootstrap before ZK ping', {
      tableConnected,
      serverStatus,
      search: typeof window !== 'undefined' ? window.location.search : '',
    });
    const { resolveNativeE2eBootstrap } = await import('./poker/native-e2e-bootstrap');
    const launchConfigPre = await resolveNativeE2eBootstrap();
    if (launchConfigPre?.autoPlay) {
      nativeAutoPlay = true;
    }
    await maybeRunNativeE2eBootstrap();
    agentDebugLog('H3', 'Poker.svelte:onMount', 'bootstrap returned', {
      localSeat,
      nativeAutoPlay,
      launchSeat: launchConfigPre?.seat ?? null,
    });
    logBridge(`onMount: bootstrap returned localSeat=${localSeat} nativeAutoPlay=${nativeAutoPlay}`);

    // === ZK BRIDGE CHECK (non-blocking timeout — must not stall bootstrap) ===
    logBridge('onMount: immediate bridge check (post-bootstrap)');
    const syncHas = (typeof window !== 'undefined' && typeof (window as any).zero?.invoke === 'function');
    if (syncHas) {
      zkBridgeOk = true;
      waitingForBridge = false;
      logBridge('onMount: sync hasNativeBridge=true -> zkBridgeOk set true immediately');
    }
    const initialPing = await tryRefreshNativeBridge(2000);
    if (initialPing.ok) {
      zkBridgeOk = true;
      waitingForBridge = false;
    }
    logBridge(`onMount: initialPing (timed) ok=${initialPing.ok} kind=${initialPing.kind} detail=${initialPing.detail ?? ''} zkBridgeOkNow=${zkBridgeOk}`);

    // If the *early inline script* (html-head) already saw window.zero before any Svelte code ran, force immediate.
    if (!zkBridgeOk) {
      try {
        const D = (window as any).__zkBridgeDebug;
        if (D && D.firstSeenAt) {
          zkBridgeOk = true;
          waitingForBridge = false;
          logBridge(`onMount: FORCED zkBridgeOk=true from early firstSeenAt=${D.firstSeenAt}`);
        }
      } catch {}
    }

    // Fast probe only when a native bridge is expected — never thrash plain browser tabs.
    if (!zkBridgeOk && expectNativeBridge) {
      waitingForBridge = true;
      logBridge('onMount: not yet -> starting FAST bridgeProbeTimer (10ms ticks for immediate)');
      bridgeProbeTimer = setInterval(async () => {
        const snap = currentBridgeSnapshot();
        logBridge(`probe: tick hasWin=${snap.hasWin} hasZero=${snap.hasZero} invoke=${snap.invoke}`);
        if (zkBridgeOk) {
          waitingForBridge = false;
          stopBridgeProbeTimer();
          return;
        }
        resetZkRuntime();
        const p = await tryRefreshNativeBridge(2000);
        logBridge(`probe: after reset+ping ok=${p.ok} kind=${p.kind}`);
        if (p.ok) {
          zkBridgeOk = true;
          waitingForBridge = false;
          if (gameState) {
            updateZkStatus(gameState);
          }
          logBridge('probe: success -> zkBridgeOk=true, calling maybeRunNativeE2eBootstrap');
          void maybeRunNativeE2eBootstrap();
          stopBridgeProbeTimer();
        }
      }, 10);  // very fast to appear "immediate"
    } else if (zkBridgeOk) {
      logBridge('onMount: bridge OK immediately (sync or first ping)');
    } else {
      waitingForBridge = false;
      logBridge('onMount: no native bridge expected (browser) — skip probe');
    }

    if ((backendKind === 'local' || onChain()) && serverStatus !== 'connected') {
      await connectServer();
    }

    void import('./poker/e2e-ui-report').then(({ startNativeUiHeartbeat }) => {
      startNativeUiHeartbeat(
        () => localSeat,
        () => ({
          holesAcked,
          zkBusy,
          shareComplete: Boolean(gameState?.zkReveal?.shareComplete),
        }),
      );
    });
    logBridge('onMount: complete');
    const onE2eSyncGame = () => {
      if (!gameId || (backendKind !== 'local' && !onChain())) {
        return;
      }
      void (async () => {
        if (!zkBridgeOk && typeof (window as any).zero?.invoke === 'function') {
          zkBridgeOk = true;
          waitingForBridge = false;
        }
        let snap = await client.getGame(gameId);
        applySnapshot(snap);
        syncLocalSeatFromState();
        if (nativeAutoPlay && localSeat !== null) {
          await runZkHandIfMyTurn(snap);
          snap = (await client.getGame(gameId)) ?? snap;
          applySnapshot(snap);
          syncLocalSeatFromState();
          await maybeAcknowledgeHoleCards(snap);
          await maybeAutoBet(snap);
          await maybeAutoAdvanceStreet(snap);
        }
      })().catch(() => {});
    };
    const onE2eBridgeReady = () => {
      zkBridgeOk = true;
      waitingForBridge = false;
      onE2eSyncGame();
    };
    const onE2eRunZk = () => {
      if (gameState && localSeat !== null && nativeAutoPlay) {
        void runZkHandIfMyTurn(gameState);
      }
    };
    window.addEventListener('e2e-sync-game', onE2eSyncGame);
    window.addEventListener('e2e-bridge-ready', onE2eBridgeReady);
    window.addEventListener('e2e-run-zk', onE2eRunZk);
    const blindPostTimer = window.setInterval(() => {
      if (!gameState || nativeAutoPlay || !shouldOpenPreflop(gameState)) return;
      void maybeAutoAdvanceStreet(gameState);
    }, 1000);
    return () => {
      stopWallets?.();
      window.clearInterval(blindPostTimer);
      window.removeEventListener('resize', syncCompactNativeLayout);
      window.removeEventListener('e2e-sync-game', onE2eSyncGame);
      window.removeEventListener('e2e-bridge-ready', onE2eBridgeReady);
      window.removeEventListener('e2e-run-zk', onE2eRunZk);
      disconnectTable();
      stopZkPollTimer();
      stopBridgeProbeTimer();
      if (serverPollTimer) {
        clearInterval(serverPollTimer);
      }
    };
  });
</script>

<div class="table-root" class:compact-native={compactNativeLayout} bind:this={tableRootEl}>
  <div class="table-toolbar">
  <div class="toolbar" data-testid="toolbar">
    <label>
      Backend
      <select
        data-testid="backend-select"
        value={backendKind}
        onchange={(e) => switchBackend((e.currentTarget as HTMLSelectElement).value as BackendKind)}
        disabled={busy}
      >
        <option value="local">Local TypeScript server</option>
        <option value="solana">Solana + Arcium localnet</option>
        <option value="devnet">Solana + Arcium devnet</option>
      </select>
    </label>
    <label>
      Game
      <select
        data-testid="game-kind-select"
        value={gameKind}
        onchange={(e) => switchGameKind((e.currentTarget as HTMLSelectElement).value as UiGameKind)}
        disabled={busy || handInProgress}
      >
        {#each UI_GAME_KIND_OPTIONS as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </label>
    {#if onChain()}
      <label>
        Room
        <select
          data-testid="room-select"
          value={selectedRoomId}
          onchange={(e) => {
            const roomIdHex = (e.currentTarget as HTMLSelectElement).value;
            const room = catalogRooms.find((entry) => entry.roomIdHex === roomIdHex);
            const tables = room?.tables ?? [];
            const tableId = tables.some((table) => table.tableId === selectedTableId)
              ? selectedTableId
              : tables[0]?.tableId ?? '';
            selectedRoomId = roomIdHex;
            selectedTableId = tableId;
            if (tableId) void openSelectedTable(roomIdHex, tableId);
          }}
          disabled={busy || handInProgress || catalogRooms.length === 0}
        >
          {#if catalogRooms.length === 0}
            <option value="">No rooms on this chain</option>
          {/if}
          {#each catalogRooms as room (room.roomIdHex)}
            <option value={room.roomIdHex}>{room.label}</option>
          {/each}
        </select>
      </label>
      <label>
        Table
        <select
          data-testid="table-select"
          value={selectedTableId}
          onchange={(e) => {
            const tableId = (e.currentTarget as HTMLSelectElement).value;
            selectedTableId = tableId;
            if (selectedRoomId && tableId) void openSelectedTable(selectedRoomId, tableId);
          }}
          disabled={busy || handInProgress || catalogTables.length === 0}
        >
          {#if catalogTables.length === 0}
            <option value="">No tables</option>
          {/if}
          {#each catalogTables as table (table.tableId)}
            <option value={table.tableId}>{table.label}</option>
          {/each}
        </select>
      </label>
    {/if}
    <span
      data-testid="server-status"
      class="server-status"
      class:connected={serverStatus === 'connected'}
      class:disconnected={serverStatus === 'disconnected'}
      class:starting={serverStatus === 'starting'}
      class:checking={serverStatus === 'checking'}
      title={serverDetail}
    >
      {#if serverStatus === 'checking'}
        {onChain() ? `${backendKind === 'devnet' ? 'Devnet' : 'Solana'}: checking…` : 'Server: checking…'}
      {:else if serverStatus === 'connected'}
        {onChain() ? `${backendKind === 'devnet' ? 'Devnet' : 'Solana'}: connected` : 'Server: connected'}
      {:else if serverStatus === 'starting'}
        {onChain() ? `${backendKind === 'devnet' ? 'Devnet' : 'Solana'}: connecting…` : 'Server: connecting…'}
      {:else}
        {onChain() ? `${backendKind === 'devnet' ? 'Devnet' : 'Solana'}: not connected` : 'Server: not connected'}
      {/if}
    </span>
    {#if showConnectServer}
      <button
        type="button"
        data-testid="connect-server"
        onclick={connectServer}
        disabled={busy || serverStatus === 'starting'}
      >
        {#if backendKind === 'devnet'}
          Connect to devnet
        {:else if onChain()}
          Connect to Solana
        {:else}
          Connect
        {/if}
      </button>
    {/if}
    {#if (backendKind === 'local' || onChain()) && usesLocalSeatKey()}
      <button
        type="button"
        data-testid="new-wallet"
        onclick={rotateWallet}
        disabled={busy || handInProgress}
        title="Generate a new wallet for this browser instance"
      >
        New wallet
      </button>
    {:else if backendKind === 'local' || onChain()}
      {#if playerPublicKey}
        <button
          type="button"
          data-testid="disconnect-wallet"
          onclick={disconnectPlayerWallet}
          disabled={busy || handInProgress}
        >
          Disconnect{walletLabel ? ` ${walletLabel}` : ''}
        </button>
      {:else}
        <button
          type="button"
          data-testid="connect-wallet"
          onclick={openWalletMenu}
          disabled={busy}
        >
          Connect wallet
        </button>
      {/if}
      {#if walletMenuOpen}
        <div class="wallet-menu" data-testid="wallet-menu">
          {#each walletChoices as choice (choice.name)}
            <button type="button" onclick={() => chooseWallet(choice.name)}>{choice.name}</button>
          {/each}
        </div>
      {/if}
    {/if}
    {#if playerPublicKey}
      <span class="player-id" data-testid="player-public-key" title={playerPublicKey}>
        You: {shortPublicKey(playerPublicKey)}
      </span>
    {/if}
    {#if backendKind === 'local' && tableConnected}
      <span class="game-id" data-testid="table-label">Local table</span>
    {/if}
    {#if backendKind === 'solana' && tableConnected}
      <span class="game-id" data-testid="table-label">Solana localnet table</span>
    {/if}
    {#if backendKind === 'devnet' && tableConnected}
      <span class="game-id" data-testid="table-label">Solana devnet table</span>
    {/if}
    {#if statusMessage}
      <span class="status">{statusMessage}</span>
    {/if}
  </div>
  </div>

  {#if tableStatusLine}
    <p
      class="table-status"
      data-testid="table-status"
      data-tone={tableStatus.tone}
      aria-live="polite"
    >{tableStatusLine}</p>
  {/if}

  <div class="table-viewport">
  <svg
    bind:this={tableSvgEl}
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1920 1080"
    preserveAspectRatio="xMidYMid meet"
    data-testid="poker-table"
    data-phase={view.phase}
    data-hand-complete={view.handComplete ? 'true' : 'false'}
    data-holes-acked={holesAcked ? 'true' : 'false'}
    data-zk-busy={zkBusy ? 'true' : 'false'}
    data-share-complete={gameState?.zkReveal?.shareComplete ? 'true' : 'false'}
    data-local-seat={localSeat ?? ''}
    data-game-kind={gameKind}
  >
    <defs>
      <linearGradient id="wood-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#8B5A2B" />
        <stop offset="100%" stop-color="#5A2E0D" />
      </linearGradient>
      <radialGradient id="felt-gradient" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#37A635" />
        <stop offset="100%" stop-color="#1F5E27" />
      </radialGradient>
      <linearGradient id="card-bg-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#1e3a8a" />
        <stop offset="100%" stop-color="#172554" />
      </linearGradient>
    </defs>

    <path d="M 360,100 H 1560 A 100,100 0 0 1 1560,640 H 360 A 100,100 0 0 1 360,100 Z" fill="url(#wood-gradient)" />
    <path d="M 380,100 H 1540 A 180,180 0 0 1 1540,720 H 380 A 180,180 0 0 1 380,100 Z" fill="url(#wood-gradient)" />
    <path d="M 420,150 H 1500 A 160,160 0 0 1 1500,670 H 420 A 160,160 0 0 1 420,150 Z" fill="url(#felt-gradient)" stroke="#333" stroke-width="4" />

    <text x="960" y={phaseLabelY} text-anchor="middle" font-size="28" fill="white" data-testid="game-phase-label">
      {view.phase} | current bet {view.currentBet}
    </text>

    <g id="pots">
      {#each view.pots as pot, index (index)}
        {@const yBase = 320 + index * 56}
        <text x="960" y={yBase} text-anchor="middle" font-size="28" fill="gold" data-testid={`table-pot-${index}`}>
          Pot {index + 1}: {pot.amount}
        </text>
        {#if pot.winnerPayouts && pot.winnerPayouts.length > 0}
          {#if pot.winnerPayouts.length > 1}
            <text
              x="960"
              y={yBase + 20}
              text-anchor="middle"
              font-size="16"
              fill="#fbbf24"
              data-testid={`table-pot-${index}-split`}
            >
              {pot.winnerLabel ?? pot.winnerPayouts.map((p) => p.name).join(' & ') + ' split'}
            </text>
          {/if}
          {#each pot.winnerPayouts as payout, payoutIndex (payout.seat)}
            <text
              x="960"
              y={yBase + (pot.winnerPayouts.length > 1 ? 38 : 22) + payoutIndex * 18}
              text-anchor="middle"
              font-size="18"
              fill="#4ade80"
              data-testid={`table-pot-${index}-winner-${payout.seat}`}
            >
              → {payout.name}{payout.handDescription ? ` (${payout.handDescription})` : ''}
            </text>
          {/each}
        {/if}
      {/each}
    </g>

    <TableSeats seats={view.seats} layout={tableLayout} onAvatarHover={handleAvatarHover} />
    <DealerButtons
      dealerSeats={view.dealerSeats ?? (view.dealerSeat >= 0 ? [view.dealerSeat] : [])}
      visible={view.showDealer}
      layout={tableLayout}
    />
    {#if usesRouletteLayout(gameKind)}
      <RouletteBoard
        bets={view.rouletteBets ?? []}
        result={view.sharedCards[0] ?? null}
        onCardHover={handleCardHover}
      />
    {:else if usesVersusDealerCards(gameKind)}
      <SharedCards
        cards={view.dealerCards ?? []}
        positions={tableLayout.dealerCards}
        testIdPrefix="dealer-card"
        cardWidth={80}
        cardHeight={108}
        onCardHover={handleCardHover}
      />
      <SharedCards
        cards={view.versusPlayerCards ?? []}
        positions={tableLayout.versusPlayerCards}
        testIdPrefix="versus-card"
        cardWidth={80}
        cardHeight={108}
        onCardHover={handleCardHover}
      />
    {:else if usesBlackjackLayout(gameKind)}
      <SharedCards
        cards={view.dealerCards ?? []}
        positions={tableLayout.dealerCards}
        testIdPrefix="dealer-card"
        cardWidth={80}
        cardHeight={108}
        onCardHover={handleCardHover}
      />
      <PlayerCards
        cardsBySeat={view.playerCards}
        positions={tableLayout.playerCards}
        onCardHover={handleCardHover}
      />
    {:else}
      <SharedCards cards={view.sharedCards} onCardHover={handleCardHover} />
      <PlayerCards cardsBySeat={view.playerCards} onCardHover={handleCardHover} />
    {/if}
  </svg>
  </div>

  <div class="table-below-band" style:--table-below-band="{TABLE_BELOW_BAND_PX}px">
    <div class="preview-dock">
      <CardHoverPreview
        card={hoveredCard}
        docked
        width={cardPreviewW}
        height={cardPreviewH}
        fontSize={cardPreviewFont}
      />
      <AvatarHoverPreview
        avatarId={hoveredAvatar?.avatarId ?? null}
        name={hoveredAvatar?.name ?? ''}
        docked
        size={avatarPreviewSize}
      />
    </div>
    <div class="hand-result-dock">
      <HandResultPanel
        result={handResultView}
        canStartNewHand={canStartNewHand}
        onStartNewHand={startHand}
      />
    </div>
    <div class="hand-lifecycle-panel" aria-live="polite">
      <h3>Hand Lifecycle</h3>
      {#if !zkBridgeOk}
        {#if bridgeDebugEarly.firstSeenAt}
          <p class="hand-lifecycle-status">Bridge seen early (firstSeenAt={bridgeDebugEarly.firstSeenAt}) — confirming…</p>
        {:else}
          <p class="hand-lifecycle-status">{waitingForBridge ? 'Waiting for ZK bridge…' : 'Hand setup unavailable'}</p>
        {/if}
      {/if}
      {#if gameState || zkStatus}
        <p class="hand-lifecycle-status" data-testid="hand-lifecycle-status">
          {gameState ? displayHandLifecycleStatus(gameState, zkBusy) : zkStatus}
        </p>
      {/if}

      <div class="event-log" data-testid="hand-event-log">
        <h4>Event log</h4>
        <div
          class="event-log-scroll"
          bind:this={eventLogScrollEl}
          onscroll={onEventLogScroll}
        >
          {#each handEventLog as ev (ev.id)}
            <div class="event-log-entry" data-kind={ev.kind}>
              <span class="event-log-time">{formatEventLogTime(ev.at)}</span>
              <span class="event-log-msg">{ev.message}</span>
            </div>
          {:else}
            <div class="event-log-empty">No events yet</div>
          {/each}
        </div>
      </div>

      {#if showBridgeDebug}
        <!-- Instrumentation: opt-in via ?debugBridge=1 -->
        <div class="bridge-debug" data-testid="bridge-debug">
          <div style="font-size:11px; opacity:0.9; margin:4px 0;">BRIDGE DEBUG (live)</div>
          <div style="font-size:11px;">
            zkBridgeOk: <strong>{zkBridgeOk}</strong> waiting: <strong>{waitingForBridge}</strong><br/>
            tableConnected: {tableConnected} server: {serverStatus}<br/>
            current hasZero: <strong>{currentBridgeSnapshot().hasZero}</strong> invoke: {currentBridgeSnapshot().invoke}<br/>
            early firstSeen: {bridgeDebugEarly.firstSeenAt ?? 'never'}<br/>
            early events#: {bridgeDebugEarly.eventsCount}
          </div>
          <div style="margin-top:4px; max-height: 120px; overflow:auto; font-family: monospace; font-size:9px; background:rgba(255,255,255,0.1); padding:2px;">
            {#each bridgeEvents.slice().reverse() as ev (ev.t + ev.msg)}
              <div>{ev.t} {ev.msg}</div>
            {/each}
            {#if bridgeEvents.length === 0}
              <div style="opacity:0.6">(no events yet)</div>
            {/if}
          </div>
          <div style="margin-top:2px;">
            <button type="button" onclick={() => { logBridge('manual re-ping'); pingZkRuntime().then(p => { zkBridgeOk = p.ok; logBridge('manual ping -> ' + JSON.stringify(p)); }); }} style="font-size:9px;">Force ping</button>
            <button type="button" onclick={() => { resetZkRuntime?.(); logBridge('manual reset + probe'); }} style="font-size:9px;">Reset runtime</button>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <div class="controls">
    <div class="sit-controls" data-testid="sit-controls">
      {#if isSeated}
        {#if canStandUp}
          <button type="button" data-testid="stand-up" onclick={standUp} disabled={busy}>
            Stand up
          </button>
        {/if}
      {:else if canPickSeat}
        <label class="sit-control">
          Seat
          <select
            data-testid="seat-select"
            bind:value={selectedSeat}
            disabled={seatSelectDisabled}
          >
            <option value="" disabled={selectedSeat !== ''}>Select seat…</option>
            {#each seatOptions as seat (seat)}
              <option value={String(seat)}>{seatLabel(seat)}</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          data-testid="sit-down"
          onclick={sitDown}
          disabled={sitDisabled || busy}
        >
          Sit
        </button>
      {/if}
      {#if onChain()}
        <span class="share-bond" data-testid="share-bond">
          Account {personalChips} chips · sit requires {minSitChips} · share bond {shareBondSol()} SOL
        </span>
      {/if}
    </div>
    <label class="raise">
      {onChain() ? 'Account (faucet)' : 'Add chips'}
      <input type="number" data-testid="add-chips-amount" bind:value={addChipsAmount} min="1" disabled={!gameId || (backendKind === 'local' && !localServerReady) || (onChain() && !tableConnected)} />
      <button type="button" data-testid="add-chips-submit" onclick={addChips} disabled={!gameId || (backendKind === 'local' && (localSeat === null || !localServerReady)) || (onChain() && !tableConnected)}>{onChain() ? 'Faucet' : 'Add'}</button>
    </label>
    <button type="button" data-testid="start-hand" onclick={startHand} disabled={!canStartHand}>
      {canStartNewHand ? 'Start new hand' : 'Start hand'}
    </button>
    {#if gameKind === 'poker'}
      <label class="sit-control" data-testid="auto-collect-blinds">
        <input
          type="checkbox"
          checked={autoCollectBlinds}
          onchange={(event) => setAutoCollectBlinds((event.currentTarget as HTMLInputElement).checked)}
        />
        Automatically collect blinds
      </label>
      <label class="sit-control" data-testid="opt-in-next-hand">
        <input
          type="checkbox"
          checked={optInNextHand}
          onchange={(event) => setOptInNextHand((event.currentTarget as HTMLInputElement).checked)}
        />
        Play the next hand
      </label>
    {/if}
    {#if sittingOutNextHand}
      <span data-testid="sitting-out">Sitting out until the stack covers the big blind</span>
    {/if}
    {#if blindHold}
      <span data-testid="blind-hold">Blinds wait until showdown is submitted and the hand is closed</span>
    {/if}
    {#if blindPrompt?.canPost}
      <button type="button" data-testid="post-blind" onclick={postBlind} disabled={busy}>
        Post {blindPrompt.role} blind ({blindPrompt.amount})
      </button>
    {/if}

    {#if turnClockLabel}
      <span data-testid="turn-clock">{turnClockLabel} to act</span>
    {/if}
    <button type="button" data-testid="fold" onclick={() => bet('fold')} disabled={busy || !canAct}>Fold</button>
    <button type="button" data-testid="check" onclick={() => bet('check')} disabled={busy || !canAct || callAmount > 0}>Check</button>
    <button type="button" data-testid="call" onclick={() => bet('call')} disabled={busy || !canAct || callAmount <= 0}>
      Call {callAmount > 0 ? callAmount : ''}
    </button>
    <label class="raise">
      Raise{minRaiseAdd > 0 ? ` (min +${minRaiseAdd})` : ''}
      <input type="number" data-testid="raise-amount" bind:value={raiseAmount} min="1" disabled={busy || !canAct} />
      <button type="button" data-testid="raise-submit" onclick={() => bet('raise', String(raiseAmount))} disabled={raiseDisabled}>Go</button>
    </label>
    {#if showResetTable}
      <button
        type="button"
        class="reset-table"
        data-testid="reset-server-table"
        onclick={resetServerTable}
        disabled={busy}
        title="Clear all seats and in-progress hand (local server testing)"
      >
        Reset table
      </button>
    {/if}
  </div>
</div>

<style>
  .table-root {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    min-height: 100vh;
    min-height: 100dvh;
    max-height: 100vh;
    max-height: 100dvh;
    overflow: hidden;
    background: #2a2a2a;
    box-sizing: border-box;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .table-toolbar {
    flex: 0 0 auto;
    padding: 16px 16px 8px;
  }

  .table-status {
    flex: 0 0 auto;
    margin: 0;
    padding: 2px 16px 8px;
    text-align: center;
    font-family: sans-serif;
    font-size: 22px;
    font-weight: 650;
    line-height: 1.3;
    color: #ffe6a8;
  }

  .table-status[data-tone='you'] {
    color: #b8f5b0;
  }

  .table-status[data-tone='seat'] {
    color: #ffffff;
  }

  .table-viewport {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  .table-viewport svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .table-below-band {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(var(--table-below-band, 416px), 38vh);
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr) minmax(340px, 380px);
    align-items: stretch;
    gap: 16px;
    padding: 0 16px 16px;
    overflow-y: auto;
  }

  .preview-dock {
    position: relative;
    width: 300px;
    height: 400px;
    grid-column: 1;
  }

  .hand-result-dock {
    grid-column: 2;
    justify-self: center;
    width: min(100%, 36rem);
    max-height: var(--table-below-band, 416px);
    overflow-y: auto;
  }

  .hand-lifecycle-panel {
    grid-column: 3;
    width: 100%;
    max-width: 380px;
    max-height: var(--table-below-band, 416px);
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 12px;
    background: rgba(0, 0, 0, 0.75);
    border-radius: 8px;
    color: white;
    font-family: sans-serif;
  }

  .toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    color: white;
    font-family: sans-serif;
  }

  .game-id, .status, .player-id {
    opacity: 0.85;
    font-size: 14px;
  }

  .player-id {
    font-family: ui-monospace, monospace;
  }

  .wallet-menu {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .server-status {
    font-size: 14px;
    font-family: sans-serif;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.25);
  }

  .server-status.connected {
    color: #b8f5b0;
    border-color: #3d8b37;
    background: rgba(55, 166, 53, 0.2);
  }

  .server-status.disconnected {
    color: #ffb4b4;
    border-color: #8b3d3d;
    background: rgba(166, 53, 53, 0.2);
  }

  .server-status.starting,
  .server-status.checking {
    color: #ffe6a8;
    border-color: #8b733d;
    background: rgba(166, 140, 53, 0.2);
  }

  .controls {
    position: static;
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    padding: 8px 16px 12px;
    background: #1e1e1e;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
  }

  .raise {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: white;
    font-family: sans-serif;
  }

  .raise input {
    width: 72px;
  }

  .sit-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .share-bond {
    font-size: 12px;
    opacity: 0.85;
  }

  .sit-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: white;
    font-family: sans-serif;
  }

  .reset-table {
    border-color: #8b4513;
    background: rgba(139, 69, 19, 0.35);
    color: #ffd8a8;
  }

  .hand-lifecycle-panel h3 {
    margin: 0 0 8px;
    font-size: 16px;
    flex: 0 0 auto;
  }

  .hand-lifecycle-status {
    font-size: 13px;
    margin: 6px 0;
    word-break: break-all;
    flex: 0 0 auto;
  }

  .event-log {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .event-log h4 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
    opacity: 0.9;
    flex: 0 0 auto;
  }

  .event-log-scroll {
    flex: 1 1 auto;
    min-height: 140px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    font-size: 11px;
    line-height: 1.35;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .event-log-entry {
    display: grid;
    grid-template-columns: 5.5em minmax(0, 1fr);
    gap: 8px;
    padding: 2px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .event-log-time {
    opacity: 0.55;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .event-log-msg {
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .event-log-entry[data-kind='error'] .event-log-msg {
    color: #ffb4b4;
  }

  .event-log-entry[data-kind='result'] .event-log-msg {
    color: #b8f5b0;
  }

  .event-log-entry[data-kind='phase'] .event-log-msg,
  .event-log-entry[data-kind='zk'] .event-log-msg {
    color: #ffe6a8;
  }

  .event-log-entry[data-kind='chain'] .event-log-msg {
    color: #9fd4ff;
  }

  .event-log-empty {
    opacity: 0.55;
    font-style: italic;
  }

  .bridge-debug {
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px solid rgba(255,255,255,0.2);
    font-size: 10px;
    line-height: 1.3;
  }

  /* Phone / narrow WebView: stack panels under the table instead of 900px desktop grid. */
  @media (max-width: 820px) {
    .table-root {
      --table-below-band: auto;
    }

    .table-toolbar {
      padding: 8px 10px 4px;
    }

    .toolbar {
      gap: 6px;
      font-size: 13px;
    }

    .table-viewport {
      flex: 1 1 auto;
      min-height: 0;
    }

    .table-below-band {
      min-height: 0;
      max-height: 38vh;
      overflow-y: auto;
      grid-template-columns: 1fr;
      gap: 8px;
      padding: 8px 10px 10px;
    }

    .preview-dock {
      display: none;
    }

    .hand-result-dock {
      grid-column: 1;
      width: 100%;
      max-height: none;
    }

    .hand-lifecycle-panel {
      grid-column: 1;
      max-width: none;
      max-height: none;
      padding: 8px 10px;
    }

    .controls {
      padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
    }

    .controls button,
    .controls select,
    .controls input {
      font-size: 12px;
      padding: 4px 8px;
    }
  }

  .table-root.compact-native {
    --table-below-band: auto;
  }

  .table-root.compact-native .table-viewport {
    flex: 1 1 auto;
    min-height: 0;
  }

  .table-root.compact-native .table-below-band {
    min-height: 0;
    max-height: 34vh;
    overflow-y: auto;
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 8px 10px 10px;
  }

  .table-root.compact-native .preview-dock {
    display: none;
  }

  .table-root.compact-native .hand-result-dock,
  .table-root.compact-native .hand-lifecycle-panel {
    grid-column: 1;
    max-width: none;
  }

  .table-root.compact-native .hand-lifecycle-panel {
    max-height: min(34vh, 280px);
    overflow: hidden;
  }

  .table-root.compact-native .event-log-scroll {
    min-height: 100px;
  }
</style>
