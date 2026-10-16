/**
 * Shared house-seat session. Game files pass their own kind and variant.
 * Bet and bingo-card ops are rejected here and again by a `-Dhouse=true` bridge.
 * Showdown stays, and blackjack action stays, so the dealer can finish a hand
 * and prove showdown after the player window.
 */
import { AnchorProvider, Program, Wallet, web3 } from '@coral-xyz/anchor';
import { suffix } from 'bun:ffi';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameKind } from '../game-config';
import type { PlayerSession } from '../player-native-bridge';
import { bridgeCall, openSession } from '../player-bridge-ffi';
import { LIGHT_CASINO_PROGRAM_ID, connectHouseChain } from './chain';
import { proverLibPath } from '../prover-lib';

export type HousePlayer = Omit<PlayerSession, 'bet' | 'card'>;

export const HOUSE_SHARED_LIBS = [
  'libfr.so',
  'librapidsnark.so',
  'libzkcasino.so',
  'libzkcasino-player.so',
  'libzkcasino-player-bridge.so',
] as const;

export const CARD_SHOE_LIBS = [
  'libzkcasino-shuffle-1-deck-52.so',
  'libzkcasino-shuffle-6-deck-52.so',
  'libzkcasino-shuffle-8-deck-52.so',
] as const;

export const CARD_SHOE_DATS = [
  'shuffle_1_deck_52.dat',
  'shuffle_6_deck_52.dat',
  'shuffle_8_deck_52.dat',
] as const;

const CHAIN_PACKAGES = [
  '@coral-xyz/anchor',
  '@arcium-hq/client',
  '@solana/spl-token',
  '@lightprotocol/stateless.js',
];

export function houseLibs(...gameLibs: readonly string[]): string[] {
  return [...HOUSE_SHARED_LIBS, ...gameLibs].sort();
}

export function openHouseSession(kind: GameKind, variant: number): HousePlayer {
  const session = openSession({ kind, variant });
  const { bet: _bet, card: _card, invoke, ...rest } = session;
  return {
    ...rest,
    invoke(payload) {
      if (payload.op === 'bet' || payload.op === 'card') {
        throw new Error('house player does not place bets');
      }
      return invoke(payload);
    },
  };
}

export interface HouseGameModule {
  game: string;
  kind: GameKind;
  variant: number;
  libs: readonly string[];
  dats: readonly string[];
  openHousePlayer: () => HousePlayer;
}

function sameSet(label: string, actual: string[], expected: readonly string[]): void {
  const got = [...actual].sort();
  const want = [...expected].sort();
  if (got.join('\n') !== want.join('\n')) {
    throw new Error(`${label}\n got: ${got.join(' ')}\n want: ${want.join(' ')}`);
  }
}

function refuse(kind: GameKind, variant: number, op: 'bet' | 'card'): void {
  try {
    bridgeCall(kind, variant, { op });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('zkplayer_bridge_op failed')) {
      throw new Error(`${op} failed before the house check: ${message}`);
    }
    console.log(`house ${op} refused`);
    return;
  }
  throw new Error(`${op} was accepted`);
}

const IMAGE_LIB_DIR = '/opt/zkcasino/lib';
const IMAGE_DAT_DIR = '/opt/zkcasino/dat';

function houseLibDir(): string {
  if (process.env.ZKCASINO_LIB_DIR) return process.env.ZKCASINO_LIB_DIR;
  if (existsSync(IMAGE_LIB_DIR)) return IMAGE_LIB_DIR;
  return path.join(process.cwd(), 'libzkcasino/zig-out/lib');
}

function houseDatDir(): string {
  if (process.env.ZKCASINO_DAT_ROOT) return process.env.ZKCASINO_DAT_ROOT;
  if (existsSync(IMAGE_DAT_DIR)) return IMAGE_DAT_DIR;
  return path.join(process.cwd(), 'libzkcasino/src/zig/dat');
}

/** The image install is a closed set. A checkout contains every game. */
function isImageInstall(libDir: string): boolean {
  const resolved = path.resolve(libDir);
  return resolved === IMAGE_LIB_DIR || resolved.startsWith('/opt/zkcasino/');
}

function proverLibInstalled(): boolean {
  try {
    return existsSync(proverLibPath());
  } catch {
    return false;
  }
}

function platformLib(name: string): string {
  return name.endsWith('.so') ? `${name.slice(0, -3)}.${suffix}` : name;
}

function assertHostInstall(libDir: string, datDir: string, game: HouseGameModule): void {
  const missing: string[] = [];
  for (const name of game.libs) {
    if (name.includes('_bet')) throw new Error(`house set lists a bet library: ${name}`);
    const file = platformLib(name);
    const inLibDir = existsSync(path.join(libDir, file));
    const proverLib = name.startsWith('librapidsnark.') && proverLibInstalled();
    if (!inLibDir && !proverLib) missing.push(file);
  }
  for (const name of game.dats) {
    if (name.includes('_bet')) throw new Error(`house set lists bet witness data: ${name}`);
    if (!existsSync(path.join(datDir, name))) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`house ${game.game} is missing on the host: ${missing.join(' ')}`);
  }
}

export async function selfCheck(game: HouseGameModule): Promise<void> {
  const libDir = houseLibDir();
  const datDir = houseDatDir();
  const image = isImageInstall(libDir);
  if (image) {
    sameSet(libDir, readdirSync(libDir), game.libs);
    sameSet(datDir, readdirSync(datDir), game.dats);
    for (const name of readdirSync(datDir)) {
      if (name.includes('_bet')) throw new Error(`bet witness data in image: ${name}`);
    }
  } else {
    assertHostInstall(libDir, datDir, game);
  }

  const modulesRoot = existsSync('/app/node_modules')
    ? '/app/node_modules'
    : path.join(process.cwd(), 'node_modules');
  for (const pkg of CHAIN_PACKAGES) {
    const dir = path.join(modulesRoot, pkg);
    if (!existsSync(dir)) throw new Error(`missing on-chain dependency ${pkg}`);
  }

  const idlPath = path.join(process.cwd(), 'rust/light-casino/idl/light_casino.json');
  const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as { address?: string };
  if (idl.address !== LIGHT_CASINO_PROGRAM_ID) {
    throw new Error(`light-casino IDL address is ${idl.address ?? '(missing)'}`);
  }
  const provider = new AnchorProvider(
    new web3.Connection('http://127.0.0.1:8899', 'confirmed'),
    new Wallet(web3.Keypair.generate()),
    { commitment: 'confirmed' },
  );
  const light = new Program(idl, provider);
  if (light.programId.toBase58() !== LIGHT_CASINO_PROGRAM_ID) {
    throw new Error(`light program id ${light.programId.toBase58()}`);
  }

  const player = game.openHousePlayer();
  const ping = await player.ping();
  if (!ping.ok) throw new Error(`house ${game.game} ping failed`);
  const keyed = await player.key();
  if (keyed.key.publicKey[0] === 0n && keyed.key.publicKey[1] === 0n) {
    throw new Error('house key is the zero point');
  }

  for (const op of ['bet', 'card'] as const) {
    try {
      await player.invoke({ op });
      throw new Error(`house session accepted a ${op}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('house player does not place bets')) throw err;
    }
  }

  if (image) {
    refuse(game.kind, game.variant, 'bet');
    refuse(game.kind, game.variant, 'card');
  }
  player.close();
  console.log(`house ${game.game} ${image ? 'image' : 'host'} ok`);
}

export async function bootHouse(game: HouseGameModule): Promise<void> {
  const player = game.openHousePlayer();
  const ping = await player.ping();
  console.log(`house ${game.game} player ready`, ping);

  const rpc = process.env.RPC_URL;
  const keypairPath = process.env.HOUSE_KEYPAIR;
  if (rpc && keypairPath) {
    const chain = await connectHouseChain(rpc, keypairPath);
    console.log('casino', chain.casino.programId.toBase58());
    console.log('light-casino', chain.light.programId.toBase58());
  }
}
