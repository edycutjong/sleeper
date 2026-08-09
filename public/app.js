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

function startReplay() {
  const button = $('replay')
  button.disabled = true
  button.textContent = 'Replaying…'

  $('events').replaceChildren()
  for (const id of ['arc-panel', 'explain-panel', 'match-panel', 'decision-panel', 'hold-panel', 'verdict-panel']) {
    $(id).hidden = true
  }
  text($('stat-events'), 0)

  const source = new EventSource('/api/replay')
  const finish = (label) => {
    source.close()
    button.disabled = false
    button.textContent = label
  }

  source.addEventListener('event', (e) => renderEvent(JSON.parse(e.data)))
  source.addEventListener('arc', (e) => renderArc(JSON.parse(e.data)))
  source.addEventListener('explain', (e) => renderExplain(JSON.parse(e.data)))
  source.addEventListener('match', (e) => renderMatch(JSON.parse(e.data)))
  source.addEventListener('decision', (e) => renderDecision(JSON.parse(e.data)))
  source.addEventListener('hold', (e) => renderHold(JSON.parse(e.data)))
  source.addEventListener('summary', (e) => {
    renderSummary(JSON.parse(e.data))
    finish('Replay again')
  })
  source.addEventListener('failed', (e) => {
    $('verdict-panel').hidden = false
    text($('verdict'), `Replay failed: ${JSON.parse(e.data).message}`)
    finish('Retry')
  })
  // EventSource auto-reconnects on a dropped connection, which would restart the whole replay.
  source.onerror = () => finish('Retry')
}

$('replay').addEventListener('click', startReplay)
loadState()
