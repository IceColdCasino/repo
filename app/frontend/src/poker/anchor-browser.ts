export * from '../../../../node_modules/@coral-xyz/anchor/dist/esm/index.js';

/** Browser stand-in. The Node package only attaches Wallet outside the browser build. */
export class Wallet {
  readonly payer: { publicKey: unknown };

  constructor(payer: { publicKey: unknown }) {
    this.payer = payer;
  }

  get publicKey(): unknown {
    return this.payer.publicKey;
  }

  async signTransaction<T>(tx: T): Promise<T> {
    return tx;
  }

  async signAllTransactions<T>(txs: T[]): Promise<T[]> {
    return txs;
  }
}
