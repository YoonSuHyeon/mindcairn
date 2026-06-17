import { describe, expect, test } from 'bun:test';
import { tokenize, toSparse } from '../src/builder/bm25.ts';

describe('tokenize', () => {
  test('splits camelCase into parts and keeps the whole identifier', () => {
    const toks = tokenize('cancelExpiredOrders');
    expect(toks).toContain('cancel');
    expect(toks).toContain('expired');
    expect(toks).toContain('orders');
    expect(toks).toContain('cancelexpiredorders'); // whole token preserved (length >= 3)
  });

  test('splits snake_case and ACRONYM boundaries', () => {
    const toks = tokenize('HTTPServer user_id');
    expect(toks).toContain('http');
    expect(toks).toContain('server');
    expect(toks).toContain('user');
    expect(toks).toContain('id');
  });

  test('drops stopwords and sub-2-char tokens', () => {
    // "a" is too short, common english stopwords removed
    const toks = tokenize('a the of');
    expect(toks).not.toContain('a');
  });

  test('keeps Korean tokens of length >= 2', () => {
    const toks = tokenize('주문 취소 가');
    expect(toks).toContain('주문');
    expect(toks).toContain('취소');
    expect(toks).not.toContain('가'); // single char dropped
  });
});

describe('toSparse', () => {
  test('produces aligned indices/values with term frequency', () => {
    const { indices, values } = toSparse('order order cancel');
    expect(indices.length).toBe(values.length);
    // "order" appears twice → one index should carry value 2
    expect(values).toContain(2);
    // all indices are positive 32-bit ints
    expect(indices.every((i) => Number.isInteger(i) && i >= 0)).toBe(true);
  });

  test('empty text yields empty sparse vector', () => {
    const { indices, values } = toSparse('');
    expect(indices).toEqual([]);
    expect(values).toEqual([]);
  });
});
