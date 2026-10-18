/** Browser stub — proving uses window.zero (libzkcasino + rapidsnark in the native shell). */
export function getBufferSizes(): never {
  throw new Error('rapidsnark FFI is not available in the browser');
}

export function prove(): never {
  throw new Error('rapidsnark FFI is not available in the browser');
}

export function verify(): never {
  throw new Error('rapidsnark FFI is not available in the browser');
}

export class Prover {
  constructor() {
    throw new Error('rapidsnark FFI is not available in the browser');
  }
}

export class FileProver {
  constructor() {
    throw new Error('rapidsnark FFI is not available in the browser');
  }
}
