/** Browser stub — assert is only used for dev invariants in shared poker code. */
export default function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message ?? 'Assertion failed');
  }
}
