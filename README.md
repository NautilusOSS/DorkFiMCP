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

## Documentation

- **[docs/index.md](docs/index.md)** — doc index (MCP vs scripts)
- **[docs/SCRIPTS.md](docs/SCRIPTS.md)** — CLI scripts (audit, staleness sync, notifications)

## Market identity (`poolId` + `marketId`)

Every lending **market** is addressed by:

| Field | Meaning |
|-------|--------|
| **`poolId`** | Lending pool application id (e.g. Voi main `47139778`, community `47139781`) |
| **`marketId`** | On-chain market id — the `uint64` passed to `get_market` / `deposit` / `borrow` / `get_user`. Same as **`contractId`** in `data/contracts.json` for that row. |

`get_markets` returns both on each row. **Do not rely on symbol alone** (e.g. **WAD** exists in two pools on Voi with the same token contract id but different pool contexts — disambiguation is always `poolId` + `marketId`).

### Markets

| Tool | Description |
|------|-------------|
| `get_markets` | List all markets, or one market if you pass **`poolId` + `marketId`** |
| `get_market` | On-chain `get_market` for **`poolId` + `marketId`** |
| `get_tvl` | TVL per market and totals |

### Positions

| Tool | Description |
|------|-------------|
| `get_position` | User positions (optional filter **`poolId` + `marketId`**) |
| `get_user` | On-chain **`get_user`** for **`poolId` + `marketId`** |
| `get_health_factor` | Health factor and risk. **Health factors are per-pool** (liquidation is per-pool); response includes `pools[]` and optional `aggregateHealthFactor`. |

### Liquidations

Health factors and liquidation eligibility are **per-pool**; a user can be liquidatable in one pool and safe in another.

| Tool | Description |
|------|-------------|
| `get_liquidation_candidates` | Find undercollateralized accounts from pre-indexed health data (per-pool) |

### Transaction Preparation

| Tool | Description |
|------|-------------|
| `deposit_txn` | Supply — **`poolId` + `marketId` + amount + sender** |
| `borrow_txn` | Borrow — same |
| `repay_txn` / `repay_all_txn` / … | Same market addressing |
| `withdraw_txn` | Withdraw — same |
| `liquidate_txn` | **`poolId` + `debtMarketId` + `collateralMarketId` + borrower + amount + sender** |

## Agent Workflow

```
Agent calls DorkFiMCP:  deposit_txn(chain, poolId, marketId, amount, sender)
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
  markets.js          Market data; each row has poolId + marketId
  positions.js        User positions and health factors from API
  liquidation.js      Liquidation candidates from pre-indexed health data
  builders.js         Unsigned transaction group builders (on-chain)
scripts/
  audit.js                    account | staleness | summary
  sync-position.js            Stale sync (all positions, or --deposit-only, optional market filter)
  notify.js                   User notifications (send-one | broadcast | plan)
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
| `audit` | `node scripts/audit.js` | **`--mode account`** (one wallet), **`staleness`** (full scan, `--json` → artifact), **`summary`** (read artifact). Aliases: `audit:account`, `audit:staleness`, `audit:summary`. |
| `sync:position` | `node scripts/sync-position.js` | Sync stale rows from an audit (default: all borrowers + depositors). See [docs/SCRIPTS.md](docs/SCRIPTS.md). |
| `sync:deposit-only` | same + `--deposit-only` | Only users with no borrows anywhere. |
| `sync:deposit-only-market` | same + `--deposit-only --chain … --contract-id …` | Deposit-only, one market (alias npm script). |
| `notify` | `node scripts/notify.js` | **`--mode send-one`** (urgent note, one address), **`broadcast`** (all users), **`plan`** (shell commands for at-risk users). See [docs/SCRIPTS.md](docs/SCRIPTS.md). |
| `send:liquidation-warning` | notify `--mode send-one` | Alias. |
| `broadcast:notification` | notify `--mode broadcast` | Alias (`--max` caps recipients). |
| `generate:notification-commands` | notify `--mode plan` | Alias. |

### Typical workflow

```bash
# 1. Full staleness audit → JSON
npm run audit:staleness -- --json -o audit.json

# 2. Summarize JSON
npm run audit:summary -- audit.json

# 3. Dry-run sync (all stale rows, or deposit-only)
npm run sync:position -- audit.json
npm run sync:position -- audit.json --deposit-only

# 4. Deposit-only, one market
npm run sync:position -- audit.json --deposit-only --chain voi --contract-id 420069

# 5. Submit (requires MN)
MN="your mnemonic" npm run sync:position -- audit.json --deposit-only --submit

# 6. Audit one account (address or enVoi)
npm run audit:account -- <ADDRESS> --chain voi
npm run audit:account -- shelly.voi --chain voi

# 7. Notify one user (urgent) or broadcast / plan
MN="…" npm run send:liquidation-warning -- --chain voi --address <ADDR> --submit
MN="…" npm run broadcast:notification -- --chain voi --submit --max 50   # optional cap
npm run generate:notification-commands -- --chain voi   # prints notify send-one lines
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

### Algorand (31 markets across 2 pools)

**Pool 3333688282 (A Market):** ALGO, USDC, UNIT, POW, goBTC, aVOI, wBTC, goETH, wETH, LINK, SOL, AVAX, WAD (borrow-only)

**Pool 3345940978 (Community / B Markets):** WAD, FINITE, FOLKS, COOP, HOG, USDt, xUSD, MONKO, HAY, BRO, ALPHA, COMPX, AKTA, PEPE, GOLD$, TINY, ALGO (B Market), USDC (B Market)

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

1. **Transaction groups** — The `prepare_*` tools build simplified transaction groups. The DorkFi frontend uses `ulujs` CONTRACT class for more sophisticated group construction with automatic box funding and resource sharing.

2. **Price scale** — Prices from the API use 18 decimal precision referenced against aUSDC = 1,000,000. USD values in health/position responses are approximated by dividing raw values by 10^12.

3. **API freshness** — Read data comes from the DorkFi API which periodically refreshes from on-chain state. For the most current data, the API's POST endpoints can trigger a fresh blockchain query.
