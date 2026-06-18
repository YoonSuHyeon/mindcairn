import { describe, expect, test } from 'bun:test';
import { scoreEvalResult, type ScoredChunk } from '../src/mcp/handlers/eval-score.ts';

/** Build a stored chunk for type/keyword scoring. */
function chunk(over: Partial<ScoredChunk> = {}): ScoredChunk {
  return { type: 'method', enrichedLabel: null, rawContent: '', ...over };
}

describe('scoreEvalResult — recall & MRR (chunkId)', () => {
  test('full recall and MRR=1 when the only expected id is the top hit', () => {
    const s = scoreEvalResult(['a', 'b', 'c'], [chunk(), chunk(), chunk()], 10, {
      expectedChunkIds: ['a'],
    });
    expect(s.recallChunkId).toBe(1);
    expect(s.mrr).toBe(1);
    // only chunkId expectations active → overall = avg(recall, mrr) = 1
    expect(s.overall).toBe(1);
  });

  test('MRR reflects the rank of the FIRST expected hit, not later ones', () => {
    const s = scoreEvalResult(['x', 'y', 'a', 'b'], [chunk(), chunk(), chunk(), chunk()], 10, {
      expectedChunkIds: ['a', 'b'],
    });
    // a is at index 2 → rank 3 → 1/3
    expect(s.mrr).toBeCloseTo(1 / 3, 10);
    // both expected ids present → recall 2/2
    expect(s.recallChunkId).toBe(1);
  });

  test('partial recall, zero MRR when no expected id is in the hits', () => {
    const s = scoreEvalResult(['x', 'y'], [chunk(), chunk()], 10, {
      expectedChunkIds: ['a', 'b'],
    });
    expect(s.recallChunkId).toBe(0);
    expect(s.mrr).toBe(0);
    expect(s.overall).toBe(0);
  });

  test('recall is fraction of EXPECTED ids found (not fraction of hits)', () => {
    const s = scoreEvalResult(['a', 'z'], [chunk(), chunk()], 10, {
      expectedChunkIds: ['a', 'b', 'c', 'd'],
    });
    // 1 of 4 expected found
    expect(s.recallChunkId).toBeCloseTo(0.25, 10);
  });
});

describe('scoreEvalResult — type match', () => {
  test('typeMatchRatio is normalized by topK, not by hit count', () => {
    const stored = [chunk({ type: 'method' }), chunk({ type: 'doc' })];
    const s = scoreEvalResult(['a', 'b'], stored, 10, { expectedTypes: ['method'] });
    // 1 matching type out of topK=10
    expect(s.typeMatchRatio).toBeCloseTo(0.1, 10);
  });

  test('counts every hit whose type is in the expected set', () => {
    const stored = [chunk({ type: 'method' }), chunk({ type: 'method' }), chunk({ type: 'doc' })];
    const s = scoreEvalResult(['a', 'b', 'c'], stored, 3, { expectedTypes: ['method', 'doc'] });
    expect(s.typeMatchRatio).toBe(1); // 3/3
  });
});

describe('scoreEvalResult — keyword match', () => {
  test('matches keywords case-insensitively across label and rawContent', () => {
    const stored = [
      chunk({ enrichedLabel: 'Order Cancellation', rawContent: 'fun cancel() {}' }),
      chunk({ rawContent: 'handles REFUND flow' }),
    ];
    const s = scoreEvalResult(['a', 'b'], stored, 10, {
      expectedKeywords: ['cancel', 'refund', 'shipping'],
    });
    // cancel + refund found, shipping not → 2/3
    expect(s.keywordHitRatio).toBeCloseTo(2 / 3, 10);
  });

  test('null enrichedLabel does not throw and still searches rawContent', () => {
    const stored = [chunk({ enrichedLabel: null, rawContent: 'payment gateway' })];
    const s = scoreEvalResult(['a'], stored, 10, { expectedKeywords: ['payment'] });
    expect(s.keywordHitRatio).toBe(1);
  });
});

describe('scoreEvalResult — overall aggregation & edge cases', () => {
  test('overall averages only the active expectation groups', () => {
    // chunkId (recall=1, mrr=1) + types (ratio=0) active → avg(1,1,0) = 2/3
    const s = scoreEvalResult(['a'], [chunk({ type: 'doc' })], 1, {
      expectedChunkIds: ['a'],
      expectedTypes: ['method'],
    });
    expect(s.recallChunkId).toBe(1);
    expect(s.mrr).toBe(1);
    expect(s.typeMatchRatio).toBe(0);
    expect(s.overall).toBeCloseTo(2 / 3, 10);
  });

  test('no expectations → all metrics and overall are zero', () => {
    const s = scoreEvalResult(['a', 'b'], [chunk(), chunk()], 10, {});
    expect(s).toEqual({
      recallChunkId: 0,
      typeMatchRatio: 0,
      keywordHitRatio: 0,
      mrr: 0,
      overall: 0,
    });
  });

  test('empty hit list with expectations → zero recall/MRR, no throw', () => {
    const s = scoreEvalResult([], [], 10, {
      expectedChunkIds: ['a'],
      expectedTypes: ['method'],
      expectedKeywords: ['x'],
    });
    expect(s.recallChunkId).toBe(0);
    expect(s.mrr).toBe(0);
    expect(s.typeMatchRatio).toBe(0);
    expect(s.keywordHitRatio).toBe(0);
    expect(s.overall).toBe(0);
  });

  test('empty (but present) expectation arrays are treated as inactive', () => {
    const s = scoreEvalResult(['a'], [chunk()], 10, {
      expectedChunkIds: [],
      expectedTypes: [],
      expectedKeywords: [],
    });
    expect(s.overall).toBe(0);
  });
});
