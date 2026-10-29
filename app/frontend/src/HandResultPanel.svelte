<script lang="ts">
  import type { HandResultView } from './poker/hand-result-view';

  let {
    result,
    canStartNewHand = false,
    onStartNewHand,
  }: {
    result: HandResultView | null;
    canStartNewHand?: boolean;
    onStartNewHand?: () => void;
  } = $props();
</script>

{#if result || canStartNewHand}
  <div class="hand-result" data-testid="hand-result-panel">
    <h3>{result ? `Hand #${result.handNumber} complete` : 'Hand complete'}</h3>
    {#if canStartNewHand}
      <button
        type="button"
        class="start-new-hand"
        data-testid="start-new-hand"
        onclick={() => onStartNewHand?.()}
      >
        Start new hand
      </button>
    {/if}
    {#if result?.reason === 'fold'}
      <p class="summary">Hand ended by fold</p>
    {:else if result}
      <p class="summary">Showdown</p>
    {/if}

    {#if result && result.pots.length > 0}
      <section>
        <h4>Pots</h4>
        <ul>
          {#each result.pots as pot (pot.potIndex)}
            <li data-testid={`hand-result-pot-${pot.potIndex}`}>
              <strong>Pot {pot.potIndex + 1}: {pot.amount}</strong>
              {#if pot.winners.length > 1}
                <div class="split" data-testid={`hand-result-pot-${pot.potIndex}-split`}>
                  {pot.splitLabel}
                </div>
              {/if}
              {#each pot.winners as winner (winner.seat)}
                <div class="winner" data-testid={`hand-result-winner-${winner.seat}`}>
                  <span>{winner.name} (seat {winner.seat})</span>
                  {#if winner.handDescription}
                    <span class="hand"> — {winner.handDescription}</span>
                  {/if}
                  {#if winner.cardsLabel}
                    <span class="cards">{@html winner.cardsLabel}</span>
                  {/if}
                </div>
              {/each}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if result}
    <section>
      <h4>Players</h4>
      <ul>
        {#each result.seats as seat (seat.seat)}
          <li data-testid={`hand-result-seat-${seat.seat}`}>
            <span>{seat.name} (seat {seat.seat})</span>
            {#if seat.folded}
              <span class="folded"> — folded</span>
            {/if}
            {#if seat.handDescription}
              <span class="hand"> — {seat.handDescription}</span>
            {/if}
            {#if seat.cardsLabel}
              <div class="cards">{@html seat.cardsLabel}</div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
    {/if}
  </div>
{/if}

<style>
  .hand-result {
    margin-top: 0;
    margin-inline: auto;
    padding: 0.75rem 1rem;
    border: 1px solid #334155;
    border-radius: 8px;
    background: #0f172a;
    color: #e2e8f0;
    max-width: 36rem;
  }

  h3, h4 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }

  h4 {
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: #94a3b8;
  }

  .summary {
    margin: 0 0 0.5rem;
    color: #cbd5e1;
  }

  .start-new-hand {
    margin: 0.25rem 0 0.75rem;
    padding: 0.45rem 0.9rem;
    border: 0;
    border-radius: 6px;
    background: #15803d;
    color: #f0fdf4;
    font-weight: 700;
    cursor: pointer;
  }

  .start-new-hand:hover {
    background: #166534;
  }

  ul {
    margin: 0;
    padding-left: 1.1rem;
  }

  li {
    margin-bottom: 0.35rem;
  }

  .split {
    margin-left: 0.5rem;
    margin-top: 0.15rem;
    color: #fbbf24;
    font-weight: 600;
  }

  .winner {
    margin-left: 0.5rem;
    color: #f8fafc;
  }

  .hand {
    color: #fbbf24;
  }

  .cards {
    display: block;
    margin-left: 0.5rem;
    font-size: 0.85rem;
    color: #94a3b8;
  }

  .folded {
    color: #64748b;
  }
</style>
