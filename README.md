# Delimit -- API Governance for VS Code

Catch breaking API changes before they ship. Delimit integrates API governance directly into your editor, powered by the same engine used in CI/CD via the [Delimit GitHub Action](https://github.com/marketplace/actions/delimit-api-governance).

## Features

- **Status bar indicator** -- see governance health at a glance
- **Auto-lint on save** -- OpenAPI specs are automatically checked for breaking changes when saved
- **Inline diagnostics** -- breaking changes appear as squiggly underlines in your spec files
- **One-click init** -- set up governance policies from the command palette

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "Delimit":

| Command | Description |
|---------|-------------|
| `Delimit: Lint API Spec` | Lint the active OpenAPI spec for breaking changes |
| `Delimit: Check Governance Health` | Run a health check on your governance configuration |
| `Delimit: Initialize Governance` | Set up Delimit governance in this workspace |
| `Delimit: Show Status` | Show current governance status |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `delimit.autoLint` | `true` | Automatically lint OpenAPI specs on save |
| `delimit.cliPath` | `""` | Path to delimit-cli binary (leave empty to use npx) |

## Requirements

- [delimit-cli](https://www.npmjs.com/package/delimit-cli) (`npm install -g delimit-cli`)
- Or use via npx (no install needed, but slower on first run)

## Publishing

Marketplace publishing is wired through [`.github/workflows/publish.yml`](./.github/workflows/publish.yml).

Before the first release:

- Create the `delimit-ai` publisher in VS Code Marketplace
- Create an Azure DevOps personal access token and store it as `VSCE_PAT`
- Create an Open VSX token and store it as `OVSX_PAT`
- Create a GitHub release or run the workflow manually

Local packaging:

```bash
npm ci
npm run compile
npx @vscode/vsce package
```

## How it works

The extension wraps the `delimit-cli` tool, which detects 27 types of API changes (17 breaking, 10 non-breaking) across OpenAPI specs. It supports three policy presets (strict, default, relaxed) and custom YAML policies.

## Links

- [Documentation](https://delimit.ai/docs)
- [GitHub Action](https://github.com/marketplace/actions/delimit-api-governance)
- [npm CLI](https://www.npmjs.com/package/delimit-cli)
- [MCP Server](https://github.com/delimit-ai/delimit-mcp-server)

## License

MIT
