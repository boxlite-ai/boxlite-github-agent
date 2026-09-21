// The structured contract between the in-box model and the runner-side publisher.
// The box prints Claude's `.result` (a JSON object) to stdout; the runner parses and
// normalizes it here. This module is the single source of truth for the review shape —
// the box only pre-checks that its output parses at all (see broker/src/reviewer.js.txt).

export const SEVERITIES = ['blocker', 'warning', 'nit']

// Per-severity emoji badge (inline/summary) + GitHub check-run annotation level.
export const SEVERITY_META = {
  blocker: { badge: '🛑', level: 'failure' },
  warning: { badge: '⚠️', level: 'warning' },
  nit: { badge: '🧹', level: 'notice' },
}

// GitHub caps check-run annotations at 50 per request; keep findings within that so a
// single check-run POST carries them all.
const MAX_FINDINGS = 50
const MAX_CHANGE_MAP = 60

/**
 * Extract the JSON object from the model's reply, tolerating a prose preamble/trailer
 * and/or a ```json fence anywhere in the text (models often explain, then emit).
 */
export function stripFence(text) {
  const raw = String(text)
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i)
  const scope = fenced ? fenced[1] : raw
  const start = scope.indexOf('{')
  const end = scope.lastIndexOf('}')
  return start !== -1 && end > start ? scope.slice(start, end + 1).trim() : scope.trim()
}

/**
 * Parse the model's raw result text into a normalized review. Throws with a clear
 * message when the text is not the expected JSON — the box uses this to fail fast, the
 * runner to surface a bad review instead of publishing garbage.
 * @returns {{ verdict: string, changeMap: object[], findings: object[] }}
 */
export function parseReview(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('review output was empty')
  }
  let parsed
  try {
    parsed = JSON.parse(stripFence(text))
  } catch (cause) {
    throw new Error(`review output was not JSON: ${cause.message}`)
  }
  return normalizeReview(parsed)
}

/** Coerce a parsed object into the review shape, dropping malformed entries. */
export function normalizeReview(parsed) {
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings.map(normalizeFinding).filter(Boolean).slice(0, MAX_FINDINGS)
    : []
  const changeMap = Array.isArray(parsed?.changeMap)
    ? parsed.changeMap.map(normalizeChange).filter(Boolean).slice(0, MAX_CHANGE_MAP)
    : []
  const verdict =
    typeof parsed?.verdict === 'string' && parsed.verdict.trim()
      ? parsed.verdict.trim()
      : findings.length
        ? `${findings.length} issue${findings.length === 1 ? '' : 's'}`
        : 'looks good'
  return { verdict, changeMap, findings }
}

function normalizeFinding(f) {
  if (!f || typeof f.path !== 'string' || !f.path.trim()) return null
  const line = toInt(f.line)
  if (line === null || line < 1) return null
  const endRaw = toInt(f.endLine)
  const endLine = endRaw !== null && endRaw > line ? endRaw : null
  const title = str(f.title) || str(f.body) || 'issue'
  return {
    path: f.path.trim().replace(/^\/+/, ''),
    line,
    endLine,
    severity: SEVERITIES.includes(f.severity) ? f.severity : 'warning',
    category: str(f.category) || 'correctness',
    title,
    body: str(f.body) || title,
    suggestion: str(f.suggestion) || null,
  }
}

function normalizeChange(c) {
  if (!c || typeof c.file !== 'string' || !c.file.trim()) return null
  return {
    file: c.file.trim().replace(/^\/+/, ''),
    symbol: str(c.symbol) || null,
    loc: str(c.loc),
    note: str(c.note),
  }
}

function toInt(v) {
  if (Number.isInteger(v)) return v
  const n = Number.parseInt(v, 10)
  return Number.isInteger(n) ? n : null
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}
