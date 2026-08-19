// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useToolState } from './useToolState';
import { StreamEvent } from '../types';

describe('useToolState', () => {
  it('returns empty array for empty events', () => {
    const { result } = renderHook(() => useToolState([]));
    expect(result.current).toEqual([]);
  });

  it('returns pending tool call when tool-input-start event arrives', () => {
    const events: StreamEvent[] = [
      { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].status).toBe('pending');
    expect(result.current[0].toolName).toBe('bash');
  });

  it('upgrades to completed when tool-output-available matches toolCallId', () => {
    const events: StreamEvent[] = [
      { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
      { type: 'tool-output-available', toolCallId: 'tc-1', output: { stdout: 'file.txt' } },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current[0].status).toBe('completed');
    expect(result.current[0].output).toEqual({ stdout: 'file.txt' });
  });

  it('does not mutate completed state when duplicate tool-output-available arrives', () => {
    const events: StreamEvent[] = [
      { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
      { type: 'tool-output-available', toolCallId: 'tc-1', output: { stdout: 'first' } },
      { type: 'tool-output-available', toolCallId: 'tc-1', output: { stdout: 'second' } },
    ];
    const { result } = renderHook(() => useToolState(events));
    // First output wins; duplicate ignored
    expect(result.current[0].output).toEqual({ stdout: 'first' });
    expect(result.current[0].status).toBe('completed');
  });

  it('tracks multiple concurrent tool calls independently', () => {
    const events: StreamEvent[] = [
      { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'bash', input: {} },
      { type: 'tool-input-start', toolCallId: 'tc-2', toolName: 'read_file', input: { path: '/foo' } },
      { type: 'tool-output-available', toolCallId: 'tc-1', output: 'done' },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current).toHaveLength(2);
    const tc1 = result.current.find((t) => t.toolCallId === 'tc-1')!;
    const tc2 = result.current.find((t) => t.toolCallId === 'tc-2')!;
    expect(tc1.status).toBe('completed');
    expect(tc2.status).toBe('pending');
  });

  it('converges correctly when tool-output-available arrives before tool-input-start (out-of-order)', () => {
    // Out-of-order: output arrives before input
    const events: StreamEvent[] = [
      { type: 'tool-output-available', toolCallId: 'tc-oo', output: { result: 42 } },
      { type: 'tool-input-start', toolCallId: 'tc-oo', toolName: 'compute', input: { x: 1 } },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current).toHaveLength(1);
    // After processing both events in this order, state must be completed
    expect(result.current[0].status).toBe('completed');
    expect(result.current[0].output).toEqual({ result: 42 });
    expect(result.current[0].toolName).toBe('compute');
  });
});
