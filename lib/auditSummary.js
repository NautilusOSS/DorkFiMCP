/**
 * Staleness audit JSON → human summary (CLI + Discord). Used by scripts/audit.js and audit-and-sync.js.
 */
import fs from "node:fs";

export function loadAudit(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!Array.isArray(data.candidates)) throw new Error("missing candidates[]");
  if (!data.addressesByPriority || !data.depositOnlyByPriority) {
    throw new Error("Re-run: audit.js --mode staleness --json -o file.json");
  }
  return data;
}

export function buildSummary(audit, topN) {
  const { generatedAt, totalStalePositions, addressesByPriority, depositOnlyByPriority, candidates } = audit;
  const total = totalStalePositions ?? candidates.length;
  const byNetwork = {};
  const bySymbol = {};
  for (const c of candidates) {
    if (!byNetwork[c.network]) byNetwork[c.network] = [];
    byNetwork[c.network].push(c);
    if (!bySymbol[c.symbol]) bySymbol[c.symbol] = [];
    bySymbol[c.symbol].push(c);
  }
  const sorted = [...candidates].sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
  const borrowersAtRisk = candidates.filter((c) => c.scaledBorrows > 0).sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
  const borrowerAddresses = new Set(candidates.filter((c) => c.scaledBorrows > 0).map((c) => c.address));
  const symbolStats = Object.entries(bySymbol).map(([symbol, items]) => {
    const pcts = items.map((c) => Math.abs(c.priceChangePercent));
    return { symbol, count: items.length, avgDrift: pcts.reduce((a, b) => a + b, 0) / pcts.length, maxDrift: Math.max(...pcts), borrowers: items.filter((c) => c.scaledBorrows > 0).length };
  }).sort((a, b) => b.maxDrift - a.maxDrift);
  const networkStats = Object.entries(byNetwork).map(([network, items]) => ({
    network, total: items.length,
    critical: items.filter((c) => c.priority === "critical").length,
    high: items.filter((c) => c.priority === "high").length,
    low: items.filter((c) => c.priority === "low").length,
    borrowers: items.filter((c) => c.scaledBorrows > 0).length,
    uniqueUsers: new Set(items.map((c) => c.address)).size,
  }));
  const NET = { "voi-mainnet": "voi", "algorand-mainnet": "algorand" };
  const depositOnlyMarkets = new Map();
  for (const c of candidates) {
    if (c.scaledDeposits > 0 && !borrowerAddresses.has(c.address) && (c.priority === "critical" || c.priority === "high")) {
      const key = `${c.network}:${c.contractId}`;
      if (!depositOnlyMarkets.has(key)) depositOnlyMarkets.set(key, { chain: NET[c.network] ?? c.network, contractId: c.contractId, poolId: c.poolId, symbols: new Set(), count: 0 });
      const e = depositOnlyMarkets.get(key);
      e.symbols.add(c.symbol);
      e.count++;
    }
  }
  return {
    generatedAt, total, uniqueUsers: new Set([...addressesByPriority.critical, ...addressesByPriority.high, ...addressesByPriority.low]).size,
    borrowerAddresses: borrowerAddresses.size, borrowerPositions: borrowersAtRisk.length,
    addressesByPriority, depositOnlyByPriority,
    priority: {
      critical: { positions: candidates.filter((c) => c.priority === "critical").length, addresses: addressesByPriority.critical.length, depositOnly: depositOnlyByPriority.critical.length },
      high: { positions: candidates.filter((c) => c.priority === "high").length, addresses: addressesByPriority.high.length, depositOnly: depositOnlyByPriority.high.length },
      low: { positions: candidates.filter((c) => c.priority === "low").length, addresses: addressesByPriority.low.length, depositOnly: depositOnlyByPriority.low.length },
    },
    networkStats, symbolStats, topStale: sorted.slice(0, topN), borrowersAtRisk,
    depositOnlyMarkets: [...depositOnlyMarkets.values()].map((m) => ({ ...m, symbols: [...m.symbols] })).sort((a, b) => b.count - a.count),
  };
}

function formatDuration(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h ago`;
}

function fmtTs(e) {
  if (!e) return "n/a";
  return new Date(e * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Header + priority + by network + by market table (matches CLI summary through “By Market”). */
export function formatStalenessSummaryDiscordBlock(summary) {
  const { priority } = summary;
  const lines = [];
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
  for (const s of summary.symbolStats) {
    lines.push(`  ${s.symbol.padEnd(10)} ${String(s.count).padStart(6)} ${s.avgDrift.toFixed(2).padStart(10)} ${s.maxDrift.toFixed(2).padStart(10)} ${String(s.borrowers).padStart(10)}`);
  }
  return lines.join("\n");
}

export function formatSummaryText(summary, topN, auditFile) {
  const lines = [...formatStalenessSummaryDiscordBlock(summary).split("\n"), ""];
  lines.push(`─── Top ${topN} Most Stale Positions ─────────────────────────`);
  for (let i = 0; i < summary.topStale.length; i++) {
    const c = summary.topStale[i];
    const ar = c.priceChangePercent >= 0 ? "↑" : "↓";
    lines.push(`  ${String(i + 1).padStart(2)}. ${c.symbol.padEnd(8)} ${ar} ${Math.abs(c.priceChangePercent).toFixed(2)}%${c.scaledBorrows > 0 ? "  ** BORROWER **" : ""}`);
    lines.push(`      last=${c.userLastPrice}  now=${c.currentMarketPrice}  deposits=${c.scaledDeposits}  borrows=${c.scaledBorrows}`);
    lines.push(`      ${c.address}  (${c.network})`);
    lines.push(`      pool=${c.poolId}  contract=${c.contractId}  updated=${fmtTs(c.lastUpdateTime)}`);
  }
  lines.push("");
  if (summary.borrowersAtRisk.length > 0) {
    lines.push("─── Borrowers at Risk ───────────────────────────────────────");
    for (const c of summary.borrowersAtRisk) {
      const ar = c.priceChangePercent >= 0 ? "↑" : "↓";
      lines.push(`  [${c.priority.toUpperCase()}] ${c.symbol.padEnd(8)} ${ar} ${Math.abs(c.priceChangePercent).toFixed(2)}%`);
      lines.push(`      ${c.address}  (${c.network})`);
    }
    lines.push("");
  }
  const NET = { "voi-mainnet": "voi", "algorand-mainnet": "algorand" };
  const file = auditFile ?? "<audit.json>";
  const depTotal = summary.priority.critical.depositOnly + summary.priority.high.depositOnly;
  const chains = summary.networkStats.map((ns) => NET[ns.network] ?? ns.network);
  lines.push("─── Suggested Commands ─────────────────────────────────────");
  if (depTotal > 0) {
    lines.push(`  Sync deposit-only (${depTotal} addrs critical+high):`);
    lines.push(`    npm run sync:position -- ${file} --deposit-only`);
    for (const m of summary.depositOnlyMarkets) {
      lines.push(`    npm run sync:position -- ${file} --deposit-only --chain ${m.chain} --contract-id ${m.contractId}  # ${m.symbols.join(", ")}`);
    }
    lines.push("");
  }
  if (summary.borrowersAtRisk.length > 0) {
    const ub = new Map();
    for (const c of summary.borrowersAtRisk) {
      if (!ub.has(c.address)) ub.set(c.address, { chain: NET[c.network], symbols: new Set() });
      ub.get(c.address).symbols.add(c.symbol);
    }
    lines.push(`  Warn at-risk (${ub.size}):`);
    for (const [addr, info] of [...ub.entries()].slice(0, 5)) {
      lines.push(`    npm run notify -- --mode send-one --chain ${info.chain} --address ${addr}  # ${[...info.symbols].join(", ")}`);
    }
    lines.push("");
  }
  for (const ch of chains) lines.push(`    npm run broadcast:notification -- --chain ${ch}`);
  if (summary.topStale[0]) {
    const t = summary.topStale[0];
    lines.push(`    npm run audit -- --mode account -- ${t.address} --chain ${NET[t.network]}`);
  }
  lines.push(`    npm run audit -- --mode staleness --json -o audit.json`);
  lines.push("═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}
