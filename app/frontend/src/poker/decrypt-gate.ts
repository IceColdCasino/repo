/**
 * Native autoplay must not await WASM decrypt on the betting/prove path —
 * a second Poker.init() (or decrypt in the same tick as hole-ack) wedges
 * both WKWebViews. Faces still paint from a background decrypt after ack.
 */

const PROVE_PHASES = new Set([
  'Register',
  'Shuffle',
  'Share',
  // On-chain share finalize is Evaluation; UI usually remaps it to PreFlop.
  'Evaluation',
]);

const STREET_PHASES = new Set(['PreFlop', 'Flop', 'Turn', 'River']);

export function shouldDeferNativeDecrypt(options: {
  phase: string;
  nativeAutoPlay: boolean;
  holesAcked: boolean;
  hasE2eDealValues?: boolean;
  showdownSubmitted?: boolean;
}): boolean {
  if (options.hasE2eDealValues) {
    return false;
  }
  if (!options.nativeAutoPlay) {
    return false;
  }
  if (options.phase === 'Complete') {
    return false;
  }
  if (options.phase === 'Showdown' && options.showdownSubmitted) {
    return false;
  }
  return PROVE_PHASES.has(options.phase) || STREET_PHASES.has(options.phase)
    || options.phase === 'Showdown';
}

/** Background face-paint is allowed once holes are acked (or at Complete). */
export function shouldPaintNativeDecrypt(options: {
  phase: string;
  nativeAutoPlay: boolean;
  holesAcked: boolean;
  hasE2eDealValues?: boolean;
  showdownSubmitted?: boolean;
}): boolean {
  if (options.hasE2eDealValues) {
    return true;
  }
  if (!options.nativeAutoPlay) {
    return true;
  }
  if (options.phase === 'Complete') {
    return true;
  }
  if (options.phase === 'Showdown') {
    return true;
  }
  if (PROVE_PHASES.has(options.phase)) {
    return false;
  }
  if (STREET_PHASES.has(options.phase)) {
    return true;
  }
  return false;
}

/** Full-deck WASM decrypt at Showdown wedges the proving WebView. Reuse street faces. */
export function shouldRunNativeDecryptWasm(options: {
  phase: string;
  nativeAutoPlay: boolean;
  holesAcked: boolean;
  hasE2eDealValues?: boolean;
  showdownSubmitted?: boolean;
}): boolean {
  if (options.hasE2eDealValues) {
    return true;
  }
  if (options.phase === 'Showdown' && !options.showdownSubmitted) {
    return false;
  }
  return shouldPaintNativeDecrypt(options);
}
