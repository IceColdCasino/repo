<svelte:options namespace="svg" />

<script lang="ts">
  import { sharedCardPositions, type CardOrigin } from './poker/table-layout';
  import type { CardView } from './poker/view-model';

  let {
    cards = [],
    positions = sharedCardPositions,
    testIdPrefix = 'shared-card',
    cardWidth = 96,
    cardHeight = 128,
    onCardHover,
  }: {
    cards?: CardView[];
    positions?: readonly CardOrigin[];
    testIdPrefix?: string;
    cardWidth?: number;
    cardHeight?: number;
    onCardHover?: (card: CardView | null) => void;
  } = $props();
</script>

<g id="shared_cards">
  {#each cards as card, index (positions[index]?.id ?? index)}
    {@const cardPosition = positions[index]}
    {#if cardPosition}
      <g
        id={cardPosition.id}
        data-testid={`${testIdPrefix}-${index}`}
        data-face-up={card.flipped ? 'true' : 'false'}
        data-card-unicode={card.unicode}
        class="card-hover-target {card.flipped ? 'flipped' : ''} {card.suit}"
        role="img"
        onmouseenter={() => onCardHover?.(card)}
        onmouseleave={() => onCardHover?.(null)}
      >
        <rect x={cardPosition.x} y={cardPosition.y} width={cardWidth} height={cardHeight} rx="4" />
        <text x={cardPosition.x - 8} y={cardPosition.y + cardHeight - 22}>
          {@html `&#x${card.unicode};`}
        </text>
      </g>
    {/if}
  {/each}
</g>
