import { describe, expect, it } from 'bun:test';
import { logHandProgress, setHandProgressListener } from '../src/hand-progress';

describe('hand progress', () => {
  it('forwards showdown lines to the event-log listener', () => {
    const lines: Array<{ message: string; kind: string }> = [];
    setHandProgressListener((message, kind) => {
      lines.push({ message, kind });
    });
    logHandProgress('Showdown witness generation starting (seat 1)', 'zk');
    logHandProgress('Showdown tx: verify_showdown_receipt sending (seat player 0)');
    setHandProgressListener(null);
    expect(lines).toEqual([
      { message: 'Showdown witness generation starting (seat 1)', kind: 'zk' },
      { message: 'Showdown tx: verify_showdown_receipt sending (seat player 0)', kind: 'chain' },
    ]);
    logHandProgress('after clear');
    expect(lines).toHaveLength(2);
  });
});
