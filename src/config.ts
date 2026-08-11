import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`)
  return v
}

/** Documented endpoint of the CockroachDB Cloud Managed MCP Server. */
export const MCP_DEFAULT_ENDPOINT = 'https://cockroachlabs.cloud/mcp'

export const config = {
  /** Full CockroachDB Cloud connection URL, from `ccloud cluster sql --connection-url sleeper-cluster`. */
  databaseUrl: () => required('DATABASE_URL'),

  /**
   * CockroachDB Cloud Managed MCP Server — the read-only audit path.
   *
   * Deliberately OPTIONAL, and read through `required()` nowhere: a checkout with no MCP
   * credentials must still run the whole demo. Absence routes the audit reads back onto direct
   * SQL with a printed reason (see `resolveMcpMode` in src/mcp.ts) rather than failing at import.
   *
   * Each getter takes an env so the fallback logic is testable without mutating process.env.
   */
  mcp: {
    endpoint: (env: NodeJS.ProcessEnv = process.env) => env.COCKROACH_MCP_URL ?? MCP_DEFAULT_ENDPOINT,
    /** Service-account API key → `Authorization: Bearer …`. Created by scripts/provision.sh. */
    apiKey: (env: NodeJS.ProcessEnv = process.env) => env.COCKROACH_MCP_API_KEY ?? null,
    /** Pins the session to one cluster → `mcp-cluster-id: …`. Without it the key reaches all of them. */
    clusterId: (env: NodeJS.ProcessEnv = process.env) => env.COCKROACH_CLUSTER_ID ?? null,
    /** Escape hatch for demoing the fallback path with credentials still in .env. */
    disabled: (env: NodeJS.ProcessEnv = process.env) => env.SLEEPER_MCP === 'off',
  },

  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    /** Titan Text Embeddings V2 — 1024-dim output, matching VECTOR(1024) in sql/schema.sql. */
    embeddingModelId: process.env.BEDROCK_EMBEDDING_MODEL_ID ?? 'amazon.titan-embed-text-v2:0',
    embeddingDimensions: 1024,
    /** Claude on Bedrock, used via the Converse API for arc summaries and hold rationales. */
    chatModelId: process.env.BEDROCK_CHAT_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  packageId: process.env.PACKAGE_ID ?? 'xz-utils',
  /** Rolling behavioural window, in days, that an actor arc summarises. */
  arcWindowDays: Number(process.env.ARC_WINDOW_DAYS ?? 90),
  /** The account whose arc the xz replay assesses at the 5.6.0 release. */
  suspectActor: process.env.SUSPECT_ACTOR ?? 'jia-tan',
  /** Demo server port. */
  port: Number(process.env.PORT ?? 3000),
} as const
