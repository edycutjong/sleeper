/**
 * The hold decision — deliberately pure, so it is unit-testable without a cluster or a model.
 *
 * The rule is two-sided on purpose. A bare "similarity to a known takeover arc >= X" gate cries
 * wolf on any contributor who happens to be new and prolific, which is most good first-time
 * maintainers. Sleeper holds only when the arc is BOTH close to a known takeover shape AND
 * meaningfully closer to that shape than to the nearest ordinary-contributor shape. The benign
 * arcs in the playbook are what make the second half of that possible, which is why several of
 * them are written to superficially resemble a takeover (fast rise, handover, new account).
 */

export type Label = 'takeover' | 'benign'

export type PlaybookMatch = {
  id: string
  packageId: string
  label: Label
  source: string
  similarity: number
}

export type Thresholds = {
  /** Minimum nearest-takeover similarity before a hold is even considered. */
  holdAt: number
  /** Minimum (nearest takeover - nearest benign) gap required on top of that. */
  minMargin: number
}

/**
 * Fallback only. The real values are produced by `npm run calibrate`, which fits them by
 * leave-one-out over the PLAYBOOK arcs alone and writes data/thresholds.json. Held-out arcs are
 * never used to pick a threshold — that separation is the entire reason the benchmark means
 * anything.
 */
export const FALLBACK_THRESHOLDS: Thresholds = { holdAt: 0.6, minMargin: 0.02 }

export type Decision = {
  hold: boolean
  /** Nearest takeover-labelled arc in the playbook, if any. */
  matched: PlaybookMatch | null
  nearestBenign: PlaybookMatch | null
  similarity: number
  margin: number
  thresholds: Thresholds
  /** Human-readable reason the gate opened or stayed shut — surfaced in the UI and the audit log. */
  explanation: string
}

function nearest(matches: PlaybookMatch[], label: Label): PlaybookMatch | null {
  let best: PlaybookMatch | null = null
  for (const m of matches) {
    if (m.label !== label) continue
    if (!best || m.similarity > best.similarity) best = m
  }
  return best
}

export function decide(matches: PlaybookMatch[], thresholds: Thresholds): Decision {
  const matched = nearest(matches, 'takeover')
  const nearestBenign = nearest(matches, 'benign')

  const similarity = matched?.similarity ?? 0
  // With no benign neighbour retrieved at all there is nothing to contrast against, so the
  // margin test cannot be satisfied honestly — treat it as zero rather than as a free pass.
  const margin = matched && nearestBenign ? matched.similarity - nearestBenign.similarity : 0

  const meetsSimilarity = similarity >= thresholds.holdAt
  const meetsMargin = margin >= thresholds.minMargin
  const hold = Boolean(matched) && meetsSimilarity && meetsMargin

  let explanation: string
  if (!matched) {
    explanation = 'No takeover-labelled arc was retrieved from the playbook.'
  } else if (hold) {
    explanation =
      `Arc matches known takeover shape ${matched.packageId} at cosine similarity ` +
      `${similarity.toFixed(4)} (>= ${thresholds.holdAt}), and sits ${margin.toFixed(4)} ` +
      `(>= ${thresholds.minMargin}) closer to that shape than to the nearest ordinary ` +
      `contributor arc${nearestBenign ? ` (${nearestBenign.packageId})` : ''}.`
  } else if (!meetsSimilarity) {
    explanation =
      `Nearest takeover shape is only ${similarity.toFixed(4)} similar, below the ` +
      `${thresholds.holdAt} hold threshold.`
  } else {
    explanation =
      `Similarity ${similarity.toFixed(4)} clears the threshold, but the arc is nearly as close ` +
      `to an ordinary contributor arc (margin ${margin.toFixed(4)} < ${thresholds.minMargin}) — ` +
      `not separable enough to justify holding a release.`
  }

  return { hold, matched, nearestBenign, similarity, margin, thresholds, explanation }
}

/**
 * Fits thresholds by leave-one-out over the playbook only.
 *
 * For each candidate cut point we score every playbook arc against the rest of the playbook and
 * count how many are classified correctly; the chosen point maximises balanced accuracy, and ties
 * break toward the higher threshold (a release gate should prefer to stay shut about holding).
 */
export function fitThresholds(
  scored: { label: Label; similarity: number; margin: number }[],
): Thresholds {
  const candidates = (values: number[]): number[] => {
    const sorted = [...new Set(values)].sort((a, b) => a - b)
    const mids = sorted.slice(0, -1).map((v, i) => (v + sorted[i + 1]!) / 2)
    return [...sorted, ...mids]
  }

  let best: { thresholds: Thresholds; score: number } | null = null
  const takeovers = scored.filter((s) => s.label === 'takeover')
  const benigns = scored.filter((s) => s.label === 'benign')
  if (!takeovers.length || !benigns.length) return FALLBACK_THRESHOLDS

  for (const holdAt of candidates(scored.map((s) => s.similarity))) {
    for (const minMargin of candidates(scored.map((s) => s.margin))) {
      const recall =
        takeovers.filter((s) => s.similarity >= holdAt && s.margin >= minMargin).length /
        takeovers.length
      const specificity =
        benigns.filter((s) => !(s.similarity >= holdAt && s.margin >= minMargin)).length /
        benigns.length
      const score = (recall + specificity) / 2
      if (!best || score > best.score || (score === best.score && holdAt > best.thresholds.holdAt)) {
        best = { thresholds: { holdAt, minMargin }, score }
      }
    }
  }

  return best!.thresholds
}
