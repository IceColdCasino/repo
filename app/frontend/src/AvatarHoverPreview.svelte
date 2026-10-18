<script lang="ts">
  import { PUNKS_SPRITE_URL, punkSpriteFillStyle } from './poker/smoking-punks';

  let {
    avatarId = null,
    name = '',
    x = 0,
    y = 0,
    size = 180,
    docked = false,
  }: {
    avatarId?: number | null;
    name?: string;
    x?: number;
    y?: number;
    size?: number;
    docked?: boolean;
  } = $props();
</script>

{#if avatarId !== null && avatarId !== undefined}
  <div
    class="avatar-hover-preview"
    class:docked
    data-testid="avatar-hover-preview"
    data-avatar-id={avatarId}
    style:left={docked ? undefined : `${x}px`}
    style:top={docked ? undefined : `${y}px`}
    style:width="{size}px"
    style:height="{size}px"
    title={name}
  >
    <img
      class="punk-sprite-fill"
      alt={name ? `${name} punk` : 'Player punk'}
      src={PUNKS_SPRITE_URL}
      style={punkSpriteFillStyle(avatarId, size)}
    />
  </div>
{/if}

<style>
  .avatar-hover-preview {
    position: fixed;
    transform: translate(-100%, 0);
    pointer-events: none;
    z-index: 15;
    overflow: hidden;
    border-radius: 50%;
    border: 3px solid #c8a84b;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    background: #2a2a2a;
  }

  .avatar-hover-preview.docked {
    position: absolute;
    left: 0;
    top: 0;
    transform: none;
  }

  .punk-sprite-fill {
    display: block;
    max-width: none;
    /* Nearest-neighbor upscale keeps 24px punks crisp (avoid bilinear blur). */
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }
</style>
