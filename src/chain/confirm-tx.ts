import { TransactionExpiredBlockheightExceededError, type Commitment, type Connection } from '@solana/web3.js';
import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';

const PATCHED = Symbol.for('icecasino.durableConfirm');
const RPC_TIMEOUT_MS = 8_000;
const POLL_MS = 800;
const DEFAULT_ATTEMPTS = 5;

export type SignaturePoll = 'confirmed' | 'expired';

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function rankEnough(status: string | undefined, commitment: Commitment): boolean {
  if (commitment === 'processed') return status === 'processed' || status === 'confirmed' || status === 'finalized';
  if (commitment === 'finalized') return status === 'finalized';
  return status === 'confirmed' || status === 'finalized';
}

/**
 * HTTP-poll a signature until it reaches `commitment`, the blockhash can no
 * longer land, or the wall clock expires. A stuck websocket cannot hold this.
 */
export async function pollSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  commitment: Commitment = 'confirmed',
  wallMs = 150_000,
  pollMs = POLL_MS,
): Promise<SignaturePoll> {
  const deadline = Date.now() + wallMs;
  while (Date.now() < deadline) {
    try {
      const { value } = await withTimeout(
        connection.getSignatureStatuses([signature]),
        RPC_TIMEOUT_MS,
      );
      const status = value[0];
      if (status?.err) {
        throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      }
      if (rankEnough(status?.confirmationStatus, commitment)) return 'confirmed';
      const height = await withTimeout(connection.getBlockHeight('confirmed'), RPC_TIMEOUT_MS);
      if (height > lastValidBlockHeight) {
        const again = await withTimeout(
          connection.getSignatureStatuses([signature]),
          RPC_TIMEOUT_MS,
        );
        const late = again.value[0];
        if (late?.err) {
          throw new Error(`transaction ${signature} failed: ${JSON.stringify(late.err)}`);
        }
        if (rankEnough(late?.confirmationStatus, commitment)) return 'confirmed';
        return 'expired';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/transaction .* failed:/.test(message)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return 'expired';
}

/** Send with a fresh blockhash until one signature confirms. */
export async function confirmOrResend(
  connection: Connection,
  send: (latest: BlockhashWithExpiryBlockHeight, attempt: number) => Promise<string>,
  commitment: Commitment = 'confirmed',
  attempts = DEFAULT_ATTEMPTS,
  pollMs = POLL_MS,
): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const latest = await connection.getLatestBlockhash('confirmed');
    let signature: string;
    try {
      signature = await send(latest, attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reported = (error as { signature?: unknown }).signature;
      const seen = typeof reported === 'string' ? reported : '';
      if (!message.includes('already been processed')) throw error;
      if (seen) {
        const { value } = await connection.getSignatureStatuses([seen], {
          searchTransactionHistory: true,
        });
        const status = value[0];
        if (status?.err) throw error;
        if (rankEnough(status?.confirmationStatus, commitment)) return seen;
      }
      continue;
    }
    last = signature;
    const outcome = await pollSignature(
      connection,
      signature,
      latest.lastValidBlockHeight,
      commitment,
      150_000,
      pollMs,
    );
    if (outcome === 'confirmed') return signature;
  }
  throw new TransactionExpiredBlockheightExceededError(last);
}

/** Replace websocket confirmation on this connection with `pollSignature`. */
export function installDurableConfirm(connection: Connection): void {
  const tagged = connection as Connection & { [PATCHED]?: boolean };
  if (tagged[PATCHED]) return;
  tagged[PATCHED] = true;
  connection.confirmTransaction = (async (
    strategy: Parameters<Connection['confirmTransaction']>[0],
    commitment?: Commitment,
  ) => {
    const wanted = commitment ?? 'confirmed';
    if (typeof strategy === 'string') {
      const outcome = await pollSignature(connection, strategy, Number.MAX_SAFE_INTEGER, wanted, 120_000);
      if (outcome !== 'confirmed') throw new TransactionExpiredBlockheightExceededError(strategy);
      return { context: { slot: 0 }, value: { err: null } };
    }
    const outcome = await pollSignature(
      connection,
      strategy.signature,
      strategy.lastValidBlockHeight,
      wanted,
    );
    if (outcome !== 'confirmed') {
      throw new TransactionExpiredBlockheightExceededError(strategy.signature);
    }
    return { context: { slot: 0 }, value: { err: null } };
  }) as Connection['confirmTransaction'];
}
