import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UseRunStreamResult } from '@/lib/hooks/useRunStream';
import type { ToolCallState } from '@/lib/types';

vi.mock('@/lib/hooks/useRunStream', () => ({ useRunStream: vi.fn() }));
vi.mock('@/lib/hooks/useToolState', () => ({ useToolState: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ runId: 'test-run-id' })),
  useSearchParams: vi.fn(() => new URLSearchParams('threadId=test-thread-id')),
}));

import { useRunStream } from '@/lib/hooks/useRunStream';
import { useToolState } from '@/lib/hooks/useToolState';
import { useSearchParams } from 'next/navigation';
import RunDetailPage from './page';

const mockUseRunStream = useRunStream as ReturnType<typeof vi.fn>;
const mockUseToolState = useToolState as ReturnType<typeof vi.fn>;
const mockUseSearchParams = useSearchParams as ReturnType<typeof vi.fn>;

const defaultStreamResult: UseRunStreamResult = {
  events: [],
  status: 'connecting',
  error: null,
  retry: vi.fn(),
};

beforeEach(() => {
  mockUseRunStream.mockReturnValue(defaultStreamResult);
  mockUseToolState.mockReturnValue([]);
  mockUseSearchParams.mockReturnValue(new URLSearchParams('threadId=test-thread-id'));
});

describe('RunDetail', () => {
  it('renders loading state while connecting', () => {
    mockUseRunStream.mockReturnValue({ ...defaultStreamResult, status: 'connecting' });
    render(<RunDetailPage />);
    expect(screen.getByTestId('stream-status').textContent).toContain('connecting');
  });

  it('renders streamed text delta events as concatenated text', () => {
    mockUseRunStream.mockReturnValue({
      ...defaultStreamResult,
      status: 'streaming',
      events: [
        { type: 'text-delta', delta: 'Hello, ' },
        { type: 'text-delta', delta: 'world!' },
      ],
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId('agent-text').textContent).toBe('Hello, world!');
  });

  it('renders ToolCard for each tool call in state', () => {
    const toolCalls: ToolCallState[] = [
      { toolCallId: 'tc-1', toolName: 'bash', input: {}, status: 'pending' },
      { toolCallId: 'tc-2', toolName: 'read_file', input: {}, status: 'completed', output: {} },
    ];
    mockUseToolState.mockReturnValue(toolCalls);
    render(<RunDetailPage />);
    const cards = screen.getAllByTestId('tool-card');
    expect(cards).toHaveLength(2);
  });

  it('shows error message when stream errors', () => {
    mockUseRunStream.mockReturnValue({
      ...defaultStreamResult,
      status: 'error',
      error: new Error('Connection refused'),
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId('stream-error').textContent).toContain('Connection refused');
  });

  it('shows error state when threadId is missing from query string', () => {
    mockUseSearchParams.mockReturnValueOnce(new URLSearchParams(''));
    render(<RunDetailPage />);
    expect(screen.getByTestId('missing-thread-id')).toBeTruthy();
  });
});
