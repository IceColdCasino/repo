import { describe, expect, it } from 'vitest';
import { pickAccount } from './wallet-standard';

const devnet = { address: 'dev', chains: ['solana:devnet'] };
const mainnet = { address: 'main', chains: ['solana:mainnet'] };
const local = { address: 'local', chains: ['solana:localnet'] };

describe('pickAccount', () => {
  it('uses the devnet account on devnet', () => {
    expect(pickAccount([mainnet, devnet], 'devnet')?.address).toBe('dev');
  });

  it('refuses a mainnet-only wallet on devnet', () => {
    expect(pickAccount([mainnet], 'devnet')).toBeNull();
  });

  it('prefers a localnet account and otherwise accepts any Solana account', () => {
    expect(pickAccount([mainnet, local], 'localnet')?.address).toBe('local');
    expect(pickAccount([mainnet], 'localnet')?.address).toBe('main');
  });
});
