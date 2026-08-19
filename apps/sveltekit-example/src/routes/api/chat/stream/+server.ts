import { createDeepAgentsHandler } from '@deepagents-nextjs/sveltekit';

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL || 'http://localhost:8000/stream',
});
