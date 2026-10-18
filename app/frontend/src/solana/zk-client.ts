import type { ShuffleReceiptPayload } from './hash-receipt';

const DEFAULT_BASE = '';

export async function submitOutputReceipt(
  payload: ShuffleReceiptPayload,
  baseUrl = DEFAULT_BASE,
): Promise<{ ok: boolean; stub?: boolean; error?: string }> {
  const res = await fetch(`${baseUrl}/api/solana/consume-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: string };
      return { ok: false, error: body.error ?? text };
    } catch {
      return { ok: false, error: text };
    }
  }
  const body = await res.json() as { ok?: boolean; stub?: boolean };
  return { ok: body.ok === true, stub: body.stub === true };
}
