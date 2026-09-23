
import * as path from 'node:path';
import { verify as rapidsnarkVerify } from './rapidsnark-ffi';
import { getSharedProver, type SharedProver } from './zkey-cache';
import { generateWitnessFfi } from './witness';

export type NumberLike = bigint | number | string;
export type DeepArray<T> = Array<T | DeepArray<T>>;

export class Circuit {
  readonly circuitName: string;
  private _zkeyPath?: string;
  private _prover?: SharedProver;
  private _verifyingKey?: object;
  private _nextWitnessCache: Map<string, Promise<Uint8Array>> = new Map();
  private _witnessQueue: Promise<Uint8Array> = Promise.resolve(new Uint8Array());

  constructor(circuitName: string) {
    this.circuitName = circuitName;
  }

  async load() {
    if (this._verifyingKey) return;
    this._zkeyPath = path.join(__dirname, `../zkey/${this.circuitName}_0001.zkey`);
    const verifyingKeyPath = path.join(__dirname, `../zkey/${this.circuitName}_verification_key.json`);
    this._verifyingKey = JSON.parse(await Bun.file(verifyingKeyPath).text());
  }

  private _initProver() {
    if (this._prover) return;
    if (!this._zkeyPath) throw new Error('Circuit not loaded');
    // Shared across all Circuit instances for this zkey: loaded into memory once.
    this._prover = getSharedProver(this._zkeyPath);
  }

  private _normalizeParams(params: Record<string, NumberLike | DeepArray<NumberLike>>): Record<string, string[]> {
    for (const [key, value] of Object.entries(params)) {
      let v = value;
      if (!Array.isArray(v)) {
        v = [v];
      }
      const flattened = v.flat(5) as NumberLike[];
      params[key] = flattened.map(
        v => (typeof v === 'bigint' || typeof v === 'number') ? v.toString() : v
      ) as string[];
    }
    return params as Record<string, string[]>;
  }

  private async _generateWitness(params: Record<string, string[]>): Promise<Uint8Array> {
    const next = this._witnessQueue.then(async () => {
      return await generateWitnessFfi(this.circuitName, params);
    });
    this._witnessQueue = next.catch(() => new Uint8Array());
    return next;
  }

  preloadWitness(params: Record<string, NumberLike | DeepArray<NumberLike>>): void {
    const normalized = this._normalizeParams({ ...params });
    const cacheKey = JSON.stringify(normalized);
    
    if (this._nextWitnessCache.has(cacheKey)) return;
    
    const witnessPromise = this._generateWitness(normalized);
    this._nextWitnessCache.set(cacheKey, witnessPromise);
  }

  releaseProver(): void {
    this._prover = undefined;
    this._nextWitnessCache.clear();
  }

  async prove(params: Record<string, NumberLike | DeepArray<NumberLike>>) {
    if (!this._zkeyPath) {
      throw new Error('Circuit not loaded. Call load() before prove().');
    }

    this._initProver();

    const normalized = this._normalizeParams({ ...params });
    const cacheKey = JSON.stringify(normalized);
    
    let witnessFileData: Uint8Array;
    
    if (this._nextWitnessCache.has(cacheKey)) {
      witnessFileData = await this._nextWitnessCache.get(cacheKey)!;
      this._nextWitnessCache.delete(cacheKey);
    } else {
      witnessFileData = await this._generateWitness(normalized);
    }

    return this._prover!.prove(witnessFileData);
  }

  async verify(proof: object, publicSignals: string[]) {
    return rapidsnarkVerify(proof, publicSignals, this.verifyingKey!);
  }

  get verifyingKey() {
    if (!this._verifyingKey) {
      throw new Error('Circuit not loaded. Call load() first.');
    }
    return this._verifyingKey;
  }
}
