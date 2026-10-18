<svelte:options namespace="svg" />

<script lang="ts">
  import { dealerButtonPositions } from './poker/table-layout';

  let {
    dealerSeat = -1,
    visible = false,
  }: {
    dealerSeat?: number;
    visible?: boolean;
  } = $props();

  const pos = $derived(
    dealerSeat >= 0 && dealerSeat < dealerButtonPositions.length
      ? dealerButtonPositions[dealerSeat]
      : null,
  );
</script>

{#if visible && pos}
  <g id="dealer" transform="translate({pos.cx}, {pos.cy})">
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
{/if}
