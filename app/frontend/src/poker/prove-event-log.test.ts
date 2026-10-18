import { describe, expect, it } from 'vitest';
import { formatProveEventMessage } from './prove-event-log';

describe('formatProveEventMessage', () => {
  it('formats start with seat', () => {
    expect(
      formatProveEventMessage({
        phase: 'start',
        circuitName: 'register_main',
        seat: 0,
      }),
    ).toBe('Witness+prove start: register_main (seat 0)');
  });

  it('formats done with duration', () => {
    expect(
      formatProveEventMessage({
        phase: 'done',
        circuitName: 'register_main',
        seat: 1,
        ms: 82,
      }),
    ).toBe('Witness+prove done: register_main 82ms (seat 1)');
  });

  it('formats failed with error', () => {
    expect(
      formatProveEventMessage({
        phase: 'failed',
        circuitName: 'shuffle_1_deck_52_main',
        seat: 0,
        ms: 1200,
        error: 'ProveBusy',
      }),
    ).toBe('Witness+prove failed: shuffle_1_deck_52_main 1200ms (seat 0): ProveBusy');
  });
});
