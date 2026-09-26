# privacAgent

A browser agent with on-device perception and privacy filtering. The extension is designed
to keep raw DOM and screenshots on the user's machine and send only sanitized, structured
Screen State to the server.

Current foundation: **A-01** (Chrome/Firefox extension scaffold), **A-02** (platform
adapter), **A-10** (side-panel shell), and **E-01** (shared TypeScript/Python protocol).
The panel currently runs a clearly labelled local demo controller; the agent and privacy
pipeline are still to be implemented.

## Development setup

Start with the **[development environment guide](docs/development.md)** for tool
installation, first-time setup, loading the extension in Chrome and Firefox, daily
commands and troubleshooting.

Once the tools are installed, run these commands from the repository root:

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

Use **pnpm** for JavaScript/TypeScript and **uv** for Python dependencies and virtual
environments. The [protocol package guide](packages/protocol/README.md) covers schemas,
imports, generation and validation boundaries.

## Contribution workflow

All changes must be tied to an issue; direct commits to `main` are disabled.

1. Open or use the issue for your work. Reference the feature ID, such as `A-02` or `E-01`.
2. In the issue's **Development** sidebar, select **Create a branch**, then check out that
   branch locally using GitHub's instructions. Do not create the branch from `main` in
   the terminal.
3. Make your changes, run the checks above, then commit and push to the issue branch.
4. Open a PR against `main` with a closing keyword in its description, such as
   `Closes #12` or `Fixes #34`. The **Enforce Linked Issue** workflow checks this.
5. Merge only after required reviews and status checks pass. GitHub closes the linked
   issue when the PR is merged.

Follow-up commits pushed to the same branch automatically appear in its existing PR.
