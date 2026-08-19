// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCard } from './ToolCard';
import { ToolCallState } from '../lib/types';

const pendingTool: ToolCallState = {
  toolCallId: 'tc-1',
  toolName: 'bash',
  input: { cmd: 'ls -la' },
  status: 'pending',
};

const completedTool: ToolCallState = {
  toolCallId: 'tc-2',
  toolName: 'read_file',
  input: { path: '/foo/bar.ts' },
  output: { content: 'export const x = 1;' },
  status: 'completed',
};

describe('ToolCard', () => {
  it('renders tool name in pending state', () => {
    render(<ToolCard tool={pendingTool} />);
    expect(screen.getByTestId('tool-name').textContent).toBe('bash');
    expect(screen.getByTestId('tool-status').textContent).toBe('pending');
    expect(screen.queryByTestId('expand-toggle')).toBeNull();
  });

  it('renders completed state with expand button', () => {
    render(<ToolCard tool={completedTool} />);
    expect(screen.getByTestId('tool-status').textContent).toBe('completed');
    expect(screen.getByTestId('expand-toggle')).toBeTruthy();
  });

  it('shows input and output payload when expanded', () => {
    render(<ToolCard tool={completedTool} />);
    fireEvent.click(screen.getByTestId('expand-toggle'));
    expect(screen.getByTestId('tool-payload')).toBeTruthy();
    expect(screen.getByTestId('tool-input').textContent).toContain('/foo/bar.ts');
    expect(screen.getByTestId('tool-output').textContent).toContain('export const x = 1');
  });

  it('does not show payload when not expanded', () => {
    render(<ToolCard tool={completedTool} />);
    expect(screen.queryByTestId('tool-payload')).toBeNull();
  });
});
