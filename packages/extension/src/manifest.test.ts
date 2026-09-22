import { describe, expect, it } from 'vitest';
import { createManifest } from './manifest.js';

const VERSION = '0.0.0';

describe('createManifest', () => {
  it('builds MV3 for both targets', () => {
    for (const target of ['chrome', 'firefox'] as const) {
      expect(createManifest(target, VERSION).manifest_version).toBe(3);
    }
  });

  it('gives Chrome an offscreen-capable service worker and a side panel', () => {
    const manifest = createManifest('chrome', VERSION);

    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.background).toMatchObject({ type: 'module' });
    expect(manifest.background).toHaveProperty('service_worker');
    expect(manifest.side_panel).toBeDefined();
    expect(manifest.sidebar_action).toBeUndefined();
  });

  it('gives Firefox an event page and a sidebar, with a gecko id for AMO', () => {
    const manifest = createManifest('firefox', VERSION);

    expect(manifest.background).toHaveProperty('scripts');
    expect(manifest.background).not.toHaveProperty('service_worker');
    expect(manifest.sidebar_action).toBeDefined();
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.browser_specific_settings).toMatchObject({
      gecko: {
        id: expect.any(String),
        // AMO requires an explicit declaration; ours must stay "none".
        data_collection_permissions: { required: ['none'] },
      },
    });
    // Firefox has no offscreen API; the event page hosts the worker itself.
    expect(manifest.permissions).not.toContain('offscreen');
  });

  it('never requests host permissions at install time', () => {
    for (const target of ['chrome', 'firefox'] as const) {
      const manifest = createManifest(target, VERSION);
      const permissions = manifest.permissions as string[];

      expect(manifest).not.toHaveProperty('host_permissions');
      expect(permissions.some((p) => p.includes('://'))).toBe(false);
      expect(permissions).not.toContain('<all_urls>');
    }
  });

  it('never declares <all_urls> even as an optional permission', () => {
    for (const target of ['chrome', 'firefox'] as const) {
      const optional = createManifest(target, VERSION).optional_host_permissions as string[];
      expect(optional).not.toContain('<all_urls>');
    }
  });

  it('does not statically inject a content script', () => {
    // Perception must be idle until invoked, so injection happens on demand
    // under activeTab rather than through a manifest content_scripts entry.
    for (const target of ['chrome', 'firefox'] as const) {
      expect(createManifest(target, VERSION)).not.toHaveProperty('content_scripts');
    }
  });

  it('carries the version it was given', () => {
    expect(createManifest('chrome', '1.2.3').version).toBe('1.2.3');
  });
});
