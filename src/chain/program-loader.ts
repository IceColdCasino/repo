/**
 * Load Anchor programs from committed IDL JSON — no fs / anchor CLI.
 * Safe for WKWebView and Node (CLI tooling).
 */
import { Program, type AnchorProvider, type Idl } from '@coral-xyz/anchor';
import casinoIdl from './idl/casino.json';
import lightCasinoIdl from './idl/light_casino.json';

export const BUNDLED_CASINO_PROGRAM_ID =
  (casinoIdl as { address?: string }).address
  ?? '4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY';

export const BUNDLED_LIGHT_CASINO_PROGRAM_ID =
  (lightCasinoIdl as { address?: string }).address
  ?? 'CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc';

export function loadCasinoProgram(provider: AnchorProvider): Program {
  return new Program(casinoIdl as Idl, provider);
}

export function loadLightCasinoProgram(provider: AnchorProvider): Program {
  const idl = { ...(lightCasinoIdl as Idl) } as Idl & { address?: string };
  idl.address = BUNDLED_LIGHT_CASINO_PROGRAM_ID;
  return new Program(idl, provider);
}
