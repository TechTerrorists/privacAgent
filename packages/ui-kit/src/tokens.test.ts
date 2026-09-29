import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(
  fileURLToPath(new URL('./tokens.css', import.meta.url)),
  'utf8'
).replace(/\r\n/g, '\n');

function blockFor(selector: string): string {
  const start = tokens.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = tokens.indexOf('}', start);
  return tokens.slice(start, end);
}

const REQUIRED_TOKENS = [
  '--pa-canvas',
  '--pa-surface',
  '--pa-elevated',
  '--pa-border',
  '--pa-text',
  '--pa-muted',
  '--pa-accent',
  '--pa-on-accent',
  '--pa-danger',
  '--pa-on-danger',
  '--pa-success',
  '--pa-warning',
  '--pa-ring',
] as const;

describe('tokens.css', () => {
  it('defines every documented token for light and dark themes', () => {
    const light = blockFor(":root,\n[data-pa-theme='light']");
    const dark = blockFor("[data-pa-theme='dark'] {");

    for (const token of REQUIRED_TOKENS) {
      expect(light).toContain(`${token}:`);
      expect(dark).toContain(`${token}:`);
    }
  });

  it('gives the two themes different values', () => {
    const light = blockFor(":root,\n[data-pa-theme='light']");
    const dark = blockFor("[data-pa-theme='dark'] {");

    const valueOf = (block: string, token: string): string =>
      block.split(`${token}:`)[1]?.split(';')[0]?.trim() ?? '';

    for (const token of REQUIRED_TOKENS) {
      expect(valueOf(dark, token)).not.toBe('');
      expect(valueOf(dark, token)).not.toBe(valueOf(light, token));
    }
  });

  it('follows the OS colour scheme when no explicit theme is set', () => {
    expect(tokens).toContain('@media (prefers-color-scheme: dark)');
    expect(tokens).toContain(":root:not([data-pa-theme='light'])");
    expect(tokens).toContain('color-scheme: light');
    expect(tokens).toContain('color-scheme: dark');
  });

  it('exposes tokens to Tailwind and honours motion and focus preferences', () => {
    expect(tokens).toContain('@theme inline');
    expect(tokens).toContain('--color-pa-accent: var(--pa-accent)');
    expect(tokens).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tokens).toContain(':focus-visible');
  });

  it('pins its Tailwind sources instead of scanning the consumer project', () => {
    expect(tokens).toContain('source(none)');
    expect(tokens).toContain("@source './components'");
    expect(tokens).not.toContain("@source './preview'");
  });

  it('lets the preview declare its own sources', () => {
    const preview = readFileSync(
      fileURLToPath(new URL('./preview/preview.css', import.meta.url)),
      'utf8'
    );
    expect(preview).toContain("@import '../tokens.css'");
    expect(preview).toContain("@source '.'");
  });
});
