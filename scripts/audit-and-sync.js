#!/usr/bin/env node

/**
 * Audit both chains (Voi + Algorand), print summary, then sync all stale positions using defaults.
 *
 * Steps:
 *   1. Run staleness audit on both chains → write JSON
 *   2. Print human-readable summary from that audit
 *   3. Run sync-position.js on the audit file with default priority (critical, high) and concurrency
 *
 * Usage:
 *   node scripts/audit-and-sync.js [options]
 *
 * Options:
 *   --output, -o <file>   Audit JSON path (default: audit-both.json)
 *   --submit             Sign and submit sync txns (requires MN). Default: dry-run
 *   --dry-run            Only build sync txns, do not submit (default)
 *   --concurrency <N>     Audit concurrency (default 6); sync uses 3
 *   --chain <voi|algorand>  Audit only this chain (default: both)
 *   --priority <tiers>    Sync priority tiers, comma-separated (default: critical,high)
 *   --deposit-only       Sync only deposit-only addresses (no borrows)
 *   --help, -h           Show this help
 *
 * Environment:
 *   MN                    25-word mnemonic (required for --submit)
 *   DISCORD_WEBHOOK_URL   Optional. If set, POST a short embed when the run finishes (success or failure).
 */

import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAudit, buildSummary, formatStalenessSummaryDiscordBlock } from "../lib/auditSummary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_AUDIT_FILE = "audit-both.json";
const DEFAULT_AUDIT_CONCURRENCY = 6;
const DEFAULT_SYNC_CONCURRENCY = 3;
const DEFAULT_PRIORITIES = "critical,high";

function help() {
  console.log(`Usage: node scripts/audit-and-sync.js [options]

  Audit both chains (Voi + Algorand), print summary, then sync stale positions with defaults.

Options:
  --output, -o <file>   Audit JSON path (default: ${DEFAULT_AUDIT_FILE})
  --submit              Sign and submit sync txns (requires MN). Default: dry-run
  --dry-run             Only build sync txns (default)
  --concurrency <N>     Audit concurrency (default ${DEFAULT_AUDIT_CONCURRENCY}); sync uses ${DEFAULT_SYNC_CONCURRENCY}
  --chain <voi|algorand>  Audit only this chain (default: both)
  --priority <tiers>     Sync priority tiers (default: ${DEFAULT_PRIORITIES})
  --deposit-only        Sync only deposit-only addresses
  --help, -h            Show this help

Environment:
  MN                     Mnemonic for --submit
  DISCORD_WEBHOOK_URL    Optional Discord webhook for run completion (success or failure)

Examples:
  node scripts/audit-and-sync.js
  node scripts/audit-and-sync.js --submit
  node scripts/audit-and-sync.js -o my-audit.json --deposit-only --submit
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    output: DEFAULT_AUDIT_FILE,
    submit: false,
    concurrency: DEFAULT_AUDIT_CONCURRENCY,
    chain: null,
    priority: DEFAULT_PRIORITIES,
    depositOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      help();
      process.exit(0);
    }
    if (args[i] === "--output" || args[i] === "-o") {
      if (args[i + 1]) opts.output = args[++i];
      continue;
    }
    if (args[i] === "--submit") {
      opts.submit = true;
      continue;
    }
    if (args[i] === "--dry-run") {
      opts.submit = false;
      continue;
    }
    if (args[i] === "--concurrency" && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
      continue;
    }
    if (args[i] === "--chain" && args[i + 1]) {
      opts.chain = args[++i].toLowerCase();
      if (!["voi", "algorand"].includes(opts.chain)) {
        console.error("--chain must be voi or algorand");
        process.exit(1);
      }
      continue;
    }
    if (args[i] === "--priority" && args[i + 1]) {
      opts.priority = args[++i];
      continue;
    }
    if (args[i] === "--deposit-only") {
      opts.depositOnly = true;
      continue;
    }
  }

  return opts;
}

/**
 * @param {{ exitCode: number; failureReason: string | null; opts: ReturnType<typeof parseArgs> | null; auditPath: string | null }} p
 */
const DISCORD_EMBED_DESC_MAX = 4096;

async function notifyDiscordIfConfigured(p) {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!url) return;

  const ok = p.exitCode === 0;
  const title = ok ? "Audit & sync completed" : "Audit & sync failed";
  const color = ok ? 0x2ecc71 : 0xe74c3c;

  let stalenessBlock = null;
  if (ok && p.auditPath) {
    try {
      const audit = loadAudit(p.auditPath);
      const summary = buildSummary(audit, 10);
      stalenessBlock = formatStalenessSummaryDiscordBlock(summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Discord: could not build staleness summary:", msg);
    }
  }

  const metaParts = [];
  if (p.opts && p.auditPath) {
    metaParts.push(`**Audit file:** \`${p.auditPath}\``);
    metaParts.push(`**Submit:** ${p.opts.submit}`);
    metaParts.push(`**Priority:** ${p.opts.priority}`);
    if (p.opts.chain) metaParts.push(`**Chain:** ${p.opts.chain}`);
  }
  if (p.failureReason) metaParts.push(`**Detail:** ${p.failureReason}`);
  else if (!ok) metaParts.push(`**Exit code:** ${p.exitCode}`);

  const meta = metaParts.join("\n");

  let description;
  if (stalenessBlock) {
    const footer = meta ? `\n\n${meta}` : "";
    const fence = (inner) => "```\n" + inner + "\n```";
    const fenceOverhead = 8; // "```\n" + "\n```"
    const suffix = "\n… (truncated)";
    const maxInner = DISCORD_EMBED_DESC_MAX - footer.length - fenceOverhead;
    let inner =
      stalenessBlock.length <= maxInner
        ? stalenessBlock
        : stalenessBlock.slice(0, Math.max(0, maxInner - suffix.length)) + suffix;
    let text = fence(inner) + footer;
    if (text.length > DISCORD_EMBED_DESC_MAX) {
      inner =
        stalenessBlock.slice(0, Math.max(0, maxInner - suffix.length - 64)) + suffix;
      text = fence(inner) + footer;
    }
    description = text.slice(0, DISCORD_EMBED_DESC_MAX);
  } else {
    description = (meta || (ok ? "Run finished successfully." : "Run failed.")).slice(0, DISCORD_EMBED_DESC_MAX);
  }

  const body = {
    embeds: [
      {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const text = await res.text();
      console.error(`Discord webhook failed: ${res.status} ${text}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Discord webhook error:", msg);
  }
}

function run(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  return r.status;
}

async function main() {
  const opts = parseArgs();
  const auditPath = path.isAbsolute(opts.output) ? opts.output : path.join(ROOT, opts.output);

  async function finish(exitCode, failureReason) {
    await notifyDiscordIfConfigured({ exitCode, failureReason, opts, auditPath });
    process.exit(exitCode);
  }

  console.error("═══════════════════════════════════════════════════════════════");
  console.error("  DORKFI AUDIT BOTH CHAINS → SUMMARY → SYNC (defaults)");
  console.error("═══════════════════════════════════════════════════════════════");
  console.error(`  Audit file: ${auditPath}`);
  console.error(`  Concurrency: audit=${opts.concurrency} sync=${DEFAULT_SYNC_CONCURRENCY}`);
  console.error(`  Priority: ${opts.priority}  Submit: ${opts.submit}`);
  if (opts.chain) console.error(`  Chain: ${opts.chain} only`);
  console.error("");

  // 1. Staleness audit (both chains by default)
  const auditArgs = [
    "--mode", "staleness",
    "--json",
    "-o", auditPath,
    "--concurrency", String(opts.concurrency),
  ];
  if (opts.chain) auditArgs.push("--chain", opts.chain);

  console.error("── Step 1: Staleness audit ──");
  const auditStatus = run("node", ["scripts/audit.js", ...auditArgs]);
  if (auditStatus !== 0 && auditStatus !== 1) {
    console.error("Audit failed with status", auditStatus);
    return finish(auditStatus, `Audit failed with status ${auditStatus}`);
  }
  // Exit 1 from audit means "stale positions found" — we continue

  // 2. Summary
  console.error("\n── Step 2: Summary ──");
  const summaryStatus = run("node", ["scripts/audit.js", "--mode", "summary", auditPath]);
  if (summaryStatus !== 0) {
    console.error("Summary failed with status", summaryStatus);
    return finish(summaryStatus, `Summary failed with status ${summaryStatus}`);
  }

  // 3. Sync positions (defaults: critical,high; dry-run unless --submit)
  const syncArgs = [
    auditPath,
    "--priority", opts.priority,
    "--concurrency", String(DEFAULT_SYNC_CONCURRENCY),
  ];
  if (opts.submit) syncArgs.push("--submit");
  else syncArgs.push("--dry-run");
  if (opts.depositOnly) syncArgs.push("--deposit-only");

  console.error("\n── Step 3: Sync positions (defaults) ──");
  const syncStatus = run("node", ["scripts/sync-position.js", ...syncArgs]);
  if (syncStatus !== 0) {
    return finish(syncStatus, `Sync failed with status ${syncStatus}`);
  }

  return finish(0, null);
}

main().catch(async (e) => {
  console.error(e);
  await notifyDiscordIfConfigured({
    exitCode: 2,
    failureReason: e instanceof Error ? e.message : String(e),
    opts: null,
    auditPath: null,
  });
  process.exit(2);
});
