import { type AnchorProvider, BN, web3 } from '@coral-xyz/anchor';
import { claimComputationRent, getArciumProgram, getComputationAccAddress } from '@arcium-hq/client';
import { depositRentVault, rentVaultFor } from '../chain/rent-vault';

const MAX_CLAIM_ATTEMPTS = 8;

export type ComputationClaimResult = 'claimed' | 'gone' | 'pending' | 'unsigned' | 'retry' | 'missing';

/** A seal claim waits out `pending` and `missing`. `unsigned` cannot succeed later. */
export function claimWaitDecision(result: ComputationClaimResult): 'done' | 'wait' | 'unsigned' {
  if (result === 'claimed' || result === 'gone') return 'done';
  if (result === 'unsigned') return 'unsigned';
  return 'wait';
}

/** Anchor encodes the finalized variant as `{ finalized: {} }`. */
export function isComputationFinalized(status: unknown): boolean {
  if (typeof status === 'string') return status === 'finalized';
  if (status !== null && typeof status === 'object') return 'finalized' in status;
  return false;
}

/**
 * Rent is paid by the computation account's `payer` and returned to the claim
 * signer. The signer has to be that payer.
 */
export function selectComputationClaimSigner(
  payer: web3.PublicKey,
  provider: web3.PublicKey,
  signers: ReadonlyMap<string, web3.Keypair>,
): web3.Keypair | 'provider' | null {
  if (payer.equals(provider)) return 'provider';
  return signers.get(payer.toBase58()) ?? null;
}

export function classifyClaimError(err: unknown): 'gone' | 'pending' | 'retry' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/AccountNotFound|account does not exist|has been closed|could not find account/i.test(msg)) {
    return 'gone';
  }
  if (/InvalidComputationStatus|6206|0x183e/i.test(msg)) return 'pending';
  return 'retry';
}

function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/https?:\/\/\S+/g, '[rpc]');
}

/**
 * Tracks computation offsets this process queued and sends `claimComputationRent`
 * once each account is finalized. A missing account counts as already claimed.
 */
export class ComputationRentLedger {
  private readonly signers = new Map<string, web3.Keypair>();
  private readonly open = new Map<string, BN>();
  private readonly restore = new Set<string>();
  private readonly pendingRestore = new Map<string, { payer: string; lamports: number }>();
  private readonly failures = new Map<string, number>();
  private readonly unsignedWarned = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly provider: AnchorProvider,
    private readonly clusterOffset: number,
  ) {}

  note(offset: number | BN, authority?: web3.Keypair | null, restoreToVault = false): void {
    if (authority) this.signers.set(authority.publicKey.toBase58(), authority);
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const key = offsetBn.toString(10);
    if (!this.open.has(key)) this.open.set(key, offsetBn);
    if (restoreToVault) this.restore.add(key);
  }

  async reclaimFinalized(): Promise<void> {
    if (this.open.size === 0) return;
    const run = this.chain.then(() => this.reclaimOnce());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  /**
   * Poll one queued computation until it is finalized, then claim its rent.
   * The seal callback can land while this account is still pending; a single
   * reclaim pass leaves that rent on the seat.
   */
  async reclaimWhenFinalized(offset: BN, timeoutMs = 180_000): Promise<void> {
    const key = offset.toString(10);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const decision = await this.tryClaimOffset(offset);
      if (decision === 'done') return;
      if (decision === 'unsigned') {
        throw new Error(
          `computation ${key} is finalized but its payer key cannot claim the rent`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`computation ${key} did not finalize in time to reclaim its rent`);
  }

  private tryClaimOffset(offset: BN): Promise<'done' | 'wait' | 'unsigned'> {
    const run = this.chain.then(async () => {
      const key = offset.toString(10);
      if (!this.open.has(key)) return 'done' as const;
      const result = await this.claimOne(offset);
      const decision = claimWaitDecision(result);
      if (decision === 'done') {
        await this.flushRestore(key);
        this.open.delete(key);
        this.failures.delete(key);
      }
      return decision;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reclaimOnce(): Promise<void> {
    const batch = [...this.open.entries()];
    for (const [key, offset] of batch) {
      if (!this.open.has(key)) continue;
      let result: ComputationClaimResult;
      try {
        result = await this.claimOne(offset);
      } catch (err) {
        result = classifyClaimError(err);
        if (result === 'retry') {
          console.warn(
            `[arcium] claim computation ${key} failed: ${safeError(err)}`,
          );
        }
      }
      if (result === 'claimed' || result === 'gone') {
        await this.flushRestore(key);
        this.open.delete(key);
        this.failures.delete(key);
        continue;
      }
      if (result === 'pending') continue;
      if (result === 'unsigned') {
        if (!this.unsignedWarned.has(key)) {
          this.unsignedWarned.add(key);
          console.warn(
            `[arcium] computation ${key} is finalized but its payer key is not available to claim the rent`,
          );
        }
        continue;
      }
      const attempts = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, attempts);
      if (attempts >= MAX_CLAIM_ATTEMPTS) {
        console.warn(`[arcium] giving up on computation ${key} after ${attempts} claim attempts`);
        this.open.delete(key);
      }
    }
  }

  private async claimOne(computationOffset: BN): Promise<ComputationClaimResult> {
    const program = getArciumProgram(this.provider);
    const comp = getComputationAccAddress(this.clusterOffset, computationOffset);
    const info = await this.provider.connection.getAccountInfo(comp, 'confirmed');
    if (!info) return 'missing';
    const account = await (program.account as any).computationAccount.fetch(comp);
    if (!isComputationFinalized(account?.status)) return 'pending';
    const payer = new web3.PublicKey(account.payer);
    const signer = selectComputationClaimSigner(
      payer,
      this.provider.wallet.publicKey,
      this.signers,
    );
    if (signer === null) return 'unsigned';
    if (signer === 'provider') {
      await claimComputationRent(this.provider, this.clusterOffset, computationOffset);
    } else {
      await this.claimAsKeypair(program, comp, computationOffset, signer);
    }
    console.info(
      `[arcium] claimed computation ${computationOffset.toString(10)} (${info.lamports} lamports) to ${payer.toBase58()}`,
    );
    const key = computationOffset.toString(10);
    if (this.restore.has(key)) {
      this.pendingRestore.set(key, { payer: payer.toBase58(), lamports: info.lamports });
      await this.flushRestore(key);
    }
    return 'claimed';
  }

  private async flushRestore(key: string): Promise<void> {
    const pending = this.pendingRestore.get(key);
    if (!pending) return;
    const player = new web3.PublicKey(pending.payer);
    const vault = rentVaultFor(player);
    this.pendingRestore.delete(key);
    if (!vault) return;
    const balance = await this.provider.connection.getBalance(player, 'confirmed');
    const amount = Math.min(pending.lamports, Math.max(0, balance - 20_000));
    if (amount <= 0) return;
    try {
      await depositRentVault(
        this.provider,
        vault,
        amount,
        this.signers.get(pending.payer),
      );
    } catch (err) {
      console.warn(
        `[arcium] computation rent stayed with ${player.toBase58()}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async claimAsKeypair(
    program: ReturnType<typeof getArciumProgram>,
    comp: web3.PublicKey,
    computationOffset: BN,
    authority: web3.Keypair,
  ): Promise<void> {
    const ix = await program.methods
      .claimComputationRent(computationOffset, this.clusterOffset)
      .accountsPartial({
        signer: authority.publicKey,
        comp,
      })
      .instruction();
    const latest = await this.provider.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({
      feePayer: this.provider.wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(ix);
    tx.partialSign(authority);
    const signed = await this.provider.wallet.signTransaction(tx);
    const signature = await this.provider.connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: 'confirmed',
    });
    const confirmation = await this.provider.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(
        `claim computation ${computationOffset.toString(10)} failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }
  }
}
