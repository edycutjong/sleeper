/**
 * Demo front end. Consumes the server-sent-event stream from /api/replay and renders each step of
 * the agent loop as it happens — no polling, no client-side decision logic. Everything shown here
 * is a value the agent produced against the live cluster.
 */

const $ = (id) => document.getElementById(id)

const REAL_WORLD_CATCH = Date.UTC(2024, 2, 29) // Andres Freund's oss-security post
const DAY_MS = 86_400_000

function text(el, value) {
  el.textContent = value
}

async function loadState() {
  try {
    const state = await (await fetch('/api/state')).json()
    text($('stat-events'), state.counts.events)
    text($('stat-playbook'), state.counts.playbook)
    text($('stat-heldout'), state.counts.heldOut)
    text($('stat-trust'), state.trustStatus ?? '—')
    text($('provider'), state.provider)
    $('offline-warning').hidden = !state.offline

    // Which path served the audit reads. Shown rather than claimed: if the Managed MCP Server is
    // not configured or could not be reached, this says `direct SQL` and the tooltip says why.
    const audit = $('stat-audit')
    audit.textContent = state.audit.via === 'mcp' ? 'MCP' : 'direct SQL'
    audit.className = state.audit.via === 'mcp' ? 'via-mcp' : 'via-direct'
    audit.title = state.audit.reason

    // /api/state now answers 200 with a `degraded` code instead of throwing a 500, so the page can
    // say what is broken instead of only that something is.
    const banner = $('degraded-warning')
    banner.hidden = !state.degraded
    if (state.degraded) {
      text(
        banner,
        state.degraded === 'db_unreachable'
          ? 'The CockroachDB cluster is not reachable — counts below are placeholders and a replay will fail. Check /api/health.'
          : `Server reports degraded state: ${state.degraded}. Check /api/health.`,
      )
    }
  } catch {
    text($('provider'), 'server unreachable')
  }
}

function renderEvent(step) {
  const li = document.createElement('li')
  if (step.event.kind === 'release') li.classList.add('release')
  if (step.afterHold) li.classList.add('after-hold')
  li.innerHTML = `
    <span class="when">${step.event.occurredAt.slice(0, 10)}</span>
    <span>
      <span class="who">${step.event.actorId}</span>
      <span class="what"> ${step.event.content}</span>
    </span>`
  $('events').append(li)
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  text($('stream-count'), `${step.index + 1} / ${step.total}`)
  text($('stat-events'), Number($('stat-events').textContent || 0) + 1)
}

function renderArc(step) {
  $('arc-panel').hidden = false
  text(
    $('arc-window'),
    `${step.actorId} · ${step.windowStart.slice(0, 10)} → ${step.windowEnd.slice(0, 10)} · ` +
      `${step.cumulativeEvents} events in memory`,
  )
  text($('arc-summary'), step.summary)
  const list = $('arc-evidence')
  list.replaceChildren()
  for (const line of step.evidence) {
    const li = document.createElement('li')
    text(li, line)
    list.append(li)
  }
  text($('stat-trust'), 'assessing')
}

function renderExplain(step) {
  $('explain-panel').hidden = false
  const badge = $('explain-badge')
  badge.className = `badge ${step.explain.prefixScoped ? 'ok' : 'bad'}`
  text(badge, step.explain.prefixScoped ? 'prefix-scoped' : 'NOT prefix-scoped')

  // Highlight the one line that is the actual proof, so it reads on camera.
  const plan = $('explain-plan')
  plan.replaceChildren()
  for (const line of step.explain.plan.split('\n')) {
    const span = document.createElement('span')
    if (/prefix spans:/i.test(line)) span.className = 'hit'
    text(span, `${line}\n`)
    plan.append(span)
  }
}

function renderMatch(step) {
  $('match-panel').hidden = false
  const body = $('matches')
  body.replaceChildren()
  for (const [i, m] of step.matches.entries()) {
    const tr = document.createElement('tr')
    if (i === 0) tr.className = 'top'
    tr.innerHTML = `
      <td>${m.packageId}</td>
      <td class="${m.label}">${m.label}</td>
      <td>${m.similarity.toFixed(4)}</td>`
    body.append(tr)
  }
}

function renderDecision(step) {
  $('decision-panel').hidden = false
  const badge = $('decision-badge')
  badge.className = `badge ${step.decision.hold ? 'hold' : 'ok'}`
  text(badge, step.decision.hold ? `HOLD ${step.releaseVersion}` : `ALLOW ${step.releaseVersion}`)
  text($('decision-explanation'), step.decision.explanation)
  // A hold flips this to 'held' in renderHold; an allow has to put it back itself.
  if (!step.decision.hold) text($('stat-trust'), 'trusted')
}

function renderHold(step) {
  $('hold-panel').hidden = false
  text($('hold-id'), step.holdId)
  text($('hold-latency'), ` · ${step.latencyMs} ms from the release event landing`)
  const writes = $('hold-writes')
  writes.replaceChildren()
  for (const w of step.writes) {
    const li = document.createElement('li')
    text(li, w)
    writes.append(li)
  }
  text($('hold-reason'), step.reason)
  text($('hold-advisory'), step.advisory)
  text($('stat-trust'), 'held')
}

function renderSummary(summary) {
  $('verdict-panel').hidden = false
  if (!summary.holdId) {
    text($('verdict'), 'The gate stayed open — no release was held in this run.')
    return
  }
  const days = Math.round((REAL_WORLD_CATCH - Date.parse(summary.heldAt)) / DAY_MS)
  text(
    $('verdict'),
    `Sleeper held ${summary.releaseVersion} on ${summary.heldAt.slice(0, 10)}. ` +
      `The real world found this backdoor ${days} days later, on 2024-03-29, because one engineer ` +
      `investigated 500 ms of unexplained SSH login latency.`,
  )
}

const HANDLERS = {
  event: renderEvent,
  arc: renderArc,
  explain: renderExplain,
  match: renderMatch,
  decision: renderDecision,
  hold: renderHold,
}

/**
 * Minimal server-sent-event frame parser.
 *
 * `EventSource` can only issue GETs, and /api/replay is a POST now because it resets this
 * package's memory before it replays — a destructive action behind a GET was one prefetch away
 * from wiping the demo mid-recording. The protocol on the wire is unchanged; only the client
 * transport is, so the server still streams plain SSE and `curl -N -XPOST` still works.
 *
 * `onFrame` is called once per `\n\n`-terminated frame.
 */
function parseSseFrame(frame, onFrame) {
  let name = 'message'
  const data = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    // Comment lines (":…") and unknown fields are ignored, per the SSE spec.
  }
  if (data.length) onFrame(name, data.join('\n'))
}

async function startReplay() {
  const button = $('replay')
  button.disabled = true
  button.textContent = 'Replaying…'

  $('events').replaceChildren()
  for (const id of ['arc-panel', 'explain-panel', 'match-panel', 'decision-panel', 'hold-panel', 'verdict-panel']) {
    $(id).hidden = true
  }
  text($('stat-events'), 0)

  const finish = (label) => {
    button.disabled = false
    button.textContent = label
  }
  const fail = (message) => {
    $('verdict-panel').hidden = false
    text($('verdict'), message)
    finish('Retry')
  }

  let response
  try {
    response = await fetch('/api/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  } catch {
    fail('Replay failed: the server is not reachable.')
    return
  }

  if (!response.ok || !response.body) {
    // 409 (already running) and 405 (wrong method) both arrive as JSON, not as a stream.
    const detail = await response.json().catch(() => ({}))
    fail(`Replay failed (${response.status}): ${detail.message ?? detail.error ?? 'unknown error'}`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  const dispatch = (name, payload) => {
    const step = JSON.parse(payload)
    if (name === 'summary') {
      renderSummary(step)
      finished = true
      finish('Replay again')
      return
    }
    if (name === 'failed') {
      // The server no longer returns the raw error text; it returns a code plus a reference that
      // ties this failure to the log line holding the detail.
      finished = true
      fail(`Replay failed (${step.error}). Reference ${step.ref} — see the server log.`)
      return
    }
    HANDLERS[name]?.(step)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        parseSseFrame(buffer.slice(0, boundary), dispatch)
        buffer = buffer.slice(boundary + 2)
      }
    }
  } catch {
    fail('Replay failed: the stream was interrupted.')
    return
  }

  // A stream that ended without a summary or a failure event means the connection dropped
  // mid-replay. Unlike EventSource there is no auto-reconnect to restart the whole thing behind
  // our back, so the button simply offers a retry.
  if (!finished) fail('Replay ended without a result — the connection dropped.')
}

$('replay').addEventListener('click', () => {
  void startReplay()
})
loadState()
