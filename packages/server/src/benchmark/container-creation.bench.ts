/**
 * Benchmark: container creation time via createDeepAgentsHandler factory
 *
 * Measures synchronous factory call time for createDeepAgentsHandler with
 * default options, custom transforms, and backendUrl.
 *
 * Note: This benchmarks the factory creation overhead, NOT the async
 * stream handling. Actual request handling involves I/O and is not included.
 */
import { bench, describe } from 'vitest';
import { createDeepAgentsHandler } from '../handler';

// Dummy Request/Response for bench context — factory itself doesn't call them
const dummyReq = () => new Request('http://localhost:3000/api/chat/stream', { method: 'POST', body: '{}' });

describe('createDeepAgentsHandler factory', () => {
  bench('factory creation with default options', () => {
    for (let i = 0; i < 500; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const handler = createDeepAgentsHandler({ backendUrl: 'http://localhost:8000/api/chat/stream' });
    }
  });

  bench('factory creation with custom transforms', () => {
    const customTransform = (frame: { raw: string }) => frame;
    for (let i = 0; i < 500; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const handler = createDeepAgentsHandler({
        backendUrl: 'http://localhost:8000/api/chat/stream',
        transforms: [customTransform],
      });
    }
  });

  bench('factory creation with backendUrl only (no adapter)', () => {
    for (let i = 0; i < 500; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const handler = createDeepAgentsHandler({
        backendUrl: 'http://localhost:8000/api/chat/stream',
        adapter: { transforms: [] },
      });
    }
  });
});