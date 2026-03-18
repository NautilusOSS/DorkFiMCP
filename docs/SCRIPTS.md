# Scripts

Node CLIs: **`audit.js`** (3 modes), **`sync-position.js`**, **`notify.js`** (3 modes). Helpers: `lib/script-utils.js`.

**Environment:** `MN` when signing.

```bash
npm run audit -- --mode account <addr|name.voi> [opts]
npm run audit -- --mode staleness [--json] [-o audit.json]
npm run audit -- --mode summary <audit.json> [--top N]
# Shorthand: audit:account | audit:staleness | audit:summary (same + --mode baked in)

npm run sync:position -- <audit.json> [opts]
npm run notify -- --mode send-one|broadcast|plan --chain voi|algorand> [opts]
```

---

## `audit.js`

| Mode | What |
|------|------|
| **account** | One wallet (address or enVoi). Stale per market; optional `--submit` sync. |
| **staleness** | Every user × market; stale rows → report or `--json` artifact for `sync-position`. |
| **summary** | Read that JSON; human summary + suggested `sync` / `notify` / re-audit commands. |

```bash
node scripts/audit.js --mode account shelly.voi --chain voi
node scripts/audit.js --mode staleness --json -o audit.json
node scripts/audit.js --mode summary audit.json --top 15
```

---

## `sync-position.js`

Stale **`sync_user_market_for_price_change`** batches from staleness JSON. See prior docs: `--deposit-only`, `--chain` + `--contract-id`, etc.

---

## `notify.js`

**send-one** | **broadcast** | **plan** — 0-pay notes; see notify `--help`.

---

## Safety

Dry-run defaults; `--max` on broadcast; `MN` never committed.
