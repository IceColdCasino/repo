/**
 * Progress lines from chain/prove work into the table Event log.
 * `console.log` in per-seat code never reaches the WebView log.
 */

export type HandProgressKind = 'zk' | 'chain' | 'info';

export type HandProgressListener = (message: string, kind: HandProgressKind) => void;

let listener: HandProgressListener | null = null;

export function setHandProgressListener(next: HandProgressListener | null): void {
  listener = next;
}

export function logHandProgress(message: string, kind: HandProgressKind = 'chain'): void {
  console.log(`[hand] ${message}`);
  listener?.(message, kind);
}
