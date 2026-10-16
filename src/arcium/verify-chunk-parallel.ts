/**
 * Helpers for parallel verify_deck_hash_chunk queueing + contrib accumulation.
 */

/** Run async work over items with a fixed concurrency limit. */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (concurrency < 1) throw new Error('concurrency must be >= 1');
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

/** Retry a transient RPC/mempool failure a few times. */
export async function withRetry(
  fn: () => Promise<void>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 5;
  const delayMs = opts.delayMs ?? 250;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw last;
}

/** Mirror on-chain `add_u256_le` (LE u128 limbs, no field reduction). */
export function addU256Le(acc: bigint, contribLow: bigint, contribHigh: bigint): bigint {
  const mask = (1n << 128n) - 1n;
  const aLow = acc & mask;
  const aHigh = acc >> 128n;
  const sumLow = aLow + contribLow;
  const carry = sumLow >> 128n;
  const newLow = sumLow & mask;
  const newHigh = aHigh + contribHigh + carry;
  return newLow + (newHigh << 128n);
}

export function splitU128Halves(value: bigint): { low: bigint; high: bigint } {
  return {
    low: value & ((1n << 128n) - 1n),
    high: value >> 128n,
  };
}

/** Chunk starts (multiples of chunkLen) whose first verify bit is not set. */
export function missingVerifyChunkStarts(
  bits: Array<bigint | number | { toString(): string }>,
  chunkLen = 10,
): number[] {
  const missing: number[] = [];
  for (let start = 0; start < 900; start += chunkLen) {
    const raw = bits[start >> 6];
    const word = typeof raw === 'bigint' ? raw : BigInt(raw?.toString() ?? '0');
    if ((word & (1n << BigInt(start & 63))) === 0n) missing.push(start);
  }
  return missing;
}

export type ShareVerifyChunk = {
  startIndex: number;
  limbCount: number;
  ciphertexts: ReadonlyArray<Uint8Array>;
};

/**
 * Run `background` while `foreground` runs. Both settle before this returns.
 * A foreground failure is the error that propagates when both fail.
 */
export async function afterBackground<T>(
  background: Promise<unknown>,
  foreground: () => Promise<T>,
): Promise<T> {
  // Attach a handler so a background rejection during foreground is not unhandled.
  background.catch(() => {});
  let foregroundError: unknown;
  let foregroundOk = false;
  let result!: T;
  try {
    result = await foreground();
    foregroundOk = true;
  } catch (e) {
    foregroundError = e;
  }
  try {
    await background;
  } catch (e) {
    if (foregroundOk) throw e;
  }
  if (!foregroundOk) throw foregroundError;
  return result;
}

/**
 * Write share folds and queue Arcis verify jobs.
 *
 * Writes stay in seat order, but the first folds are queued as soon as their
 * rows land — later writes overlap the first MXE wave. Queue submissions for
 * one player take the accumulator account, so they run under a lock. The waits
 * do not. `concurrency` is how many of those waits stay in flight.
 *
 * A fold whose siblings have already returned is re-queued at
 * `SHARE_VERIFY_STALL_MS` (default 40s) instead of sitting for the hard
 * timeout. A wave where nothing has returned still waits the hard timeout.
 */
export async function runShareVerifyChunks(opts: {
  rows: ReadonlyArray<ShareVerifyChunk>;
  playerIndex: number;
  /** Extra label, e.g. `:c0` for a blackjack chunk round. */
  label?: string;
  concurrency: number;
  maxAttempts?: number;
  /** Hard cap for one fold attempt. Default 180s. */
  hardTimeoutMs?: number;
  writeRow: (row: ShareVerifyChunk) => Promise<void>;
  queueChunk: (row: ShareVerifyChunk) => Promise<void>;
  isDone: (startIndex: number) => Promise<boolean>;
  waitDone: (startIndex: number, timeoutMs: number) => Promise<void>;
}): Promise<void> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const maxAttempts = opts.maxAttempts
    ?? Number(process.env.SHARE_VERIFY_CHUNK_ATTEMPTS ?? '3');
  const hardTimeoutMs = Number.isFinite(opts.hardTimeoutMs)
    ? opts.hardTimeoutMs!
    : 180_000;
  const stallMs = Number(process.env.SHARE_VERIFY_STALL_MS ?? '40000');
  console.log(
    `[share-verify] p${opts.playerIndex}${opts.label ?? ''} ${opts.rows.length} chunks W=${concurrency} stallMs=${stallMs}`,
  );

  // Serial writes, started immediately so the first queued jobs overlap the rest.
  let writeChain: Promise<void> = Promise.resolve();
  const ready: Promise<void>[] = [];
  for (const row of opts.rows) {
    const rowReady = writeChain.then(() =>
      withRetry(() => opts.writeRow(row), { retries: 5, delayMs: 500 }),
    );
    writeChain = rowReady;
    ready.push(rowReady);
  }

  let queueLock: Promise<void> = Promise.resolve();
  const queueLocked = async (row: ShareVerifyChunk): Promise<void> => {
    const prev = queueLock;
    let release!: () => void;
    queueLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      await withRetry(() => opts.queueChunk(row), { retries: 5, delayMs: 500 });
    } finally {
      release();
    }
  };

  let completedSiblings = 0;
  const waitForRow = async (startIndex: number): Promise<void> => {
    const started = performance.now();
    while (performance.now() - started < hardTimeoutMs) {
      const elapsed = performance.now() - started;
      const siblingsDone = concurrency > 1 && completedSiblings > 0;
      if (siblingsDone && Number.isFinite(stallMs) && elapsed >= stallMs) {
        throw new Error(
          `Arcium callback timed out after ${Math.round(elapsed)}ms (sibling stall ${stallMs}ms) start=${startIndex}`,
        );
      }
      const remaining = hardTimeoutMs - elapsed;
      const slice = siblingsDone
        ? Math.min(remaining, Math.max(500, stallMs - elapsed))
        : Math.min(remaining, 5_000);
      try {
        await opts.waitDone(startIndex, Math.max(500, slice));
        completedSiblings += 1;
        return;
      } catch (e: unknown) {
        if (await opts.isDone(startIndex)) {
          completedSiblings += 1;
          return;
        }
        const msg = String((e as { message?: string })?.message ?? e);
        if (!msg.includes('timed out')) throw e;
      }
    }
    throw new Error(
      `Arcium callback timed out after ${hardTimeoutMs}ms start=${startIndex}`,
    );
  };

  try {
    await mapPool(opts.rows, concurrency, async (row, index) => {
      await ready[index];
      let chunkDone = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (await opts.isDone(row.startIndex)) {
          chunkDone = true;
          completedSiblings += 1;
          break;
        }
        await queueLocked(row);
        try {
          await waitForRow(row.startIndex);
          chunkDone = true;
          break;
        } catch (e: unknown) {
          if (await opts.isDone(row.startIndex)) {
            chunkDone = true;
            completedSiblings += 1;
            break;
          }
          const msg = String((e as { message?: string })?.message ?? e);
          if (!msg.includes('timed out') || attempt === maxAttempts) throw e;
          const why = msg.includes('sibling stall') ? 'sibling stall' : 'timed out';
          console.warn(
            `[share-verify] p${opts.playerIndex} start${row.startIndex} attempt ${attempt}/${maxAttempts} ${why} — re-queue`,
          );
        }
      }
      if (!chunkDone) {
        throw new Error(
          `share verify chunk never completed player=${opts.playerIndex} start=${row.startIndex}`,
        );
      }
    });
  } finally {
    await writeChain.catch(() => {});
  }
}

/** True when the verify bit for `startIndex` is set. */
export function isVerifyChunkStartDone(
  bits: Array<bigint | number | { toString(): string }>,
  startIndex: number,
): boolean {
  const raw = bits[startIndex >> 6];
  // Prefer toString() so Anchor BN stays exact. Never coerce u64 through Number.
  const word = typeof raw === 'bigint' ? raw : BigInt(raw?.toString() ?? '0');
  return (word & (1n << BigInt(startIndex & 63))) !== 0n;
}

/** Indices in 0..899 whose verify bit is not set (callback not applied). */
export function missingVerifyIndices(
  bits: Array<bigint | number | { toString(): string }>,
): number[] {
  const missing: number[] = [];
  for (let i = 0; i < 900; i++) {
    const raw = bits[i >> 6];
    const word = typeof raw === 'bigint' ? raw : BigInt(raw?.toString() ?? '0');
    if ((word & (1n << BigInt(i & 63))) === 0n) missing.push(i);
  }
  return missing;
}

export function isChannelClosedError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e).toLowerCase();
  return (
    msg.includes('channel closed') ||
    msg.includes('channel error') ||
    msg.includes('abortedcomputation') ||
    msg.includes('aborted computation')
  );
}

export function isVerifyStallError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e).toLowerCase();
  return msg.includes('stalled') || msg.includes('timed out');
}

export type AdaptiveVerifySchedulerOpts = {
  initialWindow: number;
  /** Cap when bumping mid-run (localnet died at 8 historically). */
  maxWindow?: number;
  /** After this many stall events, force W=1. */
  maxStallsBeforeSequential?: number;
  /** Bump window once after this many successful chunks with no stalls. */
  bumpAfterSuccesses?: number;
};

/**
 * Adaptive in-flight window for verify_deck_hash_chunk.
 * Starts at `initialWindow`, backs off on stalls, forces W=1 on peer channel deaths.
 */
export class AdaptiveVerifyScheduler {
  window: number;
  readonly maxWindow: number;
  readonly maxStallsBeforeSequential: number;
  readonly bumpAfterSuccesses: number;
  forceSequential = false;
  stallCount = 0;
  successCount = 0;
  private bumped = false;

  constructor(opts: AdaptiveVerifySchedulerOpts) {
    this.window = Math.max(1, Math.floor(opts.initialWindow));
    this.maxWindow = Math.max(1, opts.maxWindow ?? 4);
    this.maxStallsBeforeSequential = opts.maxStallsBeforeSequential ?? 2;
    this.bumpAfterSuccesses = opts.bumpAfterSuccesses ?? 12;
    if (this.window > this.maxWindow) this.window = this.maxWindow;
  }

  get concurrency(): number {
    return this.forceSequential ? 1 : this.window;
  }

  noteChannelError(): void {
    this.forceSequential = true;
    this.window = 1;
  }

  noteStall(): void {
    this.stallCount += 1;
    this.window = Math.max(1, this.window - 1);
    if (this.stallCount >= this.maxStallsBeforeSequential) {
      this.forceSequential = true;
      this.window = 1;
    }
  }

  noteChunkSuccess(): void {
    this.successCount += 1;
    if (
      !this.forceSequential &&
      this.stallCount === 0 &&
      !this.bumped &&
      this.successCount >= this.bumpAfterSuccesses &&
      this.window < this.maxWindow
    ) {
      this.window += 1;
      this.bumped = true;
    }
  }
}

/** p50 / p95 from a latency sample (ms). */
export function latencyPercentiles(samplesMs: number[]): { p50: number; p95: number; n: number } {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, n: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[idx]!;
  };
  return { p50: at(0.5), p95: at(0.95), n: sorted.length };
}
