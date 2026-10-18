#!/usr/bin/env bun
/** Fixed-key register prove payload for native iOS simulator E2E (on-device witness). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic register keys (same as E2ETestRunner prove smoke). */
export const IOS_E2E_SEAT1_PRIVATE_KEY =
  '1626022640429260911195448391915311140851446397727846428019625491664928023589';
export const IOS_E2E_SEAT1_PUBLIC_KEY = [
  '10689101058007292548237549314775531833763326939030693586706797898091839170714',
  '15394185089455923396480931182619841499985092295511166271520109125970094866909',
] as const;

/** Dev-only: regenerate committed register_prove_payload.json (not run on iOS). */
export function writeRegisterProveFixture(): void {
  const outDir = join(import.meta.dir, '../ios/testdata');
  mkdirSync(outDir, { recursive: true });
  const payloadPath = join(outDir, 'register_prove_payload.json');
  writeFileSync(
    payloadPath,
    JSON.stringify({
      circuitName: 'register_main',
      input: {
        privateKey: IOS_E2E_SEAT1_PRIVATE_KEY,
        publicKey: IOS_E2E_SEAT1_PUBLIC_KEY,
      },
    }),
  );
  console.log(`[gen-register-prove-fixture] wrote ${payloadPath}`);
}

if (import.meta.main) {
  writeRegisterProveFixture();
}
