import { expect, test, type Page } from '@playwright/test';
import { fetchState, resetTable } from './helpers/game-api';
import {
  advanceStreetViaUI,
  assertDisplayedCardsMatch,
  completeBettingRoundViaUI,
  sitAndFund,
  startHandViaUI,
  waitForHandCompleteInUi,
  waitForServerReady,
  waitForUiPhase,
} from './helpers/ui-actions';

async function assertStreetInUi(
  alice: Page,
  bob: Page,
  phase: string,
): Promise<void> {
  await waitForUiPhase(alice, phase);
  await waitForUiPhase(bob, phase);
  const state = await fetchState(alice.request);
  expect(state.phase).toBe(phase);
  await assertDisplayedCardsMatch(alice, state, 0);
  await assertDisplayedCardsMatch(bob, state, 1);
}

test.describe('two-player hand completes in the UI', () => {
  test.beforeEach(async ({ request }) => {
    await resetTable(request);
  });

  test('plays every street in the browser and reaches Complete', async ({ browser }) => {
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
      await assertStreetInUi(alice, bob, 'PreFlop');
      await expect(alice.getByTestId('hand-lifecycle-status')).toContainText('Dealing complete · PreFlop');

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(alice, alice.request);
      await assertStreetInUi(alice, bob, 'Flop');

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(bob, alice.request);
      await assertStreetInUi(alice, bob, 'Turn');

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(alice, alice.request);
      await assertStreetInUi(alice, bob, 'River');

      await completeBettingRoundViaUI(alice.request, pages);
      await advanceStreetViaUI(bob, alice.request);
      // Visual settle can jump Showdown → Complete in one snapshot.
      await expect.poll(async () => (
        await alice.getByTestId('poker-table').getAttribute('data-phase')
      )).toMatch(/Showdown|Complete/);

      await waitForHandCompleteInUi(alice);
      await waitForHandCompleteInUi(bob);

      const complete = await fetchState(alice.request);
      expect(complete.phase).toBe('Complete');
      expect(complete.handResult?.potResults.length).toBeGreaterThan(0);
      await assertDisplayedCardsMatch(alice, complete, 0);
      await assertDisplayedCardsMatch(bob, complete, 1);
      await expect(alice.getByTestId('hand-result-panel')).toContainText('Hand #');
      await expect(bob.getByTestId('hand-result-panel')).toContainText('complete');
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});
