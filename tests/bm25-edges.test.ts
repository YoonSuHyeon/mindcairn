import { describe, expect, test } from 'bun:test';
import { tokenize, toSparse } from '../src/builder/bm25.ts';

describe('tokenize — punctuation & whitespace', () => {
  test('strips punctuation and collapses whitespace', () => {
    const toks = tokenize('  order.cancel(reason);  ');
    expect(toks).toContain('order');
    expect(toks).toContain('cancel');
    expect(toks).toContain('reason');
    // no punctuation leaks into tokens
    expect(toks.every((t) => /^[a-z0-9가-힣]+$/.test(t))).toBe(true);
  });

  test('empty / whitespace-only / punctuation-only input yields no tokens', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \n\t ')).toEqual([]);
    expect(tokenize('()[]{}.,;:!?')).toEqual([]);
  });
});

describe('tokenize — mixed script', () => {
  test('separates Korean runs from latin identifiers', () => {
    const toks = tokenize('주문cancel취소');
    // latin and Korean are matched as distinct runs
    expect(toks).toContain('cancel');
    expect(toks).toContain('주문');
    expect(toks).toContain('취소');
  });

  test('drops single Korean chars but keeps 2+ char runs', () => {
    const toks = tokenize('결제 가 처리');
    expect(toks).toContain('결제');
    expect(toks).toContain('처리');
    expect(toks).not.toContain('가');
  });
});

describe('tokenize — identifier preservation', () => {
  test('keeps the whole identifier alongside its parts when length >= 3', () => {
    const toks = tokenize('getUserId');
    expect(toks).toContain('get');
    expect(toks).toContain('user');
    expect(toks).toContain('id');
    expect(toks).toContain('getuserid');
  });

  test('does not duplicate the whole identifier when it equals its single part', () => {
    // a single lowercase word: part and "full" are identical → emitted once
    const toks = tokenize('payment');
    expect(toks.filter((t) => t === 'payment')).toHaveLength(1);
  });

  test('short all-caps acronyms (< 3 chars) are not re-added as a whole token', () => {
    // "io" → length 2: kept as a part, but the length>=3 whole-token branch is skipped
    const toks = tokenize('io');
    expect(toks).toEqual(['io']);
  });
});

describe('toSparse — hashing & term frequency', () => {
  test('distinct tokens map to distinct indices with TF=1', () => {
    const { indices, values } = toSparse('order cancel refund');
    expect(new Set(indices).size).toBe(indices.length); // no collisions for these tokens
    expect(indices.length).toBe(3);
    expect(values.every((v) => v === 1)).toBe(true);
  });

  test('is deterministic — same text yields identical sparse vectors', () => {
    const a = toSparse('cancelExpiredOrders 주문 취소');
    const b = toSparse('cancelExpiredOrders 주문 취소');
    expect(a.indices).toEqual(b.indices);
    expect(a.values).toEqual(b.values);
  });

  test('repeated tokens accumulate term frequency', () => {
    const { indices, values } = toSparse('refund refund refund');
    // "refund" (>=3) also emits the whole-token form equal to its part → both collapse to same token
    const total = values.reduce((s, v) => s + v, 0);
    // each occurrence contributes once per distinct emitted token; verify the max TF is 3
    expect(Math.max(...values)).toBe(3);
    expect(indices.length).toBe(values.length);
  });
});
