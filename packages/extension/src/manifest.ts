/**
 * Manifest factory for both build targets (feature A-01).
 *
 * One source of truth, two MV3 dialects. The differences are exactly the ones
 * called out in the PRD (§4.1): Chrome hosts the ML worker in an offscreen
 * document and uses the side panel; Firefox runs an event page that can host
 * the worker directly and uses the sidebar.
 */

export type Browser = 'chrome' | 'firefox';

/**
 * The two MV3 dialects do not share one upstream type, so the tail is loose —
 * but the keys every manifest must carry are pinned, so a factory that forgets
 * one fails to compile rather than producing an extension that will not load.
 */
export type Manifest = {
  manifest_version: 3;
  name: string;
  version: string;
} & Record<string, unknown>;

const NAME = 'privacAgent';
const DESCRIPTION =
  'On-device perception and privacy gateway: your browser understands the page, the server never sees your data.';

/**
 * Permissions granted at install time. Deliberately small.
 *
 * Host access is never requested here. `activeTab` covers the tab the user
 * invoked the extension on, and everything else (cross-origin frames, extra
 * tabs for "chat with tabs", sites in a background task's allowlist) is asked
 * for at runtime, per origin, through `optional_host_permissions` (A-05).
 */
// B-05 uses webNavigation for SPA invalidation on engines without Navigation API.
// It does not grant host access; no navigation URLs are stored or relayed.
const CORE_PERMISSIONS = ['storage', 'alarms', 'activeTab', 'scripting', 'webNavigation'] as const;

/**
 * `<all_urls>` is never requested. This pattern only makes per-origin runtime
 * requests possible; each grant is asked for individually with a named site
 * prompt and can be revoked from settings.
 */
const OPTIONAL_HOST_PERMISSIONS = ['*://*/*'] as const;

const SIDEPANEL_PATH = 'src/ui/sidepanel.html';

/**
 * Toolbar and store icons, copied verbatim from `public/` by the build.
 *
 * Without these the extension shows as an anonymous puzzle piece, which makes
 * it unidentifiable in the toolbar and in Chrome's side-panel picker.
 * Regenerate from `public/icons/icon.svg`, kept alongside them:
 *
 *     magick -background none icon.svg -resize 16x16 -depth 8 -strip \
 *       PNG32:icon-16.png
 */
const ICONS = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
} as const;

/**
 * Minimum CSP that permits WebAssembly (C-02).
 *
 * `'wasm-unsafe-eval'` is required for any WASM compilation in MV3 from Chrome
 * 103 onwards. Despite the name it does **not** re-enable JavaScript `eval`; it
 * permits WASM compilation and nothing else. It is also the only relaxation MV3
 * allows — `script-src` accepts just `'self'`, `'none'` and this token — so
 * there is no weaker form and no way to widen it further.
 */
const EXTENSION_PAGES_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';";

/**
 * Cross-origin isolation, which threaded WASM requires (C-02).
 *
 * WASM threads are pthreads over one shared linear memory; that memory is a
 * `SharedArrayBuffer`; and `SharedArrayBuffer` is only available to
 * cross-origin-isolated contexts. Extension pages cannot send HTTP headers, so
 * Chrome exposes the two policies as manifest keys instead.
 *
 * The cost is `require-corp`: every cross-origin subresource loaded by any of
 * our own extension pages must opt in via CORP or CORS. That is acceptable —
 * and arguably desirable — because this extension's UI ships all of its assets
 * locally by policy. It does not affect other extensions, ordinary web pages,
 * or our content scripts, all of which live under their own origins.
 *
 * Chrome only. Firefox extension pages cannot be cross-origin isolated
 * (bugzilla 1673477), so Firefox runs single-threaded WASM.
 */
const CHROME_CROSS_ORIGIN_ISOLATION = {
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
} as const;

// The offscreen document that hosts the ML worker is deliberately absent from
// the manifest: MV3 offscreen documents are created at runtime by URL through
// `chrome.offscreen.createDocument`, not declared. Its path lives with the code
// that opens it (A-04), and the `offscreen` permission below is what gates it.

export function createManifest(browser: Browser, version: string): Manifest {
  const base: Manifest = {
    manifest_version: 3,
    name: NAME,
    version,
    description: DESCRIPTION,
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    action: {
      default_title: NAME,
      default_icon: { ...ICONS },
    },
    icons: { ...ICONS },
    web_accessible_resources: [],
    content_security_policy: {
      extension_pages: EXTENSION_PAGES_CSP,
    },
    // Deliberately EMPTY rather than absent. `scripting.executeScript` does not
    // need files to be web-accessible, and exposing anything at a stable
    // `chrome-extension://<id>/…` URL lets any page fetch it and fingerprint the
    // extension before perception has run.
    //
    // The empty array is load-bearing: omitting the key entirely makes @crxjs
    // inject its own blanket rule exposing `**/*` to `<all_urls>` as soon as the
    // manifest declares icons. That publishes every file in the package to every
    // site AND silently disables cross-origin isolation, which takes threaded
    // WASM down with it. Declaring it empty suppresses that and the key is then
    // dropped from the built manifest.
    //
    // Anything added here later needs `use_dynamic_url: true`.
  };

  if (browser === 'chrome') {
    return {
      ...base,
      permissions: [...CORE_PERMISSIONS, 'offscreen', 'sidePanel'],
      background: {
        service_worker: 'src/background/index.ts',
        type: 'module',
      },
      side_panel: {
        default_path: SIDEPANEL_PATH,
      },
      ...CHROME_CROSS_ORIGIN_ISOLATION,
      minimum_chrome_version: '116',
    };
  }

  return {
    ...base,
    permissions: [...CORE_PERMISSIONS],
    background: {
      // Firefox has no offscreen API; the event page keeps DOM access and can
      // host the ML worker itself.
      scripts: ['src/background/index.ts'],
      type: 'module',
    },
    sidebar_action: {
      default_panel: SIDEPANEL_PATH,
      default_title: NAME,
    },
    browser_specific_settings: {
      gecko: {
        id: 'privacagent@techterrorists.dev',
        // 142 is the first release that understands `data_collection_permissions`.
        strict_min_version: '142.0',
        // Required by AMO. "none" is the honest answer and the whole point of
        // the product: perception and redaction run on the device, and the
        // server only ever receives sanitized, structured text.
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  };
}
