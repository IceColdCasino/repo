<svelte:options namespace="svg" />

<script lang="ts">
  import {
    SEAT_CIRCLE_RADIUS,
    avatarCirclePositions,
    formatChipBalance,
    seatIdentityLayout,
    seatIdentityLayoutFor,
    seatStatusLayout,
    seatStatusLayoutFor,
    tableLayoutFor,
    type TableLayout,
  } from './poker/table-layout';
  import { PUNKS_SPRITE_URL } from './poker/smoking-punks';
  import type { SeatView } from './poker/view-model';

  let {
    seats = [],
    layout,
    onAvatarHover,
  }: {
    seats?: SeatView[];
    layout?: TableLayout;
    onAvatarHover?: (info: { avatarId: number; name: string; seat: number } | null) => void;
  } = $props();

  const activeLayout = $derived(layout ?? tableLayoutFor('poker'));

  function seatInfo(seatIndex: number): SeatView | undefined {
    return seats.find((s) => s.seat === seatIndex);
  }
</script>

<g id="seats">
  {#each Array.from({ length: activeLayout.seatCount }, (_, seat) => seat) as seat (seat)}
    {@const info = seatInfo(seat)}
    {@const pos = activeLayout.avatars[seat] ?? avatarCirclePositions[seat]!}
    {@const ident = layout ? seatIdentityLayoutFor(seat, activeLayout) : seatIdentityLayout(seat)}
    {@const chipLabel = info ? `${formatChipBalance(info.chips)} chips` : ''}
    {@const statusItems = info
      ? [
          info.bet > 0
            ? { key: 'bet', testId: `seat-bet-${seat}`, text: `bet ${formatChipBalance(info.bet)}`, fill: '#c8d4ff', weight: '400' }
            : null,
          info.handDescription
            ? { key: 'hand', testId: `seat-hand-${seat}`, text: info.handDescription, fill: '#fbbf24', weight: '400' }
            : null,
        ].filter((item): item is NonNullable<typeof item> => item !== null)
      : []}
    <g
      class:active={info?.active}
      class:occupied={Boolean(info)}
      class:winner={info?.winnerHighlight}
      data-testid={info?.active ? `active-seat-${seat}` : undefined}
    >
      <circle
        cx={pos.cx}
        cy={pos.cy}
        r={SEAT_CIRCLE_RADIUS}
        class:occupied={Boolean(info)}
      />
      {#if info}
        {#if info.avatarId !== undefined}
          <image
            class="punk-avatar avatar-hover-target"
            href={PUNKS_SPRITE_URL}
            x={pos.cx}
            y={pos.cy}
            width="6000"
            height="6000"
            style={`--n: ${info.avatarId}`}
            data-testid={`seat-avatar-${seat}`}
            role="img"
            aria-label={info.name}
            onmouseenter={() => onAvatarHover?.({ avatarId: info.avatarId!, name: info.name, seat })}
            onmouseleave={() => onAvatarHover?.(null)}
          />
        {/if}
        {#if info.playerIndex !== undefined}
          <text
            x={ident.nameX - 40}
            y={ident.nameY}
            text-anchor="end"
            font-family="sans-serif"
            font-size="11"
            fill="#ffd966"
            data-testid={`seat-player-index-${seat}`}
          >
            P{info.playerIndex}
          </text>
        {/if}
        <text
          x={info.playerIndex !== undefined ? ident.nameX - 34 : ident.nameX}
          y={ident.nameY}
          text-anchor={info.playerIndex !== undefined ? 'start' : ident.anchor}
          font-family="sans-serif"
          font-size="13"
          fill="#e8e8e8"
          data-testid={`seat-wallet-${seat}`}
          title={info.publicKey}
        >
          {info.name}
        </text>
        <rect
          x={ident.chipX - 52}
          y={ident.chipY - 13}
          width="104"
          height="18"
          rx="6"
          fill="rgba(0, 0, 0, 0.72)"
          stroke="#c8a84b"
          stroke-width="1"
        />
        <text
          x={ident.chipX}
          y={ident.chipY}
          text-anchor="middle"
          font-family="sans-serif"
          font-size="14"
          font-weight="600"
          fill="#f5d76e"
          data-testid={`seat-chips-${seat}`}
        >
          {chipLabel}
        </text>
        {#each statusItems as item, line (item.key)}
          {@const status = layout
            ? seatStatusLayoutFor(seat, line, activeLayout)
            : seatStatusLayout(seat, line)}
          <text
            x={status.x}
            y={status.y}
            text-anchor={status.anchor}
            font-family="sans-serif"
            font-size="12"
            font-weight={item.weight}
            fill={item.fill}
            data-testid={item.testId}
          >
            {item.text}
          </text>
        {/each}
      {/if}
    </g>
  {/each}
</g>

<style>
  circle {
    fill: #555;
    stroke: #222;
    stroke-width: 2;
  }

  circle.occupied {
    fill: #2a2a2a;
    stroke: #111;
  }

  g.active circle {
    stroke: #ffe14a;
    stroke-width: 5;
  }

  g.winner circle.occupied {
    stroke: #4ade80;
    stroke-width: 4;
  }

  g.occupied text {
    pointer-events: none;
  }
</style>
