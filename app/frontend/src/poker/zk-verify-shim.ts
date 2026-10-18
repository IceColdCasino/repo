/** Browser stub — Groth16 verify runs on the Bun server via /api/zk/verify. */
export function verifyCircuit(
  _circuitName: string,
  _proof: object,
  _publicSignals: string[],
): boolean {
  throw new Error(
    'Client-side Groth16 verify is disabled; use verifyCircuit() from src/zk/runtime.ts or pass { verified: true }',
  );
}
