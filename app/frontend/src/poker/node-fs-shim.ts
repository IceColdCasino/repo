/** Browser stub — fs is not available in the webview. */
export function existsSync(): boolean {
  return false;
}

export function readFileSync(): never {
  throw new Error('fs is not available in the browser');
}

export function writeFileSync(): never {
  throw new Error('fs is not available in the browser');
}

export function mkdirSync(): void {
  // no-op
}

export function unlinkSync(): void {
  // no-op
}

export function openSync(): never {
  throw new Error('fs is not available in the browser');
}

export function closeSync(): void {
  // no-op
}

export function readSync(): never {
  throw new Error('fs is not available in the browser');
}

export function realpathSync(p: string): string {
  return p;
}

export function appendFileSync(): void {
  // Hand-cost ledger is a Node path. The WebView keeps playing without it.
}

export function readdirSync(): string[] {
  return [];
}

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
};
