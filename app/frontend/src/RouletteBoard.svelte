<svelte:options namespace="svg" />

<script lang="ts">
  import type { CardView, RouletteBetView } from './poker/view-model';

  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

  let {
    bets = [],
    result,
    variant = 37,
    onCardHover,
  }: {
    bets?: RouletteBetView[];
    result?: CardView | null;
    variant?: 37 | 38;
    onCardHover?: (card: CardView | null) => void;
  } = $props();

  const origin = { x: 500, y: 250 };
  const cellW = 62;
  const cellH = 44;
  const zeroW = 52;

  type Cell = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    fill: string;
    match: (bet: RouletteBetView) => boolean;
  };

  const numberCells: Cell[] = [];
  for (let col = 0; col < 12; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      const n = col * 3 + (3 - row);
      numberCells.push({
        id: `n${n}`,
        x: origin.x + zeroW + col * cellW,
        y: origin.y + row * cellH,
        w: cellW,
        h: cellH,
        label: String(n),
        fill: RED.has(n) ? '#b4232c' : '#1a1a1a',
        match: (bet) => bet.type === 0 && bet.modifier === n,
      });
    }
  }

  const zeroCells = $derived.by((): Cell[] => {
    const cells: Cell[] = [
      {
        id: 'n0',
        x: origin.x,
        y: origin.y,
        w: zeroW,
        h: variant === 38 ? cellH * 1.5 : cellH * 3,
        label: '0',
        fill: '#0f7a3a',
        match: (bet) => bet.type === 0 && bet.modifier === 0,
      },
    ];
    if (variant === 38) {
      cells.push({
        id: 'n00',
        x: origin.x,
        y: origin.y + cellH * 1.5,
        w: zeroW,
        h: cellH * 1.5,
        label: '00',
        fill: '#0f7a3a',
        match: (bet) => bet.type === 0 && bet.modifier === 37,
      });
    }
    return cells;
  });

  const columnCells: Cell[] = [0, 1, 2].map((row) => ({
    id: `col${row}`,
    x: origin.x + zeroW + 12 * cellW,
    y: origin.y + row * cellH,
    w: 70,
    h: cellH,
    label: '2:1',
    fill: '#16351f',
    match: (bet) => bet.type === 7 && bet.modifier === (2 - row),
  }));

  const dozenCells: Cell[] = [0, 1, 2].map((dozen) => ({
    id: `doz${dozen}`,
    x: origin.x + zeroW + dozen * 4 * cellW,
    y: origin.y + 3 * cellH,
    w: 4 * cellW,
    h: 36,
    label: `${dozen * 12 + 1}–${dozen * 12 + 12}`,
    fill: '#1f4d2c',
    match: (bet) => bet.type === 8 && bet.modifier === dozen,
  }));

  const outside: Cell[] = [
    { id: 'low', label: '1–18', fill: '#1f4d2c', match: (b) => b.type === 11 && b.modifier === 0 },
    { id: 'even', label: 'EVEN', fill: '#1f4d2c', match: (b) => b.type === 9 && b.modifier === 0 },
    { id: 'red', label: 'RED', fill: '#b4232c', match: (b) => b.type === 10 && b.modifier === 0 },
    { id: 'black', label: 'BLACK', fill: '#1a1a1a', match: (b) => b.type === 10 && b.modifier === 1 },
    { id: 'odd', label: 'ODD', fill: '#1f4d2c', match: (b) => b.type === 9 && b.modifier === 1 },
    { id: 'high', label: '19–36', fill: '#1f4d2c', match: (b) => b.type === 11 && b.modifier === 1 },
  ].map((item, index) => ({
    ...item,
    x: origin.x + zeroW + index * 2 * cellW,
    y: origin.y + 3 * cellH + 36,
    w: 2 * cellW,
    h: 36,
  }));

  const allCells = $derived([...zeroCells, ...numberCells, ...columnCells, ...dozenCells, ...outside]);

  function chipsOn(cell: Cell): RouletteBetView[] {
    return bets.filter((bet) => cell.match(bet));
  }

  const resultX = 912;
  const resultY = 168;
</script>

<g id="roulette-felt" data-testid="roulette-board">
  {#if result}
    <g
      data-testid="roulette-result"
      data-face-up={result.flipped ? 'true' : 'false'}
      data-card-unicode={result.unicode}
      class="card-hover-target {result.flipped ? 'flipped' : ''} {result.suit}"
      role="img"
      onmouseenter={() => onCardHover?.(result)}
      onmouseleave={() => onCardHover?.(null)}
    >
      <rect x={resultX} y={resultY} width="96" height="72" rx="4" />
      <text x={resultX + 48} y={resultY + 46} text-anchor="middle" font-size="28" fill="#f5d76e">
        {#if result.flipped}
          {@html `&#x${result.unicode};`}
        {:else}
          ?
        {/if}
      </text>
    </g>
  {/if}

  {#each allCells as cell (cell.id)}
    {@const chips = chipsOn(cell)}
    <g data-testid={`roulette-cell-${cell.id}`}>
      <rect
        x={cell.x}
        y={cell.y}
        width={cell.w}
        height={cell.h}
        fill={cell.fill}
        stroke="#e8d48b"
        stroke-width="1.2"
      />
      <text
        x={cell.x + cell.w / 2}
        y={cell.y + cell.h / 2 + 4}
        text-anchor="middle"
        font-family="sans-serif"
        font-size={cell.w < 60 ? '13' : '14'}
        fill="#f4f1e6"
      >
        {cell.label}
      </text>
      {#each chips as chip, chipIndex (chip.seat + ':' + chipIndex)}
        <circle
          cx={cell.x + 12 + (chipIndex % 3) * 10}
          cy={cell.y + 12}
          r="7"
          fill={['#60a5fa', '#f472b6', '#fbbf24', '#4ade80', '#c084fc'][chip.seat % 5]}
          stroke="#111"
          stroke-width="1"
          data-testid={`roulette-chip-${cell.id}-${chip.seat}`}
        />
      {/each}
    </g>
  {/each}
</g>
