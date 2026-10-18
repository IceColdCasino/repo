import type { ZkRevealedPartialEntry, ZkRevealSnapshot } from '../backend/client';

export type PartialEntryKey = string;

export function partialEntryKey(entry: ZkRevealedPartialEntry): PartialEntryKey {
  return `${entry.cardIndex}:${entry.fromPlayerIndex}:${entry.toPlayerIndex}`;
}

export class PartialStore {
  readonly #entries = new Map<PartialEntryKey, ZkRevealedPartialEntry>();

  merge(snapshot: ZkRevealSnapshot): void {
    for (const entry of snapshot.entries) {
      this.#entries.set(partialEntryKey(entry), entry);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get entries(): ZkRevealedPartialEntry[] {
    return [...this.#entries.values()];
  }

  entryCount(): number {
    return this.#entries.size;
  }
}
