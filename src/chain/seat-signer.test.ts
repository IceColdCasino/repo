import { web3 } from '@coral-xyz/anchor';
import { describe, expect, it } from 'bun:test';
import {
  installRemoteSeatSigner,
  RemoteAuthority,
  resolveSeatAuthority,
  signAuthorityTransaction,
} from './seat-signer';

describe('seat signer', () => {
  it('uses a local secret when one is supplied', () => {
    const keypair = web3.Keypair.generate();
    const authority = resolveSeatAuthority(keypair.secretKey);
    expect(authority).toBeInstanceOf(web3.Keypair);
    expect(authority.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it('asks the connected wallet to sign when the seat has no secret', async () => {
    const owner = web3.Keypair.generate();
    installRemoteSeatSigner({
      publicKey: owner.publicKey,
      async signTransaction(tx) {
        if (tx instanceof web3.VersionedTransaction) return tx;
        tx.feePayer = owner.publicKey;
        return tx;
      },
      async signAllTransactions(txs) {
        return txs;
      },
    });
    const authority = resolveSeatAuthority(undefined);
    expect(authority).toBeInstanceOf(RemoteAuthority);
    const tx = new web3.Transaction();
    const provider = {
      wallet: {
        async signTransaction<T extends web3.Transaction>(inner: T): Promise<T> {
          inner.feePayer = owner.publicKey;
          return inner;
        },
      },
    };
    const signed = await signAuthorityTransaction(
      provider as Parameters<typeof signAuthorityTransaction>[0],
      tx,
      authority,
    );
    expect(signed.feePayer?.equals(owner.publicKey)).toBe(true);
    installRemoteSeatSigner(null);
  });
});
