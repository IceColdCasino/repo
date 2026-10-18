/** Browser stub — witness generation uses the native zero bridge, not bun:ffi. */
export function generateWitnessFfi(): never {
  throw new Error('Witness FFI is not available in the browser');
}

export function generateWitnessFfiAsync(): never {
  throw new Error('Witness FFI is not available in the browser');
}
