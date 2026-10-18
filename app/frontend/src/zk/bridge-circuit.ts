export type NumberLike = bigint | number | string;
export type DeepArray<T> = Array<T | DeepArray<T>>;

function normalizeParams(params: Record<string, NumberLike | DeepArray<NumberLike>>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    let v: NumberLike | DeepArray<NumberLike> = value;
    if (!Array.isArray(v)) {
      v = [v];
    }
    const flattened = (v as DeepArray<NumberLike>).flat(5) as NumberLike[];
    normalized[key] = flattened.map((item) =>
      typeof item === 'bigint' || typeof item === 'number' ? item.toString() : item,
    );
  }
  return normalized;
}

/** Browser Circuit wrapper: prove via native bridge, verify via server. */
export class BridgeCircuit {
  readonly circuitName: string;

  constructor(circuitName: string) {
    this.circuitName = circuitName;
  }

  async load(): Promise<void> {
    // Bridge proving does not load zkeys in the browser.
  }

  preloadWitness(_params: Record<string, NumberLike | DeepArray<NumberLike>>): void {
    // Witness preloading is handled inside the native bridge.
  }

  async prove(params: Record<string, NumberLike | DeepArray<NumberLike>>) {
    const { proveCircuit } = await import('./index');
    const input: Record<string, string | string[]> = {};
    for (const [key, values] of Object.entries(normalizeParams(params))) {
      input[key] = values.length === 1 ? values[0]! : values;
    }
    return proveCircuit(this.circuitName, input);
  }

  async verify(proof: object, publicSignals: string[]): Promise<boolean> {
    const { verifyCircuit } = await import('./index');
    return verifyCircuit(this.circuitName, proof, publicSignals);
  }
}
