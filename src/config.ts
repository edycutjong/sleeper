import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`)
  return v
}

export const config = {
  /** Full CockroachDB Cloud connection URL, from `ccloud cluster sql --connection-url sleeper-cluster`. */
  databaseUrl: () => required('DATABASE_URL'),
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
} as const
