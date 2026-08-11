/**
 * Applies sql/schema.sql to the cluster named by DATABASE_URL.
 *
 *   npm run schema
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { closePool, query } from '../src/db.js'
// The same splitter the MCP client uses. This script used to hand-roll its own — strip every
// `--` to end of line, then split on `;` — which is only safe because no statement in
// sql/schema.sql happens to contain either character inside a literal. The day one does (a CHECK
// with a `;` in an allowed value, a COMMENT ON), that splitter cuts the statement in half and the
// schema applies wrong. `splitStatements` finds boundaries in a copy with literals and comments
// blanked out, so a semicolon inside `'a; b'` is not a boundary, and there is now one statement
// splitter in this repo rather than two that disagree.
import { splitStatements } from '../src/mcp.js'

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, '..', 'sql', 'schema.sql')

/**
 * The statement with its leading comment block removed.
 *
 * `splitStatements` keeps comments — deliberately, since it exists to send SQL over the wire
 * byte-for-byte. Every statement in sql/schema.sql is preceded by the paragraph explaining it, so
 * without this the progress label would read `-- Every raw signal Sleeper has ever seen…` and, far
 * worse, the `SET CLUSTER SETTING` check below would not match. Used for labelling and matching
 * ONLY: what gets executed is always the original text.
 */
function leadingCode(statement: string): string {
  let s = statement
  while (s.startsWith('--')) {
    const nl = s.indexOf('\n')
    if (nl === -1) return ''
    s = s.slice(nl + 1).trimStart()
  }
  return s
}

async function main(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8')

  for (const statement of splitStatements(sql)) {
    const code = leadingCode(statement)
    const label = code.split('\n')[0]!.slice(0, 72)
    try {
      await query(statement)
      console.log(`  ok   ${label}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Enabling the vector-index cluster setting needs admin; on a fresh Basic cluster the
      // account that created it has that, but a least-privilege service account will not.
      if (code.startsWith('SET CLUSTER SETTING')) {
        console.warn(`  WARN ${label}\n       ${message}`)
        console.warn('       Run this once as an admin user, then re-run `npm run schema`.')
        continue
      }
      console.error(`  FAIL ${label}\n       ${message}`)
      throw err
    }
  }

  console.log('\nSchema applied.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
