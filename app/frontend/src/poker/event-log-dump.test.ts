import { describe, expect, it } from 'vitest';
import { createHandEvent } from './event-log';
import {
  eventLogMetaKey,
  formatHandEventLog,
  resolveEventLogSeat,
} from './event-log-dump';

describe('event log disk dump', () => {
  it('formats the on-screen lines and names a per-seat file', () => {
    const at = new Date(2026, 9, 20, 18, 12, 0).getTime();
    const text = formatHandEventLog([
      createHandEvent('error', 'Transaction simulation failed: custom program error: 0x1777', 4, at),
    ]);
    expect(text).toBe('18:12:00 [error] Transaction simulation failed: custom program error: 0x1777');
    expect(eventLogMetaKey(0)).toBe('event-log-seat-0');
    expect(eventLogMetaKey(null)).toBe('event-log-seat-x');
  });

  it('uses the native launch seat when the table seat is not pinned yet', () => {
    (window as Window & { __ZK_LAUNCH_CONFIG?: { seat?: number } }).__ZK_LAUNCH_CONFIG = { seat: 1 };
    expect(resolveEventLogSeat(null)).toBe(1);
    expect(resolveEventLogSeat(0)).toBe(0);
  });
});
