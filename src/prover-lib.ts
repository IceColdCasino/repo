import { spawnSync } from 'node:child_process';

/** Path of libgroth16, the prover and verifier. `zkey lib` prints it on stdout. */
export function proverLibPath(): string {
  const override = process.env.RAPIDSNARK_LIB;
  if (override && override.length > 0) return override;

  const result = spawnSync('zkey', ['lib'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new Error(detail.length > 0 ? detail : 'zkey lib failed. Install icecoldcasino/groth16/zkey with Homebrew.');
  }
  const line = result.stdout.split('\n')[0]?.trim() ?? '';
  if (line.length === 0) throw new Error('zkey lib printed an empty path');
  return line;
}
