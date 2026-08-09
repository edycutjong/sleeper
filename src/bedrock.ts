import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'
import { config } from './config.js'

const client = new BedrockRuntimeClient({ region: config.aws.region })

/**
 * Titan Text Embeddings V2 via Bedrock `InvokeModel`.
 * Every `events.content` and every `actor_arcs.arc_summary` goes through here before it is written,
 * so this is the single place embedding dimensionality is decided.
 */
export async function embed(text: string): Promise<number[]> {
  const response = await client.send(
    new InvokeModelCommand({
      modelId: config.aws.embeddingModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: config.aws.embeddingDimensions,
        normalize: true,
      }),
    }),
  )

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: number[]
    message?: string
  }
  if (!payload.embedding) {
    throw new Error(`Bedrock returned no embedding: ${payload.message ?? JSON.stringify(payload)}`)
  }
  return payload.embedding
}

/**
 * Claude on Bedrock via the `Converse` API — used to roll a 90-day window of raw events into one
 * arc summary, and to compose the hold rationale and distro advisory.
 */
export async function converse(system: string, prompt: string, maxTokens = 1024): Promise<string> {
  const response = await client.send(
    new ConverseCommand({
      modelId: config.aws.chatModelId,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens },
    }),
  )

  const text = response.output?.message?.content
    ?.map((block) => ('text' in block ? block.text : ''))
    .join('')
    .trim()

  if (!text) throw new Error('Bedrock Converse returned no text content')
  return text
}
