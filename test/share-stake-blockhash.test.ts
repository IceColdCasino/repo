import { describe, expect, test } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { postPlayerShareStake } from '../src/chain/share-stake';

type Latest = { blockhash: string; lastValidBlockHeight: number };

/** Connection stub: the first send expires unlanded, the second confirms. */
function fakeConnection(player: web3.PublicKey) {
  const fetched: Array<{ commitment: unknown; latest: Latest }> = [];
  const sent: Array<{ blockhash: string | null; fetchedBefore: number }> = [];
  let height = 1_000;
  const connection = {
    async getBalance(key: web3.PublicKey) {
      return key.equals(player) ? 10 * web3.LAMPORTS_PER_SOL : 0;
    },
    async getLatestBlockhash(commitment?: unknown) {
      const latest = {
        blockhash: web3.Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: height + 150,
      };
      fetched.push({ commitment, latest });
      return latest;
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      const tx = web3.Transaction.from(Buffer.from(raw));
      sent.push({ blockhash: tx.recentBlockhash ?? null, fetchedBefore: fetched.length });
      return `sig-${sent.length}`;
    },
    async getSignatureStatuses(signatures: string[]) {
      const landed = signatures[0] === 'sig-2';
      return { value: [landed ? { confirmationStatus: 'confirmed', err: null } : null] };
    },
    async getBlockHeight() {
      // Past the first blockhash's last valid height, so attempt one expires.
      height += 200;
      return height;
    },
  };
  return { connection: connection as unknown as web3.Connection, fetched, sent };
}

describe('share stake transfer blockhash', () => {
  test('signs every attempt with a confirmed blockhash fetched right before sending', async () => {
    const player = web3.Keypair.generate();
    const { connection, fetched, sent } = fakeConnection(player.publicKey);

    await postPlayerShareStake({
      connection,
      player,
      gameId: Uint8Array.from({ length: 32 }, (_, i) => i),
      playerCount: 2,
    });

    expect(sent).toHaveLength(2);
    expect(fetched.every((entry) => entry.commitment === 'confirmed')).toBe(true);
    for (const send of sent) {
      // The blockhash in each signed transfer is the most recent fetch.
      expect(send.blockhash).toBe(fetched[send.fetchedBefore - 1]!.latest.blockhash);
    }
    expect(sent[0]!.blockhash).not.toBe(sent[1]!.blockhash);
  });
});
