#!/usr/bin/env node

/**
 * Summarize a DorkFi staleness audit JSON report.
 *
 * Reads the JSON produced by audit-staleness.js (--json) and prints a
 * human-readable summary with per-network / per-symbol / per-priority
 * breakdowns, top stale positions, and borrower risk highlights.
 *
 * Usage:
 *   node scripts/summarize-audit.js <audit.json> [--top N] [--json]
 */

import fs from "node:fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { file: null, top: 10, json: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top" && args[i + 1]) {
      opts.top = parseInt(args[++i], 10);
    } else if (args[i] === "--json") {
      opts.json = true;
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/summarize-audit.js <audit.json> [options]
  <audit.json>       Path to the JSON output from audit-staleness.js --json
  --top <N>          Number of top stale positions to show (default: 10)
  --json             Output summary as JSON instead of formatted text`);
      process.exit(0);
    } else if (!args[i].startsWith("--")) {
      opts.file = args[i];
    }
  }

  if (!opts.file) {
    console.error("Error: Please provide the path to an audit JSON file.");
    console.error("Usage: node scripts/summarize-audit.js <audit.json> [--top N] [--json]");
    process.exit(1);
  }
  return opts;
}

function loadAudit(path) {
  const raw = fs.readFileSync(path, "utf-8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.candidates)) {
    throw new Error("Invalid audit JSON: missing 'candidates' array");
  }
  if (!data.addressesByPriority || !data.depositOnlyByPriority) {
    throw new Error(
      "Invalid audit JSON: missing 'addressesByPriority' / 'depositOnlyByPriority'.\n" +
      "Re-run audit-staleness.js with --json to produce the new format.",
    );
  }
  return data;
}

function buildSummary(audit, topN) {
  const {
    generatedAt,
    totalStalePositions,
    addressesByPriority,
    depositOnlyByPriority,
    candidates,
  } = audit;
  const total = totalStalePositions ?? candidates.length;

  const byNetwork = {};
  const bySymbol = {};

  for (const c of candidates) {
    if (!byNetwork[c.network]) byNetwork[c.network] = [];
    byNetwork[c.network].push(c);

    if (!bySymbol[c.symbol]) bySymbol[c.symbol] = [];
    bySymbol[c.symbol].push(c);
  }

  const sorted = [...candidates].sort(
    (a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent),
  );
  const topStale = sorted.slice(0, topN);

  const borrowersAtRisk = candidates
    .filter((c) => c.scaledBorrows > 0)
    .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));

  const borrowerAddresses = new Set(
    candidates.filter((c) => c.scaledBorrows > 0).map((c) => c.address),
  );

  const symbolStats = Object.entries(bySymbol).map(([symbol, items]) => {
    const pcts = items.map((c) => Math.abs(c.priceChangePercent));
    return {
      symbol,
      count: items.length,
      avgDrift: pcts.reduce((a, b) => a + b, 0) / pcts.length,
      maxDrift: Math.max(...pcts),
      borrowers: items.filter((c) => c.scaledBorrows > 0).length,
    };
  }).sort((a, b) => b.maxDrift - a.maxDrift);

  const networkStats = Object.entries(byNetwork).map(([network, items]) => {
    const crit = items.filter((c) => c.priority === "critical").length;
    const high = items.filter((c) => c.priority === "high").length;
    const low = items.filter((c) => c.priority === "low").length;
    const borr = items.filter((c) => c.scaledBorrows > 0).length;
    const addrs = new Set(items.map((c) => c.address));
    return { network, total: items.length, critical: crit, high, low, borrowers: borr, uniqueUsers: addrs.size };
  });

  const allAddresses = [
    ...addressesByPriority.critical,
    ...addressesByPriority.high,
    ...addressesByPriority.low,
  ];
  const uniqueUsers = new Set(allAddresses).size;

  const NETWORK_TO_CHAIN = { "voi-mainnet": "voi", "algorand-mainnet": "algorand" };
  const depositOnlyMarkets = new Map();
  for (const c of candidates) {
    if (c.scaledDeposits > 0 && !borrowerAddresses.has(c.address) && (c.priority === "critical" || c.priority === "high")) {
      const key = `${c.network}:${c.contractId}`;
      if (!depositOnlyMarkets.has(key)) {
        depositOnlyMarkets.set(key, {
          chain: NETWORK_TO_CHAIN[c.network] ?? c.network,
          contractId: c.contractId,
          poolId: c.poolId,
          symbols: new Set(),
          count: 0,
        });
      }
      const entry = depositOnlyMarkets.get(key);
      entry.symbols.add(c.symbol);
      entry.count++;
    }
  }

  return {
    generatedAt,
    total,
    uniqueUsers,
    borrowerAddresses: borrowerAddresses.size,
    borrowerPositions: borrowersAtRisk.length,
    addressesByPriority,
    depositOnlyByPriority,
    priority: {
      critical: { positions: candidates.filter((c) => c.priority === "critical").length, addresses: addressesByPriority.critical.length, depositOnly: depositOnlyByPriority.critical.length },
      high:     { positions: candidates.filter((c) => c.priority === "high").length,     addresses: addressesByPriority.high.length,     depositOnly: depositOnlyByPriority.high.length },
      low:      { positions: candidates.filter((c) => c.priority === "low").length,      addresses: addressesByPriority.low.length,      depositOnly: depositOnlyByPriority.low.length },
    },
    networkStats,
    symbolStats,
    topStale,
    borrowersAtRisk,
    depositOnlyMarkets: [...depositOnlyMarkets.values()]
      .map((m) => ({ ...m, symbols: [...m.symbols] }))
      .sort((a, b) => b.count - a.count),
  };
}

function formatDuration(isoTimestamp) {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

function formatTimestamp(epoch) {
  if (!epoch) return "n/a";
  const d = new Date(epoch * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatText(summary, topN, auditFile) {
  const lines = [];
  const { priority } = summary;

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("          DORKFI STALENESS AUDIT — SUMMARY");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`  Audit generated:     ${summary.generatedAt} (${formatDuration(summary.generatedAt)})`);
  lines.push(`  Total stale:         ${summary.total} positions`);
  lines.push(`  Unique users:        ${summary.uniqueUsers}`);
  lines.push(`  Borrower addresses:  ${summary.borrowerAddresses}`);
  lines.push(`  Borrower positions:  ${summary.borrowerPositions}`);
  lines.push("");
  lines.push("  Priority breakdown:        positions   addrs   deposit-only");
  lines.push(`    Critical (≥10%):   ${String(priority.critical.positions).padStart(10)} ${String(priority.critical.addresses).padStart(7)} ${String(priority.critical.depositOnly).padStart(14)}`);
  lines.push(`    High (≥3%/borr):   ${String(priority.high.positions).padStart(10)} ${String(priority.high.addresses).padStart(7)} ${String(priority.high.depositOnly).padStart(14)}`);
  lines.push(`    Low (<3%):         ${String(priority.low.positions).padStart(10)} ${String(priority.low.addresses).padStart(7)} ${String(priority.low.depositOnly).padStart(14)}`);
  lines.push("");

  lines.push("─── By Network ─────────────────────────────────────────────");
  for (const ns of summary.networkStats) {
    lines.push(`  ${ns.network}`);
    lines.push(`    Stale: ${ns.total}  |  Users: ${ns.uniqueUsers}  |  Borrowers: ${ns.borrowers}`);
    lines.push(`    Critical: ${ns.critical}  High: ${ns.high}  Low: ${ns.low}`);
    lines.push("");
  }

  lines.push("─── By Market ──────────────────────────────────────────────");
  lines.push(`  ${"Symbol".padEnd(10)} ${"Count".padStart(6)} ${"AvgDrift%".padStart(10)} ${"MaxDrift%".padStart(10)} ${"Borrowers".padStart(10)}`);
  lines.push(`  ${"─".repeat(10)} ${"─".repeat(6)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)}`);
  for (const s of summary.symbolStats) {
    lines.push(
      `  ${s.symbol.padEnd(10)} ${String(s.count).padStart(6)} ${s.avgDrift.toFixed(2).padStart(10)} ${s.maxDrift.toFixed(2).padStart(10)} ${String(s.borrowers).padStart(10)}`,
    );
  }
  lines.push("");

  lines.push(`─── Top ${topN} Most Stale Positions ─────────────────────────`);
  for (let i = 0; i < summary.topStale.length; i++) {
    const c = summary.topStale[i];
    const arrow = c.priceChangePercent >= 0 ? "↑" : "↓";
    const borrowTag = c.scaledBorrows > 0 ? "  ** BORROWER **" : "";
    lines.push(`  ${String(i + 1).padStart(2)}. ${c.symbol.padEnd(8)} ${arrow} ${Math.abs(c.priceChangePercent).toFixed(2)}%${borrowTag}`);
    lines.push(`      last=${c.userLastPrice}  now=${c.currentMarketPrice}  deposits=${c.scaledDeposits}  borrows=${c.scaledBorrows}`);
    lines.push(`      ${c.address}  (${c.network})`);
    lines.push(`      pool=${c.poolId}  contract=${c.contractId}  updated=${formatTimestamp(c.lastUpdateTime)}`);
  }
  lines.push("");

  if (summary.borrowersAtRisk.length > 0) {
    lines.push("─── Borrowers at Risk (stale + active borrows) ─────────────");
    for (const c of summary.borrowersAtRisk) {
      const arrow = c.priceChangePercent >= 0 ? "↑" : "↓";
      lines.push(`  [${c.priority.toUpperCase()}] ${c.symbol.padEnd(8)} ${arrow} ${Math.abs(c.priceChangePercent).toFixed(2)}%  borrows=${c.scaledBorrows}  deposits=${c.scaledDeposits}`);
      lines.push(`      ${c.address}  (${c.network})`);
      lines.push(`      pool=${c.poolId}  contract=${c.contractId}  updated=${formatTimestamp(c.lastUpdateTime)}`);
    }
    lines.push("");
  }

  const NETWORK_TO_CHAIN = { "voi-mainnet": "voi", "algorand-mainnet": "algorand" };
  const file = auditFile ?? "<audit.json>";
  const depositOnlyTotal = summary.priority.critical.depositOnly + summary.priority.high.depositOnly;
  const chains = summary.networkStats.map((ns) => NETWORK_TO_CHAIN[ns.network] ?? ns.network);

  lines.push("─── Suggested Commands ─────────────────────────────────────");
  lines.push("");

  if (depositOnlyTotal > 0) {
    lines.push(`  Sync all deposit-only users (${depositOnlyTotal} addrs, critical+high):`);
    lines.push(`    npm run sync:deposit-only -- ${file}`);
    lines.push("");

    if (summary.depositOnlyMarkets.length > 0) {
      lines.push("  Sync by market:");
      for (const m of summary.depositOnlyMarkets) {
        lines.push(`    npm run sync:deposit-only-market -- ${file} --chain ${m.chain} --contract-id ${m.contractId}    # ${m.symbols.join(", ")} (${m.count} positions)`);
      }
      lines.push("");
    }
  }

  if (summary.borrowersAtRisk.length > 0) {
    const uniqueBorrowers = new Map();
    for (const c of summary.borrowersAtRisk) {
      if (!uniqueBorrowers.has(c.address)) {
        uniqueBorrowers.set(c.address, { chain: NETWORK_TO_CHAIN[c.network] ?? c.network, symbols: new Set() });
      }
      uniqueBorrowers.get(c.address).symbols.add(c.symbol);
    }
    const top = [...uniqueBorrowers.entries()].slice(0, 5);
    lines.push(`  Warn at-risk borrowers (${uniqueBorrowers.size} total):`);
    for (const [addr, info] of top) {
      lines.push(`    npm run send:liquidation-warning -- --chain ${info.chain} --address ${addr}    # ${[...info.symbols].join(", ")}`);
    }
    if (uniqueBorrowers.size > 5) {
      lines.push(`    # ... and ${uniqueBorrowers.size - 5} more`);
    }
    lines.push("");
  }

  if (chains.length > 0) {
    lines.push("  Broadcast notification to all users:");
    for (const chain of chains) {
      lines.push(`    npm run broadcast:notification -- --chain ${chain}`);
    }
    lines.push("");
  }

  if (summary.topStale.length > 0) {
    const topAddr = summary.topStale[0];
    const chain = NETWORK_TO_CHAIN[topAddr.network] ?? topAddr.network;
    lines.push("  Drill into the most-stale account:");
    lines.push(`    npm run audit:account -- ${topAddr.address} --chain ${chain}    # ${topAddr.symbol} ${topAddr.priceChangePercent > 0 ? "+" : ""}${topAddr.priceChangePercent.toFixed(2)}%`);
    lines.push("");
  }

  lines.push("  Re-run staleness audit:");
  lines.push("    npm run audit:staleness -- --json -o audit.json");
  lines.push("");
  lines.push("  All commands default to --dry-run. Pass --submit to broadcast.");
  lines.push("  Set MN env var (25-word mnemonic) for signing.");
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

function main() {
  const opts = parseArgs();
  const audit = loadAudit(opts.file);
  const summary = buildSummary(audit, opts.top);

  if (opts.json) {
    const candidateFields = (c) => ({
      address: c.address,
      symbol: c.symbol,
      network: c.network,
      poolId: c.poolId,
      contractId: c.contractId,
      priceChangePercent: c.priceChangePercent,
      priority: c.priority,
      scaledDeposits: c.scaledDeposits,
      scaledBorrows: c.scaledBorrows,
      lastUpdateTime: c.lastUpdateTime,
    });
    const jsonOut = {
      generatedAt: summary.generatedAt,
      total: summary.total,
      uniqueUsers: summary.uniqueUsers,
      borrowerAddresses: summary.borrowerAddresses,
      borrowerPositions: summary.borrowerPositions,
      priority: summary.priority,
      addressesByPriority: summary.addressesByPriority,
      depositOnlyByPriority: summary.depositOnlyByPriority,
      networkStats: summary.networkStats,
      symbolStats: summary.symbolStats,
      topStale: summary.topStale.map(candidateFields),
      borrowersAtRisk: summary.borrowersAtRisk.map(candidateFields),
    };
    console.log(JSON.stringify(jsonOut, null, 2));
  } else {
    console.log(formatText(summary, opts.top, opts.file));
  }
}

main();
