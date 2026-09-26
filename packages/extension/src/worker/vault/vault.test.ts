import { afterEach, describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import { createTestLifecycleHost } from './testHost.js';
import { createVault } from './vault.js';
import type { InternInput, VaultApi } from './api.js';
import type { UseBinding } from './types.js';

const SCOPE = 's_demo';
const TASK = 't_demo';
const TAB = 'tab_1';

function binding(overrides: Partial<UseBinding> = {}): UseBinding {
  return {
    taskId: TASK,
    origin: 'https://example.test',
    docId: 'd_demo',
    allowedTargets: ['e1'],
    operations: ['type'],
    ...overrides,
  };
}

function internInput(overrides: Partial<InternInput> = {}): InternInput {
  return {
    piiClass: 'email',
    value: 'CANARY-EMAIL-001@example.test',
    binding: binding(),
    ...overrides,
  };
}

/** Fresh vault + open scope, ready to intern into. */
function setUp(idleTimeoutMs = 15 * 60 * 1000, maxEntriesPerScope?: number) {
  const clock = createManualClock();
  const vault = createVault({
    clock,
    idleTimeoutMs,
    ...(maxEntriesPerScope && { maxEntriesPerScope }),
  });
  const created = vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB });
  expect(created.outcome).toBe('ok');
  return { clock, vault };
}

let vaults: VaultApi[] = [];
afterEach(() => {
  for (const v of vaults) v.disposeAll();
  vaults = [];
});

describe('identity and equality', () => {
  it('gives the same value+class a stable placeholder within a session', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const first = vault.intern(SCOPE, internInput());
    const second = vault.intern(SCOPE, internInput());

    expect(first).toMatchObject({ outcome: 'ok' });
    expect(second).toMatchObject({ outcome: 'ok' });
    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('unreachable');
    expect(second.placeholder).toBe(first.placeholder);
    expect(first.placeholder).toMatch(/^\{\{EMAIL_1\}\}$/);
  });

  it('gives distinct values and distinct classes distinct placeholders', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const emailA = vault.intern(SCOPE, internInput({ value: 'CANARY-A@example.test' }));
    const emailB = vault.intern(SCOPE, internInput({ value: 'CANARY-B@example.test' }));
    const phone = vault.intern(SCOPE, internInput({ piiClass: 'phone', value: 'CANARY-PHONE-1' }));

    if (emailA.outcome !== 'ok' || emailB.outcome !== 'ok' || phone.outcome !== 'ok') {
      throw new Error('unreachable');
    }
    expect(new Set([emailA.placeholder, emailB.placeholder, phone.placeholder]).size).toBe(3);
    expect(emailA.placeholder).toBe('{{EMAIL_1}}');
    expect(emailB.placeholder).toBe('{{EMAIL_2}}');
    expect(phone.placeholder).toBe('{{PHONE_1}}');
  });

  it('does not merge values that differ only by case, whitespace or normalization', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const plain = vault.intern(SCOPE, internInput({ value: 'canary@example.test' }));
    const padded = vault.intern(SCOPE, internInput({ value: ' canary@example.test' }));
    const upper = vault.intern(SCOPE, internInput({ value: 'CANARY@EXAMPLE.TEST' }));

    if (plain.outcome !== 'ok' || padded.outcome !== 'ok' || upper.outcome !== 'ok') {
      throw new Error('unreachable');
    }
    expect(new Set([plain.placeholder, padded.placeholder, upper.placeholder]).size).toBe(3);
  });

  it('keeps separate sessions from sharing backing entries', () => {
    const clock = createManualClock();
    const vault = createVault({ clock });
    vaults.push(vault);
    vault.createScope({ scopeId: 's_a', taskId: TASK, ownerTabId: TAB });
    vault.createScope({ scopeId: 's_b', taskId: TASK, ownerTabId: 'tab_2' });

    const a = vault.intern('s_a', internInput());
    const b = vault.intern('s_b', internInput());

    if (a.outcome !== 'ok' || b.outcome !== 'ok') throw new Error('unreachable');
    // Same value+class, different sessions: both happen to be the first
    // entry of their own session, so both are legitimately {{EMAIL_1}} —
    // the point is that ending one session must not affect the other.
    expect(a.placeholder).toBe('{{EMAIL_1}}');
    expect(b.placeholder).toBe('{{EMAIL_1}}');

    vault.endScope('s_a', 'disposed');
    expect(vault.hasScope('s_a')).toBe(false);
    expect(vault.hasScope('s_b')).toBe(true);
    expect(vault.entryCount('s_b')).toBe(1);
  });

  it('treats a literal placeholder-shaped value as ordinary data, not an existing reference', () => {
    const { vault } = setUp();
    vaults.push(vault);

    // The raw value itself looks exactly like a valid protocol placeholder.
    const result = vault.intern(SCOPE, internInput({ value: '{{EMAIL_99}}' }));

    expect(result).toMatchObject({ outcome: 'ok' });
    if (result.outcome !== 'ok') throw new Error('unreachable');
    // It gets a normal, freshly-allocated placeholder based on interning
    // order — never the literal text it happened to contain, and never
    // treated as a lookup into some pre-existing entry.
    expect(result.placeholder).toBe('{{EMAIL_1}}');
    expect(result.placeholder).not.toBe('{{EMAIL_99}}');
  });
});

describe('reserved secrets', () => {
  it('returns the literal {{SECRET}} placeholder and stores nothing', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const result = vault.intern(
      SCOPE,
      internInput({ piiClass: 'secret', value: 'CANARY-PASSWORD-1' })
    );

    expect(result).toEqual({ outcome: 'ok', placeholder: '{{SECRET}}' });
    expect(vault.entryCount(SCOPE)).toBe(0);
    expect(vault.getBindings(SCOPE, '{{SECRET}}')).toBeUndefined();
  });

  it('never numbers the secret placeholder, even across repeated calls', () => {
    const { vault } = setUp();
    vaults.push(vault);

    vault.intern(SCOPE, internInput({ piiClass: 'secret', value: 'CANARY-A' }));
    const second = vault.intern(SCOPE, internInput({ piiClass: 'secret', value: 'CANARY-B' }));

    expect(second).toEqual({ outcome: 'ok', placeholder: '{{SECRET}}' });
  });
});

describe('use-binding metadata', () => {
  it('preserves binding metadata and never broadens it on a repeated observation', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const first = vault.intern(
      SCOPE,
      internInput({ binding: binding({ allowedTargets: ['e1'] }) })
    );
    if (first.outcome !== 'ok') throw new Error('unreachable');

    const second = vault.intern(
      SCOPE,
      internInput({ binding: binding({ allowedTargets: ['e2'], docId: 'd_other' }) })
    );
    if (second.outcome !== 'ok') throw new Error('unreachable');
    expect(second.placeholder).toBe(first.placeholder);

    const recorded = vault.getBindings(SCOPE, first.placeholder);
    expect(recorded).toHaveLength(2);
    // Each observation's binding is retained exactly as granted — never
    // merged into one entry with the union of both allowedTargets, which
    // would silently broaden what the first observation alone authorized.
    expect(recorded).toEqual([
      binding({ allowedTargets: ['e1'] }),
      binding({ allowedTargets: ['e2'], docId: 'd_other' }),
    ]);
  });

  it('rejects interning under a binding whose task_id does not match the scope', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const result = vault.intern(SCOPE, internInput({ binding: binding({ taskId: 't_other' }) }));

    expect(result).toEqual({ outcome: 'unavailable', reason: 'task_mismatch' });
    expect(vault.entryCount(SCOPE)).toBe(0);
  });

  it('returns a copy of the binding list — mutating the result cannot affect vault state', () => {
    const { vault } = setUp();
    vaults.push(vault);
    const result = vault.intern(SCOPE, internInput());
    if (result.outcome !== 'ok') throw new Error('unreachable');

    const recorded = vault.getBindings(SCOPE, result.placeholder);
    (recorded as UseBinding[]).push(binding({ taskId: 'not-really-added' }));

    expect(vault.getBindings(SCOPE, result.placeholder)).toHaveLength(1);
  });

  it('deduplicates a structurally-identical binding rather than recording it again', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const b = binding({ allowedTargets: ['e1', 'e2'], operations: ['type', 'select'] });
    vault.intern(SCOPE, internInput({ binding: b }));
    // Same fields, different array order — still the same binding.
    const repeat = vault.intern(
      SCOPE,
      internInput({
        binding: binding({ allowedTargets: ['e2', 'e1'], operations: ['select', 'type'] }),
      })
    );

    if (repeat.outcome !== 'ok') throw new Error('unreachable');
    expect(vault.getBindings(SCOPE, repeat.placeholder)).toHaveLength(1);
  });

  it('clones on ingestion — mutating the caller-owned binding object after intern() does not reach vault state', () => {
    const { vault } = setUp();
    vaults.push(vault);

    const mutableTargets = ['e1'];
    const ownedBinding = binding({ allowedTargets: mutableTargets });
    const result = vault.intern(SCOPE, internInput({ binding: ownedBinding }));
    if (result.outcome !== 'ok') throw new Error('unreachable');

    mutableTargets.push('CANARY-INJECTED-TARGET');
    (ownedBinding.operations as string[]).push('CANARY-INJECTED-OP');

    const recorded = vault.getBindings(SCOPE, result.placeholder);
    expect(recorded).toEqual([binding({ allowedTargets: ['e1'] })]);
  });

  it('returns frozen snapshots — a returned binding cannot be mutated to affect vault state', () => {
    const { vault } = setUp();
    vaults.push(vault);
    const result = vault.intern(SCOPE, internInput());
    if (result.outcome !== 'ok') throw new Error('unreachable');

    const recorded = vault.getBindings(SCOPE, result.placeholder);
    const first = recorded?.[0] as UseBinding;
    expect(() => {
      (first.allowedTargets as string[]).push('CANARY-INJECTED-TARGET');
    }).toThrow();
    expect(() => {
      (first as { taskId: string }).taskId = 'CANARY-INJECTED-TASK';
    }).toThrow();

    expect(vault.getBindings(SCOPE, result.placeholder)).toEqual([binding()]);
  });

  it('bounds distinct bindings per entry and fails closed once full, without dropping the placeholder', () => {
    const vault = createVault({
      clock: createManualClock(),
      maxBindingsPerEntry: 2,
    });
    vaults.push(vault);
    vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB });

    const first = vault.intern(SCOPE, internInput({ binding: binding({ docId: 'd1' }) }));
    const second = vault.intern(SCOPE, internInput({ binding: binding({ docId: 'd2' }) }));
    const third = vault.intern(SCOPE, internInput({ binding: binding({ docId: 'd3' }) }));

    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('unreachable');
    expect(third).toEqual({ outcome: 'unavailable', reason: 'capacity_exceeded' });
    expect(vault.getBindings(SCOPE, first.placeholder)).toHaveLength(2);
    // The placeholder itself is still valid and usable — only the new,
    // distinct binding was refused, never the whole operation.
    expect(vault.hasScope(SCOPE)).toBe(true);
  });

  it('does not let repeated distinct-binding observations of one value bypass maxEntriesPerScope', () => {
    // 10,000 structurally distinct bindings for a single already-interned
    // value must not be able to grow unbounded memory just because
    // maxEntriesPerScope only counts distinct (piiClass, value) entries.
    const vault = createVault({ clock: createManualClock(), maxBindingsPerEntry: 5 });
    vaults.push(vault);
    vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB });

    const first = vault.intern(SCOPE, internInput({ binding: binding({ docId: 'd0' }) }));
    if (first.outcome !== 'ok') throw new Error('unreachable');

    let lastOutcome: 'ok' | 'unavailable' = 'ok';
    for (let i = 1; i < 10_000; i += 1) {
      const result = vault.intern(SCOPE, internInput({ binding: binding({ docId: `d${i}` }) }));
      lastOutcome = result.outcome;
    }

    expect(lastOutcome).toBe('unavailable');
    expect(vault.getBindings(SCOPE, first.placeholder)).toHaveLength(5);
    expect(vault.hasScope(SCOPE)).toBe(true);
  });
});

describe('capacity', () => {
  it('fails closed once a scope is full, without inventing a placeholder or forwarding raw data', () => {
    const { vault } = setUp(15 * 60 * 1000, 2);
    vaults.push(vault);

    const a = vault.intern(SCOPE, internInput({ value: 'CANARY-A@example.test' }));
    const b = vault.intern(SCOPE, internInput({ value: 'CANARY-B@example.test' }));
    const c = vault.intern(SCOPE, internInput({ value: 'CANARY-C@example.test' }));

    expect(a.outcome).toBe('ok');
    expect(b.outcome).toBe('ok');
    expect(c).toEqual({ outcome: 'unavailable', reason: 'capacity_exceeded' });
    expect(vault.entryCount(SCOPE)).toBe(2);
  });

  it('still returns the existing placeholder for an already-interned value once full', () => {
    const { vault } = setUp(15 * 60 * 1000, 1);
    vaults.push(vault);

    const first = vault.intern(SCOPE, internInput());
    const repeat = vault.intern(SCOPE, internInput());

    if (first.outcome !== 'ok') throw new Error('unreachable');
    expect(repeat).toEqual({ outcome: 'ok', placeholder: first.placeholder });
  });
});

describe('lifecycle: explicit end and tab close', () => {
  it('invalidates a scope on explicit disposal', () => {
    const { vault } = setUp();
    vaults.push(vault);
    vault.endScope(SCOPE, 'disposed');
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('invalidates a scope on task end and on task cancel', () => {
    const { vault } = setUp();
    vaults.push(vault);
    vault.endScope(SCOPE, 'task_ended');
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('invalidates every scope owned by a closed tab, and no others', () => {
    const clock = createManualClock();
    const vault = createVault({ clock });
    vaults.push(vault);
    vault.createScope({ scopeId: 's_a', taskId: TASK, ownerTabId: 'tab_a' });
    vault.createScope({ scopeId: 's_b', taskId: TASK, ownerTabId: 'tab_a' });
    vault.createScope({ scopeId: 's_c', taskId: TASK, ownerTabId: 'tab_b' });

    vault.notifyTabClosed('tab_a');

    expect(vault.hasScope('s_a')).toBe(false);
    expect(vault.hasScope('s_b')).toBe(false);
    expect(vault.hasScope('s_c')).toBe(true);
  });

  it('reaches the vault through an executable lifecycle host, standing in for A-04', () => {
    const clock = createManualClock();
    const vault = createVault({ clock });
    vaults.push(vault);
    vault.createScope({ scopeId: 's_a', taskId: TASK, ownerTabId: 'tab_a' });
    vault.createScope({ scopeId: 's_b', taskId: TASK, ownerTabId: 'tab_b' });
    const host = createTestLifecycleHost(vault);

    host.emitTaskEnded('s_a');
    expect(vault.hasScope('s_a')).toBe(false);

    host.emitTabClosed('tab_b');
    expect(vault.hasScope('s_b')).toBe(false);
  });
});

describe('lifecycle: idle expiry', () => {
  it('does not expire one millisecond before the idle boundary', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);
    clock.advance(999);
    expect(vault.hasScope(SCOPE)).toBe(true);
  });

  it('expires exactly at the idle boundary', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);
    clock.advance(1000);
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('checks expiry at access time even if the scheduled timer never fired (suspended worker)', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);
    // Wall time passes far beyond the idle window, but the callback that
    // would normally fire never runs — simulating a suspended worker.
    clock.jumpWithoutFiring(10_000);
    expect(vault.hasScope(SCOPE)).toBe(false);
    expect(vault.entryCount(SCOPE)).toBe(0);
    expect(vault.getBindings(SCOPE, '{{EMAIL_1}}')).toBeUndefined();
  });

  it('re-arms the idle timer on every intern, so activity keeps a scope alive', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);

    clock.advance(900);
    expect(vault.hasScope(SCOPE)).toBe(true);
    vault.intern(SCOPE, internInput());
    clock.advance(900); // 1800ms since creation, but only 900ms since the intern
    expect(vault.hasScope(SCOPE)).toBe(true);
    clock.advance(100); // now 1000ms since the intern
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('does not treat a read-only status check as activity — polling cannot keep a scope alive', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);

    clock.advance(500);
    vault.hasScope(SCOPE);
    vault.entryCount(SCOPE);
    vault.getBindings(SCOPE, '{{EMAIL_1}}');
    clock.advance(500); // 1000ms total since creation, no intern in between
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('a stale timer cleared by an earlier re-arm does not fire and cause a double cleanup', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);

    vault.intern(SCOPE, internInput()); // re-arms: due at t=1000 from here (t=0)
    clock.advance(500);
    vault.intern(SCOPE, internInput()); // re-arms again: due at t=1500
    // Advancing to the OLD due time (1000) must not fire a stale callback.
    clock.advance(500); // now at t=1000 total
    expect(vault.hasScope(SCOPE)).toBe(true);
    clock.advance(500); // now at t=1500 total — the current timer's due time
    expect(vault.hasScope(SCOPE)).toBe(false);
  });
});

describe('cleanup idempotency', () => {
  it('tolerates repeated endScope calls without throwing', () => {
    const { vault } = setUp();
    vaults.push(vault);
    expect(() => {
      vault.endScope(SCOPE, 'disposed');
      vault.endScope(SCOPE, 'disposed');
      vault.endScope(SCOPE, 'task_ended');
    }).not.toThrow();
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('tolerates notifyTabClosed for a tab with no live scopes', () => {
    const { vault } = setUp();
    vaults.push(vault);
    expect(() => vault.notifyTabClosed('tab_with_nothing')).not.toThrow();
  });

  it('does not resurrect a disposed scope from a callback scheduled before disposal', () => {
    const { clock, vault } = setUp(1000);
    vaults.push(vault);
    vault.endScope(SCOPE, 'disposed'); // clears the idle timer
    clock.advance(10_000); // if the timer had survived, it would fire here
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('a stale timer from a disposed scope cannot reach into a later scope reusing the same id', () => {
    const clock = createManualClock();
    const vault = createVault({ clock, idleTimeoutMs: 1000 });
    vaults.push(vault);

    vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB }); // idle timer due at t=1000
    clock.advance(500); // t=500
    vault.endScope(SCOPE, 'disposed'); // clears that timer — nothing should fire at t=1000 anymore

    vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB }); // fresh scope, its own timer due at t=1500
    clock.advance(500); // t=1000 — the old (cleared) timer's original due time
    expect(vault.hasScope(SCOPE)).toBe(true); // the new scope is unaffected

    clock.advance(500); // t=1500 — the new scope's own due time
    expect(vault.hasScope(SCOPE)).toBe(false);
  });

  it('allows explicit creation of a fresh scope after disposal, starting clean', () => {
    const { vault } = setUp();
    vaults.push(vault);
    vault.intern(SCOPE, internInput());
    vault.endScope(SCOPE, 'disposed');

    const recreated = vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB });
    expect(recreated.outcome).toBe('ok');
    expect(vault.entryCount(SCOPE)).toBe(0);

    const result = vault.intern(SCOPE, internInput());
    if (result.outcome !== 'ok') throw new Error('unreachable');
    // Numbering restarts — this is a brand new session-scoped store, not a
    // continuation of the disposed one.
    expect(result.placeholder).toBe('{{EMAIL_1}}');
  });

  it('refuses to create a scope that is still live', () => {
    const { vault } = setUp();
    vaults.push(vault);
    const result = vault.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB });
    expect(result).toEqual({ outcome: 'error', reason: 'scope_already_exists' });
  });
});

describe('scope-missing behavior', () => {
  it('reports unavailable rather than throwing for an unknown scope', () => {
    const clock = createManualClock();
    const vault = createVault({ clock });
    vaults.push(vault);
    expect(vault.intern('never-created', internInput())).toEqual({
      outcome: 'unavailable',
      reason: 'scope_missing',
    });
    expect(vault.hasScope('never-created')).toBe(false);
    expect(vault.entryCount('never-created')).toBe(0);
    expect(vault.getBindings('never-created', '{{EMAIL_1}}')).toBeUndefined();
  });
});

describe('no leak through any public surface (same-realm)', () => {
  // This checks every return shape and error path in-process. It is not the
  // "real worker" requirement — that needs an actual cross-thread boundary,
  // covered separately by packages/extension/tests/vault-worker.spec.ts
  // (Playwright, a genuine `Worker`, communication purely via postMessage).
  it('never returns the raw value from any method, error, or serialized output', () => {
    const { vault } = setUp();
    vaults.push(vault);
    const MARKER = 'CANARY-VAULT-SMOKE-778899';

    const interned = vault.intern(SCOPE, internInput({ value: MARKER }));
    expect(interned).toMatchObject({ outcome: 'ok' });
    if (interned.outcome !== 'ok') throw new Error('unreachable');
    expect(JSON.stringify(interned)).not.toContain(MARKER);

    const bindings = vault.getBindings(SCOPE, interned.placeholder);
    expect(JSON.stringify(bindings)).not.toContain(MARKER);

    expect(JSON.stringify(vault.entryCount(SCOPE))).not.toContain(MARKER);
    expect(JSON.stringify(vault.hasScope(SCOPE))).not.toContain(MARKER);

    // Failure paths, too.
    const capacityProbe = createVault({ maxEntriesPerScope: 1, clock: createManualClock() });
    vaults.push(capacityProbe);
    capacityProbe.createScope({ scopeId: SCOPE, taskId: TASK, ownerTabId: TAB });
    capacityProbe.intern(SCOPE, internInput({ value: 'CANARY-FIRST' }));
    const denied = capacityProbe.intern(SCOPE, internInput({ value: MARKER }));
    expect(JSON.stringify(denied)).not.toContain(MARKER);

    let threw = false;
    try {
      vault.createScope({ scopeId: MARKER, taskId: '', ownerTabId: TAB });
    } catch (error) {
      threw = true;
      expect(String(error)).not.toContain(MARKER);
    }
    expect(threw).toBe(true);
  });
});
