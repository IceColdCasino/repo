/**
 * Native player-crypto warmup. Zig `player` owns field math — never circomlibjs / Bun.
 */
import { hasPlayerBridge, pingPlayerBridge } from './player-bridge';

let readyPromise: Promise<boolean> | null = null;

export function waitForNativePlayerReady(timeoutMs = 60_000): Promise<boolean> {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!hasPlayerBridge()) {
        throw new Error('native player bridge is required');
      }
      const ping = await pingPlayerBridge();
      if (!ping.ok) {
        throw new Error('player ping failed');
      }
      return true;
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  const pending = readyPromise.catch(() => false);
  return Promise.race([
    pending,
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}
