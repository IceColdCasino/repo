<script lang="ts">
  import {
    DEALER_BUTTON_RADIUS,
    SEAT_CIRCLE_RADIUS,
    tableLayoutFor,
    type CardOrigin,
    type Point,
    type SeatBand,
    type TableLayout,
  } from './poker/table-layout';
  import type { UiGameKind } from './poker/game-kind';
  import type { CardView } from './poker/view-model';
  import TableSeats from './TableSeats.svelte';
  import DealerButtons from './DealerButtons.svelte';
  import SharedCards from './SharedCards.svelte';

  type DragKind = 'avatar' | 'dealerCard' | 'versusCard';
  type DragTarget = { kind: DragKind; index: number };

  const FACE: CardView = { suit: 'spades', unicode: '1F0A1', flipped: true };
  const DEALER_INSET = SEAT_CIRCLE_RADIUS + 10 + DEALER_BUTTON_RADIUS;

  let kind = $state<Extract<UiGameKind, 'war' | 'baccarat' | 'roulette'>>('war');
  let svgEl = $state<SVGSVGElement | null>(null);
  let selected = $state<DragTarget | null>(null);
  let drag = $state<{ target: DragTarget; dx: number; dy: number } | null>(null);
  let copied = $state(false);
  let dirty = $state(false);
  let sourceKind = $state<typeof kind>('war');

  const source = $derived(tableLayoutFor(kind));
  let avatars = $state<Point[]>([]);
  let dealerCards = $state<CardOrigin[]>([]);
  let versusCards = $state<CardOrigin[]>([]);

  $effect(() => {
    const layout = tableLayoutFor(kind);
    if (dirty && sourceKind === kind && avatars.length === layout.seatCount) {
      return;
    }
    sourceKind = kind;
    resetFromSource(layout);
  });

  function resetFromSource(layout: TableLayout) {
    dirty = false;
    avatars = layout.avatars.map((p) => ({ ...p }));
    dealerCards = (kind === 'roulette' ? layout.sharedCards : layout.dealerCards).map((p) => ({ ...p }));
    versusCards = layout.versusPlayerCards.map((p) => ({ ...p }));
    selected = null;
  }

  function dealerButtonAt(avatar: Point, band: SeatBand): Point {
    if (band === 'top') return { cx: avatar.cx, cy: avatar.cy + DEALER_INSET };
    if (band === 'bottom') return { cx: avatar.cx, cy: avatar.cy - DEALER_INSET };
    if (band === 'right') return { cx: avatar.cx - DEALER_INSET, cy: avatar.cy };
    return { cx: avatar.cx + DEALER_INSET, cy: avatar.cy };
  }

  const liveLayout = $derived.by((): TableLayout => ({
    seatCount: avatars.length,
    avatars,
    playerCards: [],
    dealerButtons: avatars.map((avatar, seat) => dealerButtonAt(avatar, source.band(seat))),
    sharedCards: source.sharedCards,
    dealerCards,
    versusPlayerCards: versusCards,
    band: source.band,
  }));

  const seats = $derived(
    avatars.map((_, seat) => ({
      seat,
      name: `S${seat}`,
      chips: 0,
      bet: 0,
      active: selected?.kind === 'avatar' && selected.index === seat,
    })),
  );

  const snippet = $derived(formatSnippet(kind, avatars, dealerCards, versusCards));

  function formatSnippet(
    game: typeof kind,
    nextAvatars: Point[],
    nextDealer: CardOrigin[],
    nextVersus: CardOrigin[],
  ): string {
    const point = (p: Point) => `  { cx: ${Math.round(p.cx)}, cy: ${Math.round(p.cy)} }`;
    const card = (p: CardOrigin) =>
      p.id
        ? `  { id: '${p.id}', x: ${Math.round(p.x)}, y: ${Math.round(p.y)} }`
        : `  { x: ${Math.round(p.x)}, y: ${Math.round(p.y)} }`;
    const prefix = game === 'war' ? 'WAR' : game === 'baccarat' ? 'BACCARAT' : 'ROULETTE';
    const lines = [
      'const TWELVE_AVATARS: readonly Point[] = [',
      nextAvatars.map(point).join(',\n'),
      '];',
    ];
    if (game === 'roulette') {
      const result = nextDealer[0] ?? nextVersus[0];
      if (result) {
        lines.push('', `export const ROULETTE_RESULT_CARD: CardOrigin = ${card(result).trim()};`);
      }
      return lines.join('\n');
    }
    lines.push(
      '',
      `export const ${prefix}_DEALER_CARD_POSITIONS: readonly CardOrigin[] = [`,
      nextDealer.map(card).join(',\n'),
      '];',
      '',
      `export const ${prefix}_PLAYER_CARD_POSITIONS: readonly CardOrigin[] = [`,
      nextVersus.map(card).join(',\n'),
      '];',
    );
    return lines.join('\n');
  }

  function svgPoint(event: PointerEvent): { x: number; y: number } | null {
    if (!svgEl) return null;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return null;
    const pt = svgEl.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const mapped = pt.matrixTransform(ctm.inverse());
    return { x: mapped.x, y: mapped.y };
  }

  function originOf(target: DragTarget): { x: number; y: number } {
    if (target.kind === 'avatar') {
      const p = avatars[target.index]!;
      return { x: p.cx, y: p.cy };
    }
    const row = target.kind === 'dealerCard' ? dealerCards : versusCards;
    const p = row[target.index]!;
    return { x: p.x, y: p.y };
  }

  function applyPoint(target: DragTarget, x: number, y: number) {
    dirty = true;
    const nx = Math.round(x);
    const ny = Math.round(y);
    if (target.kind === 'avatar') {
      avatars = avatars.map((p, i) => (i === target.index ? { cx: nx, cy: ny } : p));
      return;
    }
    if (target.kind === 'dealerCard') {
      dealerCards = dealerCards.map((p, i) => (i === target.index ? { ...p, x: nx, y: ny } : p));
      return;
    }
    versusCards = versusCards.map((p, i) => (i === target.index ? { ...p, x: nx, y: ny } : p));
  }

  function startDrag(event: PointerEvent, target: DragTarget) {
    const pt = svgPoint(event);
    if (!pt) return;
    const origin = originOf(target);
    selected = target;
    drag = { target, dx: pt.x - origin.x, dy: pt.y - origin.y };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return;
    const pt = svgPoint(event);
    if (!pt) return;
    applyPoint(drag.target, pt.x - drag.dx, pt.y - drag.dy);
  }

  function onPointerUp() {
    drag = null;
  }

  function nudge(dx: number, dy: number) {
    if (!selected) return;
    const origin = originOf(selected);
    applyPoint(selected, origin.x + dx, origin.y + dy);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      selected = null;
      return;
    }
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      nudge(-step, 0);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      nudge(step, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nudge(0, -step);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      nudge(0, step);
    }
  }

  async function copySnippet() {
    await navigator.clipboard.writeText(snippet);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 1500);
  }

  function selectedLabel(): string {
    if (!selected) return 'click a seat or a versus card';
    const origin = originOf(selected);
    return `${selected.kind} ${selected.index}  (${Math.round(origin.x)}, ${Math.round(origin.y)})`;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="lab">
  <aside class="panel">
    <h1>12-seat rail lab</h1>
    <p class="hint">
      12 chairs on the rail. Cards are versus-dealer only: War 2+2, Baccarat 3+3, Roulette none.
      Drag seats or cards. Arrow keys nudge (Shift = 10px). Paste the snippet into
      <code>table-layout.ts</code>.
    </p>
    <label>
      Game rail
      <select bind:value={kind}>
        <option value="war">War</option>
        <option value="baccarat">Baccarat</option>
        <option value="roulette">Roulette</option>
      </select>
    </label>
    <p class="selected" data-testid="layout-lab-selected">{selectedLabel()}</p>
    <div class="actions">
      <button type="button" onclick={() => resetFromSource(source)}>Reset</button>
      <button type="button" onclick={copySnippet}>{copied ? 'Copied' : 'Copy snippet'}</button>
    </div>
    <pre data-testid="layout-lab-snippet">{snippet}</pre>
  </aside>

  <div class="stage">
    <svg
      bind:this={svgEl}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid meet"
      data-testid="layout-lab-table"
      data-game-kind={kind}
      role="application"
      aria-label="12-seat table layout"
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointerleave={onPointerUp}
    >
      <defs>
        <linearGradient id="wood-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#8B5A2B" />
          <stop offset="100%" stop-color="#5A2E0D" />
        </linearGradient>
        <radialGradient id="felt-gradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#37A635" />
          <stop offset="100%" stop-color="#1F5E27" />
        </radialGradient>
        <linearGradient id="card-bg-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#1e3a8a" />
          <stop offset="100%" stop-color="#172554" />
        </linearGradient>
      </defs>

      <path d="M 360,100 H 1560 A 100,100 0 0 1 1560,640 H 360 A 100,100 0 0 1 360,100 Z" fill="url(#wood-gradient)" />
      <path d="M 380,100 H 1540 A 180,180 0 0 1 1540,720 H 380 A 180,180 0 0 1 380,100 Z" fill="url(#wood-gradient)" />
      <path d="M 420,150 H 1500 A 160,160 0 0 1 1500,670 H 420 A 160,160 0 0 1 420,150 Z" fill="url(#felt-gradient)" stroke="#333" stroke-width="4" />

      <text x="960" y="138" text-anchor="middle" font-size="28" fill="white">
        {kind === 'war' ? 'War 2+2' : kind === 'baccarat' ? 'Baccarat 3+3' : 'Roulette'}
      </text>

      <TableSeats seats={seats} layout={liveLayout} />
      <DealerButtons
        dealerSeats={avatars.map((_, seat) => seat)}
        visible={true}
        layout={liveLayout}
      />
      <SharedCards
        cards={dealerCards.map(() => FACE)}
        positions={dealerCards}
        testIdPrefix="dealer-card"
        cardWidth={80}
        cardHeight={108}
      />
      <SharedCards
        cards={versusCards.map(() => FACE)}
        positions={versusCards}
        testIdPrefix="versus-card"
        cardWidth={80}
        cardHeight={108}
      />
      {#each avatars as avatar, seat (seat)}
        <circle
          class="hit avatar-hit"
          class:selected={selected?.kind === 'avatar' && selected.index === seat}
          cx={avatar.cx}
          cy={avatar.cy}
          r={SEAT_CIRCLE_RADIUS + 8}
          role="button"
          aria-label={`Move seat ${seat}`}
          onpointerdown={(event) => startDrag(event, { kind: 'avatar', index: seat })}
        />
        <text class="coord" x={avatar.cx} y={avatar.cy + 4} text-anchor="middle">
          {seat}
        </text>
      {/each}

      {#each dealerCards as card, index (card.id ?? index)}
        <rect
          class="hit card-hit"
          class:selected={selected?.kind === 'dealerCard' && selected.index === index}
          x={card.x - 4}
          y={card.y - 4}
          width="88"
          height="116"
          rx="6"
          role="button"
          aria-label={`Move dealer card ${index}`}
          onpointerdown={(event) => startDrag(event, { kind: 'dealerCard', index })}
        />
      {/each}

      {#each versusCards as card, index (card.id ?? index)}
        <rect
          class="hit card-hit"
          class:selected={selected?.kind === 'versusCard' && selected.index === index}
          x={card.x - 4}
          y={card.y - 4}
          width="88"
          height="116"
          rx="6"
          role="button"
          aria-label={`Move versus card ${index}`}
          onpointerdown={(event) => startDrag(event, { kind: 'versusCard', index })}
        />
      {/each}
    </svg>
  </div>
</div>

<style>
  .lab {
    display: grid;
    grid-template-columns: minmax(320px, 380px) 1fr;
    height: 100vh;
    background: #2b2b2b;
    color: #eee;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  .panel {
    padding: 16px;
    overflow: auto;
    border-right: 1px solid #444;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 18px;
  }

  .hint,
  .selected {
    font-size: 13px;
    line-height: 1.4;
    color: #ccc;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 12px 0;
    font-size: 13px;
  }

  select,
  button {
    font: inherit;
    padding: 6px 8px;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  pre {
    margin: 0;
    padding: 10px;
    background: #1b1b1b;
    color: #d6e8c3;
    font-size: 11px;
    line-height: 1.35;
    white-space: pre-wrap;
  }

  .stage {
    min-width: 0;
    height: 100vh;
  }

  svg {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }

  .hit {
    fill: transparent;
    stroke: transparent;
    cursor: grab;
  }

  .hit.selected {
    stroke: #fbbf24;
    stroke-width: 3;
  }

  .coord {
    fill: #111;
    font-size: 18px;
    font-weight: 700;
    pointer-events: none;
  }
</style>
