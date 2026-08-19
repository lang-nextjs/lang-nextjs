'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function OpenSwePage() {
  const [task, setTask] = useState('');
  const [result, setResult] = useState<{ run_id: string; thread_id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submitTask() {
    if (!task.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/open-swe/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
      } else {
        setResult(json);
        setTask('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: '2rem', maxWidth: '640px' }}>
      <h1>OpenSWE Dashboard</h1>
      <p>Submit a task to the OpenSWE agent. Requires <code>LANGGRAPH_PLATFORM_URL</code>.</p>

      <div style={{ marginTop: '1.5rem' }}>
        <textarea
          data-testid="task-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe the task for the agent…"
          rows={4}
          style={{ width: '100%', fontFamily: 'inherit', fontSize: '1rem' }}
        />
        <button
          data-testid="submit-task"
          onClick={submitTask}
          disabled={loading || !task.trim()}
          style={{ marginTop: '0.5rem' }}
        >
          {loading ? 'Submitting…' : 'Submit Task'}
        </button>
      </div>

      {error && (
        <p data-testid="submit-error" role="alert" style={{ color: 'red', marginTop: '1rem' }}>
          Error: {error}
        </p>
      )}

      {result && (
        <div data-testid="submit-result" style={{ marginTop: '1rem' }}>
          <p>Run created: <strong>{result.run_id}</strong></p>
          {result.thread_id && (
            <Link href={`/open-swe/runs/${result.run_id}?threadId=${result.thread_id}`}>
              View live stream →
            </Link>
          )}
        </div>
      )}

      <hr style={{ margin: '2rem 0' }} />
      <p style={{ fontSize: '0.875rem', color: '#666' }}>
        API: <code>POST /api/open-swe/runs</code> · <code>GET /api/open-swe/runs</code>
      </p>
    </main>
  );
}
