/**
 * Per-hand SOL measurement. A hand starts after computation definitions are
 * uploaded. The ledger records seat airdrops and vault deposits, then the
 * finish line reads what is still in each wallet and vault.
 */
import { appendFileSync } from 'node:fs';
import { type AnchorProvider, web3 } from '@coral-xyz/anchor';
import { loadWhitelistAdminProvider } from './admin-provider';
import { rentExemptLamports } from './fund-sol';
import { RENT_VAULT_DATA_LEN, rentVaultFor } from './rent-vault';

const COST_LOG = '/tmp/icc-hand-cost.jsonl';

const GAME_NAMES = [
  'poker',
  'baccarat',
  'blackjack',
  'war',
  'roulette',
  'craps',
  'keno',
  'slots',
  'bingo',
] as const;

export function gameKindName(kind: number): string {
  return GAME_NAMES[kind] ?? `game-${kind}`;
}

type Snap = {
  payer: number;
  admin: number;
  payerKey: web3.PublicKey;
  adminKey: web3.PublicKey;
};

const airdrops = new Map<string, number>();
const deposits = new Map<string, number>();
let active: Snap | null = null;

export function noteSeatAirdrop(player: web3.PublicKey, lamports: number): void {
  if (!active || lamports <= 0) return;
  const key = player.toBase58();
  airdrops.set(key, (airdrops.get(key) ?? 0) + lamports);
}

export function noteVaultDeposit(player: web3.PublicKey, lamports: number): void {
  if (!active || lamports <= 0) return;
  const key = player.toBase58();
  deposits.set(key, (deposits.get(key) ?? 0) + lamports);
}

export async function beginHandCost(provider: AnchorProvider): Promise<void> {
  airdrops.clear();
  deposits.clear();
  const admin = await loadWhitelistAdminProvider(provider.connection);
  const [payer, adminBal] = await Promise.all([
    provider.connection.getBalance(provider.wallet.publicKey, 'confirmed'),
    provider.connection.getBalance(admin.wallet.publicKey, 'confirmed'),
  ]);
  active = {
    payer,
    admin: adminBal,
    payerKey: provider.wallet.publicKey,
    adminKey: admin.wallet.publicKey,
  };
  appendFileSync(COST_LOG, `${JSON.stringify({ event: 'begin', payer: snapPayer(active) })}\n`);
}

function snapPayer(snap: Snap): string {
  return snap.payerKey.toBase58();
}

function sol(lamports: number): string {
  const sign = lamports < 0 ? '-' : '';
  const abs = Math.abs(lamports);
  const whole = Math.floor(abs / 1_000_000_000);
  const frac = String(abs % 1_000_000_000).padStart(9, '0').slice(0, 6);
  return `${sign}${whole}.${frac}`;
}

/** Read wallets and vaults and print one `[hand-cost]` line for this hand. */
export async function finishHandCost(
  provider: AnchorProvider,
  game: string,
  players: Iterable<web3.Keypair>,
): Promise<void> {
  const snap = active;
  active = null;
  if (!snap) {
    appendFileSync(COST_LOG, `${JSON.stringify({ event: 'finish-empty', game })}\n`);
    return;
  }
  try {
  await writeHandCost(provider, game, players, snap);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[hand-cost] ${game} report failed: ${message.split('\n')[0]}`);
    appendFileSync(COST_LOG, `${JSON.stringify({ event: 'finish-error', game, message })}\n`);
  }
}

async function writeHandCost(
  provider: AnchorProvider,
  game: string,
  players: Iterable<web3.Keypair>,
  snap: Snap,
): Promise<void> {
  const connection = provider.connection;
  const handPlayers = [...players];
  // House games keep the house as the last hand seat. Poker and bingo do not.
  const houseIndex = game === 'poker' || game === 'bingo' ? -1 : handPlayers.length - 1;
  const seats = [...handPlayers];
  const seen = new Set(seats.map((kp) => kp.publicKey.toBase58()));
  const payerKp = (provider.wallet as { payer?: web3.Keypair }).payer;
  if (payerKp && !seen.has(payerKp.publicKey.toBase58())) seats.push(payerKp);

  const vaultRent = rentExemptLamports(RENT_VAULT_DATA_LEN);
  const rows = [];
  for (const [index, kp] of seats.entries()) {
    const key = kp.publicKey.toBase58();
    const isPayer = kp.publicKey.equals(snap.payerKey);
    const airdrop = airdrops.get(key) ?? 0;
    const deposit = deposits.get(key) ?? 0;
    const wallet = await connection.getBalance(kp.publicKey, 'confirmed');
    const vaultPk = rentVaultFor(kp.publicKey);
    const vault = vaultPk ? await connection.getBalance(vaultPk, 'confirmed') : 0;
    const floatLeft = vaultPk ? Math.max(0, vault - vaultRent) : 0;
    const vaultDrawn = Math.max(0, deposit - floatLeft);
    const seatFees = !isPayer && airdrop > 0 ? airdrop - wallet : null;
    rows.push({
      index,
      player: key,
      role: isPayer ? 'operator' : index === houseIndex ? 'house' : 'seat',
      airdrop,
      wallet,
      seatFees,
      vaultDeposit: deposit,
      vault,
      floatLeft,
      vaultDrawn,
    });
  }

  const [payerEnd, adminEnd] = await Promise.all([
    connection.getBalance(snap.payerKey, 'confirmed'),
    connection.getBalance(snap.adminKey, 'confirmed'),
  ]);
  const deposited = rows.reduce((sum, row) => sum + row.vaultDeposit, 0);
  const payerDelta = snap.payer - payerEnd;
  const report = {
    game,
    payerDelta,
    operatorFees: payerDelta - deposited,
    adminDelta: snap.admin - adminEnd,
    players: rows,
  };
  appendFileSync(COST_LOG, `${JSON.stringify(report)}\n`);
  console.log(`[hand-cost] ${JSON.stringify(report)}`);
  const parts = rows.map((row) => {
    const fees = row.seatFees == null ? 'operator' : sol(row.seatFees);
    return `p${row.index} ${row.role} capital ${sol(row.airdrop + row.vaultDeposit)} `
      + `wallet ${sol(row.wallet)} vault ${sol(row.floatLeft)} `
      + `drawn ${sol(row.vaultDrawn)} fees ${fees}`;
  });
  console.log(
    `[hand-cost] ${game} ${parts.join(' | ')} `
    + `operatorFees ${sol(report.operatorFees)} admin ${sol(report.adminDelta)}`,
  );
}
