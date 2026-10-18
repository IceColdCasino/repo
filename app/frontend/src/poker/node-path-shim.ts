/** Minimal path shim for browser bundles that import node:path transitively. */
export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

export function resolve(...parts: string[]): string {
  return join(...parts);
}

export default { join, resolve };
