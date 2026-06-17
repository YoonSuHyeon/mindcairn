import { describe, expect, test } from 'bun:test';
import { extractJson } from '../src/llm/claude-cli.ts';

describe('extractJson', () => {
  test('parses a fenced ```json block', () => {
    const text = 'Here you go:\n```json\n{"a": 1, "b": [2, 3]}\n```\nthanks';
    expect(extractJson(text)).toEqual({ a: 1, b: [2, 3] });
  });

  test('parses a bare object without fences', () => {
    const text = 'noise before {"ok": true} noise after';
    expect(extractJson(text)).toEqual({ ok: true });
  });

  test('uses first { and last } for nested objects', () => {
    const text = '{"outer": {"inner": 42}}';
    expect(extractJson(text)).toEqual({ outer: { inner: 42 } });
  });

  test('throws when no JSON object is present', () => {
    expect(() => extractJson('there is no json here')).toThrow();
  });
});
