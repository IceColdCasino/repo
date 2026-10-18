import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  analyzeTableCards,
  expectAllHolesFaceDown,
  expectAllHolesFaceUp,
  expectSharedLayout,
  formatAnalysis,
} from './helpers/card-analysis';
import { assertCardsMatchVision } from './helpers/card-vision';
import {
  completeBettingRound,
  fetchState,
  playThroughToPhase,
  resetTable,
  setupTwoPlayerTable,
  startHand,
} from './helpers/game-api';
import {
  advanceStreetViaUI,
  assertDisplayedCardsMatch,
  sitAndFund,
  waitForHandCompleteInUi,
  waitForServerReady,
} from './helpers/ui-actions';

async function attachAnalysis(testInfo: TestInfo, label: string, page: Page): Promise<void> {
  const analysis = await analyzeTableCards(page);
  await testInfo.attach(`${label}-analysis`, {
    body: formatAnalysis(analysis),
    contentType: 'text/plain',
  });
}

async function snapshotAndAnalyze(
  page: Page,
  testInfo: TestInfo,
  label: string,
  viewerSeat: number | null,
  assertFn: (analysis: Awaited<ReturnType<typeof analyzeTableCards>>) => void,
): Promise<void> {
  await expect(page.getByTestId('game-phase-label')).toBeVisible();
  const state = await fetchState(page.request);
  await assertDisplayedCardsMatch(page, state, viewerSeat);
  await assertCardsMatchVision(page, state, viewerSeat, testInfo, label);
  const analysis = await analyzeTableCards(page);
  assertFn(analysis);
  await attachAnalysis(testInfo, label, page);
  await expect(page.getByTestId('poker-table')).toHaveScreenshot(`${label}.png`, {
    maxDiffPixelRatio: 0.02,
  });
}

test.describe('two-player hand visuals (observer)', () => {
  test.beforeEach(async ({ request }) => {
    await setupTwoPlayerTable(request);
  });

  test('table snapshots progress board reveals through ZK streets', async ({ page, request }, testInfo) => {
    await waitForServerReady(page);
    const started = await startHand(request);
    expect(started.phase).toBe('PreFlop');
    await expect(page.getByTestId('poker-table')).toHaveAttribute('data-phase', 'PreFlop', { timeout: 10_000 });

    await snapshotAndAnalyze(page, testInfo, '01-preflop', null, (analysis) => {
      expect(analysis.phase).toBe('PreFlop');
      expect(expectSharedLayout(analysis.sharedFaceUp, [false, false, false, false, false]).ok).toBe(true);
      expect(expectAllHolesFaceDown(analysis.holeFaceUp).ok).toBe(true);
      expect(analysis.seatedHoleSeats).toEqual(['0', '1']);
    });

    await completeBettingRound(request);
    await advanceStreetViaUI(page, request);
    await expect(page.getByTestId('poker-table')).toHaveAttribute('data-phase', 'Flop', { timeout: 10_000 });

    await snapshotAndAnalyze(page, testInfo, '02-flop', null, (analysis) => {
      expect(analysis.phase).toBe('Flop');
      expect(expectSharedLayout(analysis.sharedFaceUp, [true, true, true, false, false]).ok).toBe(true);
      expect(expectAllHolesFaceDown(analysis.holeFaceUp).ok).toBe(true);
    });

    await completeBettingRound(request);
    await advanceStreetViaUI(page, request);
    await expect(page.getByTestId('poker-table')).toHaveAttribute('data-phase', 'Turn');

    await snapshotAndAnalyze(page, testInfo, '03-turn', null, (analysis) => {
      expect(analysis.phase).toBe('Turn');
      expect(expectSharedLayout(analysis.sharedFaceUp, [true, true, true, true, false]).ok).toBe(true);
      expect(expectAllHolesFaceDown(analysis.holeFaceUp).ok).toBe(true);
    });

    await completeBettingRound(request);
    await advanceStreetViaUI(page, request);
    await expect(page.getByTestId('poker-table')).toHaveAttribute('data-phase', 'River');

    await snapshotAndAnalyze(page, testInfo, '04-river', null, (analysis) => {
      expect(analysis.phase).toBe('River');
      expect(expectSharedLayout(analysis.sharedFaceUp, [true, true, true, true, true]).ok).toBe(true);
      expect(expectAllHolesFaceDown(analysis.holeFaceUp).ok).toBe(true);
    });

    await completeBettingRound(request);
    await advanceStreetViaUI(page, request);
    await expect(page.getByTestId('poker-table')).toHaveAttribute('data-phase', 'Showdown');

    const state = await fetchState(request);
    expect(state.zkReveal?.allPartialsPublic).toBe(true);

    await snapshotAndAnalyze(page, testInfo, '05-showdown-unseated', null, (analysis) => {
      expect(analysis.phase).toBe('Showdown');
      expect(expectSharedLayout(analysis.sharedFaceUp, [true, true, true, true, true]).ok).toBe(true);
      expect(expectAllHolesFaceUp(analysis.holeFaceUp).ok).toBe(true);
    });
  });
});

test.describe('two-player hand visuals (seated showdown)', () => {
  test('each seated player sees all holes face up when the hand completes', async ({ browser, request }, testInfo) => {
    await resetTable(request);

    const alice = await browser.newPage();
    await alice.goto('/');
    await expect(alice.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
    await sitAndFund(alice, 0);

    const bob = await browser.newPage();
    await bob.goto('/?wallet=new');
    await expect(bob.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
    await sitAndFund(bob, 1);

    await startHand(request);
    await playThroughToPhase(request, 'Showdown');

    await expect.poll(async () => (await fetchState(request)).seats.length).toBe(2);

    await waitForHandCompleteInUi(alice);
    await waitForHandCompleteInUi(bob);

    const showdownState = await fetchState(request);
    expect(showdownState.phase).toBe('Complete');
    await assertDisplayedCardsMatch(alice, showdownState, 0);
    await assertCardsMatchVision(alice, showdownState, 0, testInfo, '06-showdown-seat0');
    await assertDisplayedCardsMatch(bob, showdownState, 1);
    await assertCardsMatchVision(bob, showdownState, 1, testInfo, '07-showdown-seat1');

    const aliceAnalysis = await analyzeTableCards(alice);
    expect(expectAllHolesFaceUp(aliceAnalysis.holeFaceUp).ok).toBe(true);
    await testInfo.attach('alice-complete-analysis', {
      body: formatAnalysis(aliceAnalysis),
      contentType: 'text/plain',
    });

    const bobAnalysis = await analyzeTableCards(bob);
    expect(expectAllHolesFaceUp(bobAnalysis.holeFaceUp).ok).toBe(true);
    await testInfo.attach('bob-complete-analysis', {
      body: formatAnalysis(bobAnalysis),
      contentType: 'text/plain',
    });

    await alice.close();
    await bob.close();
  });
});
