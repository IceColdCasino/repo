<script lang="ts">
  import { onMount } from "svelte";
  import Poker from './Poker.svelte'
  import TableLayoutLab from './TableLayoutLab.svelte';

  const showLayoutLab = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('layoutLab') === '1';

  let bridge = $state("checking...");

  onMount(() => {
    const z = typeof window !== 'undefined' ? (window as Window & { zero?: { invoke?: unknown } }).zero : undefined;
    const has = !!(z && typeof z.invoke === 'function');
    bridge = has ? "available" : "not enabled";
    try {
      console.log('[App.svelte] onMount bridge check ->', bridge, 'hasZero=', !!z, 'keys=', z ? Object.keys(z) : []);
      const D = (window as Window & { __zkBridgeDebug?: { events?: unknown[] } }).__zkBridgeDebug;
      if (D?.events) D.events.push({ t: 'App', label: 'App onMount', bridge, has });
    } catch {}
  });
</script>

{#if showLayoutLab}
  <TableLayoutLab />
{:else}
<main class="app-shell">
  <Poker />
</main>
{/if}

<style>
  .app-shell {
    width: 100%;
    height: 100%;
    min-height: 100vh;
  }
</style>
