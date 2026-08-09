import { describe, expect, it } from 'vitest'
import { decide, fitThresholds, type PlaybookMatch, type Thresholds } from '../src/decide.js'

const T: Thresholds = { holdAt: 0.6, minMargin: 0.05 }

function match(label: 'takeover' | 'benign', similarity: number, id: string = label): PlaybookMatch {
  return { id, packageId: id, label, source: 'synthetic', similarity }
}

describe('decide', () => {
  it('holds when the arc is close to a takeover shape and clearly separated from benign ones', () => {
    const d = decide([match('takeover', 0.81), match('benign', 0.62)], T)
    expect(d.hold).toBe(true)
    expect(d.similarity).toBeCloseTo(0.81)
    expect(d.margin).toBeCloseTo(0.19)
  })

  it('does not hold when similarity is below the threshold', () => {
    const d = decide([match('takeover', 0.55), match('benign', 0.2)], T)
    expect(d.hold).toBe(false)
    expect(d.explanation).toMatch(/below the/)
  })

  it('does not hold when a benign arc is nearly as close — the cry-wolf guard', () => {
    const d = decide([match('takeover', 0.83), match('benign', 0.81)], T)
    expect(d.hold).toBe(false)
    expect(d.margin).toBeCloseTo(0.02)
    expect(d.explanation).toMatch(/ordinary contributor arc/)
  })

  it('treats a similarity exactly at the threshold as passing', () => {
    const d = decide([match('takeover', 0.6), match('benign', 0.1)], T)
    expect(d.hold).toBe(true)
  })

  it('treats a similarity a hair under the threshold as failing', () => {
    expect(decide([match('takeover', 0.5999), match('benign', 0.1)], T).hold).toBe(false)
  })

  it('never holds when no takeover arc was retrieved', () => {
    const d = decide([match('benign', 0.99), match('benign', 0.98, 'b2')], T)
    expect(d.hold).toBe(false)
    expect(d.matched).toBeNull()
    expect(d.similarity).toBe(0)
    expect(d.explanation).toMatch(/No takeover-labelled arc/)
  })

  it('refuses to hold on a takeover match with nothing to contrast against', () => {
    // A margin cannot be computed honestly with no benign neighbour, so it must not pass as one.
    const d = decide([match('takeover', 0.97)], T)
    expect(d.hold).toBe(false)
    expect(d.margin).toBe(0)
  })

  it('handles an empty result set without throwing', () => {
    const d = decide([], T)
    expect(d.hold).toBe(false)
    expect(d.matched).toBeNull()
    expect(d.nearestBenign).toBeNull()
  })

  it('picks the single nearest arc of each label, not the first returned', () => {
    const d = decide(
      [match('takeover', 0.5, 't-far'), match('benign', 0.3, 'b-far'), match('takeover', 0.9, 't-near'), match('benign', 0.7, 'b-near')],
      T,
    )
    expect(d.matched?.id).toBe('t-near')
    expect(d.nearestBenign?.id).toBe('b-near')
    expect(d.margin).toBeCloseTo(0.2)
  })

  it('reports the thresholds it was given so an audit row can reproduce the call', () => {
    expect(decide([], T).thresholds).toEqual(T)
  })
})

describe('fitThresholds', () => {
  it('finds a cut that separates cleanly separable data', () => {
    const fitted = fitThresholds([
      { label: 'takeover', similarity: 0.9, margin: 0.3 },
      { label: 'takeover', similarity: 0.88, margin: 0.28 },
      { label: 'benign', similarity: 0.4, margin: -0.1 },
      { label: 'benign', similarity: 0.35, margin: -0.2 },
    ])
    const classify = (s: number, m: number) => s >= fitted.holdAt && m >= fitted.minMargin
    expect(classify(0.9, 0.3)).toBe(true)
    expect(classify(0.88, 0.28)).toBe(true)
    expect(classify(0.4, -0.1)).toBe(false)
    expect(classify(0.35, -0.2)).toBe(false)
  })

  it('falls back rather than inventing a threshold from one-sided data', () => {
    const only = [
      { label: 'takeover' as const, similarity: 0.9, margin: 0.3 },
      { label: 'takeover' as const, similarity: 0.8, margin: 0.2 },
    ]
    expect(fitThresholds(only)).toEqual({ holdAt: 0.6, minMargin: 0.02 })
    expect(fitThresholds([])).toEqual({ holdAt: 0.6, minMargin: 0.02 })
  })

  it('breaks ties toward the stricter threshold', () => {
    // Both 0.5 and 0.7 separate this set perfectly; a release gate should prefer the higher bar.
    const fitted = fitThresholds([
      { label: 'takeover', similarity: 0.8, margin: 0.5 },
      { label: 'benign', similarity: 0.1, margin: -0.5 },
    ])
    expect(fitted.holdAt).toBeGreaterThan(0.1)
    expect(fitted.holdAt).toBeLessThanOrEqual(0.8)
  })
})
