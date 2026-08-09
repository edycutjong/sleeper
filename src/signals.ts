/**
 * Structural evidence derived from what is already in memory.
 *
 * These signals do NOT vote on the hold decision — that is made by vector retrieval alone (see
 * src/decide.ts), and mixing a hand-tuned rule engine into it would quietly turn the benchmark
 * into a measurement of the rules rather than of the memory. They exist to make a hold auditable:
 * they are what the rationale cites and what a distro maintainer reads in the advisory. Keeping
 * them evidentiary rather than decisive is deliberate.
 *
 * Pure functions over rows read back from CockroachDB, so they unit-test without a cluster.
 */
import type { StoredEvent } from './memory.js'

const DAY_MS = 86_400_000

/** The concrete tell in the real xz attack lived in the build system, not the library code. */
const BUILD_SYSTEM_TERMS = [
  'build-to-host',
  'build system',
  'autoconf',
  'automake',
  'configure',
  'm4',
  'makefile',
  'ci ',
  'ifunc',
  'sanitizer',
  'oss-fuzz',
  'landlock',
]

const PRIVILEGE_TERMS = [
  'maintainer',
  'commit access',
  'co-maintainer',
  'release manager',
  'signing',
  'successor',
  'hand over',
  'handover',
]

export type ActorSignals = {
  actorId: string
  firstSeen: Date | null
  tenureDays: number
  totalEvents: number
  commits: number
  emails: number
  releases: number
  privilegeChanges: number
  /** Share of this actor's commits that touch build/CI machinery rather than library code. */
  buildSystemShare: number
  daysFromFirstActivityToPrivilege: number | null
  producesReleases: boolean
}

function mentions(content: string, terms: string[]): boolean {
  const lower = content.toLowerCase()
  return terms.some((t) => lower.includes(t))
}

export function actorSignals(events: StoredEvent[], actorId: string, asOf: Date): ActorSignals {
  const mine = events
    .filter((e) => e.actorId === actorId && e.occurredAt <= asOf)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  const firstSeen = mine[0]?.occurredAt ?? null
  const commits = mine.filter((e) => e.kind === 'commit')
  const privilege = mine.filter(
    (e) => e.kind === 'maintainer_change' || mentions(e.content, PRIVILEGE_TERMS),
  )
  const buildCommits = commits.filter((e) => mentions(e.content, BUILD_SYSTEM_TERMS))

  return {
    actorId,
    firstSeen,
    tenureDays: firstSeen ? Math.round((asOf.getTime() - firstSeen.getTime()) / DAY_MS) : 0,
    totalEvents: mine.length,
    commits: commits.length,
    emails: mine.filter((e) => e.kind === 'email').length,
    releases: mine.filter((e) => e.kind === 'release').length,
    privilegeChanges: mine.filter((e) => e.kind === 'maintainer_change').length,
    buildSystemShare: commits.length ? buildCommits.length / commits.length : 0,
    daysFromFirstActivityToPrivilege:
      firstSeen && privilege[0]
        ? Math.round((privilege[0].occurredAt.getTime() - firstSeen.getTime()) / DAY_MS)
        : null,
    producesReleases: mine.some((e) => e.kind === 'release'),
  }
}

export type PressureAccount = {
  actorId: string
  events: number
  firstSeen: Date
  lastSeen: Date
}

/**
 * Accounts that only ever talk.
 *
 * In the xz timeline the two accounts that pushed the maintainer to hand over control never
 * contributed a line of code and vanished the moment the handover happened. That shape —
 * appears, applies pressure, leaves, no commits anywhere — is one an individual code review
 * structurally cannot see, because there is no code to review.
 */
export function pressureAccounts(events: StoredEvent[], asOf: Date): PressureAccount[] {
  const byActor = new Map<string, StoredEvent[]>()
  for (const e of events) {
    if (e.occurredAt > asOf) continue
    const list = byActor.get(e.actorId) ?? []
    list.push(e)
    byActor.set(e.actorId, list)
  }

  const out: PressureAccount[] = []
  for (const [actorId, list] of byActor) {
    const emailsOnly = list.every((e) => e.kind === 'email')
    const pushesForControl = list.some((e) => mentions(e.content, PRIVILEGE_TERMS))
    if (emailsOnly && pushesForControl) {
      const sorted = [...list].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      out.push({
        actorId,
        events: list.length,
        firstSeen: sorted[0]!.occurredAt,
        lastSeen: sorted[sorted.length - 1]!.occurredAt,
      })
    }
  }
  return out.sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime())
}

/** Short, quotable lines for the hold rationale, the advisory and the audit detail. */
export function evidenceLines(signals: ActorSignals, pressure: PressureAccount[]): string[] {
  const lines: string[] = []

  lines.push(
    `Actor "${signals.actorId}" has ${signals.totalEvents} recorded events over ` +
      `${signals.tenureDays} days of tenure (first seen ` +
      `${signals.firstSeen ? signals.firstSeen.toISOString().slice(0, 10) : 'unknown'}).`,
  )

  if (signals.daysFromFirstActivityToPrivilege !== null) {
    lines.push(
      `Trust escalated to a privileged role ${signals.daysFromFirstActivityToPrivilege} days ` +
        `after first public activity.`,
    )
  }

  if (signals.buildSystemShare > 0) {
    lines.push(
      `${Math.round(signals.buildSystemShare * 100)}% of this actor's commits touch build or CI ` +
        `machinery rather than library code — the layer that ships in release tarballs but is ` +
        `least reviewed.`,
    )
  }

  if (signals.producesReleases) {
    lines.push(
      `This actor now produces signed release artifacts (${signals.releases} on record), so the ` +
        `artifact and its reviewer are the same party.`,
    )
  }

  if (pressure.length) {
    lines.push(
      `${pressure.length} account(s) with no code contributions (${pressure
        .map((p) => p.actorId)
        .join(', ')}) argued for the maintainer handover and then stopped participating.`,
    )
  }

  return lines
}
