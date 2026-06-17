import { describe, expect, test } from 'bun:test';
import { parseKotlin } from '../src/builder/kotlin-parser.ts';

// NOTE: no KDoc directly above the class — the regex parser currently drops a class whose header is
// immediately preceded by a `/** */` block (pre-existing limitation, tracked separately). Annotations
// above the class are fine. This sample focuses on the P1-3 dedup behavior.
const SAMPLE = `package com.example.order

import org.springframework.stereotype.Service

@Service
class OrderService(
    private val repo: OrderRepository,
) {
    suspend fun cancelOrder(id: Long): Boolean {
        return repo.cancel(id)
    }

    fun listOpen(): List<Order> {
        return repo.findOpen()
    }
}

enum class OrderStatus {
    OPEN,
    CANCELLED,
}

fun topLevelHelper(x: Int): Int {
    return x * 2
}
`;

describe('parseKotlin', () => {
  const parsed = parseKotlin(SAMPLE);

  test('extracts package and imports', () => {
    expect(parsed.pkg).toBe('com.example.order');
    expect(parsed.imports).toContain('org.springframework.stereotype.Service');
  });

  test('parses the class with its member functions', () => {
    const svc = parsed.classes.find((c) => c.name === 'OrderService');
    expect(svc).toBeDefined();
    const methodNames = svc!.methods.map((m) => m.name);
    expect(methodNames).toContain('cancelOrder');
    expect(methodNames).toContain('listOpen');
  });

  test('detects suspend modifier on member functions', () => {
    const svc = parsed.classes.find((c) => c.name === 'OrderService')!;
    const cancel = svc.methods.find((m) => m.name === 'cancelOrder')!;
    expect(cancel.isSuspend).toBe(true);
  });

  test('parses enum entries', () => {
    const status = parsed.classes.find((c) => c.name === 'OrderStatus');
    expect(status?.kind).toBe('enum');
    expect(status?.enumEntries?.map((e) => e.name)).toEqual(['OPEN', 'CANCELLED']);
  });

  test('top-level funs do NOT include class member funs (dedup — P1-3)', () => {
    const topNames = parsed.topLevelFunctions.map((f) => f.name);
    expect(topNames).toContain('topLevelHelper');
    expect(topNames).not.toContain('cancelOrder');
    expect(topNames).not.toContain('listOpen');
  });
});
