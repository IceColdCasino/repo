/**
 * DOM render snapshot for native WebView E2E (iOS simulator + macOS desktop).
 * Mirrors playwright helpers in e2e/helpers/card-analysis.ts without Playwright.
 */

export type TableRenderSnapshot = {
  seat: number | null;
  phase: string | null;
  tableVisible: boolean;
  seatedAvatars: number[];
  sharedCount: number;
  sharedFaceUp: boolean[];
  sharedUnicode: Array<string | null>;
  holeSeats: number[];
  holeFaceUp: Record<number, [boolean, boolean]>;
  holeUnicode: Record<number, [string | null, string | null]>;
  handResultVisible: boolean;
  lifecycleStatus: string | null;
};

function elementVisible(el: Element | null): boolean {
  if (!el) {
    return false;
  }
  if (el instanceof SVGSVGElement) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return true;
    }
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      return true;
    }
    const viewport = el.closest('.table-viewport');
    if (viewport instanceof HTMLElement && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      return true;
    }
    return el.hasAttribute('data-phase') && el.querySelector('[data-testid^="shared-card-"]') !== null;
  }
  if (el instanceof HTMLElement) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  if (el instanceof SVGElement) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return true;
    }
    return el.closest('g.occupied') !== null && el.hasAttribute('data-testid');
  }
  return false;
}

function seatOccupiedInDom(seat: number): boolean {
  const chips = document.querySelector(`[data-testid="seat-chips-${seat}"]`);
  if (chips?.textContent?.trim()) {
    return true;
  }
  const wallet = document.querySelector(`[data-testid="seat-wallet-${seat}"]`);
  if (wallet?.textContent?.trim()) {
    return true;
  }
  const avatar = document.querySelector(`[data-testid="seat-avatar-${seat}"]`);
  return avatar !== null && elementVisible(avatar);
}

function tableContentRendered(render: TableRenderSnapshot): boolean {
  return render.phase === 'Complete'
    && render.handResultVisible
    && render.sharedCount === 5
    && render.holeSeats.includes(0)
    && render.holeSeats.includes(1);
}

function readCardAttrs(testId: string): { faceUp: boolean; unicode: string | null } | null {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) {
    return null;
  }
  return {
    faceUp: el.getAttribute('data-face-up') === 'true',
    unicode: el.getAttribute('data-card-unicode'),
  };
}

export function collectTableRenderSnapshot(localSeat: number | null = null): TableRenderSnapshot {
  const table = document.querySelector('[data-testid="poker-table"]');
  const phase = table?.getAttribute('data-phase') ?? null;

  const seatedAvatars: number[] = [];
  for (let seat = 0; seat < 10; seat += 1) {
    if (seatOccupiedInDom(seat)) {
      seatedAvatars.push(seat);
    }
  }

  const sharedFaceUp: boolean[] = [];
  const sharedUnicode: Array<string | null> = [];
  for (let index = 0; index < 5; index += 1) {
    const card = readCardAttrs(`shared-card-${index}`);
    if (!card) {
      continue;
    }
    sharedFaceUp.push(card.faceUp);
    sharedUnicode.push(card.unicode);
  }

  const holeSeats: number[] = [];
  const holeFaceUp: Record<number, [boolean, boolean]> = {};
  const holeUnicode: Record<number, [string | null, string | null]> = {};
  for (let seat = 0; seat < 10; seat += 1) {
    const first = readCardAttrs(`hole-card-${seat}-0`);
    const second = readCardAttrs(`hole-card-${seat}-1`);
    if (!first || !second) {
      continue;
    }
    holeSeats.push(seat);
    holeFaceUp[seat] = [first.faceUp, second.faceUp];
    holeUnicode[seat] = [first.unicode, second.unicode];
  }

  const lifecycle = document.querySelector('[data-testid="hand-lifecycle-status"]');

  return {
    seat: localSeat,
    phase,
    tableVisible: elementVisible(table),
    seatedAvatars,
    sharedCount: sharedFaceUp.length,
    sharedFaceUp,
    sharedUnicode,
    holeSeats,
    holeFaceUp,
    holeUnicode,
    handResultVisible: elementVisible(document.querySelector('[data-testid="hand-result-panel"]')),
    lifecycleStatus: lifecycle?.textContent?.trim() ?? null,
  };
}

export function normalizeSeatKeyedRecord<T>(raw: unknown): Record<number, T> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<number, T> = {};
  for (const [key, value] of Object.entries(raw as Record<string, T>)) {
    out[Number(key)] = value;
  }
  return out;
}

export function waitForCompleteTableRender(
  localSeat: number,
  timeoutMs = 30_000,
): Promise<TableRenderSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = collectTableRenderSnapshot(localSeat);
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('resize'));
      }
      last = collectTableRenderSnapshot(localSeat);
      try {
        assertCompleteTableRender(last, localSeat);
        resolve(last);
        return;
      } catch (err) {
        if (Date.now() >= deadline) {
          const message = err instanceof Error ? err.message : String(err);
          reject(new Error(`${message}; snapshot=${formatTableRenderSnapshot(last)}`));
          return;
        }
        setTimeout(tick, 500);
      }
    };
    tick();
  });
}

export function assertCompleteTableRender(
  render: TableRenderSnapshot,
  localSeat: number,
): void {
  if (!render.tableVisible && !tableContentRendered(render)) {
    throw new Error('poker-table is not visible');
  }
  if (render.phase !== 'Complete') {
    throw new Error(`expected data-phase Complete, got ${render.phase ?? 'missing'}`);
  }
  if (!render.handResultVisible) {
    throw new Error('hand-result-panel is not visible at Complete');
  }
  for (const seat of [0, 1]) {
    const seated = render.seatedAvatars.includes(seat) || render.holeSeats.includes(seat);
    if (!seated) {
      throw new Error(`seat ${seat} is not rendered at Complete`);
    }
  }
  if (render.sharedCount !== 5) {
    throw new Error(`expected 5 board cards, saw ${render.sharedCount}`);
  }
  if (!render.sharedFaceUp.every(Boolean)) {
    throw new Error(`board cards should be face up at Complete: ${render.sharedFaceUp.join(',')}`);
  }
  if (render.sharedUnicode.some((value) => !value || value === '1F0A0')) {
    throw new Error(
      `board cards must show face glyphs (not backs) at Complete: ${render.sharedUnicode.join(',')}`,
    );
  }
  for (const seat of [0, 1]) {
    const holes = render.holeFaceUp[seat];
    if (!holes || !holes[0] || !holes[1]) {
      throw new Error(`seat ${seat} hole cards should be face up at Complete`);
    }
    const glyphs = render.holeUnicode[seat];
    if (!glyphs?.[0] || !glyphs?.[1] || glyphs[0] === '1F0A0' || glyphs[1] === '1F0A0') {
      throw new Error(
        `seat ${seat} hole cards must show face glyphs (not backs) at Complete: ${glyphs?.join('/')}`,
      );
    }
  }
  const mine = render.holeFaceUp[localSeat];
  if (!mine?.[0] || !mine?.[1]) {
    throw new Error(`local seat ${localSeat} own holes should be face up`);
  }
}

export function formatTableRenderSnapshot(render: TableRenderSnapshot): string {
  const board = render.sharedFaceUp.map((up, index) =>
    up ? (render.sharedUnicode[index] ?? 'up') : 'down',
  ).join(', ');
  const holes = render.holeSeats
    .map((seat) => {
      const cards = render.holeFaceUp[seat] ?? [false, false];
      const glyphs = render.holeUnicode[seat] ?? [null, null];
      const left = cards[0] ? (glyphs[0] ?? 'up') : 'down';
      const right = cards[1] ? (glyphs[1] ?? 'up') : 'down';
      return `seat ${seat}: ${left}/${right}`;
    })
    .join('; ');
  return [
    `phase=${render.phase ?? 'unknown'}`,
    `tableVisible=${render.tableVisible}`,
    `avatars=[${render.seatedAvatars.join(',')}]`,
    `handResult=${render.handResultVisible}`,
    `board=[${board}]`,
    `holes={${holes}}`,
    render.lifecycleStatus ? `status=${render.lifecycleStatus}` : '',
  ].filter(Boolean).join('; ');
}
