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
const CORE_PERMISSIONS = ['storage', 'alarms', 'activeTab', 'scripting'] as const;

/**
 * `<all_urls>` is never requested. This pattern only makes per-origin runtime
 * requests possible; each grant is asked for individually with a named site
 * prompt and can be revoked from settings.
 */
const OPTIONAL_HOST_PERMISSIONS = ['*://*/*'] as const;

const SIDEPANEL_PATH = 'src/ui/sidepanel.html';

export function createManifest(browser: Browser, version: string): Manifest {
  const base: Manifest = {
    manifest_version: 3,
    name: NAME,
    version,
    description: DESCRIPTION,
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    action: {
      default_title: NAME,
    },
    // Deliberately no `web_accessible_resources`. `scripting.executeScript`
    // does not need the file to be web-accessible, and exposing anything at a
    // stable `chrome-extension://<id>/…` URL lets any page fetch it and
    // fingerprint the extension before perception has run — which would defeat
    // the point of a product whose premise is that visiting a site reveals
    // nothing. Anything added here later needs `use_dynamic_url: true`.
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
