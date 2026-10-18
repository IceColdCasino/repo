/** Browser shim for node:crypto / crypto used by transitive chain imports. */

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function createHash(_alg: string): {
  update: (data: string | Uint8Array) => { digest: () => Uint8Array };
} {
  throw new Error('createHash is not available in the browser — use @noble/hashes');
}

export default { randomBytes, createHash };
