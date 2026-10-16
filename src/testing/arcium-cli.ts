import { spawnSync } from 'child_process';
import fs from 'node:fs';

/**
 * Casino is built against arcium-anchor 0.14.1. CLI 0.9.x ships an older
 * Arcium program, so InitComputationDefinition fails to deserialize.
 * Prefer an explicit 0.14 binary over whatever `arcium` is on PATH.
 */
const CANDIDATES = [
  process.env.ARCIUM_BIN,
  '/tmp/arcium-0.14/bin/arcium',
  '/tmp/arcium-0.14.1',
].filter((candidate): candidate is string => !!candidate);

let resolvedCli: string | null = null;

export function resolveArciumCli(): string {
  if (resolvedCli && (resolvedCli === 'arcium' || fs.existsSync(resolvedCli))) return resolvedCli;
  for (const candidate of CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    const version = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    const text = `${version.stdout ?? ''}${version.stderr ?? ''}`;
    if (/0\.14\./.test(text)) {
      resolvedCli = candidate;
      return candidate;
    }
  }
  const onPath = spawnSync('arcium', ['--version'], { encoding: 'utf8' });
  const text = `${onPath.stdout ?? ''}${onPath.stderr ?? ''}`;
  if (/0\.14\./.test(text)) {
    resolvedCli = 'arcium';
    return 'arcium';
  }
  throw new Error(
    `Need arcium CLI 0.14.x so localnet matches arcium-anchor 0.14.1. Found: ${text.trim() || 'not on PATH'}`,
  );
}
