# Software Developer Agent

> An AI software engineer that automates the SDLC — requirements → architecture → implementation → review → testing — driven straight from GitHub issues to pull requests.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![LangGraph](https://img.shields.io/badge/LangGraph-0.3-1C3C3C?logo=langchain&logoColor=white)](https://langchain-ai.github.io/langgraphjs/)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **Status — prototype.** This is an active research build extending LangChain's [Open SWE](https://github.com/langchain-ai/open-swe). Some functionality is experimental and not hardened for production.

---

## Overview

Software Developer Agent is an autonomous AI software engineer built on top of LangChain's **Open SWE**. It listens for GitHub issues, plans an implementation, writes the code inside an isolated cloud sandbox, reviews its own changes, runs tests, and opens a pull request — closing the loop from a plain-language request to reviewable, mergeable code.

The system is organized as a set of cooperating **LangGraph** agents, each owning one phase of the software lifecycle. A Manager graph orchestrates the workflow; specialized Planner, Programmer, Reviewer, and Testing graphs do the work. It was built to operate on a companion application repository, automating routine engineering tasks (feature work, fixes, and test coverage) with a human-in-the-loop approval gate.

### Why

Day-to-day engineering is full of well-specified but time-consuming work: turning an issue into a plan, implementing it against an existing codebase, writing tests, and shepherding a PR through review. This project treats that loop as something an agent can own end-to-end, with the engineer reviewing the plan and the resulting PR rather than typing every line.

---

## Architecture

The agent is a hierarchy of LangGraph state machines. The **Manager** classifies an incoming GitHub event and starts a session; the **Planner** turns the request into an ordered plan; the **Programmer** executes that plan in a sandbox using a toolset (shell, patch, grep, dependency install, web/URL fetch); the **Reviewer** and **Testing** graphs validate the result before a PR is opened.

```mermaid
flowchart TD
    GH[GitHub Issue / PR comment] -->|webhook| MGR
    subgraph Agent["LangGraph Agent System"]
        MGR[Manager graph<br/>classify · session · dispatch]
        PLAN[Planner graph<br/>requirements → plan]
        PROG[Programmer graph<br/>implement in sandbox]
        REV[Reviewer graph<br/>code review]
        TEST[Testing graph<br/>Playwright E2E + diagnose]
        MGR --> PLAN --> PROG
        PROG --> REV
        PROG --> TEST
    end
    PROG -->|tools| SBX[(Daytona sandbox)]
    REV --> PR[Open / update Pull Request]
    TEST --> PR
    PR -->|status comments| GH
    Agent -.checkpoints.-> PG[(Postgres)]
    Agent -.metadata.-> DDB[(DynamoDB)]
```

Rendered LangGraph diagrams for the live graphs are checked in under [`images/`](./images) (`manager-graph.mmd`, `planner-graph.mmd`, `programmer-graph.mmd`), and a high-level workflow overview:

![System Design Diagram](./images/swe-agent-workflow.png)

### Agents

| Graph | Responsibility |
|-------|----------------|
| **Manager** | Entry point. Classifies the incoming message, initializes the GitHub issue context, and starts a planning session. |
| **Planner** | Analyzes the request against the repository and produces an ordered, reviewable implementation plan. |
| **Programmer** | Executes the plan inside a sandbox using a tool suite (shell, apply-patch, grep, dependency install, URL content). |
| **Reviewer** | Performs an automated code review of the generated changes and replies to review comments. |
| **Testing** | Generates and runs tests (including Playwright end-to-end flows), diagnoses failures, and sets a testing status. |

---

## Tech Stack

- **Language:** TypeScript (strict), Node.js 20
- **Agents / orchestration:** LangGraph.js, LangChain, LangSmith tracing
- **LLM providers:** Anthropic (default), with OpenAI and Google Gemini adapters
- **Web UI:** Next.js 15, React 19, Shadcn UI (Radix) + Tailwind CSS
- **Execution sandbox:** Daytona cloud sandboxes
- **Browser testing:** Playwright
- **Tooling:** Firecrawl (URL content), MCP adapters
- **Persistence:** Postgres (LangGraph checkpoints), DynamoDB (run/thread metadata)
- **GitHub:** GitHub App + webhooks (issue-to-PR workflow)
- **Monorepo:** Yarn 3 workspaces + Turborepo

---

## Features

- **Issue-to-PR automation** — add a label to a GitHub issue and the agent plans, implements, reviews, tests, and opens a pull request.
- **Human-in-the-loop planning** — manual labels gate code execution behind plan approval; auto labels run end-to-end.
- **Sandboxed execution** — all code runs in an isolated Daytona sandbox, never on the host.
- **Automated code review** — the Reviewer graph critiques the diff and can reply to PR review comments.
- **Automated testing** — the Testing graph generates and runs tests, including Playwright E2E flows, and diagnoses failures.
- **Web dashboard** — a Next.js interface for creating, monitoring, and managing agent runs.
- **CLI** — a command-line entry point for running the agent from the terminal.
- **Full LangSmith tracing** for observability across every graph node.

---

## Repository Structure

```
apps/
├── open-swe/        – Core LangGraph agents (manager · planner · programmer · reviewer · testing) + tools, routes, auth
├── open-swe-v2/     – Next-generation single-graph agent (experimental)
├── web/             – Next.js 15 web interface for agent runs
├── cli/             – Command-line interface
└── docs/            – Setup & reference docs (MDX)

packages/
└── shared/          – Shared types, utilities, and config used across apps

local/               – Docker Compose for local DynamoDB + Postgres (+ optional Redis/pgAdmin)
tests/               – Standalone integration/diagnostic scripts (GitHub App, DynamoDB schema)
webhooks/            – Sample GitHub webhook payloads
images/ · static/    – Architecture diagrams and UI screenshots
langgraph.json       – LangGraph graph + HTTP/auth configuration
```

---

## Getting Started

### Prerequisites

- **Node.js 20+** and **Yarn 3** (this repo uses Yarn workspaces — do not use npm)
- **Docker** (for local DynamoDB + Postgres via `local/docker-compose.yml`)
- A **GitHub App** (for the issue-to-PR workflow) and an **Anthropic API key**
- Optional: **Daytona** API key (sandbox) and **Firecrawl** API key (URL tool)

### 1. Install

```bash
yarn install
yarn build        # builds shared package first via Turborepo
```

### 2. Configure environment

Each app ships its own `.env.example`. Copy and fill in the ones you need:

```bash
cp apps/open-swe/.env.example apps/open-swe/.env
cp apps/web/.env.example      apps/web/.env
cp local/.env.example         local/.env
```

Key variables (see `apps/open-swe/.env.example` for the full list):

```bash
ANTHROPIC_API_KEY=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=...
DAYTONA_API_KEY=...        # cloud sandbox
FIRECRAWL_API_KEY=...      # URL content tool
```

### 3. Start local infrastructure

```bash
cd local
export AWS_ACCESS_KEY_ID=dummy AWS_SECRET_ACCESS_KEY=dummy
docker-compose up -d        # DynamoDB (8000) + Postgres (5432)
```

### 4. Run

```bash
# Run the agent server + web UI in dev (Turborepo)
yarn dev

# Web UI:           http://127.0.0.1:3001
# LangGraph server: http://localhost:2024  (LangGraph Studio attaches here)
```

---

## GitHub Workflow

The agent integrates with GitHub through webhooks. Adding a label to an issue in a repository where the GitHub App is installed triggers an automated run:

| Label | Behavior |
|-------|----------|
| `open-swe` | Plan requires manual approval before code executes |
| `open-swe-auto` | Plan auto-approved and executed end-to-end |
| `open-swe-enterprise` | Enhanced models + additional testing/review, manual approval |
| `open-swe-enterprise-auto` | Enhanced models, fully autonomous |

> In development, append `-dev` to each label (e.g. `open-swe-dev`).

![GitHub Flow Diagram](./images/github-flow.png)

See [`webhook.md`](./webhook.md) for the webhook event-processing details.

---

## Acknowledgements

This project extends LangChain's [Open SWE](https://github.com/langchain-ai/open-swe) (MIT). The original architecture, graphs, and web interface are LangChain's work; this repository adds and adapts agents, tooling, and infrastructure on top of it.

## Links

- **Portfolio:** [iliazlobin.com/portfolio](https://iliazlobin.com/portfolio)
- **Author:** Ilia Zlobin — Principal Software Engineer ([iliazlobin.com](https://iliazlobin.com))
- **Upstream:** [LangChain Open SWE](https://github.com/langchain-ai/open-swe) · [LangGraph docs](https://langchain-ai.github.io/langgraphjs/)

## License

[MIT](./LICENSE)
