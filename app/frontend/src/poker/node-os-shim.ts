/** Minimal node:os shim for browser bundles. */
export function homedir(): string {
  return '/';
}

export default { homedir };
