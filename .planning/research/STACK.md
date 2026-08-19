# Technology Stack: Blazing REST API Client

**Project:** Blazing Workspace Provider Integration
**Researched:** June 2026

## Executive Summary

For consuming Blazing's `/v1/workspace` REST API from TypeScript, the recommended stack uses native fetch with OpenAPI-generated types and the existing circuit breaker pattern. No heavy client libraries needed - the existing architecture provides all required patterns.

## Recommended Stack

### Core HTTP Client
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `fetch` (native) | Built-in | HTTP requests | Node.js 18+ fetch is production-ready, type-safe with TypeScript, matches existing circuit breaker pattern |
| `node-fetch` (if needed) | ^3.3.0 | Polyfill for older Node | Not required - current runtime uses native fetch |

### OpenAPI Client Generation
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@hey-api/openapi-ts` ^6.0.0 | Generate TypeScript types from OpenAPI spec | Enterprise-grade with fetch client, used by Vercel/PayPal | Best balance of type safety and runtime efficiency |
| `openapi-fetch` | Runtime client | 6kb size, type-safe, no code generation overhead | Complementary to @hey-api for lightweight operations |
| `openapi-typescript` ^7.0.0 | Validate API responses at runtime | Extra safety for external API contracts | Optional validation layer |

### Error Handling & Retry
| Technology | Version | Purpose | When to Use |
|------------|---------|---------|-------------|
| Existing `circuit-breaker.ts` | Custom | Protect against cascading failures | Always - already tested and working |
| Custom retry wrapper | Hand-rolled | Retry failed requests with exponential backoff | For specific HTTP status codes (5xx, 429) |

### Authentication
| Technology | Version | Purpose | When to Use |
|------------|---------|---------|-------------|
| Custom auth headers | Hand-rolled | Add `X-Api-Key` header | Always - simple and direct |
| JWT decode if needed | `jose` | Handle JWT tokens | Only if API returns token-based auth |

### Testing
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `msw` | ^2.0.0 | Mock API responses | Unit tests for client |
| `vitest-fetch-mock` | ^1.0.0 | Mock fetch in tests | Integration tests |
| Existing mock patterns | Custom | Mocked servers | Test existing patterns |

## Implementation Strategy

### 1. Generate Client from OpenAPI Spec
```bash
# Generate TypeScript types and client
npx openapi-typescript-codegen \
  --input https://api.blazing.com/v1/workspace/openapi.json \
  --output ./src/blazing-client \
  --client fetch \
  --useOptions \
  --exportModels true
```

### 2. Integration with Existing Circuit Breaker
```typescript
// Wrap all API calls in existing circuit breaker
import { CircuitBreaker } from './circuit-breaker';

const blazingClient = new BlazingClient({
  baseUrl: process.env.BLAZING_API_URL!,
  apiKey: process.env.BLAZING_API_KEY,
  circuitBreaker: new CircuitBreaker({
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenMaxProbes: 1
  })
});
```

### 3. Authentication Pattern
```typescript
// Simple auth header pattern
const headers = {
  'Content-Type': 'application/json',
  'X-Api-Key': apiKey // or Authorization: Bearer token
};
```

### 4. Error Mapping
```typescript
// Map HTTP status codes to SandboxError
const mapError = (response: Response): never => {
  switch (response.status) {
    case 401:
    case 403:
      throw new SandboxError('auth_failed', 'Authentication failed');
    case 404:
      throw new SandboxError('not_found', 'Workspace not found');
    case 429:
      throw new SandboxError('at_capacity', 'Blazing at capacity');
    case 500:
    case 502:
    case 503:
      throw new SandboxError('provider_unavailable', 'Blazing API error');
  }
};
```

### 5. Retry Pattern for Transient Failures
```typescript
// Retry wrapper for transient failures
const retryableFetch = async (url: string, options: RequestInit) => {
  const maxRetries = 3;
  const retryDelay = 1000; // Will be exponential
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`Retryable error: ${response.status}`);
      }
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelay * (i + 1)));
    }
  }
};
```

## Integration with Existing Code

### Update BlazingSandbox to Use Generated Client
```typescript
// apps/open-swe/lib/sandbox/blazing-sandbox.ts
import { BlazingWorkspaceDto, BlazingExecDto } from './generated-types';

export class BlazingSandbox {
  private readonly client: BlazingClient;
  
  constructor(opts: BlazingSandboxOptions) {
    this.client = new BlazingClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      // Use existing circuit breaker
      circuitBreaker: new CircuitBreaker()
    });
  }

  async create(config: SandboxConfig = {}): Promise<SandboxWorkspace> {
    const workspace = await this.client.workspaces.create({
      image: config.image,
      memory_limit_mb: config.memoryLimitMb,
      cpu_limit: config.cpuLimit,
      exec_timeout_ms: config.execTimeoutMs,
      env: config.env,
      label: config.label,
    });
    return this.toWorkspace(workspace);
  }

  async executeTool(
    workspaceId: string,
    command: string,
    args: string[] = []
  ): Promise<ToolExecutionResult> {
    if (typeof command !== 'string' || command.trim() === "") {
      throw new SandboxError(
        "invalid_command",
        "command must be a non-empty string"
      );
    }
    const result = await this.client.workspaces.execute({
      workspaceId,
      command,
      args,
    });
    return {
      exitCode: result.exit_code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: result.duration_ms ?? 0,
      timedOut: result.timed_out ?? false,
    };
  }

  // ... other methods
}
```

### Provider Factory Integration
```typescript
// apps/open-swe/lib/sandbox/index.ts
import { BlazingSandbox } from './blazing-sandbox';
import { DockerSandbox } from './docker-sandbox';

export function getSandbox(): Sandbox {
  const provider = process.env.SANDBOX_PROVIDER ?? "docker";
  
  if (provider === "blazing") {
    if (!process.env.BLAZING_API_URL) {
      throw new Error("BLAZING_API_URL required for Blazing provider");
    }
    return new BlazingSandbox({
      baseUrl: process.env.BLAZING_API_URL,
      apiKey: process.env.BLAZING_API_KEY,
    });
  }
  
  return new DockerSandbox();
}
```

## Testing Strategy

### Unit Tests with MSW
```typescript
// apps/open-swe/lib/sandbox/blazing-sandbox.test.ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BlazingSandbox } from './blazing-sandbox';

const server = setupServer(
  http.post('/v1/workspace', () => {
    return HttpResponse.json({
      id: 'workspace-123',
      container_id: 'container-123',
      image: 'node:22',
      created_at: new Date().toISOString()
    });
  }),
  
  http.post('/v1/workspace/workspace-123/execute', () => {
    return HttpResponse.json({
      exit_code: 0,
      stdout: 'Hello World',
      duration_ms: 100
    });
  })
);

beforeAll(() => server.listen());
afterAll(() => server.close());

test('create workspace', async () => {
  const sandbox = new BlazingSandbox({
    baseUrl: 'http://localhost:8005',
    apiKey: 'test-key'
  });
  
  const workspace = await sandbox.create({ image: 'node:22' });
  expect(workspace.id).toBe('workspace-123');
});
```

### Integration Tests
```typescript
// tests/integration/blazing-integration.test.ts
import { BlazingSandbox } from '../../lib/sandbox/blazing-sandbox';

test('integration: create and execute in workspace', async () => {
  if (!process.env.BLAZING_API_URL) {
    skipTest('BLAZING_API_URL not set');
  }
  
  const sandbox = new BlazingSandbox({
    baseUrl: process.env.BLAZING_API_URL!,
    apiKey: process.env.BLAZING_API_KEY
  });
  
  // Create workspace
  const workspace = await sandbox.create({ 
    image: 'node:22-alpine',
    label: 'integration-test'
  });
  
  // Execute command
  const result = await sandbox.executeTool(
    workspace.id,
    'echo',
    ['hello world']
  );
  
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('hello world');
  
  // Cleanup
  await sandbox.destroy(workspace.id);
});
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| OpenAPI Client | @hey-api/openapi-ts | openapi-typescript-codegen | @hey-api has better fetch client integration |
| HTTP Client | Native fetch | axios | No need for additional dependency |
| Retry | Custom wrapper | fetch-retry | More control over retry logic integration |
| Auth | Custom headers | oauth2-client | Overkill for API key auth |

## Installation

```bash
# OpenAPI client generation
npm install -D @hey-api/openapi-typescript openapi-typescript

# Optional validation
npm install openapi-fetch

# Testing utilities
npm install -D msw vitest-fetch-mock
```

## Version Alignment

| Dependency | Version | Why |
|------------|---------|-----|
| `@hey-api/openapi-ts` | ^6.0.0 | Latest with fetch client support |
| `openapi-typescript` | ^7.0.0 | Latest for OpenAPI 3.1+ support |
| `msw` | ^2.0.0 | Latest with fetch mocking support |
| `vitest-fetch-mock` | ^1.0.0 | Latest vitest integration |

## Confidence Assessment

| Area | Level | Notes |
|------|-------|-------|
| **OpenAPI Client Generation** | HIGH | @hey-api is mature, production-grade with enterprise adoption |
| **Circuit Breaker Integration** | HIGH | Existing implementation matches patterns needed for REST API |
| **Error Mapping** | HIGH | SandboxError interface already covers all expected cases |
| **Authentication** | HIGH | Simple API key pattern is straightforward and secure |
| **Testing Strategy** | HIGH | MSW provides excellent mock API testing for integration |

## Source of API Contract

Note: The actual Blazing API contract (PR #81 endpoints) must be documented and made available. This research assumes the API follows REST patterns typical for workspace management.

## Sources

- [Hey API OpenAPI TS](https://github.com/hey-api/openapi-ts)
- [OpenAPI Fetch](https://openapi-ts.dev/openapi-fetch/)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [MSW Documentation](https://mswjs.io/)
- [Fetch API MDN](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)