# DorkFiMCP

Protocol MCP server for the [DorkFi](https://dorkfi.com) lending protocol on Voi and Algorand.

## Architecture

DorkFiMCP is a protocol-level MCP that sits above the infrastructure MCP layer:

```
UluCoreMCP / UluVoiMCP / UluAlgorandMCP / UluWalletMCP / UluBroadcastMCP
                                ↓
                           DorkFiMCP
                                ↓
                        DorkFi API (reads)
                        On-chain (writes)
```

**Data sources:**

- **DorkFi API** (`dorkfi-api.nautilus.sh`) — Pre-indexed market data, user health factors, TVL, and position data. Used for all read operations.
- **On-chain** (algod) — Used for transaction preparation (suggested params, ABI encoding).

**DorkFiMCP handles:**
- Market discovery with live data from the DorkFi API
- User position queries with pre-computed health factors
- Liquidation candidate scanning (202+ indexed users on Voi)
- TVL analytics across all chains and pools
- Transaction preparation (unsigned)

**DorkFiMCP does NOT:**
- Sign transactions (use UluWalletMCP)
- Broadcast transactions (use UluBroadcastMCP)
- Manage wallets

## Tools

### Markets

| Tool | Description |
|------|-------------|
| `get_markets` | List lending markets with live rates, deposits, borrows, and prices |
| `get_tvl` | Get total value locked per market and aggregate totals |

### Positions

| Tool | Description |
|------|-------------|
| `get_position` | Get a user's positions with per-pool health factors |
| `get_health_factor` | Check health factor and risk level per pool |

### Liquidations

| Tool | Description |
|------|-------------|
| `get_liquidation_candidates` | Find undercollateralized accounts from pre-indexed health data |

### Transaction Preparation

| Tool | Description |
|------|-------------|
| `deposit_txn` | Build unsigned transactions to deposit (supply) tokens |
| `borrow_txn` | Build unsigned transactions to borrow tokens |
| `repay_txn` | Build unsigned transactions to repay debt |
| `withdraw_txn` | Build unsigned transactions to withdraw supplied tokens |
| `liquidate_txn` | Build unsigned transactions to liquidate a position |

## Agent Workflow

```
Agent calls DorkFiMCP:  deposit_txn(chain, symbol, amount, sender)
       → returns { transactions: [base64, ...] }

Agent calls UluWalletMCP: wallet_sign_transactions(signerId, transactions)
       → returns signed transactions

Agent calls UluBroadcastMCP: broadcast_transactions(network, txns)
       → returns transaction IDs
```

## Chain Support

All tools accept a `chain` parameter:

- `"voi"` — Voi mainnet (pools: 47139778, 47139781)
- `"algorand"` — Algorand mainnet (pools: 3333688282, 3345940978)

## Project Structure

```
index.js              MCP server entry point (11 tools)
lib/
  api.js              DorkFi API client (dorkfi-api.nautilus.sh)
  client.js           Algod client factory, ABI definitions, simulation helpers
  markets.js          Market data from API with symbol resolution
  positions.js        User positions and health factors from API
  liquidation.js      Liquidation candidates from pre-indexed health data
  builders.js         Unsigned transaction group builders (on-chain)
scripts/
  audit-staleness.js          Full staleness audit across all users
  audit-account.js            Single-account audit
  summarize-audit.js          Summarize audit JSON reports
  sync-deposit-only.js        Batch sync deposit-only users
  sync-deposit-only-market.js Sync deposit-only users for a specific market
  send-liquidation-warning.js Send liquidation warning to one address
  broadcast-notification.js   Broadcast notification to all users
data/
  contracts.json      Chain configs, pool IDs, and token definitions
```

## Setup

```bash
npm install
```

## Run

```bash
node index.js
```

Or configure as an MCP server in your agent:

```json
{
  "mcpServers": {
    "dorkfi": {
      "command": "node",
      "args": ["/path/to/DorkFiMCP/index.js"]
    }
  }
}
```

## Scripts / CLI Commands

Standalone scripts for auditing, syncing, and notifying DorkFi users. All scripts support `--help` for full usage details.

| npm script | Command | Description |
|------------|---------|-------------|
| `audit:staleness` | `node scripts/audit-staleness.js` | Full audit of user-market staleness across all positions. Compares each user's on-chain `lastPrice` against the current oracle price and reports stale positions grouped by priority. |
| `audit:account` | `node scripts/audit-account.js` | Audit a single account across all markets on one or both chains. Reports stale positions and optionally syncs them. |
| `audit:summary` | `node scripts/summarize-audit.js` | Summarize an audit JSON report with per-network, per-symbol, and per-priority breakdowns. |
| `sync:deposit-only` | `node scripts/sync-deposit-only.js` | Batch-sync deposit-only addresses from a staleness audit. Filters for users with no borrows and submits `sync_user_market_for_price_change` transactions. |
| `sync:deposit-only-market` | `node scripts/sync-deposit-only-market.js` | Same as `sync:deposit-only` but scoped to a single market via `--chain` and `--contract-id`. |
| `send:liquidation-warning` | `node scripts/send-liquidation-warning.js` | Send a 0-amount payment with a liquidation-risk warning in the transaction note to a specific address. |
| `broadcast:notification` | `node scripts/broadcast-notification.js` | Broadcast a notification to all DorkFi users on a chain via 0-amount payment transaction notes. |

### Typical workflow

```bash
# 1. Run a full staleness audit and save JSON
npm run audit:staleness -- --json -o audit.json

# 2. Summarize the audit
npm run audit:summary -- audit.json

# 3. Dry-run sync for deposit-only users (critical + high priority)
npm run sync:deposit-only -- audit.json --dry-run

# 4. Sync deposit-only users for a specific market
npm run sync:deposit-only-market -- audit.json --chain voi --contract-id 420069

# 5. Submit sync transactions (requires MN env var)
MN="your mnemonic" npm run sync:deposit-only -- audit.json --submit

# 6. Audit a single account
npm run audit:account -- <ADDRESS> --chain voi

# 7. Send liquidation warning to a specific user
MN="your mnemonic" npm run send:liquidation-warning -- --chain voi --address <RECIPIENT> --submit

# 8. Broadcast notification to all users on a chain
MN="your mnemonic" npm run broadcast:notification -- --chain voi --submit
```

### Common options

All sync/submit scripts default to `--dry-run` mode. Pass `--submit` to sign and broadcast. The `MN` environment variable (25-word Algorand mnemonic) is required for signing.

| Option | Scripts | Description |
|--------|---------|-------------|
| `--dry-run` | sync, audit:account, send, broadcast | Build transactions without submitting (default) |
| `--submit` | sync, audit:account, send, broadcast | Sign and submit transactions |
| `--chain <voi\|algorand>` | all | Target chain (some default to both) |
| `--concurrency <N>` | sync, audit, broadcast | Max parallel operations |
| `--output <file>` | sync, audit, broadcast | Write JSON results to file |
| `--json` | audit:staleness, audit:account, audit:summary | Output raw JSON |
| `--priority <tiers>` | sync:deposit-only, sync:deposit-only-market | Comma-separated priorities (default: critical,high) |

## DorkFi API

Read operations use the [DorkFi API](https://dorkfi-api.nautilus.sh/api-docs/) which provides pre-indexed data:

| Endpoint | Used by |
|----------|---------|
| `/market-data/{network}` | `get_markets` |
| `/user-health/user/{address}` | `get_position`, `get_health_factor` |
| `/user-health/{network}` | `get_liquidation_candidates` |
| `/analytics/tvl` | `get_tvl` |

## Supported Markets

### Voi (22 markets across 2 pools)

**Pool 47139778:** VOI, aUSDC, UNIT, POW, aALGO, aETH, aBTC, acbBTC, WAD (borrow-only)

**Pool 47139781:** WAD, GM, CORN, SHELLY, BUIDL, F, NODE, AMMO, IAT, bVOI, NV, EV, FV

### Algorand (29 markets across 2 pools)

**Pool 3333688282:** ALGO, USDC, UNIT, POW, goBTC, aVOI, wBTC, goETH, wETH, LINK, SOL, AVAX, WAD (borrow-only)

**Pool 3345940978:** WAD, FINITE, FOLKS, COOP, HOG, USDt, xUSD, MONKO, HAY, BRO, ALPHA, COMPX, AKTA, PEPE, GOLD$, TINY

## On-Chain ABI

Transaction preparation uses the verified ABI from [`DorkFiLendingPoolClient.ts`](https://github.com/DorkFi/dorkfi-app/tree/next/src/clients):

| Method | Signature |
|--------|-----------|
| `get_market` | `(uint64)(bool,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint64,uint256,uint256,uint64,uint64)` |
| `get_user` | `(address,uint64)(uint256,uint256,uint256,uint256,uint64,uint256)` |
| `get_global_user` | `(address)(uint256,uint256,uint64)` |
| `get_user_borrow_amount` | `(address,uint64)uint256` |
| `deposit` | `(uint64,uint256)uint256` |
| `withdraw` | `(uint64,uint256)uint256` |
| `borrow` | `(uint64,uint256)uint256` |
| `repay` | `(uint64,uint256)uint256` |
| `repay_all` | `(uint64)uint256` |
| `repay_on_behalf` | `(uint64,uint256,address)uint256` |
| `liquidate_cross_market` | `(uint64,uint64,address,uint256,uint256)uint256` |

## Known Limitations

1. **WAD in multiple pools** — WAD appears in two pools per chain. `findMarket` returns the first match. For borrow-only WAD pools, specify the pool ID explicitly if needed.

2. **Transaction groups** — The `prepare_*` tools build simplified transaction groups. The DorkFi frontend uses `ulujs` CONTRACT class for more sophisticated group construction with automatic box funding and resource sharing.

3. **Price scale** — Prices from the API use 18 decimal precision referenced against aUSDC = 1,000,000. USD values in health/position responses are approximated by dividing raw values by 10^12.

4. **API freshness** — Read data comes from the DorkFi API which periodically refreshes from on-chain state. For the most current data, the API's POST endpoints can trigger a fresh blockchain query.
