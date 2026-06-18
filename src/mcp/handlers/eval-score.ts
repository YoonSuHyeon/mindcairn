/**
 * Pure scoring for eval_query.
 *
 * Extracted from eval-query.ts so the search-quality metrics (recall@K, MRR,
 * type/keyword match, overall) can be unit-tested without a DB, an embedder,
 * or any file I/O. handleEvalQuery fetches the hits, then delegates the math
 * here. This module imports nothing with side effects.
 */

/** The subset of a stored chunk the scorer reads. */
export type ScoredChunk = {
  type: string;
  enrichedLabel: string | null;
  rawContent: string;
};

export type EvalExpectations = {
  expectedChunkIds?: string[];
  expectedTypes?: string[];
  expectedKeywords?: string[];
};

export type EvalScore = {
  recallChunkId: number;
  typeMatchRatio: number;
  keywordHitRatio: number;
  mrr: number;
  overall: number;
};

/**
 * Score a query's results against expectations.
 *
 * @param hitIds   chunkIds of the search hits, in rank order (best first).
 * @param stored   the stored chunks for those hits (used for type/keyword scoring).
 * @param topK     the requested top-K (typeMatchRatio is normalized by this).
 * @param expected the golden-set expectations to score against.
 */
export function scoreEvalResult(
  hitIds: string[],
  stored: ScoredChunk[],
  topK: number,
  expected: EvalExpectations,
): EvalScore {
  const { expectedChunkIds, expectedTypes, expectedKeywords } = expected;

  // 1. recall@K — expected chunkId
  let recallChunkId = 0;
  if (expectedChunkIds?.length) {
    const found = hitIds.filter((id) => expectedChunkIds.includes(id));
    recallChunkId = found.length / expectedChunkIds.length;
  }

  // 2. type-distribution match
  let typeMatchRatio = 0;
  if (expectedTypes?.length) {
    const hitTypes = stored.map((s) => s.type);
    const matched = hitTypes.filter((t) => expectedTypes.includes(t));
    typeMatchRatio = matched.length / topK;
  }

  // 3. keyword match — whether expected keywords appear in raw_content + label
  let keywordHitRatio = 0;
  if (expectedKeywords?.length) {
    const haystack = stored
      .map((s) => `${s.enrichedLabel ?? ''}\n${s.rawContent}`.toLowerCase())
      .join('\n');
    const found = expectedKeywords.filter((k) => haystack.includes(k.toLowerCase()));
    keywordHitRatio = found.length / expectedKeywords.length;
  }

  // 4. MRR — rank of the first expected chunkId
  let mrr = 0;
  if (expectedChunkIds?.length) {
    for (let i = 0; i < hitIds.length; i++) {
      if (expectedChunkIds.includes(hitIds[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }
  }

  // overall score (average of the active parts)
  const scoreParts: number[] = [];
  if (expectedChunkIds?.length) scoreParts.push(recallChunkId, mrr);
  if (expectedTypes?.length) scoreParts.push(typeMatchRatio);
  if (expectedKeywords?.length) scoreParts.push(keywordHitRatio);
  const overall = scoreParts.length
    ? scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length
    : 0;

  return { recallChunkId, typeMatchRatio, keywordHitRatio, mrr, overall };
}
