import type { NextConfig } from "next";

const config: NextConfig = {
  /* @deepagents-nextjs/ui ships TSX source rather than a built dist, so Next
     must transpile it. Source-export is deliberate: these are shadcn
     components the fork is meant to OWN and edit, and a build step between
     the reader and the component defeats that. */
  transpilePackages: ["@deepagents-nextjs/ui"],
};

export default config;
