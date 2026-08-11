/**
 * The honesty of `npm run notice` is the whole value of it.
 *
 * The output is a hold that nothing detected, and the only thing separating that from a fabricated
 * detection is the labelling. So the labelling is asserted here rather than trusted: the banner has
 * to say it is not a detection, and both prose fields have to carry that in their OWN stored text,
 * because `scripts/explain.ts` reads them back out of the database and prints them with no banner
 * of its own.
 *
 * No cluster and no model: everything under test is pure.
 */
import { describe, expect, it } from 'vitest'
import type { Decision } from '../src/decide.js'
import {
  NOTICE_BANNER,
  NOTICE_PACKAGE,
  TEMPLATED_MARK,
  WRAP_COLUMN,
  templatedAdvisory,
  templatedAuditDetail,
  templatedRationale,
  wrap,
  type NoticeFacts,
} from '../scripts/notice.js'

const decision: Decision = {
  hold: false,
  matched: {
    id: '11111111-1111-4111-8111-111111111111',
    packageId: 'syn-takeover-01',
    label: 'takeover',
    source: 'synthetic',
    similarity: 0.4865,
  },
  nearestBenign: {
    id: '22222222-2222-4222-8222-222222222222',
    packageId: 'syn-benign-01',
    label: 'benign',
    source: 'synthetic',
    similarity: 0.546,
  },
  similarity: 0.4865,
  margin: -0.0595,
  thresholds: { holdAt: 0.3695, minMargin: -0.0198 },
  explanation: 'Similarity 0.4865 clears the threshold, but the arc is nearly as close to an ordinary contributor arc.',
}

const facts: NoticeFacts = {
  packageId: 'xz-utils-notice-preview',
  releaseVersion: '5.6.0',
  assessedActor: 'jia-tan',
  assessedActors: ['jia-tan', 'hans-jansen'],
  eventsIngested: 25,
  assessedAt: '2024-02-24',
  prefixScoped: true,
  decision,
  evidence: [
    'Actor "jia-tan" has 13 recorded events over 848 days of tenure (first seen 2021-10-29).',
    'Trust escalated to a privileged role 188 days after first public activity.',
  ],
}

describe('the preview lane is namespaced', () => {
  it('never uses the xz-utils package id', () => {
    // A deliberate hold on `xz-utils` would flip the hero replay's package to 'held' and drop a
    // preview row into the middle of the real demo's evidence.
    expect(NOTICE_PACKAGE).not.toBe('xz-utils')
    expect(NOTICE_PACKAGE).toContain('preview')
  })
})

describe('the banner refuses to be mistaken for a detection', () => {
  it('states outright that this is not a detection', () => {
    expect(NOTICE_BANNER).toContain('THIS IS NOT A DETECTION')
  })

  it('says the transaction and rows are real and the wording is templated', () => {
    expect(NOTICE_BANNER).toMatch(/REAL/)
    expect(NOTICE_BANNER).toMatch(/TEMPLATED/)
    expect(NOTICE_BANNER).toMatch(/deliberately|DELIBERATELY/)
  })

  it('names Bedrock as the reason the wording is templated', () => {
    expect(NOTICE_BANNER).toContain('Bedrock')
  })
})

describe('the stored prose carries its own label', () => {
  // `scripts/explain.ts` prints release_hold.reason and distro_advisory_outbox.advisory_text
  // verbatim. A marker that lived only in this script's stdout would vanish on audit.
  it('marks the rationale as templated inside the text that is stored', () => {
    const reason = templatedRationale(facts)
    expect(reason).toContain(TEMPLATED_MARK)
    expect(reason).toContain('NOT a detection')
    expect(reason).toContain('scripts/notice.ts')
  })

  it('marks the advisory as templated inside the text that is stored', () => {
    const advisory = templatedAdvisory(facts)
    expect(advisory).toContain(TEMPLATED_MARK)
    expect(advisory).toContain('NOT A DETECTION')
  })

  it('marks the audit detail, which is the first thing an auditor reads', () => {
    const detail = templatedAuditDetail(facts)
    expect(detail).toContain('NOT decided by the gate')
    expect(detail.split(' | ')[0]).toContain('PREVIEW HOLD')
  })

  it('names every candidate assessed, not only the one the release was judged on', () => {
    // The agent picks the account itself. A notice that named only the winner would hide the fact
    // that other candidates were considered and beaten.
    for (const actor of facts.assessedActors) {
      expect(templatedAuditDetail(facts)).toContain(actor)
      expect(templatedRationale(facts)).toContain(actor)
    }
  })
})

describe('the prose quotes the real values, not invented ones', () => {
  it('carries the real similarity, margin, matched arc and gate decision', () => {
    const reason = templatedRationale(facts)
    expect(reason).toContain('0.4865')
    expect(reason).toContain('-0.0595')
    expect(reason).toContain('syn-takeover-01')
    expect(reason).toContain('syn-benign-01')
    // The gate's own explanation, quoted verbatim — compared with whitespace collapsed, because
    // the paragraph it sits in is word-wrapped and the line breaks land wherever the values put them.
    const collapse = (s: string): string => s.replace(/\s+/g, ' ')
    expect(collapse(reason)).toContain(collapse(decision.explanation))
  })

  it('reports the gate outcome as ALLOW, never as a hold the gate chose', () => {
    expect(templatedRationale(facts)).toContain('ALLOW')
    expect(templatedRationale(facts)).not.toMatch(/the gate (decided to )?held/i)
  })

  it('states that the hold is behavioural rather than a confirmed vulnerability', () => {
    expect(templatedRationale(facts)).toContain('not a confirmed vulnerability')
    expect(templatedAdvisory(facts)).toContain('not a confirmed vulnerability')
  })

  it('degrades honestly when no playbook arc was retrieved', () => {
    const empty: NoticeFacts = {
      ...facts,
      decision: { ...decision, matched: null, nearestBenign: null, similarity: 0, margin: 0 },
    }
    expect(templatedRationale(empty)).toContain('none retrieved')
    expect(templatedAdvisory(empty)).toContain('n/a')
  })
})

describe('the templates are deterministic', () => {
  // The point of a template is that it does not vary. If these drifted between calls the output
  // could not be pasted into DEMO.md as a stable transcript.
  it('produces byte-identical output for identical facts', () => {
    expect(templatedRationale(facts)).toBe(templatedRationale(facts))
    expect(templatedAdvisory(facts)).toBe(templatedAdvisory(facts))
    expect(templatedAuditDetail(facts)).toBe(templatedAuditDetail(facts))
  })

  it('contains no timestamp of its own', () => {
    // `now()` inside the prose would make the stored text differ from the committed row's
    // created_at by however long the transaction took, and invite a reader to trust the wrong one.
    expect(templatedRationale(facts)).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  })
})

describe('wrap', () => {
  it('breaks at word boundaries and never mid-word', () => {
    const wrapped = wrap('alpha beta gamma delta epsilon', 11)
    expect(wrapped).toBe('alpha beta\ngamma delta\nepsilon')
  })

  it('keeps an over-long single word on its own line rather than truncating it', () => {
    const long = 'a'.repeat(120)
    expect(wrap(`short ${long}`, 20)).toBe(`short\n${long}`)
  })

  it('keeps every stored prose line within the wrap column, interpolation included', () => {
    for (const line of `${templatedRationale(facts)}\n${templatedAdvisory(facts)}`.split('\n')) {
      // Evidence lines are indented under a bullet, so allow the indent on top of the column.
      expect(line.length).toBeLessThanOrEqual(WRAP_COLUMN + 4)
    }
  })
})
