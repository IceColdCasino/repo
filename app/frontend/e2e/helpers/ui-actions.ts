import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { fetchState } from './game-api';
import {
  buildExpectedCardLayout,
  formatExpectedLayout,
  type ExpectedCardLayout,
} from './card-verification';

export async function waitForServerReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
  const connect = page.getByTestId('connect-server');
  if (await connect.count()) {
    await connect.click();
  }
  await expect(
    page.getByTestId('seat-select').or(page.getByTestId('stand-up')),
  ).toBeVisible({ timeout: 30_000 });
}

export async function sitAndFund(page: Page, seat: number): Promise<void> {
  const select = page.getByTestId('seat-select');
  await expect(select).toBeEnabled({ timeout: 15_000 });
  await expect(select.locator(`option[value="${seat}"]`)).toHaveCount(1, { timeout: 15_000 });
  await select.selectOption(String(seat));
  await page.getByTestId('sit-down').click();
  await expect(page.locator(`[data-testid="seat-avatar-${seat}"]`)).toBeVisible();
  await page.getByTestId('add-chips-submit').click();
}

export async function startHandViaUI(page: Page): Promise<void> {
  await expect(page.getByTestId('start-hand')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('start-hand').click();
}

export async function clickCheckOrCall(page: Page): Promise<void> {
  const call = page.getByTestId('call');
  if (await call.isEnabled()) {
    await call.click();
    return;
  }
  await expect(page.getByTestId('check')).toBeEnabled();
  await page.getByTestId('check').click();
}

export function pageForSeat(seat: number, pages: Array<{ seat: number; page: Page }>): Page {
  const match = pages.find((entry) => entry.seat === seat);
  if (!match) {
    throw new Error(`No browser page registered for seat ${seat}`);
  }
  return match.page;
}

export async function completeBettingRoundViaUI(
  request: APIRequestContext,
  pages: Array<{ seat: number; page: Page }>,
): Promise<void> {
  const startPhase = (await fetchState(request)).phase;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const state = await fetchState(request);
    if (state.phase !== startPhase) {
      return;
    }
    if (!state.bettingRoundOpen) {
      return;
    }
    const seat = state.currentPlayerSeat;
    if (seat === null) {
      return;
    }
    const page = pageForSeat(seat, pages);
    await expect(page.getByTestId('fold')).toBeEnabled({ timeout: 15_000 });
    await clickCheckOrCall(page);
  }
  throw new Error('Betting round did not close within action limit');
}

export async function advanceStreetViaUI(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const before = await fetchState(request);
  if (before.phase === 'Showdown' || before.phase === 'Complete') {
    return;
  }
  // Last action may already have auto-advanced and opened the next street.
  if (before.bettingRoundOpen) {
    return;
  }
  await expect(page.getByTestId('next-street')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('next-street').click();
  await expect.poll(async () => (await fetchState(request)).phase, { timeout: 15_000 }).not.toBe(before.phase);
}

export async function waitForUiPhase(page: Page, phase: string, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('poker-table')).toHaveAttribute('data-phase', phase, { timeout });
}

export async function waitForHandCompleteInUi(page: Page, timeout = 20_000): Promise<void> {
  await waitForUiPhase(page, 'Complete', timeout);
  await expect(page.getByTestId('poker-table')).toHaveAttribute('data-hand-complete', 'true');
  await expect(page.getByTestId('hand-result-panel')).toBeVisible();
  await expect(page.getByTestId('hand-lifecycle-status')).toContainText('Showdown complete');
  for (let index = 0; index < 5; index += 1) {
    const card = page.getByTestId(`shared-card-${index}`);
    await expect(card).toHaveAttribute('data-face-up', 'true');
    await expect(card).not.toHaveAttribute('data-card-unicode', '1F0A0');
  }
  for (const seat of [0, 1]) {
    for (const hole of [0, 1]) {
      const card = page.getByTestId(`hole-card-${seat}-${hole}`);
      await expect(card).toHaveAttribute('data-face-up', 'true');
      await expect(card).not.toHaveAttribute('data-card-unicode', '1F0A0');
    }
  }
}

export type DisplayedCardLayout = {
  shared: Array<{ faceUp: boolean; unicode: string | null }>;
  holes: Record<number, Array<{ faceUp: boolean; unicode: string | null }>>;
};

export async function readDisplayedCards(page: Page): Promise<DisplayedCardLayout> {
  const shared: DisplayedCardLayout['shared'] = [];
  for (let index = 0; index < 5; index += 1) {
    const card = page.getByTestId(`shared-card-${index}`);
    if ((await card.count()) === 0) {
      continue;
    }
    shared.push({
      faceUp: (await card.getAttribute('data-face-up')) === 'true',
      unicode: await card.getAttribute('data-card-unicode'),
    });
  }

  const holes: DisplayedCardLayout['holes'] = {};
  for (let seat = 0; seat < 10; seat += 1) {
    const first = page.getByTestId(`hole-card-${seat}-0`);
    if ((await first.count()) === 0) {
      continue;
    }
    const second = page.getByTestId(`hole-card-${seat}-1`);
    holes[seat] = [
      {
        faceUp: (await first.getAttribute('data-face-up')) === 'true',
        unicode: await first.getAttribute('data-card-unicode'),
      },
      {
        faceUp: (await second.getAttribute('data-face-up')) === 'true',
        unicode: await second.getAttribute('data-card-unicode'),
      },
    ];
  }

  return { shared, holes };
}

function assertSlotMatches(
  label: string,
  expected: ExpectedCardLayout['shared'][number],
  actual: { faceUp: boolean; unicode: string | null },
): void {
  expect(actual.faceUp, `${label} face-up`).toBe(expected.faceUp);
  expect(actual.unicode, `${label} unicode`).toBe(expected.unicode);
}

export async function assertDisplayedCardsMatch(
  page: Page,
  state: Awaited<ReturnType<typeof fetchState>>,
  viewerSeat: number | null,
): Promise<void> {
  const expected = buildExpectedCardLayout(state, viewerSeat);
  const displayed = await readDisplayedCards(page);

  expect(displayed.shared.length, 'shared card count').toBe(expected.shared.length);
  for (let index = 0; index < expected.shared.length; index += 1) {
    assertSlotMatches(`board[${index}]`, expected.shared[index]!, displayed.shared[index]!);
  }

  for (const [seatKey, expectedHole] of Object.entries(expected.holes)) {
    const seat = Number(seatKey);
    const actualHole = displayed.holes[seat];
    expect(actualHole, `hole cards for seat ${seat}`).toBeDefined();
    assertSlotMatches(`seat ${seat} hole[0]`, expectedHole[0], actualHole![0]!);
    assertSlotMatches(`seat ${seat} hole[1]`, expectedHole[1], actualHole![1]!);
  }
}

export function formatDisplayedLayout(displayed: DisplayedCardLayout): string {
  const board = displayed.shared
    .map((slot) => (slot.faceUp ? slot.unicode : 'down'))
    .join(', ');
  const holeLines = Object.entries(displayed.holes)
    .map(([seat, cards]) => {
      const rendered = cards.map((slot) => (slot.faceUp ? slot.unicode : 'down')).join('/');
      return `seat ${seat}: ${rendered}`;
    })
    .join('; ');
  return `board=[${board}]; holes={${holeLines}}`;
}

export async function formatCardVerificationReport(
  page: Page,
  state: Awaited<ReturnType<typeof fetchState>>,
  viewerSeat: number | null,
): Promise<string> {
  const displayed = await readDisplayedCards(page);
  return [
    `expected: ${formatExpectedLayout(state, viewerSeat)}`,
    `displayed: ${formatDisplayedLayout(displayed)}`,
  ].join('\n');
}
