<svelte:options namespace="svg" />

<script lang="ts">
  import type { TableLayout } from './poker/table-layout';

  let {
    dealerSeats = [],
    visible = false,
    layout,
  }: {
    dealerSeats?: number[];
    visible?: boolean;
    layout: TableLayout;
  } = $props();

  const positions = $derived(
    dealerSeats
      .filter((seat) => seat >= 0 && seat < layout.dealerButtons.length)
      .map((seat) => ({ seat, pos: layout.dealerButtons[seat]! })),
  );
</script>

{#if visible}
  <g id="dealers">
    {#each positions as { seat, pos } (seat)}
      <g
        data-testid={`dealer-button-${seat}`}
        transform="translate({pos.cx}, {pos.cy})"
      >
        <circle r="20" fill="#ffeb3b" stroke="#333" stroke-width="2" />
        <text
          text-anchor="middle"
          dominant-baseline="central"
          font-family="sans-serif"
          font-size="16"
          fill="#333"
        >
          D
        </text>
      </g>
    {/each}
  </g>
{/if}
