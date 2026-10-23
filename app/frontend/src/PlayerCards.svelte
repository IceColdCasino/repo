<svelte:options namespace="svg" />

<script lang="ts">
  import { playerCardPositions, type CardOrigin } from './poker/table-layout';
  import type { CardView } from './poker/view-model';

  let {
    cardsBySeat = {},
    positions = playerCardPositions,
    onCardHover,
  }: {
    cardsBySeat?: Record<number, CardView[]>;
    positions?: readonly CardOrigin[];
    onCardHover?: (card: CardView | null) => void;
  } = $props();
</script>

<g id="player_cards">
  {#each Object.entries(cardsBySeat) as [seatKey, cards] (seatKey)}
    {@const seat = Number(seatKey)}
    {@const cardPosition = positions[seat]}
    {#if cardPosition}
      <g id={`player${seat}_cards`}>
        {#each cards as card, cardIndex (cardIndex)}
          <g
            data-testid={`hole-card-${seat}-${cardIndex}`}
            data-face-up={card.flipped ? 'true' : 'false'}
            data-card-unicode={card.unicode}
            class="card-hover-target {card.flipped ? 'flipped' : ''} {card.suit}"
            role="img"
            onmouseenter={() => onCardHover?.(card)}
            onmouseleave={() => onCardHover?.(null)}
          >
            <rect
              x={cardPosition.x + cardIndex * 70}
              y={cardPosition.y}
              width="58"
              height="78"
              rx="4"
              fill="url(#card-bg-gradient)"
            />
            <text
              x={cardPosition.x + cardIndex * 70 - 6}
              y={cardPosition.y + 66}
            >
              {#if card.flipped && card.unicode.toUpperCase() !== '1F0A0'}
                {@html `&#x${card.unicode};`}
              {:else}
                {@html `&#x1F0A0;`}
              {/if}
            </text>
          </g>
        {/each}
      </g>
    {/if}
  {/each}
</g>
