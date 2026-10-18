import type { Page } from '@playwright/test';

export type CardLayoutAnalysis = {
  phase: string;
  sharedFaceUp: boolean[];
  holeFaceUp: Record<string, [boolean, boolean]>;
  seatedHoleSeats: string[];
};

export async function analyzeTableCards(page: Page): Promise<CardLayoutAnalysis> {
  const phase = (await page.getByTestId('poker-table').getAttribute('data-phase')) ?? 'unknown';

  const sharedFaceUp: boolean[] = [];
  for (let index = 0; index < 5; index += 1) {
    const card = page.getByTestId(`shared-card-${index}`);
    if (await card.count()) {
      sharedFaceUp.push((await card.getAttribute('data-face-up')) === 'true');
    }
  }

  const holeFaceUp: Record<string, [boolean, boolean]> = {};
  const seatedHoleSeats: string[] = [];
  for (let seat = 0; seat < 10; seat += 1) {
    const first = page.getByTestId(`hole-card-${seat}-0`);
    if ((await first.count()) === 0) {
      continue;
    }
    seatedHoleSeats.push(String(seat));
    const up0 = (await first.getAttribute('data-face-up')) === 'true';
    const up1 = (await page.getByTestId(`hole-card-${seat}-1`).getAttribute('data-face-up')) === 'true';
    holeFaceUp[String(seat)] = [up0, up1];
  }

  return { phase, sharedFaceUp, holeFaceUp, seatedHoleSeats };
}

export function expectSharedLayout(
  sharedFaceUp: boolean[],
  expected: boolean[],
): { ok: boolean; message: string } {
  const ok = sharedFaceUp.length === expected.length
    && sharedFaceUp.every((value, index) => value === expected[index]);
  return {
    ok,
    message: ok
      ? `shared cards ${sharedFaceUp.map((v) => (v ? 'UP' : 'down')).join(', ')}`
      : `expected shared [${expected.map((v) => (v ? 'UP' : 'down')).join(', ')}] got [${sharedFaceUp.map((v) => (v ? 'UP' : 'down')).join(', ')}]`,
  };
}

export function expectAllHolesFaceDown(holeFaceUp: Record<string, [boolean, boolean]>): { ok: boolean; message: string } {
  for (const [seat, cards] of Object.entries(holeFaceUp)) {
    if (cards[0] || cards[1]) {
      return { ok: false, message: `seat ${seat} hole cards should be face down` };
    }
  }
  return { ok: true, message: 'all hole cards face down' };
}

export function expectOwnHolesFaceUp(
  holeFaceUp: Record<string, [boolean, boolean]>,
  localSeat: number,
): { ok: boolean; message: string } {
  const mine = holeFaceUp[String(localSeat)];
  if (!mine || !mine[0] || !mine[1]) {
    return { ok: false, message: `seat ${localSeat} own holes should be face up` };
  }
  for (const [seat, cards] of Object.entries(holeFaceUp)) {
    if (Number(seat) !== localSeat && (cards[0] || cards[1])) {
      return { ok: false, message: `opponent seat ${seat} holes should stay face down` };
    }
  }
  return { ok: true, message: `seat ${localSeat} holes face up, opponents down` };
}

export function expectAllHolesFaceUp(holeFaceUp: Record<string, [boolean, boolean]>): { ok: boolean; message: string } {
  for (const [seat, cards] of Object.entries(holeFaceUp)) {
    if (!cards[0] || !cards[1]) {
      return { ok: false, message: `seat ${seat} hole cards should be face up at showdown` };
    }
  }
  return { ok: true, message: 'all hole cards face up' };
}

export function formatAnalysis(analysis: CardLayoutAnalysis): string {
  const shared = analysis.sharedFaceUp.map((v) => (v ? 'UP' : 'down')).join(', ');
  const holes = Object.entries(analysis.holeFaceUp)
    .map(([seat, cards]) => `seat ${seat}: ${cards.map((v) => (v ? 'UP' : 'down')).join('/')}`)
    .join('; ');
  return `phase=${analysis.phase}; board=[${shared}]; holes={${holes}}`;
}

export async function captureTableSnapshot(
  page: Page,
  name: string,
): Promise<Buffer> {
  const table = page.getByTestId('poker-table');
  await table.scrollIntoViewIfNeeded();
  return table.screenshot({ path: undefined });
}
