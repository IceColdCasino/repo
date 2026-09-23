import path from 'node:path';
import { verify } from './rapidsnark-ffi';

const vkPath = (circuitName: string) =>
  path.join(__dirname, `../zkey/${circuitName}_verification_key.json`);

export function verifyCircuit(
  circuitName: string,
  proof: object,
  publicSignals: string[],
): boolean {
  try {
    const ok = verify(proof, publicSignals, vkPath(circuitName));
    if (!ok) {
      const p = proof as { protocol?: string; curve?: string; pi_a?: unknown };
      console.error(
        `[zk-verify] invalid proof circuit=${circuitName} signals=${publicSignals.length} protocol=${p.protocol ?? '?'} keys=${Object.keys(proof).join(',')}`,
      );
    }
    return ok;
  } catch (err) {
    console.error(`[zk-verify] verify threw circuit=${circuitName}`, err);
    return false;
  }
}
