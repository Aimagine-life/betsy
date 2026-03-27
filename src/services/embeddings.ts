const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function findBestMatches<T extends { embedding: Float32Array }>(
  query: Float32Array,
  candidates: T[],
  topK: number,
): (T & { score: number })[] {
  return candidates
    .map(c => ({ ...c, score: cosineSimilarity(query, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export async function generateEmbedding(text: string, apiKey: string): Promise<Float32Array> {
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(json.data[0].embedding);
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
