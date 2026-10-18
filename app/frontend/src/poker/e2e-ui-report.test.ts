import { describe, expect, it } from 'vitest';
import { nativeUiMetaKey, shouldPostUiHeartbeatHttp } from './e2e-ui-report';

describe('native UI heartbeat persist', () => {
  it('writes Arcium dual-native reports to e2e-ui-seatN', () => {
    expect(nativeUiMetaKey(0)).toBe('e2e-ui-seat0');
    expect(nativeUiMetaKey(1)).toBe('e2e-ui-seat1');
  });

  it('POSTs only to the Bun game server / chain worker, not static preview', () => {
    expect(shouldPostUiHeartbeatHttp('http://127.0.0.1:3847')).toBe(true);
    expect(shouldPostUiHeartbeatHttp('http://127.0.0.1:3850')).toBe(true);
    expect(shouldPostUiHeartbeatHttp('http://127.0.0.1:5178')).toBe(false);
    expect(shouldPostUiHeartbeatHttp('http://127.0.0.1:5173')).toBe(false);
  });
});
