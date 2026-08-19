<script lang="ts">
  import { createDeepAgentsStore } from '@deepagents-nextjs/sveltekit';
  import { readable } from 'svelte/store';
  import type { Readable } from 'svelte/store';
  import type { DeepAgentsState } from '@deepagents-nextjs/sveltekit';

  const idle: DeepAgentsState = { messages: [], status: 'idle', error: null };
  let chat: Readable<DeepAgentsState> = readable(idle);
  let started = false;

  function start() {
    if (started) return;
    started = true;
    chat = createDeepAgentsStore('/api/chat/stream', { sessionId: 'sk-1' });
  }
</script>

<main style="max-width:640px;margin:0 auto;padding:1rem;font-family:sans-serif">
  <h1 style="font-size:1.25rem;font-weight:600;margin-bottom:1rem">
    DeepAgents SvelteKit Example
  </h1>

  <div style="min-height:200px;border:1px solid #e5e7eb;border-radius:0.5rem;padding:1rem;margin-bottom:1rem">
    {#if $chat.messages.length === 0 && $chat.status === 'idle'}
      <p style="color:#9ca3af;font-size:0.875rem">Click Start to stream a response.</p>
    {:else if $chat.messages.length === 0 && $chat.status === 'loading'}
      <p style="color:#9ca3af;font-size:0.875rem">Loading...</p>
    {:else}
      {#each $chat.messages as msg}
        <div style="margin-bottom:0.5rem;font-size:0.875rem">
          {#if typeof msg === 'object' && msg !== null && 'type' in msg && 'content' in msg}
            <strong>{(msg as { type: string }).type}:</strong>
            {(msg as { content: string }).content}
          {:else}
            {JSON.stringify(msg)}
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div style="display:flex;gap:0.5rem;align-items:center">
    <button
      on:click={start}
      disabled={started}
      style="padding:0.5rem 1rem;background:#2563eb;color:white;border:none;border-radius:0.375rem;cursor:pointer;font-size:0.875rem"
    >
      Start
    </button>
    <span data-testid="status" style="font-size:0.75rem;color:#6b7280">{$chat.status}</span>
  </div>
</main>
