<script lang="ts">
  import type { CardView } from './poker/view-model';

  let {
    card = null,
    x = 0,
    y = 0,
    width = 140,
    height = 186,
    fontSize = 120,
    docked = false,
  }: {
    card?: CardView | null;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fontSize?: number;
    docked?: boolean;
  } = $props();

  function cardChar(unicode: string): string {
    return String.fromCodePoint(parseInt(unicode, 16));
  }
</script>

{#if card}
  <div
    class="card-hover-preview {card.flipped ? 'flipped' : ''} {card.suit}"
    class:docked
    data-testid="card-hover-preview"
    style:left={docked ? undefined : `${x}px`}
    style:top={docked ? undefined : `${y}px`}
    style:width="{width}px"
    style:height="{height}px"
  >
    <span class="card-face" style:font-size="{fontSize}px">{cardChar(card.unicode)}</span>
  </div>
{/if}

<style>
  .card-hover-preview {
    position: fixed;
    transform: translate(-100%, 0);
    pointer-events: none;
    z-index: 15;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: linear-gradient(180deg, #1e3a8a 0%, #172554 100%);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }

  .card-hover-preview.docked {
    position: absolute;
    left: 0;
    top: 0;
    transform: none;
  }

  .card-hover-preview.flipped {
    background: white;
  }

  :global(.dark) .card-hover-preview.flipped {
    background: black;
  }

  .card-face {
    line-height: 1;
    opacity: 0.8;
    color: white;
  }

  .card-hover-preview.flipped .card-face {
    opacity: 1;
  }

  .card-hover-preview.spade .card-face {
    color: #000;
  }

  :global(.dark) .card-hover-preview.spade .card-face {
    color: #aaa;
  }

  .card-hover-preview.heart .card-face {
    color: #f00;
  }

  :global(.dark) .card-hover-preview.heart .card-face {
    color: #a00;
  }

  .card-hover-preview.diamond .card-face {
    color: #00a;
  }

  :global(.dark) .card-hover-preview.diamond .card-face {
    color: #00f;
  }

  .card-hover-preview.club .card-face {
    color: #030;
  }

  :global(.dark) .card-hover-preview.club .card-face {
    color: #0f0;
  }
</style>
