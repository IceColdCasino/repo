/** Browser stub — zkeys live in the native shell, not the WebView. */

export interface SharedZkeyBytes {
  path: string;
  bytes: Uint8Array;
}

export interface SharedProver {
  prove(_witnessData: Uint8Array): never;
}

function unavailable(): never {
  throw new Error('zkey cache is not available in the browser');
}

export function getSharedZkeyBytes(_zkeyPath: string): SharedZkeyBytes {
  return unavailable();
}

export function sharedZkeyByteLoadCount(_zkeyPath: string): number {
  return 0;
}

export function getSharedProver(_zkeyPath: string): SharedProver {
  return unavailable();
}

export function sharedProverLoadCount(_zkeyPath: string): number {
  return 0;
}

export function clearSharedProvers(): void {}

export function clearSharedZkeyBytes(): void {}
