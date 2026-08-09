/**
 * Applies sql/schema.sql to the cluster named by DATABASE_URL.
 *
 *   npm run schema
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { closePool, query } from '../src/db.js'

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, '..', 'sql', 'schema.sql')

function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8')

  for (const statement of statements(sql)) {
    const label = statement.split('\n')[0]!.slice(0, 72)
    try {
      await query(statement)
      console.log(`  ok   ${label}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Enabling the vector-index cluster setting needs admin; on a fresh Basic cluster the
      // account that created it has that, but a least-privilege service account will not.
      if (statement.startsWith('SET CLUSTER SETTING')) {
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
