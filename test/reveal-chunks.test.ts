import { describe, expect, test } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import {
  REVEAL_CHUNK_BYTES,
  packRevealRanges,
  writeRevealChunkInstruction,
} from '../src/chain/reveal-chunks';

describe('reveal chunk packing', () => {
  test('packs contiguous poker rows and leaves the board gap', () => {
    const row = () => new Uint8Array(36 * 32);
    const holes = [0, 1, 2, 3].map((card) => ({
      byteOffset: card * 36 * 32,
      data: row(),
    }));
    const board = [20, 21, 22, 23, 24].map((card) => ({
      byteOffset: card * 36 * 32,
      data: row(),
    }));
    const chunks = packRevealRanges([...holes, ...board]);
    const boardAt = chunks.findIndex((chunk) => chunk.offset === 20 * 36 * 32);
    expect(boardAt).toBeGreaterThan(0);
    expect(chunks[0]!.offset).toBe(0);
    expect(chunks[0]!.data.length).toBe(REVEAL_CHUNK_BYTES);
    expect(chunks[boardAt - 1]!.offset + chunks[boardAt - 1]!.data.length).toBe(4 * 36 * 32);
    expect(chunks.length).toBeLessThanOrEqual(16);
    const boardBytes = chunks.slice(boardAt).reduce((sum, chunk) => sum + chunk.data.length, 0);
    expect(boardBytes).toBe(5 * 36 * 32);
  });

  test('a packed write fits in one transaction', () => {
    const programId = web3.Keypair.generate().publicKey;
    const authority = web3.Keypair.generate();
    const payer = web3.Keypair.generate();
    const ix = writeRevealChunkInstruction({
      programId,
      authority: authority.publicKey,
      payer: payer.publicKey,
      refund: web3.Keypair.generate().publicKey,
      gameState: web3.Keypair.generate().publicKey,
      tableState: web3.Keypair.generate().publicKey,
      chunk: web3.Keypair.generate().publicKey,
      gameId: new Uint8Array(32),
      offset: 0,
      data: new Uint8Array(REVEAL_CHUNK_BYTES),
    });
    const tx = new web3.Transaction({
      feePayer: payer.publicKey,
      blockhash: web3.Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }).add(ix);
    tx.partialSign(payer, authority);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  });
});
