/**
 * Stable storage namespace per native window / browser tab.
 *
 * URL params (`seat`, `e2eSeat`, `instance`, `player`) isolate two manual-test
 * windows on the same origin. Without them, a single id is persisted in
 * sessionStorage so WebView reloads mid-hand keep the same wallet + ElGamal keys.
 */
export function stableInstanceId(): string {
  if (typeof window === 'undefined') {
    return 'default';
  }
  const params = new URLSearchParams(window.location.search);
  const fromUrl =
    params.get('seat')
    ?? params.get('e2eSeat')
    ?? params.get('instance')
    ?? params.get('player');
  if (fromUrl !== null && fromUrl !== '') {
    return `seat-${fromUrl}`;
  }

  const persistKey = 'poker-stable-instance-id';
  let id = sessionStorage.getItem(persistKey);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(persistKey, id);
  }
  return id;
}

/** @deprecated Prefer stableInstanceId — kept for existing imports. */
export const BROWSING_CONTEXT_ID = stableInstanceId();
