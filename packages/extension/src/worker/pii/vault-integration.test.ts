import { describe, expect, it } from 'vitest';

import { createLayeredPiiEngine } from './layered.js';
import { createManualClock, createVault } from '../vault/index.js';
import type { UseBinding, VaultScopeId } from '../vault/index.js';

const SCOPE = 's1' as VaultScopeId;

function binding(overrides: Partial<UseBinding> = {}): UseBinding {
  return {
    taskId: 'task-1' as never,
    origin: 'https://example.test',
    docId: 'doc-1' as never,
    allowedTargets: [],
    operations: ['type'],
    ...overrides,
  };
}

describe('D-05 real worker round trip: layered engine + real D-04 vault', () => {
  it('mints the same placeholder for the same value across two different elements in one scope', async () => {
    const vault = createVault({ clock: createManualClock() });
    vault.createScope({ scopeId: SCOPE, taskId: 'task-1' as never, ownerTabId: 1 as never });
    const engine = createLayeredPiiEngine();

    const first = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-REPEAT@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
      vaultContext: {
        vault,
        scopeId: SCOPE,
        binding: binding({ allowedTargets: ['e1' as never] }),
      },
    });
    const second = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-REPEAT@example.test',
      location: { kind: 'element_field', elementId: 'e2', field: 'value' },
      vaultContext: {
        vault,
        scopeId: SCOPE,
        binding: binding({ allowedTargets: ['e2' as never] }),
      },
    });

    expect(first.value).toBe(second.value);
    expect(first.value).toMatch(/^\{\{EMAIL_\d+\}\}$/);
    expect(vault.entryCount(SCOPE)).toBe(1);
    expect(JSON.stringify([first, second])).not.toContain('CANARY-REPEAT');
  });

  it('mints distinct placeholders for distinct classes found in one free-text field', async () => {
    const vault = createVault({ clock: createManualClock() });
    vault.createScope({ scopeId: SCOPE, taskId: 'task-1' as never, ownerTabId: 1 as never });
    const engine = createLayeredPiiEngine();

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'reach me at CANARY-MULTI@example.test or +919876543210',
      location: { kind: 'text_context_entry', index: 0 },
      vaultContext: { vault, scopeId: SCOPE, binding: binding() },
    });

    expect(result.outcome).toBe('redacted');
    expect(result.piiClass).toBe('other');
    expect(result.value).toMatch(/\{\{EMAIL_\d+\}\}/);
    expect(result.value).toMatch(/\{\{PHONE_\d+\}\}/);
    expect(result.value).not.toContain('CANARY-MULTI');
    expect(result.value).not.toContain('9876543210');
    expect(vault.entryCount(SCOPE)).toBe(2);
  });

  it('falls back to withholding the span when the vault scope is missing (explicit detector-error handling)', async () => {
    const vault = createVault({ clock: createManualClock() });
    const engine = createLayeredPiiEngine();

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-NOSPACE@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
      vaultContext: { vault, scopeId: SCOPE, binding: binding() },
    });

    expect(result.outcome).toBe('withheld');
    expect(result.value).toBe('{{TEXT_WITHHELD}}');
    expect(result.finding?.decision).toBe('withhold');
  });

  it('never mints a resolvable placeholder for a password field even with a live vault', async () => {
    const vault = createVault({ clock: createManualClock() });
    vault.createScope({ scopeId: SCOPE, taskId: 'task-1' as never, ownerTabId: 1 as never });
    const engine = createLayeredPiiEngine();

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-SECRET-VALUE',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
      hints: { inputType: 'password' },
      vaultContext: { vault, scopeId: SCOPE, binding: binding() },
    });

    expect(result.value).toBe('{{SECRET}}');
    expect(vault.entryCount(SCOPE)).toBe(0);
  });

  it('keeps a redacted text_context entry (placeholder-substituted) instead of dropping it, via redactTextContext', async () => {
    const vault = createVault({ clock: createManualClock() });
    vault.createScope({ scopeId: SCOPE, taskId: 'task-1' as never, ownerTabId: 1 as never });
    const engine = createLayeredPiiEngine();

    const result = await engine.redactTextContext(
      ['Sign in to continue', 'Email us at CANARY-CTX@example.test for help'],
      'd1' as never
    );

    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatch(/\{\{EMAIL_\d+\}\}/);
    expect(result.values.join(' ')).not.toContain('CANARY-CTX');
    expect(result.withheldCount).toBe(1);
  });

  it('is safe against a page-supplied literal placeholder string — never treated as an authorized secret', async () => {
    const vault = createVault({ clock: createManualClock() });
    vault.createScope({ scopeId: SCOPE, taskId: 'task-1' as never, ownerTabId: 1 as never });
    const engine = createLayeredPiiEngine();

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'my code is {{SECRET}} literally',
      location: { kind: 'text_context_entry', index: 0 },
      vaultContext: { vault, scopeId: SCOPE, binding: binding() },
    });

    expect(result.outcome).toBe('withheld');
    expect(result.value).toBe('{{TEXT_WITHHELD}}');
    expect(vault.entryCount(SCOPE)).toBe(0);
  });

  it('handles already-redacted input (idempotent re-scan) without leaking or fabricating a new binding', async () => {
    const vault = createVault({ clock: createManualClock() });
    vault.createScope({ scopeId: SCOPE, taskId: 'task-1' as never, ownerTabId: 1 as never });
    const engine = createLayeredPiiEngine();

    const already = await engine.scanText({
      evidence: 'dom_text',
      text: '{{EMAIL_1}}',
      location: { kind: 'text_context_entry', index: 0 },
      vaultContext: { vault, scopeId: SCOPE, binding: binding() },
    });

    expect(already.outcome).toBe('withheld');
    expect(already.value).toBe('{{TEXT_WITHHELD}}');
    expect(vault.entryCount(SCOPE)).toBe(0);
  });
});
