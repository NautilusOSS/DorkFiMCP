# DorkFi MCP — documentation

## Contents

| Doc | Description |
|-----|-------------|
| [**SCRIPTS.md**](./SCRIPTS.md) | CLI scripts: audits, staleness sync, notifications |
| [**README.md**](../README.md) | MCP server, tools, install, protocol overview |

## MCP vs scripts

- **MCP** (`npm start` → `index.js`): Model Context Protocol server exposing DorkFi tools to agents (markets, positions, liquidations, etc.).
- **Scripts** (`scripts/*.js`): Standalone Node CLIs for batch audits, on-chain sync, and user notifications. See [SCRIPTS.md](./SCRIPTS.md).

## Local notes

Ad-hoc runbooks or issue notes can live in **`issue-notes/`** (gitignored except `issue-notes/README.md`). Do not commit sensitive addresses or mnemonics.
