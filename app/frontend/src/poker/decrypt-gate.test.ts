import { describe, expect, it } from 'vitest';
import {
  shouldDeferNativeDecrypt,
  shouldPaintNativeDecrypt,
  shouldRunNativeDecryptWasm,
} from './decrypt-gate';

describe('shouldDeferNativeDecrypt', () => {
  it('never defers visual e2e deal values', () => {
    expect(shouldDeferNativeDecrypt({
      phase: 'Share',
      nativeAutoPlay: true,
      holesAcked: false,
      hasE2eDealValues: true,
    })).toBe(false);
  });

  it('defers Arcium Evaluation the same way as PreFlop', () => {
    expect(shouldDeferNativeDecrypt({
      phase: 'Evaluation',
      nativeAutoPlay: true,
      holesAcked: true,
    })).toBe(true);
  });

  it('defers Share / Register / Shuffle during native autoplay', () => {
    for (const phase of ['Register', 'Shuffle', 'Share']) {
      expect(shouldDeferNativeDecrypt({
        phase,
        nativeAutoPlay: true,
        holesAcked: false,
      })).toBe(true);
    }
  });

  it('defers every betting street, even after hole ack', () => {
    for (const phase of ['PreFlop', 'Flop', 'Turn', 'River']) {
      expect(shouldDeferNativeDecrypt({
        phase,
        nativeAutoPlay: true,
        holesAcked: true,
      })).toBe(true);
    }
  });

  it('defers Showdown until a proof is submitted', () => {
    expect(shouldDeferNativeDecrypt({
      phase: 'Showdown',
      nativeAutoPlay: true,
      holesAcked: true,
      showdownSubmitted: false,
    })).toBe(true);
    expect(shouldDeferNativeDecrypt({
      phase: 'Showdown',
      nativeAutoPlay: true,
      holesAcked: true,
      showdownSubmitted: true,
    })).toBe(false);
  });

  it('allows Complete decrypt so the result panel can show faces', () => {
    expect(shouldDeferNativeDecrypt({
      phase: 'Complete',
      nativeAutoPlay: true,
      holesAcked: true,
    })).toBe(false);
  });

  it('does not defer when autoplay is off', () => {
    expect(shouldDeferNativeDecrypt({
      phase: 'Share',
      nativeAutoPlay: false,
      holesAcked: false,
    })).toBe(false);
  });

  it('paints street faces after share, without waiting for hole ack', () => {
    for (const phase of ['PreFlop', 'Flop', 'Turn', 'River']) {
      expect(shouldPaintNativeDecrypt({
        phase,
        nativeAutoPlay: true,
        holesAcked: false,
      })).toBe(true);
    }
  });

  it('paints Showdown faces before the proof', () => {
    expect(shouldPaintNativeDecrypt({
      phase: 'Showdown',
      nativeAutoPlay: true,
      holesAcked: false,
      showdownSubmitted: false,
    })).toBe(true);
  });

  it('does not run WASM decrypt at Showdown until a proof is submitted', () => {
    expect(shouldRunNativeDecryptWasm({
      phase: 'Showdown',
      nativeAutoPlay: true,
      holesAcked: true,
      showdownSubmitted: false,
    })).toBe(false);
    expect(shouldRunNativeDecryptWasm({
      phase: 'Showdown',
      nativeAutoPlay: true,
      holesAcked: true,
      showdownSubmitted: true,
    })).toBe(true);
  });

  it('does not paint during Register / Shuffle / Share', () => {
    for (const phase of ['Register', 'Shuffle', 'Share', 'Evaluation']) {
      expect(shouldPaintNativeDecrypt({
        phase,
        nativeAutoPlay: true,
        holesAcked: true,
      })).toBe(false);
    }
  });
});
