/**
 * Chain client for a house image. Casino IDL is read from the deployed
 * program. Light-casino IDL ships in the image.
 */
import { AnchorProvider, Program, Wallet, web3 } from '@coral-xyz/anchor';
import fs from 'node:fs';
import path from 'node:path';
import { OnchainGameLifecycle } from '../chain/onchain-game-lifecycle';
import { OnchainRoomLifecycle } from '../chain/room/onchain-room-lifecycle';
import {
  CASINO_PROGRAM_ID,
  LIGHT_CASINO_PROGRAM_ID,
} from '../testing/deploy';

export { CASINO_PROGRAM_ID, LIGHT_CASINO_PROGRAM_ID };
export { OnchainGameLifecycle, OnchainRoomLifecycle };

export interface HouseChain {
  provider: AnchorProvider;
  keypair: web3.Keypair;
  casino: Program;
  light: Program;
}

export async function connectHouseChain(rpcUrl: string, keypairPath: string): Promise<HouseChain> {
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8')) as number[];
  const keypair = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: 'confirmed' });
  const casinoId = new web3.PublicKey(CASINO_PROGRAM_ID);
  const casinoIdl = await Program.fetchIdl(casinoId, provider);
  if (!casinoIdl) {
    throw new Error(`casino IDL is not on ${rpcUrl} for ${CASINO_PROGRAM_ID}`);
  }
  const casino = new Program(casinoIdl, provider);
  const lightIdlPath = path.join(process.cwd(), 'rust/light-casino/idl/light_casino.json');
  const lightIdl = JSON.parse(fs.readFileSync(lightIdlPath, 'utf8')) as ConstructorParameters<typeof Program>[0];
  const light = new Program(lightIdl, provider);
  return { provider, keypair, casino, light };
}

export function houseGameLifecycle(
  chain: HouseChain,
  gameId: Uint8Array,
): OnchainGameLifecycle {
  return new OnchainGameLifecycle(chain.light, chain.provider, gameId, chain.casino);
}
