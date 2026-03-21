# DorkFi MCP — documentation

## Contents

| Doc | Description |
|-----|-------------|
| [**SCRIPTS.md**](./SCRIPTS.md) | CLI scripts: audits, staleness sync, notifications |
| [**MARKET_UPDATES_AND_ADDITIONS.md**](./MARKET_UPDATES_AND_ADDITIONS.md) | **Combined plan:** Market parameter updates (interest rates, caps) + new market additions (tALGO, xALGO) |
| [**PLAN-tALGO.md**](./PLAN-tALGO.md) | Detailed plan for adding tALGO (Tinyman Liquid Staking ALGO) market |
| [**PLAN-xALGO.md**](./PLAN-xALGO.md) | Detailed plan for adding xALGO (Folks Finance Liquid Staking ALGO) market |
| [**PLANS-tALGO-xALGO.md**](./PLANS-tALGO-xALGO.md) | Combined overview of tALGO and xALGO plans |
| [**ALL_MARKET_PARAMETERS.md**](./ALL_MARKET_PARAMETERS.md) | **Complete reference:** All parameters for ALGO, aALGO, xALGO, tALGO (risk, interest, caps, phases) |
| [**ALGORAND_MARKETS.md**](./ALGORAND_MARKETS.md) | All Algorand DorkFi markets: A Market (13) + Community pool (16) with symbols, contract IDs, asset IDs |
| [**ALGORAND_DEPOSITS_BORROWS.md**](./ALGORAND_DEPOSITS_BORROWS.md) | Live deposits & borrows for all Algorand markets (on-chain via get_market) |
| [**ALGO_VARIANT_MARKET_PARAMETERS.md**](./ALGO_VARIANT_MARKET_PARAMETERS.md) | Target CF/LT ladder: ALGO, xALGO, tALGO, aALGO (+ interest notes) |
| [**INTEREST_RATE_RAMP_UP_SCHEDULE.md**](./INTEREST_RATE_RAMP_UP_SCHEDULE.md) | Week-by-week interest rate ramp-up schedule: ALGO & aALGO side-by-side comparison (1% increments/week) |
| [**XALGO_TALGO_CAP_PHASES.md**](./XALGO_TALGO_CAP_PHASES.md) | How 25k/2.5k caps fit into phases; Phase 1 → 2 → 3 progression for xALGO & tALGO |
| [**README.md**](../README.md) | MCP server, tools, install, protocol overview |

## MCP vs scripts

- **MCP** (`npm start` → `index.js`): Model Context Protocol server exposing DorkFi tools to agents (markets, positions, liquidations, etc.).
- **Scripts** (`scripts/*.js`): Standalone Node CLIs for batch audits, on-chain sync, and user notifications. See [SCRIPTS.md](./SCRIPTS.md).

## Local notes

Ad-hoc runbooks or issue notes can live in **`issue-notes/`** (gitignored except `issue-notes/README.md`). Do not commit sensitive addresses or mnemonics.
