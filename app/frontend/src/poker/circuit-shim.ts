/** Browser stub — circuits use BridgeCircuit + native bridge, not zkey files on disk. */
export type NumberLike = bigint | number | string;
export type DeepArray<T> = Array<T | DeepArray<T>>;

export class Circuit {
  readonly circuitName: string;

  constructor(circuitName: string) {
    this.circuitName = circuitName;
  }

  async load(): Promise<void> {}

  preloadWitness(_params: Record<string, NumberLike | DeepArray<NumberLike>>): void {}

  async prove(): Promise<never> {
    throw new Error('Circuit.prove is not available in the browser');
  }

  async verify(): Promise<boolean> {
    throw new Error('Circuit.verify is not available in the browser');
  }
}
