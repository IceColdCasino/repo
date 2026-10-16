import { createHash } from 'node:crypto';
import { web3 } from '@coral-xyz/anchor';

/** Staging bytes stored in one chunk. Matches on-chain `REVEAL_CHUNK_BYTES`. */
export const REVEAL_CHUNK_BYTES = 736;
/** game id, refund destination, offset, length. Matches on-chain `REVEAL_CHUNK_HEADER`. */
export const REVEAL_CHUNK_HEADER = 70;
export const REVEAL_CHUNK_ACCOUNT_SIZE = REVEAL_CHUNK_HEADER + REVEAL_CHUNK_BYTES;
/** Parallel fee payers. Each lane owns the chunks it creates. */
export const REVEAL_LANES = 16;
/** Chunks copied into `deck_staging` by one absorb transaction. */
export const REVEAL_ABSORB_PER_TX = 8;
/** Signature budget for one chunk transaction, including a retry. */
export const REVEAL_LANE_FEE = 20_000;

const WRITE_REVEAL_CHUNK = sighash('write_reveal_chunk');
const ABSORB_REVEAL_CHUNKS = sighash('absorb_reveal_chunks');

export type RevealRange = {
  byteOffset: number;
  data: Uint8Array;
};

export type RevealChunk = {
  offset: number;
  data: Buffer;
};

/**
 * Merge adjacent reveal rows, then split them into chunk-sized pieces.
 * Rows that do not touch stay separate so a gap is not filled with zeroes.
 */
export function packRevealRanges(ranges: RevealRange[]): RevealChunk[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.byteOffset - b.byteOffset);
  const merged: { byteOffset: number; data: Buffer }[] = [];
  for (const range of sorted) {
    if (range.data.length === 0) {
      throw new Error('reveal range is empty');
    }
    if (range.byteOffset % 32 !== 0 || range.data.length % 32 !== 0) {
      throw new Error(
        `reveal range is not limb aligned: offset=${range.byteOffset} length=${range.data.length}`,
      );
    }
    const last = merged[merged.length - 1];
    if (last && last.byteOffset + last.data.length === range.byteOffset) {
      last.data = Buffer.concat([last.data, Buffer.from(range.data)]);
      continue;
    }
    if (last && range.byteOffset < last.byteOffset + last.data.length) {
      throw new Error(`reveal ranges overlap at offset ${range.byteOffset}`);
    }
    merged.push({ byteOffset: range.byteOffset, data: Buffer.from(range.data) });
  }

  const chunks: RevealChunk[] = [];
  for (const span of merged) {
    for (let i = 0; i < span.data.length; i += REVEAL_CHUNK_BYTES) {
      chunks.push({
        offset: span.byteOffset + i,
        data: Buffer.from(span.data.subarray(i, i + REVEAL_CHUNK_BYTES)),
      });
    }
  }
  return chunks;
}

export function revealChunkPda(
  programId: web3.PublicKey,
  gameId: Uint8Array,
  offset: number,
): web3.PublicKey {
  const offsetLe = Buffer.alloc(4);
  offsetLe.writeUInt32LE(offset);
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('reveal_chunk'), Buffer.from(gameId), offsetLe],
    programId,
  )[0];
}

export function chunkPayloadMatches(accountData: Uint8Array, payload: Uint8Array): boolean {
  if (accountData.length < REVEAL_CHUNK_HEADER + payload.length) return false;
  const len = Buffer.from(accountData.subarray(68, 70)).readUInt16LE(0);
  if (len !== payload.length) return false;
  return Buffer.from(accountData.subarray(REVEAL_CHUNK_HEADER, REVEAL_CHUNK_HEADER + len)).equals(
    Buffer.from(payload),
  );
}

export function writeRevealChunkInstruction(args: {
  programId: web3.PublicKey;
  authority: web3.PublicKey;
  payer: web3.PublicKey;
  refund: web3.PublicKey;
  gameState: web3.PublicKey;
  tableState: web3.PublicKey;
  chunk: web3.PublicKey;
  gameId: Uint8Array;
  offset: number;
  data: Uint8Array;
}): web3.TransactionInstruction {
  const offsetLe = Buffer.alloc(4);
  offsetLe.writeUInt32LE(args.offset);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(args.data.length);
  return new web3.TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.refund, isSigner: false, isWritable: false },
      { pubkey: args.gameState, isSigner: false, isWritable: false },
      { pubkey: args.tableState, isSigner: false, isWritable: false },
      { pubkey: args.chunk, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      WRITE_REVEAL_CHUNK,
      Buffer.from(args.gameId),
      offsetLe,
      len,
      Buffer.from(args.data),
    ]),
  });
}

export function absorbRevealChunksInstruction(args: {
  programId: web3.PublicKey;
  authority: web3.PublicKey;
  gameState: web3.PublicKey;
  tableState: web3.PublicKey;
  deckStaging: web3.PublicKey;
  pairs: { chunk: web3.PublicKey; lane: web3.PublicKey }[];
  gameId: Uint8Array;
}): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.gameState, isSigner: false, isWritable: false },
      { pubkey: args.tableState, isSigner: false, isWritable: false },
      { pubkey: args.deckStaging, isSigner: false, isWritable: true },
      ...args.pairs.flatMap((pair) => [
        { pubkey: pair.chunk, isSigner: false, isWritable: true },
        { pubkey: pair.lane, isSigner: false, isWritable: true },
      ]),
    ],
    data: Buffer.concat([ABSORB_REVEAL_CHUNKS, Buffer.from(args.gameId)]),
  });
}

function sighash(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
