import { describe, expect, test } from 'bun:test';
import { parseKotlin } from '../src/builder/kotlin-parser.ts';

// KDoc placed directly above a declaration (no blank line) must be parsed and captured as that
// declaration's doc — see the dedicated "KDoc directly above ..." suite below. This sample focuses
// on the P1-3 dedup behavior; annotations above the class are also covered.
const SAMPLE = `package com.example.order

import org.springframework.stereotype.Service

/** Handles the lifecycle of customer orders. */
@Service
class OrderService(
    private val repo: OrderRepository,
) {
    /** Cancels an order. */
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

  test('captures the KDoc directly above the class as its doc', () => {
    const svc = parsed.classes.find((c) => c.name === 'OrderService')!;
    expect(svc.kdoc).toBe('Handles the lifecycle of customer orders.');
  });

  test('captures the KDoc directly above a member fun as its doc', () => {
    const svc = parsed.classes.find((c) => c.name === 'OrderService')!;
    const cancel = svc.methods.find((m) => m.name === 'cancelOrder')!;
    expect(cancel.kdoc).toBe('Cancels an order.');
  });
});

// Regression coverage for issue #1: a declaration immediately preceded (no blank line) by a KDoc
// block used to be silently dropped during parsing. These golden cases pin the fixed behavior.
describe('parseKotlin — KDoc directly above a declaration (issue #1)', () => {
  test('class with a leading KDoc (no blank line) is parsed and its kdoc is set', () => {
    const src = `package com.example

/** A foo. */
class Foo {
    fun bar(): Int = 1
}
`;
    const parsed = parseKotlin(src);
    const foo = parsed.classes.find((c) => c.name === 'Foo');
    expect(foo).toBeDefined();
    expect(foo!.kdoc).toBe('A foo.');
  });

  test('top-level fun with a leading KDoc (no blank line) is extracted with suspend/returnType intact', () => {
    const src = `package com.example

/** Cancels an order. */
suspend fun cancelOrder(id: Long): Boolean {
    return true
}
`;
    const parsed = parseKotlin(src);
    const fn = parsed.topLevelFunctions.find((f) => f.name === 'cancelOrder');
    expect(fn).toBeDefined();
    expect(fn!.kdoc).toBe('Cancels an order.');
    expect(fn!.isSuspend).toBe(true);
    expect(fn!.returnType).toBe('Boolean');
  });

  test('member fun with a leading KDoc (no blank line) is extracted with suspend/returnType intact', () => {
    const src = `package com.example

class Service {
    /** Loads a value. */
    suspend fun load(id: Long): String {
        return ""
    }
}
`;
    const parsed = parseKotlin(src);
    const svc = parsed.classes.find((c) => c.name === 'Service')!;
    const load = svc.methods.find((m) => m.name === 'load');
    expect(load).toBeDefined();
    expect(load!.kdoc).toBe('Loads a value.');
    expect(load!.isSuspend).toBe(true);
    expect(load!.returnType).toBe('String');
  });

  test('annotation + KDoc together: both are preserved', () => {
    const src = `package com.example

/** A service. */
@Service
class OrderService {
    /** Does work. */
    @Transactional
    fun work(): Unit {
    }
}
`;
    const parsed = parseKotlin(src);
    const svc = parsed.classes.find((c) => c.name === 'OrderService')!;
    expect(svc.kdoc).toBe('A service.');
    expect(svc.annotations.map((a) => a.name)).toContain('@Service');

    const work = svc.methods.find((m) => m.name === 'work')!;
    expect(work.kdoc).toBe('Does work.');
    expect(work.annotations.map((a) => a.name)).toContain('@Transactional');
  });

  test('KDoc with a blank line before the declaration still works (no regression)', () => {
    const src = `package com.example

/** doc */

class Foo {
}
`;
    const parsed = parseKotlin(src);
    const foo = parsed.classes.find((c) => c.name === 'Foo');
    expect(foo).toBeDefined();
    expect(foo!.kdoc).toBe('doc');
  });
});
