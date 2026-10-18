/**
 * Normalize native-bridge / snarkjs Groth16 prove results so field elements stay
 * decimal strings. WKWebView JSON.parse must never see BN254 limbs as JSON numbers
 * (precision loss → rapidsnark "invalid proof data").
 */

export interface NormalizedProveResult {
  proof: object;
  publicSignals: string[];
}

function fieldToDecimalString(value: unknown, path: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid field element at ${path}: ${value}`);
    }
    return trimmed;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    throw new Error(
      `Field element at ${path} lost precision (got JS number ${value}). `
        + 'Native prove must deliver proofJson/publicSignalsJson strings.',
    );
  }
  throw new Error(`Invalid field element type at ${path}: ${typeof value}`);
}

function normalizeG1(point: unknown, path: string): string[] {
  if (!Array.isArray(point) || point.length < 2) {
    throw new Error(`Invalid G1 point at ${path}`);
  }
  return point.map((limb, i) => fieldToDecimalString(limb, `${path}[${i}]`));
}

function normalizeG2(point: unknown, path: string): string[][] {
  if (!Array.isArray(point) || point.length < 2) {
    throw new Error(`Invalid G2 point at ${path}`);
  }
  return point.map((coord, i) => {
    if (!Array.isArray(coord)) {
      throw new Error(`Invalid G2 coordinate at ${path}[${i}]`);
    }
    return coord.map((limb, j) => fieldToDecimalString(limb, `${path}[${i}][${j}]`));
  });
}

export function normalizeGroth16Proof(proof: unknown): object {
  if (!proof || typeof proof !== 'object') {
    throw new Error('Prove result missing proof object');
  }
  const p = proof as Record<string, unknown>;
  const protocol = typeof p.protocol === 'string' ? p.protocol : 'groth16';
  const curve = typeof p.curve === 'string' ? p.curve : undefined;
  const out: Record<string, unknown> = {
    pi_a: normalizeG1(p.pi_a, 'pi_a'),
    pi_b: normalizeG2(p.pi_b, 'pi_b'),
    pi_c: normalizeG1(p.pi_c, 'pi_c'),
    protocol,
  };
  if (curve) {
    out.curve = curve;
  }
  return out;
}

export function normalizePublicSignals(signals: unknown): string[] {
  if (!Array.isArray(signals)) {
    throw new Error('Prove result missing publicSignals array');
  }
  return signals.map((value, i) => fieldToDecimalString(value, `publicSignals[${i}]`));
}

/**
 * Accept either classic `{proof, publicSignals}` or string-wrapped
 * `{proofJson, publicSignalsJson}` from the native bridge (preferred — avoids
 * outer JSON.parse turning limbs into JS numbers).
 */
export function normalizeProveResult(raw: unknown): NormalizedProveResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Native bridge returned empty prove result');
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.proofJson === 'string' && typeof body.publicSignalsJson === 'string') {
    return {
      proof: normalizeGroth16Proof(JSON.parse(body.proofJson)),
      publicSignals: normalizePublicSignals(JSON.parse(body.publicSignalsJson)),
    };
  }

  return {
    proof: normalizeGroth16Proof(body.proof),
    publicSignals: normalizePublicSignals(body.publicSignals),
  };
}
