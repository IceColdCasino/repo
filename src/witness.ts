import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import * as path from 'node:path';

const libDir = path.join(__dirname, '../libzkcasino/zig-out/lib');

const FFI_SYMBOLS = {
  zkcasino_init: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  zkcasino_get_size: {
    args: [FFIType.ptr],
    returns: FFIType.u32,
  },
  zkcasino_generate_wtns: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
  zkcasino_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  zkcasino_set_dat_root: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
} as const;

/** Directory of `{circuit}.dat` files loaded at runtime (not embedded in dylibs). */
const datDir = process.env.ZKCASINO_DAT_ROOT
  ?? path.join(__dirname, '../libzkcasino/src/zig/dat');

// zkey/circuit name -> { lib, short circuit name }
const CIRCUIT_MAP: Record<string, { lib: string; circuit: string }> = {
  'register_main': { lib: 'zkcasino', circuit: 'register' },
  // shared shuffle (separate dynamic libs)
  'shuffle_1_deck_52_main': { lib: 'zkcasino-shuffle-1-deck-52', circuit: 'shuffle_1_deck_52' },
  'shuffle_6_deck_52_main': { lib: 'zkcasino-shuffle-6-deck-52', circuit: 'shuffle_6_deck_52' },
  'shuffle_8_deck_52_main': { lib: 'zkcasino-shuffle-8-deck-52', circuit: 'shuffle_8_deck_52' },
  // poker (share + showdown only)
  'poker_share_hashout_main': { lib: 'zkcasino-poker', circuit: 'poker_share' },
  'poker_showdown_hashout_main': { lib: 'zkcasino-poker', circuit: 'poker_showdown' },
  // baccarat
  'baccarat_share_hashout_main': { lib: 'zkcasino-baccarat', circuit: 'baccarat_share' },
  'baccarat_showdown_hashout_main': { lib: 'zkcasino-baccarat', circuit: 'baccarat_showdown' },
  // war
  'war_share_hashout_main': { lib: 'zkcasino-war', circuit: 'war_share' },
  'war_showdown_hashout_main': { lib: 'zkcasino-war', circuit: 'war_showdown' },
  // blackjack (share chunk + action + player showdown only)
  'blackjack_share_hashout_main': { lib: 'zkcasino-blackjack', circuit: 'blackjack_share' },
  'blackjack_action_hashout_main': { lib: 'zkcasino-blackjack', circuit: 'blackjack_action' },
  'blackjack_showdown_hashout_main': { lib: 'zkcasino-blackjack', circuit: 'blackjack_showdown' },
  // roulette (EU 37 / US 38)
  'shuffle_1_deck_37_main': { lib: 'zkcasino-shuffle-1-deck-37', circuit: 'shuffle_1_deck_37' },
  'shuffle_1_deck_38_main': { lib: 'zkcasino-shuffle-1-deck-38', circuit: 'shuffle_1_deck_38' },
  'roulette_share_hashout_main': { lib: 'zkcasino-roulette', circuit: 'roulette_share' },
  'roulette_bet_37_main': { lib: 'zkcasino-roulette', circuit: 'roulette_bet_37' },
  'roulette_bet_38_main': { lib: 'zkcasino-roulette', circuit: 'roulette_bet_38' },
  'roulette_showdown_37_hashout_main': { lib: 'zkcasino-roulette', circuit: 'roulette_showdown_37' },
  'roulette_showdown_38_hashout_main': { lib: 'zkcasino-roulette', circuit: 'roulette_showdown_38' },
  // craps
  'shuffle_2_dice_6_main': { lib: 'zkcasino-shuffle-2-dice-6', circuit: 'shuffle_2_dice_6' },
  'craps_share_hashout_main': { lib: 'zkcasino-craps', circuit: 'craps_share' },
  'craps_bet_main': { lib: 'zkcasino-craps', circuit: 'craps_bet' },
  'craps_showdown_hashout_main': { lib: 'zkcasino-craps', circuit: 'craps_showdown' },
  // keno
  'shuffle_1_deck_80_main': { lib: 'zkcasino-shuffle-1-deck-80', circuit: 'shuffle_1_deck_80' },
  'keno_share_hashout_main': { lib: 'zkcasino-keno', circuit: 'keno_share' },
  'keno_bet_main': { lib: 'zkcasino-keno', circuit: 'keno_bet' },
  'keno_showdown_hashout_main': { lib: 'zkcasino-keno', circuit: 'keno_showdown' },
  // slots (bet stays fused with share)
  'shuffle_3_reel_22_main': { lib: 'zkcasino-shuffle-3-reel-22', circuit: 'shuffle_3_reel_22' },
  'shuffle_5_reel_22_main': { lib: 'zkcasino-shuffle-5-reel-22', circuit: 'shuffle_5_reel_22' },
  'slot_share_3_reel_hashout_main': { lib: 'zkcasino-slots', circuit: 'slot_share_3_reel' },
  'slot_share_5_reel_hashout_main': { lib: 'zkcasino-slots', circuit: 'slot_share_5_reel' },
  'slot_showdown_3_reel_hashout_main': { lib: 'zkcasino-slots', circuit: 'slot_showdown_3_reel' },
  'slot_showdown_5_reel_hashout_main': { lib: 'zkcasino-slots', circuit: 'slot_showdown_5_reel' },
  // bingo
  'shuffle_1_deck_75_main': { lib: 'zkcasino-shuffle-1-deck-75', circuit: 'shuffle_1_deck_75' },
  'shuffle_1_deck_90_main': { lib: 'zkcasino-shuffle-1-deck-90', circuit: 'shuffle_1_deck_90' },
  'bingo_share_hashout_main': { lib: 'zkcasino-bingo', circuit: 'bingo_share' },
  'bingo_card_75_main': { lib: 'zkcasino-bingo', circuit: 'bingo_card_75' },
  'bingo_card_90_main': { lib: 'zkcasino-bingo', circuit: 'bingo_card_90' },
  'bingo_showdown_75_hashout_main': { lib: 'zkcasino-bingo', circuit: 'bingo_showdown_75' },
  'bingo_showdown_90_hashout_main': { lib: 'zkcasino-bingo', circuit: 'bingo_showdown_90' },
};

function openZkCasinoLib(libPath: string) {
  return dlopen(libPath, FFI_SYMBOLS);
}

const loadedLibs = new Map<string, ReturnType<typeof openZkCasinoLib>>();
const circuitHandles = new Map<string, any>();

function resolveLibName(libName: string): string {
  return libName;
}

function getLib(libName: string) {
  const resolved = resolveLibName(libName);
  let lib = loadedLibs.get(resolved);
  if (!lib) {
    const libPath = path.join(libDir, `lib${resolved}.${suffix}`);
    lib = openZkCasinoLib(libPath);
    const datRoot = new TextEncoder().encode(datDir);
    lib.symbols.zkcasino_set_dat_root(ptr(datRoot), BigInt(datRoot.length));
    loadedLibs.set(resolved, lib);
  }
  return lib;
}

function initCircuit(circuitName: string): void {
  if (circuitHandles.has(circuitName)) return;

  const config = CIRCUIT_MAP[circuitName];
  if (!config) throw new Error(`No libzkcasino config for circuit: ${circuitName}`);

  const libName = resolveLibName(config.lib);
  const lib = getLib(libName);
  const nameBuf = new TextEncoder().encode(config.circuit + '\0');

  const handle = lib.symbols.zkcasino_init(ptr(nameBuf));

  if (!handle) {
    throw new Error(`zkcasino_init failed for ${circuitName} (lib=${libName}, circuit=${config.circuit})`);
  }

  circuitHandles.set(circuitName, { handle, lib: libName });
}

export function generateWitnessFfi(
  circuitName: string,
  input: Record<string, string | string[]>
): Uint8Array {
  initCircuit(circuitName);

  const entry = circuitHandles.get(circuitName);
  const lib = getLib(entry.lib);
  const handle = entry.handle;
  const jsonStr = JSON.stringify(input);
  const jsonBuf = new TextEncoder().encode(jsonStr + '\0');
  const jsonLen = jsonStr.length;

  const sizeBuf = new Uint32Array(1);
  const sizeResult = lib.symbols.zkcasino_generate_wtns(
    handle,
    ptr(jsonBuf),
    jsonLen,
    null,
    ptr(sizeBuf)
  );

  if (sizeResult !== 0) {
    throw new Error(`zkcasino_generate_wtns size query failed: ${sizeResult}`);
  }

  const requiredSize = sizeBuf[0]!;
  const outputBuf = new Uint8Array(requiredSize);
  const outSizeBuf = new Uint32Array([requiredSize]);

  const genResult = lib.symbols.zkcasino_generate_wtns(
    handle,
    ptr(jsonBuf),
    jsonLen,
    ptr(outputBuf),
    ptr(outSizeBuf)
  );

  if (genResult !== 0) {
    throw new Error(`zkcasino_generate_wtns failed: ${genResult}`);
  }

  const result = outputBuf.slice(0, outSizeBuf[0]);
  if (process.env.ZK_WITNESS_DEBUG === '1') {
    console.log(`[DEBUG] ${circuitName}: witness size=${result.length}, magic=${new TextDecoder().decode(result.slice(0, 4))}, version=${new DataView(result.buffer).getUint32(4, true)}, nSections=${new DataView(result.buffer).getUint32(8, true)}`);
  }

  return result;
}

export default generateWitnessFfi;
