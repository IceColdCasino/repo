/** WebView stub — Bun FFI never ships in the macOS/iOS apps. */

export function playerFfiAvailable(): boolean {
  return false;
}

export function requirePlayerFfi(): void {
  throw new Error('player-ffi is not available in the native app or browser');
}

export function shouldUsePlayerFfi(): boolean {
  return false;
}

export class PlayerEngine {
  constructor() {
    throw new Error('player-ffi is not available in the native app or browser');
  }
}
