#!/usr/bin/env bun
/**
 * Generates chained bridge prove payloads for per-phase native E2E.
 * Bun is used only as a dev tool here — runtime proves use window.zero on macOS/iOS.
 *
 * Player index 0 = iOS seat 1 (fixed IOS_E2E keys)
 * Player index 1 = macOS seat 0 (deterministic mac keys)
 *
 * Outputs: app/testdata/bridge-chain/*_payload.json + manifest.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../../../src/poker-game.ts';
import { Player } from '../../../src/poker-player.ts';
import { preloadCircuits } from '../../../src/circuit-manager.ts';
import { padPublicKeysForShuffle } from '../../../src/shuffle-common.ts';
import { shareOthersForPlayer } from '../../../src/share-common.ts';
import type { Ciphertext, PublicKey } from '../../../src/zk-casino.ts';
import {
  IOS_E2E_SEAT1_PRIVATE_KEY,
  IOS_E2E_SEAT1_PUBLIC_KEY,
} from '../gen-register-prove-fixture.ts';

const OUT_DIR = join(import.meta.dir, '../../ios/testdata/bridge-chain');

/** macOS seat 0 / player index 1 — deterministic BabyJub key (generated once, pinned). */
const MAC_PRIVATE_KEY =
  '2428100415488936355968301999630349525397609005992624203874181406818413588194';
const MAC_PUBLIC_KEY: [string, string] = [
  '10429952485622130609882731530366307520824781500227589532846431809368879831161',
  '15200591953928644735713799398207577817690089034042298911397302112874420590117',
];

function normalizeParams(params: Record<string, unknown>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    let v: unknown = value;
    if (!Array.isArray(v)) {
      v = [v];
    }
    const flat = (v as unknown[]).flat(5);
    normalized[key] = flat.map((item) =>
      typeof item === 'bigint' || typeof item === 'number' ? String(item) : String(item),
    );
  }
  return normalized;
}

function writePayload(name: string, circuitName: string, input: Record<string, string[]>) {
  const path = join(OUT_DIR, `${name}_payload.json`);
  writeFileSync(path, JSON.stringify({ circuitName, input }, null, 2));
  console.log(`[bridge-chain] wrote ${path}`);
  return path;
}

async function captureProveInput(
  circuits: Awaited<ReturnType<typeof preloadCircuits>>,
  circuit: 'register' | 'shuffle' | 'share' | 'showdown',
  run: () => Promise<unknown>,
): Promise<Record<string, string[]>> {
  const target = circuits[circuit];
  const orig = target.prove.bind(target);
  let captured: Record<string, string[]> | null = null;
  target.prove = async (params: Record<string, unknown>) => {
    captured = normalizeParams(params);
    throw new Error('fixture-capture');
  };
  try {
    await run();
  } catch (err) {
    // expected capture abort from stubbed prove; surface anything else
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== 'fixture-capture' && !captured) {
      console.error(`[bridge-chain] ${circuit} capture run failed:`, err);
    }
  }
  target.prove = orig;
  if (!captured) {
    throw new Error(`failed to capture ${circuit} prove input`);
  }
  return captured;
}

main().catch((err) => {
  console.error('[bridge-chain] fatal:', err);
  process.exit(1);
});

async function main() {
  await generateCoreFixtures();
  writeManifest();
}

async function generateCoreFixtures() {
  mkdirSync(OUT_DIR, { recursive: true });
  const circuits = await preloadCircuits();
  const iosPlayer = new Player(circuits);
  await iosPlayer.init();
  iosPlayer.loadPlayerKey({
    privateKey: BigInt(IOS_E2E_SEAT1_PRIVATE_KEY),
    publicKey: [BigInt(IOS_E2E_SEAT1_PUBLIC_KEY[0]), BigInt(IOS_E2E_SEAT1_PUBLIC_KEY[1])],
  });

  const macPlayer = new Player(circuits);
  await macPlayer.init();
  macPlayer.loadPlayerKey({
    privateKey: BigInt(MAC_PRIVATE_KEY),
    publicKey: [BigInt(MAC_PUBLIC_KEY[0]), BigInt(MAC_PUBLIC_KEY[1])],
  });

  writeFileSync(
    join(OUT_DIR, 'keys.json'),
    JSON.stringify(
      {
        player0: {
          platform: 'ios',
          privateKey: IOS_E2E_SEAT1_PRIVATE_KEY,
          publicKey: IOS_E2E_SEAT1_PUBLIC_KEY,
        },
        player1: {
          platform: 'macos',
          privateKey: MAC_PRIVATE_KEY,
          publicKey: MAC_PUBLIC_KEY,
        },
      },
      null,
      2,
    ),
  );

  const registerP0 = await captureProveInput(circuits, 'register', () => iosPlayer.registerProve());
  writePayload('register_p0', 'register_main', registerP0);

  const registerP1 = await captureProveInput(circuits, 'register', () => macPlayer.registerProve());
  writePayload('register_p1', 'register_main', registerP1);

  const game = new Game();
  await game.init();
  const reg0 = await iosPlayer.registerProve();
  game.addPlayer(reg0.proof, reg0.publicSignals, { verified: true });
  const reg1 = await macPlayer.registerProve();
  game.addPlayer(reg1.proof, reg1.publicSignals, { verified: true });
  game.start();

  // After start(), game.publicKeys is padded to 10 with identity — use registered count.
  const publicKeys = game.registeredPublicKeys();
  const nActualPlayers = game.nPlayers;
  const shuffleKeys = padPublicKeysForShuffle(publicKeys);

  // HU shuffle order: player 1 then player 0
  let deck = game.deck as Ciphertext[];

  macPlayer.preloadShuffle(deck, shuffleKeys);
  const shuffleP1 = await captureProveInput(circuits, 'shuffle', () =>
    macPlayer.shuffleProve(deck, shuffleKeys),
  );
  writePayload('shuffle_p1', 'shuffle_1_deck_52_main', shuffleP1);
  const shuffled1 = await macPlayer.shuffleProve(deck, shuffleKeys);
  game.shuffle(
    shuffled1.proof,
    shuffled1.publicSignals,
    {
      publicKey: macPlayer.publicKey,
      deck: shuffled1.deck,
      permutationHash: shuffled1.permutationHash,
    },
    { verified: true, skipTurnCheck: true },
  );
  deck = game.deck as Ciphertext[];

  iosPlayer.preloadShuffle(deck, shuffleKeys);
  const shuffleP0 = await captureProveInput(circuits, 'shuffle', () =>
    iosPlayer.shuffleProve(deck, shuffleKeys),
  );
  writePayload('shuffle_p0', 'shuffle_1_deck_52_main', shuffleP0);

  const shuffled0 = await iosPlayer.shuffleProve(deck, shuffleKeys);
  game.shuffle(
    shuffled0.proof,
    shuffled0.publicSignals,
    {
      publicKey: iosPlayer.publicKey,
      deck: shuffled0.deck,
      permutationHash: shuffled0.permutationHash,
    },
    { verified: true, skipTurnCheck: true },
  );

  const shareDeck = game.finalShuffledDeck as Ciphertext[];
  const shareKeysP1 = shareOthersForPlayer(publicKeys, 1);
  macPlayer.preloadShare(shareDeck, shareKeysP1, nActualPlayers);
  const shareP1 = await captureProveInput(circuits, 'share', () =>
    macPlayer.shareProve(shareDeck, shareKeysP1, nActualPlayers),
  );
  writePayload('share_p1', 'poker_share_hashout_main', shareP1);

  const shareKeysP0 = shareOthersForPlayer(publicKeys, 0);
  iosPlayer.preloadShare(shareDeck, shareKeysP0, nActualPlayers);
  const shareP0 = await captureProveInput(circuits, 'share', () =>
    iosPlayer.shareProve(shareDeck, shareKeysP0, nActualPlayers),
  );
  writePayload('share_p0', 'poker_share_hashout_main', shareP0);

  game.share(
    {} as never,
    [],
    {
      publicKey: macPlayer.publicKey,
      ciphertexts: macPlayer.sharePartialsOnly(shareDeck, shareKeysP1, nActualPlayers),
    },
    { verified: true, skipTurnCheck: true, fixtureApply: true },
  );
  game.share(
    {} as never,
    [],
    {
      publicKey: iosPlayer.publicKey,
      ciphertexts: iosPlayer.sharePartialsOnly(shareDeck, shareKeysP0, nActualPlayers),
    },
    { verified: true, skipTurnCheck: true, fixtureApply: true },
  );

  // Showdown circuit is fixed at 10 PK slots + 9 pot masks (padded identity).
  const showdownKeys = game.publicKeys as PublicKey[];
  const showdownP0 = await captureProveInput(circuits, 'showdown', () =>
    iosPlayer.showdownProve(
      0,
      showdownKeys,
      game.potMasks,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(0),
    ),
  );
  writePayload('showdown_p0', 'poker_showdown_hashout_main', showdownP0);

  const showdownP1 = await captureProveInput(circuits, 'showdown', () =>
    macPlayer.showdownProve(
      1,
      showdownKeys,
      game.potMasks,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(1),
    ),
  );
  writePayload('showdown_p1', 'poker_showdown_hashout_main', showdownP1);
}

function writeManifest() {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    phases: {
      register_p0: { platform: 'ios', playerIndex: 0, payloadFile: 'register_p0_payload.json' },
      register_p1: { platform: 'macos', playerIndex: 1, payloadFile: 'register_p1_payload.json' },
      shuffle_p1: { platform: 'macos', playerIndex: 1, payloadFile: 'shuffle_p1_payload.json', dependsOn: ['register_p0', 'register_p1'] },
      shuffle_p0: { platform: 'ios', playerIndex: 0, payloadFile: 'shuffle_p0_payload.json', dependsOn: ['shuffle_p1'] },
      share_p1: { platform: 'macos', playerIndex: 1, payloadFile: 'share_p1_payload.json', dependsOn: ['shuffle_p0'] },
      share_p0: { platform: 'ios', playerIndex: 0, payloadFile: 'share_p0_payload.json', dependsOn: ['share_p1'] },
      showdown_p0: { platform: 'ios', playerIndex: 0, payloadFile: 'showdown_p0_payload.json', dependsOn: ['share_p0'] },
      showdown_p1: { platform: 'macos', playerIndex: 1, payloadFile: 'showdown_p1_payload.json', dependsOn: ['share_p0'] },
    },
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('[bridge-chain] manifest + payloads complete');
}

