/** Browser stub — bun:ffi is not available in the webview. */
export const suffix = 'dylib';
export const FFIType = {};
export function dlopen(): never {
  throw new Error('bun:ffi is not available in the browser');
}
export function ptr(): never {
  throw new Error('bun:ffi is not available in the browser');
}
