/**
 * Loads the bundled corpora and the calibrated thresholds.
 *
 * data/xz-timeline.json is the GROUND-TRUTH HERO REPLAY, reconstructed from the public record of
 * CVE-2024-3094. data/synthetic-arcs.json is written-for-this-project material split into a
 * `playbook` half (what an incoming arc is matched against) and a `heldout` half (never inserted,
 * never used to pick a threshold). Those two things are reported separately everywhere — see
 * DEMO.md — because blurring a ground-truth demo into a benchmark number is how you get a claim
 * that does not survive a judge re-running it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TimelineEvent } from './agent.js'
import { FALLBACK_THRESHOLDS, type Label, type Thresholds } from './decide.js'

const here = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = join(here, '..', 'data')

type RawTimelineEvent = {
  actor_id: string
  kind: string
  occurred_at: string
  content: string
  source_url?: string
  approximate?: boolean
}

export type Timeline = {
  packageId: string
  actors: Record<string, string>
  provenance: Record<string, unknown>
  events: TimelineEvent[]
}

export function loadTimeline(packageIdOverride?: string): Timeline {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'xz-timeline.json'), 'utf8')) as {
    package_id: string
    actors: Record<string, string>
    provenance: Record<string, unknown>
    events: RawTimelineEvent[]
  }
  const packageId = packageIdOverride ?? raw.package_id
  return {
    packageId,
    actors: raw.actors,
    provenance: raw.provenance,
    events: raw.events.map((e) => ({
      packageId,
      actorId: e.actor_id,
      kind: e.kind,
      content: e.content,
      occurredAt: e.occurred_at,
      sourceUrl: e.source_url ?? null,
      approximate: e.approximate,
    })),
  }
}

export type SyntheticArc = { id: string; label: Label; arc_summary: string }

export type Synthetic = {
  provenance: Record<string, unknown>
  playbook: SyntheticArc[]
  heldout: SyntheticArc[]
}

export function loadSynthetic(): Synthetic {
  return JSON.parse(readFileSync(join(DATA_DIR, 'synthetic-arcs.json'), 'utf8')) as Synthetic
}

export const THRESHOLDS_PATH = join(DATA_DIR, 'thresholds.json')

export type CalibratedThresholds = Thresholds & {
  fittedOn: string
  method: string
  generatedWith: string
}

/**
 * Returns the calibrated thresholds if `npm run calibrate` has been run, otherwise the fallback.
 * The caller is told which it got so the UI and the bench can say so out loud.
 */
export function loadThresholds(): { thresholds: Thresholds; calibrated: CalibratedThresholds | null } {
  if (!existsSync(THRESHOLDS_PATH)) return { thresholds: FALLBACK_THRESHOLDS, calibrated: null }
  const parsed = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as CalibratedThresholds
  return { thresholds: { holdAt: parsed.holdAt, minMargin: parsed.minMargin }, calibrated: parsed }
}
