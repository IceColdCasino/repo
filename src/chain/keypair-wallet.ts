/** Minimal Anchor-compatible wallet (browser Anchor build omits `Wallet`). */
import type { web3 } from '@coral-xyz/anchor';

export class KeypairWallet {
  constructor(readonly payer: web3.Keypair) {}

  get publicKey(): web3.PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends web3.Transaction | web3.VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if ('partialSign' in tx && typeof tx.partialSign === 'function') {
      (tx as web3.Transaction).partialSign(this.payer);
    }
    return tx;
  }

  async signAllTransactions<T extends web3.Transaction | web3.VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    const out: T[] = [];
    for (const tx of txs) {
      out.push(await this.signTransaction(tx));
    }
    return out;
  }
}
