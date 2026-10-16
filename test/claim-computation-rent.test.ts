import { describe, expect, test } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import {
  claimWaitDecision,
  classifyClaimError,
  isComputationFinalized,
  selectComputationClaimSigner,
} from '../src/arcium/claim-computation-rent';

describe('computation rent claim', () => {
  test('finalized status is the only claimable variant', () => {
    expect(isComputationFinalized({ finalized: {} })).toBe(true);
    expect(isComputationFinalized('finalized')).toBe(true);
    expect(isComputationFinalized({ queued: {} })).toBe(false);
    expect(isComputationFinalized(null)).toBe(false);
  });

  test('rent is claimed by the computation payer', () => {
    const provider = web3.Keypair.generate();
    const seat = web3.Keypair.generate();
    const signers = new Map<string, web3.Keypair>([[seat.publicKey.toBase58(), seat]]);
    expect(selectComputationClaimSigner(provider.publicKey, provider.publicKey, signers)).toBe(
      'provider',
    );
    expect(selectComputationClaimSigner(seat.publicKey, provider.publicKey, signers)).toBe(seat);
    expect(
      selectComputationClaimSigner(web3.Keypair.generate().publicKey, provider.publicKey, signers),
    ).toBeNull();
  });

  test('a seal claim waits until the computation finalizes', () => {
    expect(claimWaitDecision('claimed')).toBe('done');
    expect(claimWaitDecision('gone')).toBe('done');
    expect(claimWaitDecision('pending')).toBe('wait');
    expect(claimWaitDecision('missing')).toBe('wait');
    expect(claimWaitDecision('retry')).toBe('wait');
    expect(claimWaitDecision('unsigned')).toBe('unsigned');
  });

  test('a closed account or a status error is not a hard failure', () => {
    expect(classifyClaimError(new Error('AccountNotFound'))).toBe('gone');
    expect(classifyClaimError(new Error('Error Number: 6206. Error Message: InvalidComputationStatus'))).toBe(
      'pending',
    );
    expect(classifyClaimError(new Error('blockhash not found'))).toBe('retry');
  });
});
