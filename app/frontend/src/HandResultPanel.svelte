<script lang="ts">
  import type { HandResultView } from './hand-result-view';

  let { result }: { result: HandResultView | null } = $props();
</script>

{#if result}
  <div class="hand-result" data-testid="hand-result-panel">
    <h3>Hand #{result.handNumber} complete</h3>
    {#if result.reason === 'fold'}
      <p class="summary">Hand ended by fold</p>
    {:else}
      <p class="summary">Showdown</p>
    {/if}

    {#if result.pots.length > 0}
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
                  {#if winner.wonAmount > 0}
                    <span class="won"> — won {winner.wonAmount}</span>
                  {/if}
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

    <section>
      <h4>Players</h4>
      <ul>
        {#each result.seats as seat (seat.seat)}
          <li data-testid={`hand-result-seat-${seat.seat}`}>
            <span>{seat.name} (seat {seat.seat})</span>
            {#if seat.folded}
              <span class="folded"> — folded</span>
            {/if}
            {#if seat.wonAmount > 0}
              <span class="won"> — won {seat.wonAmount}</span>
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

  .won {
    color: #4ade80;
    font-weight: 600;
  }
</style>
