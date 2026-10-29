/**
 * Wallet Standard connection for desktop extensions and iOS Safari extensions.
 * The wallet signs. This module never reads a secret key.
 */
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { installRemoteSeatSigner, type RemoteSeatSigner } from '@poker-src/chain/seat-signer';

export type WalletCluster = 'devnet' | 'localnet' | 'any';

export type StandardAccount = {
  address: string;
  chains: readonly string[];
};

type SignInput = {
  account: WalletAccount;
  transaction: Uint8Array;
  chain?: string;
};

type SignFeature = {
  signTransaction: (...inputs: SignInput[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};

type ConnectFeature = {
  connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
};

type DisconnectFeature = {
  disconnect: () => Promise<void>;
};

type ChangeFeature = {
  on: (event: 'change', listener: () => void) => () => void;
};

export type ConnectedWallet = {
  address: string;
  name: string;
};

type Session = {
  wallet: Wallet;
  account: WalletAccount;
  chain: string;
  signer: RemoteSeatSigner;
  stopEvents: () => void;
};

let session: Session | null = null;
const listeners = new Set<(next: ConnectedWallet) => void>();

export function preferredChain(cluster: WalletCluster): string | null {
  if (cluster === 'devnet') return 'solana:devnet';
  if (cluster === 'localnet') return 'solana:localnet';
  return null;
}

export function pickAccount<T extends StandardAccount>(
  accounts: readonly T[],
  cluster: WalletCluster,
): T | null {
  const solana = accounts.filter((account) =>
    account.chains.some((chain) => chain.startsWith('solana:')),
  );
  const preferred = preferredChain(cluster);
  if (preferred) {
    const match = solana.find((account) => account.chains.includes(preferred));
    if (match) return match;
    if (cluster === 'localnet') return solana[0] ?? null;
    return null;
  }
  return solana[0] ?? null;
}

function chainFor(account: StandardAccount, cluster: WalletCluster): string {
  const preferred = preferredChain(cluster);
  if (preferred && account.chains.includes(preferred)) return preferred;
  return account.chains.find((chain) => chain.startsWith('solana:')) ?? 'solana:devnet';
}

function signFeature(wallet: Wallet): SignFeature | null {
  const feature = wallet.features['solana:signTransaction'] as SignFeature | undefined;
  return feature?.signTransaction ? feature : null;
}

function wallets(): readonly Wallet[] {
  return getWallets().get();
}

function notify(): void {
  const next = {
    address: session?.account.address ?? '',
    name: session?.wallet.name ?? '',
  };
  for (const listener of listeners) listener(next);
}

function isVersioned(tx: object): tx is VersionedTransaction {
  return tx.constructor?.name === 'VersionedTransaction';
}

function serializeTx(tx: Transaction | VersionedTransaction): Uint8Array {
  if (isVersioned(tx)) return tx.serialize();
  return (tx as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false });
}

function deserializeTx<T extends Transaction | VersionedTransaction>(
  bytes: Uint8Array,
  original: T,
): T {
  if (isVersioned(original)) return VersionedTransaction.deserialize(bytes) as T;
  return Transaction.from(bytes) as T;
}

function signerFor(account: WalletAccount, chain: string, feature: SignFeature): RemoteSeatSigner {
  const signOne = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    const [signed] = await feature.signTransaction({
      account,
      transaction: serializeTx(tx),
      chain,
    });
    if (!signed) throw new Error('The wallet returned no signed transaction.');
    return deserializeTx(signed.signedTransaction, tx);
  };
  return {
    publicKey: new PublicKey(account.address),
    signTransaction: signOne,
    async signAllTransactions(txs) {
      const signed = await feature.signTransaction(
        ...txs.map((tx) => ({
          account,
          transaction: serializeTx(tx),
          chain,
        })),
      );
      return signed.map((item, index) => deserializeTx(item.signedTransaction, txs[index]!));
    },
  };
}

export function connectedAddress(): string {
  return session?.account.address ?? '';
}

export function listWalletChoices(): { name: string }[] {
  return wallets()
    .filter((wallet) => signFeature(wallet))
    .map((wallet) => ({ name: wallet.name }));
}

export function installConnectedSigner(): void {
  if (!session) throw new Error('Connect a wallet to play.');
  installRemoteSeatSigner(session.signer);
}

export function startWalletStandard(
  onChange: (next: ConnectedWallet) => void,
): () => void {
  listeners.add(onChange);
  onChange({
    address: session?.account.address ?? '',
    name: session?.wallet.name ?? '',
  });
  const api = getWallets();
  const stopRegister = api.on('register', () => notify());
  const stopUnregister = api.on('unregister', () => {
    if (session && !wallets().includes(session.wallet)) {
      session.stopEvents();
      session = null;
      installRemoteSeatSigner(null);
    }
    notify();
  });
  return () => {
    listeners.delete(onChange);
    stopRegister();
    stopUnregister();
  };
}

export async function connectWallet(name: string, cluster: WalletCluster): Promise<ConnectedWallet> {
  const wallet = wallets().find((item) => item.name === name);
  if (!wallet) throw new Error(`${name} is not available in this browser.`);
  const connect = wallet.features['standard:connect'] as ConnectFeature | undefined;
  const sign = signFeature(wallet);
  if (!connect?.connect || !sign) {
    throw new Error(`${name} cannot sign Solana transactions.`);
  }
  const { accounts } = await connect.connect();
  const account = pickAccount(accounts, cluster);
  if (!account) {
    const where = cluster === 'devnet' ? 'devnet' : 'this cluster';
    throw new Error(`${name} has no ${where} account.`);
  }
  session?.stopEvents();
  const chain = chainFor(account, cluster);
  const events = wallet.features['standard:events'] as ChangeFeature | undefined;
  const stopEvents = events?.on
    ? events.on('change', () => {
      const still = wallet.accounts.find((item) => item.address === account.address);
      if (!still) {
        session?.stopEvents();
        session = null;
        installRemoteSeatSigner(null);
        notify();
      }
    })
    : () => undefined;
  session = {
    wallet,
    account,
    chain,
    signer: signerFor(account, chain, sign),
    stopEvents,
  };
  installRemoteSeatSigner(session.signer);
  const next = { address: account.address, name: wallet.name };
  notify();
  return next;
}

export async function disconnectWallet(): Promise<void> {
  const current = session;
  session = null;
  installRemoteSeatSigner(null);
  current?.stopEvents();
  const disconnect = current?.wallet.features['standard:disconnect'] as DisconnectFeature | undefined;
  await disconnect?.disconnect().catch(() => undefined);
  notify();
}
