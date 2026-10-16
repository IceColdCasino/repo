/**
 * Build each house image and run its game file.
 *
 *   bun run test:e2e:house
 *   bun test test/e2e/house-image.test.ts -t keno
 *
 * Each test builds linux/arm64 `--target <game>` and runs
 * `src/house/<game>.ts`. A full witness compile is slow the first time.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { game as baccarat } from '../../src/house/baccarat';
import { game as blackjack } from '../../src/house/blackjack';
import { game as craps } from '../../src/house/craps';
import { game as keno } from '../../src/house/keno';
import { game as roulette } from '../../src/house/roulette';
import { game as slots } from '../../src/house/slots';
import { game as war } from '../../src/house/war';
import {
  appleContainerBin,
  houseImageDockerEnv,
  isAppleContainerInstalled,
  isAppleContainerRuntime,
  resolveDockerBinary,
} from './arcium-docker';

const HOUSE_GAMES = [baccarat, blackjack, war, roulette, craps, keno, slots] as const;

const IMAGE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * The `docker` shim forwards `build` and `run` to a socktainer socket.
 * Apple Container implements those as `container build` and `container run`.
 */
function useAppleContainer(): boolean {
  return isAppleContainerRuntime() && isAppleContainerInstalled();
}

function builderBin(): string {
  if (!useAppleContainer()) return resolveDockerBinary();
  return fs.existsSync(appleContainerBin()) ? appleContainerBin() : 'container';
}

function runBuilder(args: string[], stdio: 'inherit' | 'pipe') {
  return spawnSync(builderBin(), args, {
    cwd: process.cwd(),
    env: houseImageDockerEnv(),
    encoding: 'utf8',
    stdio,
    timeout: IMAGE_TIMEOUT_MS,
  });
}

describe('house docker images', () => {
  for (const game of HOUSE_GAMES) {
    test(
      `${game} image boots, refuses bets, and contains only that game`,
      () => {
        const tag = `icecold-house-${game}:e2e`;
        const buildArgs = useAppleContainer()
          ? ['build', '--platform', 'linux/arm64', '--memory', '40G', '--cpus', '8', '--target', game, '-t', tag, '.']
          : ['build', '--platform', 'linux/arm64', '--target', game, '-t', tag, '.'];
        const build = runBuilder(buildArgs, 'inherit');
        expect(build.status, build.stderr ?? build.error?.message).toBe(0);

        const checkScript = `import { selfCheck } from './src/house/${game}.ts'; await selfCheck()`;
        const checkArgs = useAppleContainer()
          ? ['run', '--rm', '--entrypoint', 'bun', tag, '-e', checkScript]
          : ['run', '--rm', '--platform', 'linux/arm64', '--entrypoint', 'bun', tag, '-e', checkScript];
        const check = runBuilder(checkArgs, 'pipe');
        if (check.stdout) process.stdout.write(check.stdout);
        if (check.stderr) process.stderr.write(check.stderr);
        expect(check.status, check.stderr || check.stdout).toBe(0);
        expect(check.stdout).toContain('house bet refused');
        expect(check.stdout).toContain('house card refused');
        expect(check.stdout).toContain(`house ${game} image ok`);
        expect(`${check.stderr ?? ''}`).toContain('HouseDoesNotBet');

        const bootArgs = useAppleContainer()
          ? ['run', '--rm', tag]
          : ['run', '--rm', '--platform', 'linux/arm64', tag];
        const boot = runBuilder(bootArgs, 'pipe');
        if (boot.stdout) process.stdout.write(boot.stdout);
        if (boot.stderr) process.stderr.write(boot.stderr);
        expect(boot.status, boot.stderr || boot.stdout).toBe(0);
        expect(boot.stdout).toContain(`house ${game} player ready`);
      },
      IMAGE_TIMEOUT_MS,
    );
  }
});