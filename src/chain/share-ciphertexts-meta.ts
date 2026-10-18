/**
 * Dual-process share outputs for showdown materials.
 * Public ciphertexts + the sharer's register padding (not ElGamal secrets).
 */
import { partialRowForRecipient } from '../backend/card-layout';
import type { ZkRevealedPartialEntry } from '../backend/zk-serialize';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from './shared-meta-store';

export const SHARE_CIPHERTEXTS_META_PREFIX = 'share-ciphertexts-p';

export type PersistedShareCiphertexts = {
  playerIndex: number;
  ciphertexts: string[][][];
  padding: string[];
};

export function shareCiphertextsMetaKey(playerIndex: number): string {
  return `${SHARE_CIPHERTEXTS_META_PREFIX}${playerIndex}`;
}

export function persistShareCiphertexts(record: PersistedShareCiphertexts): void {
  writeSharedMeta(shareCiphertextsMetaKey(record.playerIndex), JSON.stringify(record));
}

export function loadShareCiphertexts(playerIndex: number): PersistedShareCiphertexts | null {
  const raw = readSharedMeta(shareCiphertextsMetaKey(playerIndex));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedShareCiphertexts;
    if (parsed.playerIndex !== playerIndex) return null;
    if (!parsed.ciphertexts?.length || !parsed.padding?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function refreshShareCiphertexts(numPlayers: number): Promise<void> {
  const keys = Array.from({ length: numPlayers }, (_, i) => shareCiphertextsMetaKey(i));
  await getSharedMetaStore().refreshFromDisk?.(keys);
}

/**
 * Street-legal decrypt entries from persisted share matrices.
 * Used when RevealedCard PDAs are not published yet so the table can paint
 * own holes / board / showdown faces from materials each seat already wrote.
 */
export function entriesFromPersistedShareCiphertexts(opts: {
  viewerPlayerIndex: number;
  numPlayers: number;
  cardIndices: number[];
}): ZkRevealedPartialEntry[] {
  const entries: ZkRevealedPartialEntry[] = [];
  for (let sharer = 0; sharer < opts.numPlayers; sharer += 1) {
    if (sharer === opts.viewerPlayerIndex) {
      continue;
    }
    const shared = loadShareCiphertexts(sharer);
    if (!shared) {
      continue;
    }
    const row = shared.ciphertexts[partialRowForRecipient(sharer, opts.viewerPlayerIndex)];
    if (!row) {
      continue;
    }
    for (const cardIndex of opts.cardIndices) {
      const cell = row[cardIndex];
      if (!cell?.length) {
        continue;
      }
      entries.push({
        cardIndex,
        fromPlayerIndex: sharer,
        toPlayerIndex: opts.viewerPlayerIndex,
        ciphertext: cell.map(String),
      });
    }
  }
  return entries;
}
