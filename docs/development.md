# Development environment setup

This guide takes a fresh machine from tool installation to building and checking the
current A-01 extension scaffold, E-01 shared protocol, and E-02 Agent API service. Run
commands from the repository root unless a step says otherwise.

## 1. Install the tools

| Tool    | Version to use                 | Purpose                                                 |
| ------- | ------------------------------ | ------------------------------------------------------- |
| Git     | Current stable                 | Clone the repository and work on issue branches         |
| Node.js | Current 22.x, at least 22.13.0 | Match CI and satisfy the locked JavaScript tooling      |
| pnpm    | 12.3.4                         | Version pinned in the root `package.json`               |
| uv      | 0.12.17                        | Version used in CI; manages Python and its dependencies |
| Python  | 3.12                           | Install through uv; matches CI                          |
| Chrome  | Current stable, at least 116   | Load and test the Chrome extension                      |
| Firefox | Current stable, at least 142   | Load and test the Firefox extension                     |

Install [Git](https://git-scm.com/downloads) and
[Node.js 22](https://nodejs.org/en/download/archive/v22). Although the root `engines` field
says Node `>=22`, the locked ESLint version requires at least **22.13.0** on the Node 22
line. Use a current 22.x release to avoid this mismatch.

The commands below use the official [pnpm installer](https://pnpm.io/installation) with
[its version pin](https://github.com/pnpm/get.pnpm.io/blob/main/README.md) and the
[uv installer](https://docs.astral.sh/uv/getting-started/installation/), pinned to the
versions above.

### Linux or macOS

Run in a shell with `curl` installed:

```sh
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.3.4 sh -
curl -LsSf https://astral.sh/uv/0.12.17/install.sh | sh
```

### Windows PowerShell

```powershell
$env:PNPM_VERSION = '12.3.4'
Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/0.12.17/install.ps1 | iex"
```

Use one environment consistently. If using WSL, install the tools and dependencies
inside WSL; do not share `node_modules` or `.venv` with a Windows checkout. The browser
must be able to access the extension's build directory.

### Verify the tools and install Python

Reopen your terminal after installation so the updated `PATH` takes effect:

```sh
git --version
node --version
pnpm --version
uv --version
uv python install 3.12
```

Use **pnpm** for all JavaScript dependency management and **uv** for all Python dependency
management and virtual environments. Do not create competing npm, Yarn or Poetry lockfiles
or install packages into the system Python environment.

No `.env` file or API keys are needed for any current check. Docker/Redis is required only
for the full `pnpm test` — the E-02 agent-api suite talks to a real Redis, started with
`docker run --name pa-redis -p 6379:6379 -d redis:7-alpine`. CI runs the same suite against
a `redis:7-alpine` service container (see `.github/workflows/ci.yml`). GPU and model
runtime setup are still not needed (E-03+ has not landed).

## 2. Clone and check out your issue branch

```sh
git clone https://github.com/TechTerrorists/privacAgent.git
cd privacAgent
git status --short --branch
```

If repository access requires authentication, configure your GitHub credentials first.
With the optional [GitHub CLI](https://cli.github.com/), use `gh auth login` followed by
`gh auth setup-git`. Do not embed access tokens in clone URLs or tracked files.

Before editing, open or select your assigned issue. In GitHub, use its **Development →
Create a branch** action, then follow the displayed fetch and checkout commands locally.
For an existing issue branch or PR, check out that branch instead. Keep uncommitted work
safe before switching branches.

New scaffolding may still be on a PR branch until it merges. Make sure you have checked
out the branch containing the features you need before following the remaining steps.

## 3. Install dependencies and verify the checkout

```sh
pnpm install --frozen-lockfile
uv sync --locked --python 3.12
pnpm protocol:check
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
pnpm --filter @privacagent/extension lint:firefox
```

The first installation needs network access to download dependencies and, if missing,
Python. `uv sync` creates the root `.venv`; manual activation is unnecessary because
Python commands use `uv run`. `pnpm test` runs both Vitest and pytest, including protocol
round-trip tests between TypeScript and Python; it needs Redis running (the `docker run`
command in step 1).

`pnpm protocol:check` verifies that checked-in generated protocol files match the schemas.
`pnpm build` builds the protocol package and both browser targets. The final command
validates the Firefox extension with `web-ext`, as CI does.

| Output                            | Location                           |
| --------------------------------- | ---------------------------------- |
| Chrome extension                  | `packages/extension/dist/chrome/`  |
| Firefox extension                 | `packages/extension/dist/firefox/` |
| Built TypeScript protocol package | `packages/protocol/dist/`          |
| Python environment                | `.venv/`                           |

These build outputs and the virtual environment are ignored by Git. Generated protocol
source files are checked in; see the protocol workflow below.

## 4. Load the extension in a browser

Start with the builds from step 3. Each browser loads its own output directory.

### Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `packages/extension/dist/chrome` inside your clone.
   Select the directory, not an individual file.
3. Confirm that the **privacAgent** card appears without manifest or loading errors.
4. Copy the extension ID shown on the card. Open the following address in a new tab,
   replacing `EXTENSION_ID` with that ID:

   ```text
   chrome-extension://EXTENSION_ID/src/ui/sidepanel.html
   ```

5. Expect `privacAgent`, `Extension shell is loading.` and `Build target: chrome`.
6. Use the card's **service worker** inspection link to inspect background errors. An
   inactive service worker after idle is normal for MV3.

Opening the URL checks the UI page in a tab. The current scaffold has no toolbar-click
handler to open the docked side panel, so clicking the toolbar icon is not a useful smoke
test yet. See Chrome's [unpacked extension instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select
   `packages/extension/dist/firefox/manifest.json` inside your clone.
3. Confirm that **privacAgent** appears without loading errors.
4. Open the browser's sidebar selector and choose **privacAgent**. In the traditional
   menu layout this is **View → Sidebar → privacAgent**.
5. Expect `privacAgent`, `Extension shell is loading.` and `Build target: firefox`.
6. Use **Inspect** on the temporary add-on entry to inspect extension errors.

Firefox removes temporary add-ons when the browser restarts; load the manifest again
after restarting. See the [temporary installation instructions](https://www.extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

### What this smoke test proves

A-01 provides the manifests, build tooling and placeholder entry points. The text
`Extension shell is loading.` is static placeholder copy; it is not an unfinished network
request. The build-target line confirms that the UI script ran for the selected browser.

E-01 provides schemas, types, validators and fixtures, so it is exercised through the
protocol checks and tests rather than a browser control. E-02 is exercised through
`services/agent-api` tests (session endpoints, Redis TTL, scripted fake planner) rather
than a browser control; the real planner is not wired yet. E-05 is exercised the same way
— `prompt.py` is a pure prompt builder covered by unit tests, a byte-for-byte golden for
the system prefix, and route tests that read the prompt the fake planner receives. Task
input, agent actions,
content-script injection, perception and the privacy pipeline are not wired into this
scaffold yet.

## 5. Daily development commands

| Command                                                | Use                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm build`                                           | Build all packages and both browser targets                                    |
| `pnpm build:chrome`                                    | Build just the Chrome extension                                                |
| `pnpm build:firefox`                                   | Build just the Firefox extension                                               |
| `pnpm dev:chrome`                                      | Start the Chrome development server on port 5173                               |
| `pnpm test`                                            | Run TypeScript and Python tests once                                           |
| `pnpm test:watch`                                      | Watch TypeScript tests only                                                    |
| `uv run --locked pytest`                               | Run Python tests only                                                          |
| `uv run black services/agent-api`                      | Normalize Python formatting (pinned in the workspace dev dependencies)         |
| `uv run black --check services/agent-api`              | Verify Python formatting without changing files                                |
| `pnpm lint`                                            | Run ESLint                                                                     |
| `pnpm typecheck`                                       | Check TypeScript projects                                                      |
| `pnpm format:check`                                    | Check formatting without changing files                                        |
| `pnpm exec prettier --write path/to/file.md`           | Format a file you changed; replace the example path                            |
| `pnpm --filter @privacagent/extension lint:firefox`    | Validate the built Firefox extension                                           |
| `pnpm --filter @privacagent/extension package:firefox` | Package a built Firefox extension into `packages/extension/web-ext-artifacts/` |

For a reliable manual loop, edit the source, run the browser's build command, reload the
extension on its management page, and reopen its UI. Refresh any test page after a
content-script change once content-script injection is implemented.

### Chrome development server

Run `pnpm dev:chrome`, keep the terminal running, and load `packages/extension/dist/chrome`
as described above. CRXJS provides the development output and reload support. Reload the
extension manually after manifest changes or if the browser retains an old context.

Port 5173 is fixed in the Vite configuration. To return to a standalone build, stop the
server with Ctrl+C, run `pnpm build:chrome`, and reload the extension.

### Firefox build watching

For extension testing with automatic rebuilds, run:

```sh
pnpm --filter @privacagent/extension exec vite build --mode firefox --watch
```

After the first build, load the Firefox manifest. After later rebuilds, click **Reload**
on the add-on's `about:debugging` entry and reopen the sidebar. Stop the watcher with
Ctrl+C when finished.

`pnpm dev:firefox` starts Vite's page development server, but the current manifest emitter
runs only during a build. Use `build:firefox` or the watch command above to produce an
installable extension.

Both manifests come from `packages/extension/src/manifest.ts`. Edit that source file and
rebuild; do not edit generated `dist/*/manifest.json` files. Code that injects the content
script should use `__CONTENT_SCRIPT_PATH__` because the two build tools emit different
paths.

After pulling dependency changes, rerun the locked install commands from step 3. Keep
`pnpm-lock.yaml` and `uv.lock` aligned with their manifests when intentionally adding or
updating dependencies.

### Browser tests and benchmark

For B-02 browser tests, first run `pnpm exec playwright install chromium firefox`, then
`pnpm test:browser`. `pnpm bench:dom` reports the synthetic 2,000-node DOM-walker benchmark.
See the [DOM walker guide](../packages/extension/src/content/dom-extract/README.md) for the
API, test scope and benchmark limitations. These commands are separate from `pnpm test`.

## 6. Working on the shared protocol

Read the [protocol package guide](../packages/protocol/README.md) for schema locations,
imports, fixtures and compatibility rules. After intentionally changing schemas or the
generator, regenerate and verify the outputs:

```sh
pnpm protocol:generate
pnpm protocol:check
pnpm typecheck
pnpm test
pnpm format:check
```

Review and commit the generated source changes with their schema changes. Do not fix
generated files by hand. If a consuming package needs the protocol, follow the workspace
dependency and build instructions in the protocol guide.

Protocol validation checks message structure. It does not implement PII detection,
redaction, the Egress Guard or client-side authorization. Raw DOM, screenshots and real
personal data must stay out of outbound messages and test fixtures.

## 7. Before committing and pushing

Run the verification commands from step 3, normalize Python formatting, then inspect your
changes:

```sh
uv run black services/agent-api
git diff --check
git diff
git status --short --branch
```

Python under `services/agent-api` is formatted with `black`, pinned in the workspace dev
dependencies so its output is stable across machines. No CI job checks Python formatting
(the `services/` tree is prettier-ignored), so run it before every push. Scope the command
to `services/agent-api`: `packages/protocol/python` holds generated sources that must not
be reformatted.

Stage only files that belong to your issue. Keep build outputs, virtual environments,
credentials and local debugging data out of commits. Commit and push to the issue branch,
then open a PR against `main` with a closing keyword such as `Closes #12` in its description.
Follow-up pushes to the same branch automatically update the existing PR.

The [CI workflow](../.github/workflows/ci.yml) checks generated protocol drift, formatting
(prettier only — Python is not checked in CI), lint, types, tests, both browser builds and
Firefox extension linting. Merge only after the required checks and reviews pass.

## 8. Troubleshooting

| Symptom                                                                                  | What to check                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm` or `uv` is not found                                                              | Reopen the terminal and check the installer's PATH instructions. Use `command -v pnpm` / `command -v uv` on Linux/macOS, or `Get-Command pnpm` / `Get-Command uv` in PowerShell. |
| Node engine errors                                                                       | Use a current Node 22.x release, at least 22.13.0. Check `node --version` in the same terminal that runs pnpm.                                                                   |
| pnpm version differs from the repository                                                 | Install 12.3.4 and check which executable your terminal resolves. The root `packageManager` field is the source of truth.                                                        |
| A frozen or locked install fails                                                         | Ensure you pulled matching manifests and lockfiles. Preserve the lockfiles; investigate the mismatch before intentionally updating dependencies.                                 |
| pnpm reports a store permission or SQLite error                                          | Check `pnpm store path` and that your user can write there. Use a user-owned store; avoid installing repository dependencies with `sudo`.                                        |
| Python or a Python package is missing                                                    | Run `uv sync --locked --python 3.12`, then use `uv run --locked` for Python commands. Check `uv run --locked python --version`.                                                  |
| agent-api pytest fails with Redis Connection refused / agent-api tests need a real Redis | Check that the `docker run` container from step 1 is running (`docker ps`), port 6379 is reachable, and `PA_TEST_REDIS_URL` (default `redis://127.0.0.1:6379/15`) points at it.  |
| A TypeScript consumer cannot import `@privacagent/protocol`                              | Follow the protocol guide to add its workspace dependency, run `pnpm install`, then `pnpm build` so the package export exists.                                                   |
| Generated protocol drift                                                                 | For intentional schema changes, run `pnpm protocol:generate` and review the resulting diff; otherwise check that your branch has matching schemas and generated sources.         |
| The browser cannot find a manifest                                                       | Run the correct browser build and select its output under `packages/extension/dist/`. Firefox needs the manifest file; Chrome needs the directory.                               |
| Chrome reports a localhost connection failure                                            | Development output needs `pnpm dev:chrome` running. Alternatively stop the server, run `pnpm build:chrome`, and reload the extension.                                            |
| Chrome development port 5173 is occupied                                                 | Stop your other process using that port before starting this project's development server.                                                                                       |
| Firefox rejects the extension version or manifest                                        | Use Firefox 142 or newer and the Firefox build, not the Chrome build.                                                                                                            |
| Toolbar clicks do nothing or the UI says it is loading                                   | The current A-01 UI is a placeholder. Follow the browser smoke test above and look for the build-target line.                                                                    |
| Source changes do not appear                                                             | Rebuild the correct target, reload the extension, and reopen the UI. Confirm the browser loaded the same clone you are editing.                                                  |

When reporting a setup failure, include your OS, tool versions, branch, failing command
and relevant error output. Use synthetic data and remove credentials or page contents
from logs and screenshots.

## Local mock sites (B-08)

Run `pnpm mocks:start` from the repository root and open
[the local fixture index](http://127.0.0.1:4173/). The profile, settings, and
search/filter pages use synthetic data and work without the extension, Redis,
models, or the API server. Each page has a full reset control.

Run `pnpm test:mocks` for Chromium/Firefox fixture and real DOM-walker smoke
tests, or `pnpm test:browser` for those plus the existing B-02 suite. Playwright
starts and stops its own server, so stop a manual server first or select another
port with `MOCK_SITES_PORT=4180`. See the [mock-site guide](../bench/mock-sites/README.md)
for ground truth, canary locations, expected outcomes, and consumer boundaries.
