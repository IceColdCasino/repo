/**
 * Seat fee SOL. Localnet airdrops. Any other cluster transfers from the payer
 * so a devnet run does not depend on the faucet.
 */
import { type AnchorProvider, web3 } from '@coral-xyz/anchor';
import {
  EIGHT_DECK_CALLER_INPUTS,
  MAX_CPI_ALLOC,
  shuffleInputsAccountSize,
} from './shuffle-account';

/**
 * The 8-deck shuffle buffer is the largest staging account. Its rent lives in
 * the seat's vault float. The seat wallet only keeps signature fees.
 */
export const SEAT_SHUFFLE_INPUTS_BYTES = shuffleInputsAccountSize(EIGHT_DECK_CALLER_INPUTS);
export const SEAT_SHARE_STAGING_BYTES = 29_920;
export const SEAT_FEE_CUSHION_LAMPORTS = Math.floor(0.05 * web3.LAMPORTS_PER_SOL);

/**
 * Lamports charged for each byte of account data plus the 128-byte overhead.
 * Devnet's rent sysvar is 5,080 today. A later epoch can publish a lower rate;
 * `clusterRentLamportsPerByte` reads that sysvar before a reclaim.
 */
export const RENT_LAMPORTS_PER_BYTE = 5_080;

/** Rent-exempt lamports for an account whose data length is `dataLen`. */
export function rentExemptLamports(
  dataLen: number,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
): number {
  return lamportsPerByte * (dataLen + 128);
}

/**
 * Rent the seat fronts while a hand moves from shuffle into share.
 * The shuffle-inputs account stays open until the hand closes, and share
 * staging is allocated on top of it, so the vault has to cover both.
 */
export function reusedStagingLamports(
  callerInputs: number,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
): number {
  const shuffleBytes = Math.max(shuffleInputsAccountSize(callerInputs), MAX_CPI_ALLOC);
  return rentExemptLamports(shuffleBytes, lamportsPerByte)
    + rentExemptLamports(SEAT_SHARE_STAGING_BYTES, lamportsPerByte);
}

/**
 * Seat wallet floor. Staging, chunk lanes, and the other hand accounts are
 * drawn from the vault float and closed back into it. The seat keeps signature fees.
 */
export function seatFloorLamports(_callerInputs = EIGHT_DECK_CALLER_INPUTS): number {
  return SEAT_FEE_CUSHION_LAMPORTS;
}

/** Floor for a reused devnet seat on an 8-deck shoe. */
export const DEVNET_SEAT_LAMPORTS = seatFloorLamports();

/**
 * Lamports to send so `balance` reaches `floor`.
 * A craps seat at 3_512_520 lamports could not pay a 52_019_200 shuffle extend.
 */
export function seatTopUpLamports(balance: number, floor = DEVNET_SEAT_LAMPORTS): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error(`seat balance must be a non-negative number, got ${balance}`);
  }
  if (balance >= floor) return 0;
  return floor - balance;
}

export function isLocalCluster(rpc: string): boolean {
  return rpc.includes('127.0.0.1') || rpc.includes('localhost');
}

export function walletPayer(provider: AnchorProvider): web3.Keypair | null {
  const payer = (provider.wallet as { payer?: web3.Keypair }).payer;
  return payer ?? null;
}

export async function fundSol(
  provider: AnchorProvider,
  to: web3.PublicKey,
  lamports: number,
): Promise<void> {
  const connection = provider.connection;
  if (isLocalCluster(connection.rpcEndpoint)) {
    const sig = await connection.requestAirdrop(to, lamports);
    await connection.confirmTransaction(sig, 'confirmed');
    const { noteSeatAirdrop } = await import('./hand-cost');
    noteSeatAirdrop(to, lamports);
    return;
  }
  const from = walletPayer(provider);
  if (!from) {
    throw new Error(`Cannot fund ${to.toBase58()} without a payer keypair.`);
  }
  if (from.publicKey.equals(to)) return;
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: Math.min(lamports, DEVNET_SEAT_LAMPORTS),
    }),
  );
  const sig = await connection.sendTransaction(tx, [from]);
  await connection.confirmTransaction(sig, 'confirmed');
}

/** Bring a reused devnet seat key up to `floor` (default: 8-deck reused buffer). */
export async function ensureSeatSol(
  provider: AnchorProvider,
  to: web3.PublicKey,
  floor = DEVNET_SEAT_LAMPORTS,
): Promise<void> {
  if (isLocalCluster(provider.connection.rpcEndpoint)) return;
  const balance = await provider.connection.getBalance(to, 'confirmed');
  const topUp = seatTopUpLamports(balance, floor);
  if (topUp > 0) await fundSol(provider, to, topUp);
  const held = await provider.connection.getBalance(to, 'confirmed');
  const { noteSeatAirdrop } = await import('./hand-cost');
  noteSeatAirdrop(to, held);
}
