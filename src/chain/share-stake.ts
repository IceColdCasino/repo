/**
 * SOL posted before a poker share. The rent float stays in the vault.
 * This holds only the signature-fee bond plus the protocol penalty, and
 * returns it when the hand completes without a slash.
 */
import { web3 } from '@coral-xyz/anchor';
import { requiredShareStake } from '../poker-share-penalty';
import { confirmOrResend } from './confirm-tx';

type Hold = {
  gameId: string;
  player: string;
  keypair: web3.Keypair;
};

const holds = new Map<string, Hold>();

function storage(): Storage | null {
  const candidate = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  return candidate ?? null;
}

function holdId(player: string): string {
  return `poker-share-stake:${player}`;
}

function readHold(player: string): Hold | null {
  const cached = holds.get(player);
  if (cached) return cached;
  const raw = storage()?.getItem(holdId(player));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { gameId: string; secretKey: number[] };
  const hold: Hold = {
    gameId: parsed.gameId,
    player,
    keypair: web3.Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey)),
  };
  holds.set(player, hold);
  return hold;
}

function writeHold(hold: Hold): void {
  holds.set(hold.player, hold);
  storage()?.setItem(holdId(hold.player), JSON.stringify({
    gameId: hold.gameId,
    secretKey: Array.from(hold.keypair.secretKey),
  }));
}

function clearHold(player: string): void {
  holds.delete(player);
  storage()?.removeItem(holdId(player));
}

async function feePayer(): Promise<web3.Keypair> {
  const launch = (globalThis as {
    window?: { __ZK_LAUNCH_CONFIG?: { feePayerSecret?: number[] } };
  }).window?.__ZK_LAUNCH_CONFIG;
  const secret = launch?.feePayerSecret;
  if (Array.isArray(secret) && secret.length > 0) {
    return web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  if ((globalThis as { window?: unknown }).window !== undefined) {
    throw new Error('fee payer secret is missing from the launch config');
  }
  const { loadMxeAuthorityKeypair } = await import('./admin-provider');
  return loadMxeAuthorityKeypair();
}

async function transfer(
  connection: web3.Connection,
  from: web3.Keypair,
  to: web3.PublicKey,
  lamports: number,
  payer: web3.Keypair = from,
): Promise<void> {
  if (lamports <= 0) return;
  const signers = from.publicKey.equals(payer.publicKey) ? [from] : [payer, from];
  // web3's sendAndConfirmTransaction signs with a cached `finalized`
  // blockhash. Fetch a `confirmed` one right before each signature instead.
  await confirmOrResend(connection, async (latest) => {
    const tx = new web3.Transaction({
      feePayer: payer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(
      web3.SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports,
      }),
    );
    tx.sign(...signers);
    return connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: 'confirmed',
    });
  });
}

/** Top the seat up from the fee payer so it can open its room session. */
export async function ensureSeatLamports(
  connection: web3.Connection,
  seat: web3.Keypair,
  lamports: number,
): Promise<void> {
  const have = await connection.getBalance(seat.publicKey, 'confirmed');
  if (have >= lamports) return;
  const payer = await feePayer();
  const short = lamports - have;
  if (payer.publicKey.equals(seat.publicKey)) {
    throw new Error(`seat is short ${short} lamports for the room session`);
  }
  await transfer(connection, payer, seat.publicKey, short);
}

async function releaseHold(
  connection: web3.Connection,
  hold: Hold,
  player: web3.PublicKey,
): Promise<void> {
  const balance = await connection.getBalance(hold.keypair.publicKey, 'confirmed');
  if (balance > 0) {
    const payer = await feePayer();
    await transfer(connection, hold.keypair, player, balance, payer);
  }
  clearHold(hold.player);
}

/**
 * Lock this seat's share bond for `gameId`. A bond still held for an earlier
 * hand is returned first.
 */
export async function postPlayerShareStake(args: {
  connection: web3.Connection;
  player: web3.Keypair;
  gameId: Uint8Array;
  playerCount: number;
}): Promise<bigint> {
  const gameId = Buffer.from(args.gameId).toString('hex');
  const player = args.player.publicKey.toBase58();
  const amount = requiredShareStake(args.playerCount);
  const previous = readHold(player);
  if (previous && previous.gameId !== gameId) {
    await releaseHold(args.connection, previous, args.player.publicKey);
  }
  const existing = previous && previous.gameId === gameId ? previous : null;
  const hold = existing ?? {
    gameId,
    player,
    keypair: web3.Keypair.generate(),
  };
  writeHold(hold);
  const have = await args.connection.getBalance(hold.keypair.publicKey, 'confirmed');
  const need = Number(amount) - have;
  if (need > 0) {
    await ensureSeatLamports(args.connection, args.player, need + 20_000);
    await transfer(args.connection, args.player, hold.keypair.publicKey, need);
  }
  return amount;
}

/** Return a posted bond to the seat. A missing bond is a no-op. */
export async function releasePlayerShareStake(
  connection: web3.Connection,
  player: web3.Keypair,
): Promise<void> {
  const hold = readHold(player.publicKey.toBase58());
  if (!hold) return;
  await releaseHold(connection, hold, player.publicKey);
}
