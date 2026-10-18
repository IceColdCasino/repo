import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { assertCardsMatchVision } from './helpers/card-vision';
import { fetchState, resetTable } from './helpers/game-api';
import {
  advanceStreetViaUI,
  assertDisplayedCardsMatch,
  completeBettingRoundViaUI,
  formatCardVerificationReport,
  sitAndFund,
  startHandViaUI,
  waitForServerReady,
} from './helpers/ui-actions';

async function snapshotAndVerify(
  page: Page,
  viewerSeat: number,
  label: string,
  testInfo: TestInfo,
): Promise<void> {
  const state = await fetchState(page.request);
  await assertDisplayedCardsMatch(page, state, viewerSeat);
  await assertCardsMatchVision(page, state, viewerSeat, testInfo, `${label}-seat${viewerSeat}`);
  await testInfo.attach(`${label}-seat${viewerSeat}-cards`, {
    body: await formatCardVerificationReport(page, state, viewerSeat),
    contentType: 'text/plain',
  });
  await expect(page.getByTestId('poker-table')).toHaveScreenshot(`${label}-seat${viewerSeat}.png`, {
    maxDiffPixelRatio: 0.02,
  });
}

async function verifyBothPlayers(
  alice: Page,
  bob: Page,
  label: string,
  testInfo: TestInfo,
): Promise<void> {
  await expect(alice.getByTestId('poker-table')).toHaveAttribute('data-phase', /.+/);
  await expect(bob.getByTestId('poker-table')).toHaveAttribute('data-phase', /.+/);
  await snapshotAndVerify(alice, 0, label, testInfo);
  await snapshotAndVerify(bob, 1, label, testInfo);
}

test.describe('two-player hand via UI', () => {
  test.beforeEach(async ({ request }) => {
    await resetTable(request);
  });

  test('clicks betting controls, screenshots each street, verifies card identities', async ({
    browser,
  }, testInfo) => {
    const alice = await browser.newPage();
    const bob = await browser.newPage();
    const pages = [{ seat: 0, page: alice }, { seat: 1, page: bob }];

    try {
      await waitForServerReady(alice);
      await bob.goto('/?wallet=new');
      await expect(bob.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
      const bobConnect = bob.getByTestId('connect-server');
      if (await bobConnect.count()) {
        await bobConnect.click();
      }
      await expect(
        bob.getByTestId('seat-select').or(bob.getByTestId('stand-up')),
      ).toBeVisible({ timeout: 30_000 });

      await sitAndFund(alice, 0);
      await sitAndFund(bob, 1);

      await startHandViaUI(alice);
      await expect.poll(async () => (await fetchState(alice.request)).phase).toBe('PreFlop');
      await expect(alice.getByTestId('poker-table')).toHaveAttribute('data-phase', 'PreFlop');
      await expect(bob.getByTestId('poker-table')).toHaveAttribute('data-phase', 'PreFlop');

      await verifyBothPlayers(alice, bob, '01-preflop', testInfo);

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(alice, alice.request);
      await expect.poll(async () => (await fetchState(alice.request)).phase).toBe('Flop');

      await verifyBothPlayers(alice, bob, '02-flop', testInfo);

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(bob, alice.request);
      await expect.poll(async () => (await fetchState(alice.request)).phase).toBe('Turn');

      await verifyBothPlayers(alice, bob, '03-turn', testInfo);

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(alice, alice.request);
      await expect.poll(async () => (await fetchState(alice.request)).phase).toBe('River');

      await verifyBothPlayers(alice, bob, '04-river', testInfo);

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(bob, alice.request);
      await expect.poll(async () => (await fetchState(alice.request)).phase).toBe('Showdown');

      const showdownState = await fetchState(alice.request);
      expect(showdownState.zkReveal?.allPartialsPublic).toBe(true);

      await verifyBothPlayers(alice, bob, '05-showdown', testInfo);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});
