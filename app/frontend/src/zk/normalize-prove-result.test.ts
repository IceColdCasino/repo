import { describe, expect, it } from 'vitest';
import { normalizeProveResult } from './normalize-prove-result';

const sampleProof = {
  pi_a: [
    '16670335950832870119252903300548468180980818213505040022857439075297675421967',
    '1978410753438054332996432834815771316041086744954388599629379809952525207263',
    '1',
  ],
  pi_b: [
    [
      '134940730978760201234567890123456789012345678901234567890123456789012345678',
      '9753106196885256618534764998365852822894020681435853944568043505866934797683',
    ],
    [
      '7393966794767719959229820834007601085634020681435853944568043505866934797683',
      '1208380177263231981950037548868374277346734902128765084821884865079603991291',
    ],
    ['1', '0'],
  ],
  pi_c: [
    '5461637479002795851100328821158298578713201083899708515808705640496344279190',
    '1208380177263231981950037548868374277346734902128765084821884865079603991291',
    '1',
  ],
  protocol: 'groth16',
};

const sampleSignals = [
  '14484545415065694761857794177007407059942605566261259721997001112493898267237',
  '11670410028902067101537382154140957641234567890123456789012345678901234567',
];

describe('normalizeProveResult', () => {
  it('accepts classic proof + publicSignals objects with string limbs', () => {
    const out = normalizeProveResult({ proof: sampleProof, publicSignals: sampleSignals });
    expect((out.proof as { protocol: string }).protocol).toBe('groth16');
    expect(out.publicSignals[0]).toBe(sampleSignals[0]);
    expect(typeof (out.proof as { pi_a: string[] }).pi_a[0]).toBe('string');
  });

  it('parses string-wrapped proofJson / publicSignalsJson from native bridge', () => {
    const out = normalizeProveResult({
      proofJson: JSON.stringify(sampleProof),
      publicSignalsJson: JSON.stringify(sampleSignals),
    });
    expect(out.publicSignals).toEqual(sampleSignals);
    expect((out.proof as { pi_a: string[] }).pi_a[0]).toBe(sampleProof.pi_a[0]);
  });

  it('rejects JS number limbs (precision already lost)', () => {
    expect(() =>
      normalizeProveResult({
        proof: {
          ...sampleProof,
          pi_a: [1.667e76, sampleProof.pi_a[1], '1'],
        },
        publicSignals: sampleSignals,
      }),
    ).toThrow(/lost precision/);
  });
});
