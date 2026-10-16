/**
 * Arcium mempool HeapFull (error 6602 / 0x19ca) under concurrent
 * RevealCard → QueueComputation.
 *
 * Observed 10p failure (`/tmp/zk-poker-timing-10p.log`):
 *   [reveal] recipients=10 parallel=true W=3
 *   [reveal] r0/r1/r2 2 cards parallel W=2
 * → overlapping queue_reveal txs → mempool_zc.rs HeapFull.
 *
 * Solana `requestHeapFrame` does not fix this — it is Arcium's computation
 * mempool that fills, not the BPF heap.
 */

/** Anchor / Arcium custom error number for mempool heap exhaustion. */
export const ARCIUM_HEAP_FULL_CODE = 6602;

/** Hex form of 6602 as seen in Solana custom program errors. */
export const ARCIUM_HEAP_FULL_HEX = '0x19ca';

/**
 * Max simultaneous QueueComputation submissions on localnet.
 * Product of recipient×card×limb concurrency above this flooded the mempool
 * on the 10p continuous hand (W=3×2 with parallel limbs).
 */
export const SAFE_REVEAL_QUEUE_IN_FLIGHT = 2;

/**
 * Devnet MXE (cluster offset from `ARCIUM_CLUSTER_OFFSET`) accepts a wider
 * queue than the local Docker mempool. Share folds and reveal cards use this
 * as their combined in-flight budget when `E2E_CLUSTER=devnet`.
 */
export const DEVNET_ARCIUM_IN_FLIGHT = 8;

/**
 * Keno publishes one `reveal_card` job per drawn number. The draw is 20,
 * and those jobs do not depend on each other, so devnet queues the whole
 * draw at once. The keno vault float covers this many computation accounts.
 */
export const KENO_REVEAL_IN_FLIGHT = 20;

/** Default recipient/card/limb concurrency for N>2 on localnet (serial Arcis queue). */
export const SAFE_REVEAL_CONCURRENCY_N_GT_2 = 1;

/** True for the devnet e2e harness. Localnet stays on the HeapFull-safe defaults. */
export function devnetArcis(): boolean {
  return process.env.E2E_CLUSTER === 'devnet' || process.env.ARCIUM_CLUSTER === 'devnet';
}

/** In-flight QueueComputation cap. Env overrides win over the cluster default. */
export function arciumInFlightCap(): number {
  const fallback = devnetArcis() ? DEVNET_ARCIUM_IN_FLIGHT : SAFE_REVEAL_QUEUE_IN_FLIGHT;
  return envInt(
    'ARCIUM_QUEUE_IN_FLIGHT',
    envInt('REVEAL_QUEUE_IN_FLIGHT', fallback),
  );
}

/**
 * How many queue transactions may be in flight together.
 * On devnet this is the keno draw, 20. A reveal must be able to submit the
 * whole wave before any of those callbacks return. Share still starts at most
 * {@link DEVNET_ARCIUM_IN_FLIGHT} workers; localnet stays at the HeapFull cap.
 */
export function arciumQueueGateMax(): number {
  const cap = arciumInFlightCap();
  if (!devnetArcis()) return cap;
  return Math.max(cap, KENO_REVEAL_IN_FLIGHT);
}

export function isArciumHeapFull(err: unknown): boolean {
  const anyErr = err as {
    message?: string;
    logs?: string[];
    errorLogs?: string[];
    error?: { errorCode?: { number?: number }; errorMessage?: string };
    errorCode?: { number?: number };
  };
  const num =
    anyErr?.error?.errorCode?.number ??
    anyErr?.errorCode?.number;
  if (num === ARCIUM_HEAP_FULL_CODE) return true;

  const blob = [
    anyErr?.message,
    anyErr?.error?.errorMessage,
    ...(anyErr?.logs ?? []),
    ...(anyErr?.errorLogs ?? []),
  ]
    .filter(Boolean)
    .join('\n');

  if (/HeapFull|Heap is full/i.test(blob)) return true;
  if (new RegExp(`\\b${ARCIUM_HEAP_FULL_CODE}\\b|${ARCIUM_HEAP_FULL_HEX}`, 'i').test(blob)) {
    return true;
  }
  return false;
}

/** Resolve env int or fall back; always ≥ 1. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Default / env-resolved reveal concurrency for continuous + phased paths.
 * N>2 defaults to 1 so hole-card parallelization cannot flood the mempool
 * unless REVEAL_* env vars are raised (still gated by {@link revealQueueGate}).
 */
export function revealRecipientConcurrency(
  numPlayers: number,
  canParallelRecipients: boolean,
): number {
  if (!canParallelRecipients) return 1;
  // Devnet N>2: two recipients at a time. 2p already runs both seats.
  const fallback = numPlayers === 2
    ? numPlayers
    : devnetArcis()
      ? Math.min(2, numPlayers)
      : SAFE_REVEAL_CONCURRENCY_N_GT_2;
  return envInt('REVEAL_RECIPIENT_CONCURRENCY', fallback);
}

export function revealCardConcurrency(numPlayers: number, cardCount: number): number {
  const cards = Math.max(cardCount, 1);
  // 2p: every card in the batch. Devnet N>2: up to 4 cards (with 2 recipients
  // that fills DEVNET_ARCIUM_IN_FLIGHT). Localnet N>2 stays serial.
  const fallback = numPlayers > 2
    ? (devnetArcis() ? Math.min(4, cards) : SAFE_REVEAL_CONCURRENCY_N_GT_2)
    : cards;
  return envInt('REVEAL_CARD_CONCURRENCY', fallback);
}

export function revealLimbConcurrency(_numPlayers?: number): number {
  // Limbs of one card share a RevealedCard account. Keep this at 1 on devnet
  // too — the first job creates the PDA, and parallel limbs were the 10p flood.
  return envInt('REVEAL_LIMB_CONCURRENCY', SAFE_REVEAL_CONCURRENCY_N_GT_2);
}

/**
 * Simultaneous Groth16 proves. The native engine keeps this many
 * witness calculators and provers per circuit, and the bridge runs each
 * prove on its own thread. Shuffle stays one seat at a time in the hand.
 */
export function groth16ProveConcurrency(): number {
  return envInt('GROTH16_PROVE_CONCURRENCY', 2);
}

/**
 * How many players may run Arcis share-verify at once.
 * `localFallback` is the localnet width (1 for casino hands, 3 or 5 for poker).
 * Devnet overlaps every seat, capped by {@link DEVNET_ARCIUM_IN_FLIGHT}.
 */
export function sharePlayerConcurrency(numPlayers: number, localFallback: number): number {
  if (process.env.SHARE_VERIFY_PLAYER_CONCURRENCY) {
    return envInt('SHARE_VERIFY_PLAYER_CONCURRENCY', localFallback);
  }
  if (devnetArcis()) {
    return Math.min(DEVNET_ARCIUM_IN_FLIGHT, Math.max(1, numPlayers));
  }
  return Math.max(1, localFallback);
}

/**
 * Share-fold jobs in flight for one player.
 * Localnet is 1 (write, queue, wait). Devnet splits the in-flight budget
 * across the players already running, so 2p gets 4 folds each.
 */
export function shareChunkConcurrency(playerConcurrency: number): number {
  if (process.env.SHARE_CHUNK_CONCURRENCY) {
    return envInt('SHARE_CHUNK_CONCURRENCY', 1);
  }
  if (!devnetArcis()) return 1;
  const players = Math.max(1, Math.floor(playerConcurrency));
  return Math.max(1, Math.floor(DEVNET_ARCIUM_IN_FLIGHT / players));
}

/**
 * Casino `reveal_card` width. Localnet stays serial. Devnet runs up to the
 * in-flight budget; the queue gate still spaces the submissions.
 */
export function casinoRevealConcurrency(cardCount: number): number {
  const cards = Math.max(cardCount, 1);
  const fallback = devnetArcis() ? Math.min(DEVNET_ARCIUM_IN_FLIGHT, cards) : 1;
  return envInt('CASINO_REVEAL_CONCURRENCY', fallback);
}

/**
 * Keno draw width. One card is `(numPlayers-1)` limb jobs, and every job stays
 * open until it finalizes. Devnet queues as many cards as fit in
 * {@link KENO_REVEAL_IN_FLIGHT}; a 2-player draw is one job per card, so all
 * 20 go at once. Localnet stays serial.
 */
export function kenoRevealConcurrency(cardCount: number, numPlayers = 2): number {
  const cards = Math.max(cardCount, 1);
  const jobsPerCard = Math.max(1, Math.floor(numPlayers) - 1);
  const width = Math.max(1, Math.floor(KENO_REVEAL_IN_FLIGHT / jobsPerCard));
  const fallback = devnetArcis() ? Math.min(width, cards) : 1;
  return envInt('KENO_REVEAL_CONCURRENCY', fallback);
}

/**
 * Product of the three reveal concurrency knobs. Localnet N>2 stays at
 * {@link SAFE_REVEAL_CONCURRENCY_N_GT_2}^3 (= 1). Devnet raises recipient
 * and card width; limb width stays 1.
 */
export function revealConcurrencyProduct(
  numPlayers: number,
  cardCount: number,
  canParallelRecipients = true,
): number {
  return (
    revealRecipientConcurrency(numPlayers, canParallelRecipients) *
    revealCardConcurrency(numPlayers, cardCount) *
    revealLimbConcurrency(numPlayers)
  );
}

/** Simple async semaphore for in-flight QueueComputation submissions. */
export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {
    if (max < 1) throw new Error('AsyncSemaphore max must be >= 1');
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * Client-side Arcis QueueComputation priority.
 *
 * - `high`: live-hand blocking (reveal, showdown seal, compute_pots, bets)
 * - `low`: background next-hand critical path (share verify / staging queues)
 *
 * High waiters always take free slots before low. Low never blocks high from
 * entering when a slot frees (HeapFull-safe in-flight cap still applies).
 *
 * Arcium also supports on-chain `cu_price_micro` priority fees; the poker
 * program currently hardcodes `0`. Client gate is the localnet safety net;
 * plumbing higher cu_price for `high` is a follow-up.
 */
export type ArciumQueuePriority = 'high' | 'low';

export class PriorityArciumQueue {
  private active = 0;
  private readonly highWaiters: Array<() => void> = [];
  private readonly lowWaiters: Array<() => void> = [];

  max: number;

  constructor(max: number) {
    if (max < 1) throw new Error('PriorityArciumQueue max must be >= 1');
    this.max = max;
  }

  /** Pick up a wider cap. Waiters already blocked recheck on the next release. */
  widen(max: number): void {
    if (max < 1) throw new Error('PriorityArciumQueue max must be >= 1');
    if (max <= this.max) return;
    this.max = max;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.max) {
      const nextHigh = this.highWaiters.shift();
      if (nextHigh) {
        this.active++;
        nextHigh();
        continue;
      }
      if (this.lowWaiters.length === 0) return;
      const nextLow = this.lowWaiters.shift()!;
      this.active++;
      nextLow();
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get highWaiting(): number {
    return this.highWaiters.length;
  }

  get lowWaiting(): number {
    return this.lowWaiters.length;
  }

  async run<T>(priority: ArciumQueuePriority, fn: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private canStart(priority: ArciumQueuePriority): boolean {
    if (this.active >= this.max) return false;
    if (priority === 'high') return true;
    // Low only starts when no high is waiting for a slot.
    return this.highWaiters.length === 0;
  }

  private async acquire(priority: ArciumQueuePriority): Promise<void> {
    if (this.canStart(priority)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      if (priority === 'high') this.highWaiters.push(resolve);
      else this.lowWaiters.push(resolve);
    });
    // Waker already reserved the slot (incremented active).
  }

  private release(): void {
    this.active--;
    const nextHigh = this.highWaiters.shift();
    if (nextHigh) {
      this.active++;
      nextHigh();
      return;
    }
    if (this.active < this.max && this.lowWaiters.length > 0) {
      const nextLow = this.lowWaiters.shift()!;
      this.active++;
      nextLow();
    }
  }
}

/**
 * Shared Arcis QueueComputation gate (override via ARCIUM_QUEUE_IN_FLIGHT or
 * legacy REVEAL_QUEUE_IN_FLIGHT). Devnet widens to the keno draw so a 20-card
 * reveal is not cut into callback waves of {@link DEVNET_ARCIUM_IN_FLIGHT}.
 */
export const arciumQueueGate = new PriorityArciumQueue(arciumQueueGateMax());

/**
 * Backward-compat high-priority wrapper used by reveal paths.
 * Prefer `arciumQueueGate.run('high' | 'low', …)` for new code.
 */
export const revealQueueGate = {
  get max(): number {
    return arciumQueueGate.max;
  },
  get inFlight(): number {
    return arciumQueueGate.inFlight;
  },
  run<T>(fn: () => Promise<T>): Promise<T> {
    arciumQueueGate.widen(arciumQueueGateMax());
    return arciumQueueGate.run('high', fn);
  },
};

/**
 * Retry wrapper that backs off harder on HeapFull (mempool must drain) and
 * still retries other transient RPC failures with linear backoff.
 */
export async function withArciumMempoolRetry(
  fn: () => Promise<void>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 8;
  const delayMs = opts.delayMs ?? 750;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
      if (attempt === retries) break;
      const heapFull = isArciumHeapFull(e);
      const wait = heapFull
        ? delayMs * 2 ** Math.min(attempt, 5)
        : delayMs * (attempt + 1);
      if (heapFull) {
        console.log(
          `[arcium] HeapFull (6602) — retry ${attempt + 1}/${retries} after ${wait}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
