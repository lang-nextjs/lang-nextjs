import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    hmr: { port: 24679 },
  },
  resolve: {
    dedupe: ["svelte", "ai", "@ai-sdk/react"],
  },
});
