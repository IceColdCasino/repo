/**
 * Seat signer for a Wallet Standard account.
 * A local keypair still signs itself. A connected wallet signs through
 * `signTransaction` and never exposes a secret key.
 */
import { AnchorProvider, web3 } from '@coral-xyz/anchor';
import { KeypairWallet } from './keypair-wallet';

export type RemoteSignTransaction = <T extends web3.Transaction | web3.VersionedTransaction>(
  tx: T,
) => Promise<T>;

export type RemoteSeatSigner = {
  publicKey: web3.PublicKey;
  signTransaction: RemoteSignTransaction;
  signAllTransactions: <T extends web3.Transaction | web3.VersionedTransaction>(
    txs: T[],
  ) => Promise<T[]>;
};

/** Public key of a connected wallet. Signing goes through the installed signer. */
export class RemoteAuthority {
  readonly remote = true;
  constructor(readonly publicKey: web3.PublicKey) {}
}

export type SeatAuthority = web3.Keypair | RemoteAuthority;

let installed: RemoteSeatSigner | null = null;

export function installRemoteSeatSigner(signer: RemoteSeatSigner | null): void {
  installed = signer;
}

export function remoteSeatSigner(): RemoteSeatSigner | null {
  return installed;
}

export function localKeypair(authority?: SeatAuthority | null): web3.Keypair | undefined {
  return authority instanceof web3.Keypair ? authority : undefined;
}

export function resolveSeatAuthority(secretKey?: Uint8Array | null): SeatAuthority {
  if (secretKey && secretKey.length > 0) {
    return web3.Keypair.fromSecretKey(secretKey);
  }
  const remote = installed;
  if (!remote) {
    throw new Error('Connect a wallet to play.');
  }
  return new RemoteAuthority(remote.publicKey);
}

export function seatProvider(
  connection: web3.Connection,
  authority: SeatAuthority,
): AnchorProvider {
  const wallet = authority instanceof web3.Keypair
    ? new KeypairWallet(authority)
    : installed;
  if (!wallet || (authority instanceof RemoteAuthority && !wallet.publicKey.equals(authority.publicKey))) {
    throw new Error('Connected wallet does not match this seat.');
  }
  return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
}

export async function signAuthorityTransaction<T extends web3.Transaction | web3.VersionedTransaction>(
  provider: { wallet: { signTransaction: RemoteSignTransaction } },
  tx: T,
  authority: SeatAuthority,
): Promise<T> {
  if (authority instanceof web3.Keypair) {
    if (tx instanceof web3.VersionedTransaction) {
      tx.sign([authority]);
      return tx;
    }
    tx.sign(authority);
    return tx;
  }
  return provider.wallet.signTransaction(tx);
}
