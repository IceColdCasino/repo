import { createHash } from 'node:crypto';
import { type AnchorProvider, web3 } from '@coral-xyz/anchor';
import { DEVNET_ARCIUM_IN_FLIGHT } from '../arcium/heap';
import { LIGHT_CASINO_PROGRAM_ID } from '../testing/deploy';
import { EIGHT_DECK_CALLER_INPUTS, MAX_CPI_ALLOC } from './shuffle-account';
import {
  RENT_LAMPORTS_PER_BYTE,
  rentExemptLamports,
  reusedStagingLamports,
} from './fund-sol';

/**
 * Lanes in one `fund_shuffle_lanes` transaction. Each lane is a 32-byte key
 * and the legacy packet is 1232 bytes, which fits 28 lanes plus the program,
 * operator, game, player, and vault. A larger shoe is funded in batches.
 * Must match on-chain `SHUFFLE_LANES`.
 */
export const SHUFFLE_LANES_PER_TX = 28;
/** game id, lane payer, generation, player, start, count. */
export const SHUFFLE_CHUNK_HEADER = 77;
/** Full 16-field chunk, including the tail of a shoe. Header, fields, MSM partial. */
export const SHUFFLE_CHUNK_ACCOUNT_SIZE = SHUFFLE_CHUNK_HEADER + 16 * 32 + 64;
/** Signature budget for one chunk transaction, including a retry. */
export const SHUFFLE_LANE_FEE_PER_TX = 10_000;

/**
 * One funded signer per chunk. Every chunk stays open until its multiply
 * result is copied, so the float covers one rent-exempt account per chunk.
 */
export function shuffleLanePlan(
  callerInputs = EIGHT_DECK_CALLER_INPUTS,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
): {
  chunks: number;
  lanes: number;
  perLane: number;
  rent: number;
  amountPerLane: number;
  slots: number;
  fee: number;
} {
  const chunks = Math.max(1, Math.ceil(callerInputs / 16));
  const rent = rentExemptLamports(SHUFFLE_CHUNK_ACCOUNT_SIZE, lamportsPerByte);
  const fee = chunks * SHUFFLE_LANE_FEE_PER_TX;
  return {
    chunks,
    lanes: chunks,
    perLane: 1,
    rent,
    amountPerLane: rent + SHUFFLE_LANE_FEE_PER_TX,
    slots: chunks,
    fee,
  };
}

/**
 * Largest computation-account balance measured on a 2-player localnet hand
 * (6,521,520 lamports), plus headroom. The balance is rent plus Arcium's
 * execution fee, so it is not a pure rent-exempt figure.
 */
export const COMPUTATION_RENT_CEILING = 8_000_000;

/**
 * Computations whose rent is out of the vault at once. The default matches
 * the devnet queue cap. Keno passes 20 because the whole draw is queued
 * together and each card's computation account stays open until it finalizes.
 */
export function computationFloat(slots = DEVNET_ARCIUM_IN_FLIGHT): number {
  return COMPUTATION_RENT_CEILING * slots;
}

/** Lamports moved out of the vault to fund every lane for this shoe. */
export function shuffleLaneFloat(
  callerInputs = EIGHT_DECK_CALLER_INPUTS,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
): number {
  const plan = shuffleLanePlan(callerInputs, lamportsPerByte);
  return plan.lanes * plan.amountPerLane;
}

/**
 * Vault float for this shoe. Shuffle inputs stay open while share staging
 * is allocated, plus a proof receipt beside them, plus the parallel chunk
 * lanes, plus one computation account per in-flight queue slot. An 8-deck
 * shoe is the ceiling. `lamportsPerByte` is the cluster rent rate; the
 * default is today's 5,080. The computation budget is a fixed lamport
 * ceiling and does not scale with the rent rate.
 */
export function rentVaultFloat(
  callerInputs = EIGHT_DECK_CALLER_INPUTS,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
  computationSlots = DEVNET_ARCIUM_IN_FLIGHT,
): number {
  return reusedStagingLamports(callerInputs, lamportsPerByte)
    + rentExemptLamports(85, lamportsPerByte)
    + shuffleLaneFloat(callerInputs, lamportsPerByte)
    + computationFloat(computationSlots);
}

/** 8-deck ceiling. Callers that know the table shoe pass `rentVaultFloat(caller)`. */
export const RENT_VAULT_FLOAT = rentVaultFloat();

/**
 * Lamports that stay in the vault: its own rent plus shuffle and share staging.
 * Surplus above this is the recapture.
 */
export function vaultKeepLamports(
  callerInputs = EIGHT_DECK_CALLER_INPUTS,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
  computationSlots = DEVNET_ARCIUM_IN_FLIGHT,
): number {
  return rentExemptLamports(RENT_VAULT_DATA_LEN, lamportsPerByte)
    + rentVaultFloat(callerInputs, lamportsPerByte, computationSlots);
}

/**
 * Current rent rate from the cluster sysvar.
 * An empty account costs `rate × 128` and a one-byte account costs one rate more.
 */
export async function clusterRentLamportsPerByte(
  connection: {
    getMinimumBalanceForRentExemption(dataLength: number): Promise<number>;
  },
): Promise<number> {
  const empty = await connection.getMinimumBalanceForRentExemption(0);
  const oneByte = await connection.getMinimumBalanceForRentExemption(1);
  const rate = oneByte - empty;
  if (!Number.isInteger(rate) || rate <= 0 || empty !== rate * 128) {
    throw new Error(
      `rent sysvar is not a flat per-byte charge (0 bytes costs ${empty}, 1 byte costs ${oneByte})`,
    );
  }
  return rate;
}

const LIGHT_PROGRAM = new web3.PublicKey(LIGHT_CASINO_PROGRAM_ID);
const RENT_VAULT_SEED = Buffer.from('rent_vault');
const CASINO_RENT_AUTHORITY_SEED = Buffer.from('casino_rent_authority');

export const INIT_RENT_VAULT = sighash('init_rent_vault');
export const DEPOSIT_RENT_VAULT = sighash('deposit_rent_vault');
export const SETTLE_RENT_VAULT = sighash('settle_rent_vault');
export const REIMBURSE_RENT_VAULT = sighash('reimburse_rent_vault');
export const RECAPTURE_RENT_VAULT = sighash('recapture_rent_vault');
export const DRAW_RENT_VAULT = sighash('draw_rent_vault');
/** On-chain `RENT_VAULT_LEN`: discriminator, room, player, bump. */
export const RENT_VAULT_DATA_LEN = 73;
export const SIT_OUT = sighash('sit_out');
export const CLOSE_SEAT_RENT = sighash('close_seat_rent');
export const CLOSE_PLAYER_STATE = Buffer.from([107, 168, 253, 249, 125, 169, 108, 96]);
export const CLOSE_SHARE_RECEIPT = sighash('close_share_receipt');
export const RENT_VAULT_DISCRIMINATOR = accountDiscriminator('RentVault');

const vaults = new Map<string, web3.PublicKey>();

function sighash(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

export function rentVaultPda(roomId: Uint8Array, player: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [RENT_VAULT_SEED, Buffer.from(roomId), player.toBuffer()],
    LIGHT_PROGRAM,
  )[0];
}

export function casinoRentAuthority(casinoProgramId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [CASINO_RENT_AUTHORITY_SEED],
    casinoProgramId,
  )[0];
}

export function rememberRentVault(player: web3.PublicKey, vault: web3.PublicKey): void {
  vaults.set(player.toBase58(), vault);
}

export function rentVaultFor(player: web3.PublicKey): web3.PublicKey | undefined {
  return vaults.get(player.toBase58());
}

/** Leading remaining account for a light-casino staging instruction. */
export function leadingVaultMeta(player: web3.PublicKey): web3.AccountMeta[] {
  const vault = rentVaultFor(player);
  if (!vault) return [];
  return [{ pubkey: vault, isSigner: false, isWritable: true }];
}

export function prependVault(
  player: web3.PublicKey,
  rest: web3.AccountMeta[],
): web3.AccountMeta[] {
  return [...leadingVaultMeta(player), ...rest];
}

/**
 * Casino remaining accounts: vault, rent-authority PDA, light-casino program.
 * Empty when this player has no staged float.
 */
export function casinoVaultRemaining(
  player: web3.PublicKey,
  casinoProgramId: web3.PublicKey,
): web3.AccountMeta[] {
  const vault = rentVaultFor(player);
  if (!vault) return [];
  return [
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: casinoRentAuthority(casinoProgramId), isSigner: false, isWritable: false },
    { pubkey: LIGHT_PROGRAM, isSigner: false, isWritable: false },
  ];
}

async function send(
  provider: AnchorProvider,
  ixs: web3.TransactionInstruction[],
  extraSigner?: web3.Keypair,
): Promise<void> {
  const latest = await provider.connection.getLatestBlockhash('confirmed');
  const tx = new web3.Transaction({
    feePayer: provider.wallet.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...ixs);
  if (extraSigner && !extraSigner.publicKey.equals(provider.wallet.publicKey)) {
    tx.partialSign(extraSigner);
  }
  const signed = await provider.wallet.signTransaction(tx);
  const signature = await provider.connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: 'confirmed',
  });
  const confirmation = await provider.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`rent vault transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
}

/**
 * Open the player's vault (admin pays the account rent) and fund the float
 * from the fee payer. A vault that already exists is reused.
 */
export async function stagePlayerRent(
  provider: AnchorProvider,
  admin: AnchorProvider,
  roomId: Uint8Array,
  player: web3.PublicKey,
  callerInputs = EIGHT_DECK_CALLER_INPUTS,
  /** Rent for accounts this vault will open at table setup, on top of the hand float. */
  tableLamports = 0,
  /** Computation accounts that can be open together. Keno's draw uses 20. */
  computationSlots = DEVNET_ARCIUM_IN_FLIGHT,
): Promise<web3.PublicKey> {
  const vault = rentVaultPda(roomId, player);
  rememberRentVault(player, vault);
  const lamportsPerByte = await clusterRentLamportsPerByte(provider.connection);
  const lamports = rentVaultFloat(callerInputs, lamportsPerByte, computationSlots) + tableLamports;
  const existing = await provider.connection.getAccountInfo(vault, 'confirmed');
  if (existing && existing.data.length >= RENT_VAULT_DATA_LEN) {
    const keep = rentExemptLamports(RENT_VAULT_DATA_LEN, lamportsPerByte) + lamports;
    const topUp = Math.max(0, keep - existing.lamports);
    await fitVaultFloat(provider, admin, vault, player, lamports, existing.lamports, lamportsPerByte);
    if (topUp > 0) {
      const { noteVaultDeposit } = await import('./hand-cost');
      noteVaultDeposit(player, topUp);
    }
    return vault;
  }
  const initIx = new web3.TransactionInstruction({
    programId: LIGHT_PROGRAM,
    keys: [
      { pubkey: admin.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([INIT_RENT_VAULT, Buffer.from(roomId), player.toBuffer()]),
  });
  await send(admin, [initIx]);
  await depositRentVault(provider, vault, lamports);
  const { noteVaultDeposit } = await import('./hand-cost');
  noteVaultDeposit(player, lamports);
  return vault;
}

/**
 * Move a live vault onto `floatLamports` of working capital.
 * A short vault is topped up from the fee payer. A fat vault returns the
 * surplus to that same payer and keeps its rent plus the shoe float.
 */
async function fitVaultFloat(
  provider: AnchorProvider,
  admin: AnchorProvider,
  vault: web3.PublicKey,
  player: web3.PublicKey,
  floatLamports: number,
  balance: number,
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
): Promise<void> {
  const keep = rentExemptLamports(RENT_VAULT_DATA_LEN, lamportsPerByte) + floatLamports;
  if (balance < keep) {
    await depositRentVault(provider, vault, keep - balance);
    return;
  }
  if (balance > keep) {
    await recaptureRentVault(provider, admin, vault, player, keep);
  }
}

/** Close a vault and send its entire balance to its player. The admin signs. */
export async function settleRentVault(
  provider: AnchorProvider,
  admin: AnchorProvider,
  vault: web3.PublicKey,
  player: web3.PublicKey,
): Promise<void> {
  const adminKp = (admin.wallet as { payer?: web3.Keypair }).payer;
  if (!adminKp) throw new Error('whitelist admin key is required to settle a vault');
  const ix = new web3.TransactionInstruction({
    programId: LIGHT_PROGRAM,
    keys: [
      { pubkey: adminKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: false, isWritable: true },
    ],
    data: SETTLE_RENT_VAULT,
  });
  await send(provider, [ix], adminKp);
}

/** Send lamports above `keep` to the fee payer. The vault account stays open. */
export async function recaptureRentVault(
  provider: AnchorProvider,
  admin: AnchorProvider,
  vault: web3.PublicKey,
  player: web3.PublicKey,
  keep: number,
): Promise<void> {
  const adminKp = (admin.wallet as { payer?: web3.Keypair }).payer;
  if (!adminKp) throw new Error('whitelist admin key is required to recapture vault float');
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(BigInt(keep));
  const ix = new web3.TransactionInstruction({
    programId: LIGHT_PROGRAM,
    keys: [
      { pubkey: adminKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([RECAPTURE_RENT_VAULT, amount]),
  });
  await send(provider, [ix], adminKp);
}

/**
 * Read the cluster rent rate, recompute this shoe's keep, and return the surplus.
 * A lower rate shrinks every byte of the shuffle buffer, the share buffer, the
 * proof receipt, and the vault account itself. Vaults already at or under the
 * new keep are left alone, including one whose float is out in an open buffer.
 */
export async function recalculateAndRecaptureFloat(
  provider: AnchorProvider,
  admin: AnchorProvider,
  callerInputs = EIGHT_DECK_CALLER_INPUTS,
): Promise<{
  lamportsPerByte: number;
  keep: number;
  scanned: number;
  recapturedVaults: number;
  lamports: number;
}> {
  const lamportsPerByte = await clusterRentLamportsPerByte(provider.connection);
  const keep = vaultKeepLamports(callerInputs, lamportsPerByte);
  const swept = await recaptureExcessFloat(provider, admin, keep);
  return { lamportsPerByte, keep, ...swept };
}

/**
 * Pull every rent vault down to `keep`. Vaults already at or under it are left
 * alone, including one whose float is currently sitting in an open staging account.
 * Pass a keep from `vaultKeepLamports` at the current rent rate, or call
 * `recalculateAndRecaptureFloat` to read that rate first.
 */
export async function recaptureExcessFloat(
  provider: AnchorProvider,
  admin: AnchorProvider,
  keep = vaultKeepLamports(),
): Promise<{ scanned: number; recapturedVaults: number; lamports: number }> {
  const accounts = await provider.connection.getProgramAccounts(LIGHT_PROGRAM, {
    commitment: 'confirmed',
    filters: [{ dataSize: RENT_VAULT_DATA_LEN }],
  });
  let recapturedVaults = 0;
  let lamports = 0;
  for (const { pubkey, account } of accounts) {
    if (!account.data.subarray(0, 8).equals(RENT_VAULT_DISCRIMINATOR)) continue;
    if (account.lamports <= keep) continue;
    const player = new web3.PublicKey(account.data.subarray(40, 72));
    await recaptureRentVault(provider, admin, pubkey, player, keep);
    recapturedVaults += 1;
    lamports += account.lamports - keep;
  }
  return { scanned: accounts.length, recapturedVaults, lamports };
}

/**
 * Move `lamports` from the player's vault onto `destination` so the next
 * account create can spend them. The player signs. The vault keeps its rent.
 */
export async function drawRentVault(
  provider: AnchorProvider,
  player: web3.PublicKey,
  destination: web3.PublicKey,
  lamports: number,
  playerSigner?: web3.Keypair,
): Promise<void> {
  if (lamports <= 0) return;
  const vault = rentVaultFor(player);
  if (!vault) throw new Error(`no rent vault staged for ${player.toBase58()}`);
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(BigInt(lamports));
  const keys: web3.AccountMeta[] = [
    { pubkey: player, isSigner: true, isWritable: true },
  ];
  if (!destination.equals(player)) {
    keys.push({ pubkey: destination, isSigner: false, isWritable: true });
  }
  keys.push({ pubkey: vault, isSigner: false, isWritable: true });
  const ix = new web3.TransactionInstruction({
    programId: LIGHT_PROGRAM,
    keys,
    data: Buffer.concat([DRAW_RENT_VAULT, amount]),
  });
  const signer = playerSigner
    && !playerSigner.publicKey.equals(provider.wallet.publicKey)
    ? playerSigner
    : undefined;
  await send(provider, [ix], signer);
}

/**
 * Move the rent for a `dataLen` account from this player's vault onto their
 * wallet. The following create spends it. Do not also pass the vault into
 * that create: the in-handler reimburse would draw the rent a second time.
 * Closing the account back into the vault restores the float.
 */
export async function frontFromVault(
  provider: AnchorProvider,
  player: web3.PublicKey,
  dataLen: number,
  heldLamports = 0,
  playerSigner?: web3.Keypair,
): Promise<void> {
  const rate = await clusterRentLamportsPerByte(provider.connection);
  const need = rentExemptLamports(dataLen, rate) - heldLamports;
  if (need <= 0) return;
  await drawStagedRent(provider, player, player, need, playerSigner);
}

/**
 * Draw the next 10 KiB realloc from the vault onto the payer.
 * The extend spends this exact top-up. A wallet that already holds SOL is
 * not the source: that SOL would be closed back into the vault.
 */
export async function frontExtendFromVault(
  provider: AnchorProvider,
  player: web3.PublicKey,
  dataLen: number,
  heldLamports: number,
  target: number,
  playerSigner?: web3.Keypair,
): Promise<void> {
  if (dataLen >= target) return;
  const rate = await clusterRentLamportsPerByte(provider.connection);
  const next = Math.min(dataLen + MAX_CPI_ALLOC, target);
  const short = rentExemptLamports(next, rate) - heldLamports;
  if (short <= 0) return;
  await drawStagedRent(provider, player, player, short, playerSigner);
}

const vaultLocks = new Map<string, Promise<void>>();

/** Serialize draws and refunds on one vault. Queue transactions stay outside the lock. */
function withPlayerVaultLock(player: web3.PublicKey, run: () => Promise<void>): Promise<void> {
  const key = player.toBase58();
  const previous = vaultLocks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  vaultLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Draw one computation account's rent from the player's vault, run the queue,
 * then return whatever the computation account did not take. The claim path
 * deposits the account balance back into the vault when the job finalizes.
 * No staged vault leaves the payer to fund the account.
 */
export async function withComputationFloat(
  provider: AnchorProvider,
  player: web3.PublicKey,
  computation: web3.PublicKey,
  run: () => Promise<void>,
  playerSigner?: web3.Keypair,
): Promise<void> {
  if (!rentVaultFor(player)) {
    await run();
    return;
  }
  let drawn = 0;
  await withPlayerVaultLock(player, async () => {
    const existing = await provider.connection.getAccountInfo(computation, 'confirmed');
    if (existing && existing.lamports > 0) return;
    await drawStagedRent(
      provider,
      player,
      player,
      COMPUTATION_RENT_CEILING,
      playerSigner,
    );
    drawn = COMPUTATION_RENT_CEILING;
  });
  try {
    await run();
  } catch (err) {
    await returnComputationFront(provider, player, computation, drawn, playerSigner).catch((restoreErr) => {
      console.warn(
        `[rent] computation front stayed with ${player.toBase58()}: ${
          restoreErr instanceof Error ? restoreErr.message : restoreErr
        }`,
      );
    });
    throw err;
  }
  await returnComputationFront(provider, player, computation, drawn, playerSigner);
}

async function returnComputationFront(
  provider: AnchorProvider,
  player: web3.PublicKey,
  computation: web3.PublicKey,
  drawn: number,
  playerSigner?: web3.Keypair,
): Promise<void> {
  if (drawn <= 0) return;
  await withPlayerVaultLock(player, async () => {
    const info = await provider.connection.getAccountInfo(computation, 'confirmed');
    const paid = info?.lamports ?? 0;
    const surplus = drawn - paid;
    if (surplus <= 0) return;
    const vault = rentVaultFor(player);
    if (!vault) return;
    const balance = await provider.connection.getBalance(player, 'confirmed');
    const amount = Math.min(surplus, Math.max(0, balance - 20_000));
    if (amount <= 0) return;
    await depositRentVault(provider, vault, amount, playerSigner);
  });
}

/** Draw when this player already has a staged vault. No vault leaves the payer to fund the account. */
export async function drawStagedRent(
  provider: AnchorProvider,
  player: web3.PublicKey,
  destination: web3.PublicKey,
  lamports: number,
  playerSigner?: web3.Keypair,
): Promise<void> {
  if (!rentVaultFor(player) || lamports <= 0) return;
  await drawRentVault(provider, player, destination, lamports, playerSigner);
}

/** Move `lamports` from `payer` into an existing vault. The provider pays the fee. */
export async function depositRentVault(
  provider: AnchorProvider,
  vault: web3.PublicKey,
  lamports: number,
  payer?: web3.Keypair,
): Promise<void> {
  if (lamports <= 0) return;
  const from = payer?.publicKey ?? provider.wallet.publicKey;
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(BigInt(lamports));
  const ix = new web3.TransactionInstruction({
    programId: LIGHT_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DEPOSIT_RENT_VAULT, amount]),
  });
  await send(provider, [ix], payer);
}

export function sitOutInstruction(args: {
  casinoProgramId: web3.PublicKey;
  player: web3.PublicKey;
  whitelistEntry: web3.PublicKey;
  tableState: web3.PublicKey;
  roomWallet: web3.PublicKey;
  tableEscrow: web3.PublicKey;
  roomSession: web3.PublicKey;
  roomSessionLock: web3.PublicKey;
}): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId: args.casinoProgramId,
    keys: [
      { pubkey: args.player, isSigner: true, isWritable: true },
      { pubkey: args.whitelistEntry, isSigner: false, isWritable: false },
      { pubkey: args.tableState, isSigner: false, isWritable: true },
      { pubkey: args.roomWallet, isSigner: false, isWritable: true },
      { pubkey: args.tableEscrow, isSigner: false, isWritable: true },
      { pubkey: args.roomSession, isSigner: false, isWritable: true },
      { pubkey: args.roomSessionLock, isSigner: false, isWritable: true },
      ...casinoVaultRemaining(args.player, args.casinoProgramId),
    ],
    data: SIT_OUT,
  });
}
