/**
 * Debug logging for @deepagents-nextjs/server.
 * Enabled via: DEBUG=deepagents:sse
 * Zero overhead when env var is unset.
 */

const NAMESPACE = 'deepagents:sse'

/** Returns true only when DEBUG env var includes the exact namespace 'deepagents:sse'. */
export function shouldDebug(): boolean {
  const val = process.env.DEBUG
  if (!val) return false
  // Support comma-separated namespaces: DEBUG=deepagents:sse,other:ns
  return val.split(',').map((s) => s.trim()).includes(NAMESPACE)
}

/**
 * Emits a parsed SSE frame to stderr.
 * Only call this after checking shouldDebug() to avoid any overhead.
 * Non-JSON data lines (e.g., [DONE]) are silently skipped.
 * Parse errors do NOT propagate — they must not corrupt the SSE stream.
 */
export function logSseFrame(frame: { raw: string }): void {
  try {
    const dataLine = frame.raw.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) return
    const jsonStr = dataLine.slice(6) // Remove "data: " prefix
    if (jsonStr === '[DONE]') return
    const parsed = JSON.parse(jsonStr)
    console.error(`[deepagents:sse] frame: ${JSON.stringify(parsed)}`)
  } catch {
    // Non-JSON or malformed data lines are expected (e.g., event: lines).
    // Silently skip — parse errors must NOT corrupt the SSE stream.
  }
}
