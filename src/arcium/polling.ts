import { type AnchorProvider, type Program, web3 } from '@coral-xyz/anchor';
import { isVerifyChunkStartDone } from './verify-chunk-parallel';

/**
 * Waits for Arcium callback completion via on-chain state or program events.
 *
 * Prefer `waitForEvent` when the program emits a completion event (e.g.
 * `RevealCardEvent`) — that avoids polling account state after the callback.
 */
export class ArciumPollingHelper {
  constructor(private provider: AnchorProvider) {}

  async waitForCallback<T>(
    accountPDA: web3.PublicKey,
    fetchFn: (pda: web3.PublicKey) => Promise<T>,
    condition: (state: T) => boolean,
    options: { timeout?: number; interval?: number } = {}
  ): Promise<T> {
    // Guard NaN from Number('120_000')-style env parsing (underscores → NaN).
    const timeout = Number.isFinite(options.timeout) ? options.timeout! : 60_000;
    const interval = Number.isFinite(options.interval) ? options.interval! : 2_000;
    // performance.now() is monotonic; Date.now() can jump forward under sleep /
    // VM pause and falsely trip long Arcis chunk timeouts (seen on 10p start600).
    const start = performance.now();

    while (performance.now() - start < timeout) {
      try {
        const state = await fetchFn(accountPDA);
        if (condition(state)) {
          return state;
        }
      } catch {
        // Account may not exist yet; keep polling
      }
      await new Promise(r => setTimeout(r, interval));
    }

    // Final confirmed read before giving up — callback may have landed on the
    // last interval boundary while a prior fetch was mid-flight.
    try {
      const state = await fetchFn(accountPDA);
      if (condition(state)) {
        return state;
      }
    } catch {
      // fall through
    }

    throw new Error(
      `Arcium callback timed out after ${timeout}ms for ${accountPDA.toBase58()}`
    );
  }

  async waitForPhase(
    accountPDA: web3.PublicKey,
    fetchFn: (pda: web3.PublicKey) => Promise<any>,
    targetPhase: number,
    options?: { timeout?: number; interval?: number }
  ): Promise<any> {
    return this.waitForCallback(
      accountPDA,
      fetchFn,
      (state) => state.phase === targetPhase,
      options
    );
  }

  /**
   * Resolve when a matching program event is emitted.
   * Subscribe before queueing the computation that will emit it.
   */
  async waitForEvent<T = any>(
    program: Program,
    eventName: string,
    condition: (event: T) => boolean = () => true,
    options: { timeout?: number } = {},
  ): Promise<T> {
    const timeout = options.timeout ?? 180_000;
    let listenerId: number | undefined;

    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Event "${eventName}" timed out after ${timeout}ms`));
        }, timeout);

        listenerId = program.addEventListener(eventName as any, (event: T) => {
          try {
            if (condition(event)) {
              clearTimeout(timer);
              resolve(event);
            }
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });
      });
    } finally {
      if (listenerId !== undefined) {
        await program.removeEventListener(listenerId).catch(() => {});
      }
    }
  }

  /** Await `RevealCardEvent` for a fully filled card (`count` = total limbs). */
  async waitForRevealCardEvent(
    program: Program,
    cardIndex: number,
    totalCount: number,
    recipientIndex?: number,
    options?: { timeout?: number },
  ): Promise<{ cardIndex: number; recipientIndex: number; count: number }> {
    return this.waitForEvent(
      program,
      'revealCardEvent',
      (event: any) => {
        const idx = Number(event.cardIndex ?? event.card_index);
        const recipient = Number(event.recipientIndex ?? event.recipient_index ?? -1);
        const count = Number(event.count);
        return idx === cardIndex
          && (recipientIndex === undefined || recipient === recipientIndex)
          && count >= totalCount;
      },
      options,
    );
  }

  /**
   * Wait until `verify_progress` reaches `target` (or verified) via account poll,
   * optionally driven by VerifyDeckHashChunkEvent wakeups.
   */
  async waitForVerifyProgress(
    program: Program,
    gameStatePda: web3.PublicKey,
    fetchFn: () => Promise<any>,
    targetProgress: number,
    options: { timeout?: number; interval?: number; stallMs?: number } = {},
  ): Promise<any> {
    const timeout = options.timeout ?? 300_000;
    const interval = options.interval ?? 2_000;
    // If set, throw when verifyProgress does not advance for this long
    // (even if overall timeout has not elapsed). Used to re-queue stragglers.
    const stallMs = options.stallMs;
    const start = Date.now();
    let lastProgress = -1;
    let lastProgressAt = start;

    // Event wakeups reduce poll latency without depending solely on them.
    let listenerId: number | undefined;
    let wake: (() => void) | undefined;
    const waitWake = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, interval);
      });
    try {
      listenerId = program.addEventListener('verifyDeckHashChunkEvent' as any, (event: any) => {
        const progress = Number(event.progress);
        if (progress !== lastProgress) {
          console.log(`[verify] event progress=${progress} start=${Number(event.startIndex ?? event.start_index)}`);
        }
        wake?.();
      });
    } catch {
      // IDL may omit the event in older builds — fall back to pure polling.
    }

    try {
      while (Date.now() - start < timeout) {
        const state = await fetchFn();
        const progress = Number(state.verifyProgress);
        if (progress !== lastProgress) {
          lastProgress = progress;
          lastProgressAt = Date.now();
          console.log(`[verify] progress=${progress}/${targetProgress}`);
        }
        if (progress >= targetProgress || state.verified === true) {
          return state;
        }
        if (stallMs != null && Date.now() - lastProgressAt >= stallMs) {
          throw new Error(
            `verify_progress stalled for ${stallMs}ms ` +
              `(progress=${progress}/${targetProgress} verified=${state.verified}) ` +
              `game=${gameStatePda.toBase58()}`,
          );
        }
        await waitWake();
      }
      const state = await fetchFn();
      throw new Error(
        `verify_progress timed out after ${timeout}ms ` +
          `(progress=${Number(state.verifyProgress)}/${targetProgress} verified=${state.verified}) ` +
          `game=${gameStatePda.toBase58()}`,
      );
    } finally {
      if (listenerId !== undefined) {
        await program.removeEventListener(listenerId);
      }
    }
  }

  /**
   * Wait until every `startIndex` in `starts` has its verify bit set
   * (callback applied). Event wakeups on `verifyDeckHashChunkEvent` when
   * the event's start matches; poll interval is a backup.
   */
  async waitForVerifyStarts(
    program: Program,
    fetchFn: () => Promise<any>,
    starts: number[],
    options: { timeout?: number; interval?: number; stallMs?: number } = {},
  ): Promise<any> {
    const wanted = [...new Set(starts)].sort((a, b) => a - b);
    if (wanted.length === 0) return fetchFn();

    const timeout = options.timeout ?? 300_000;
    const interval = options.interval ?? 500;
    const stallMs = options.stallMs;
    const start = Date.now();
    let lastDoneCount = -1;
    let lastAdvanceAt = start;

    let listenerId: number | undefined;
    let wake: (() => void) | undefined;
    const waitWake = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, interval);
      });

    try {
      listenerId = program.addEventListener('verifyDeckHashChunkEvent' as any, (event: any) => {
        const si = Number(event.startIndex ?? event.start_index);
        if (wanted.includes(si)) {
          console.log(
            `[verify] event start=${si} progress=${Number(event.progress)}`,
          );
          wake?.();
        }
      });
    } catch {
      // IDL may omit the event — fall back to pure polling.
    }

    try {
      while (Date.now() - start < timeout) {
        const state = await fetchFn();
        if (state.verified === true) return state;
        const bits = state.verifyBits as any[];
        const pending = wanted.filter((s) => !isVerifyChunkStartDone(bits, s));
        const doneCount = wanted.length - pending.length;
        if (doneCount !== lastDoneCount) {
          lastDoneCount = doneCount;
          lastAdvanceAt = Date.now();
          console.log(`[verify] starts ${doneCount}/${wanted.length} done`);
        }
        if (pending.length === 0) return state;
        if (stallMs != null && Date.now() - lastAdvanceAt >= stallMs) {
          throw new Error(
            `verify starts stalled for ${stallMs}ms ` +
              `(pending=[${pending.join(',')}] progress=${Number(state.verifyProgress)})`,
          );
        }
        await waitWake();
      }
      const state = await fetchFn();
      const bits = state.verifyBits as any[];
      const pending = wanted.filter((s) => !isVerifyChunkStartDone(bits, s));
      throw new Error(
        `verify starts timed out after ${timeout}ms ` +
          `(pending=[${pending.join(',')}] progress=${Number(state.verifyProgress)})`,
      );
    } finally {
      if (listenerId !== undefined) {
        await program.removeEventListener(listenerId);
      }
    }
  }
}
