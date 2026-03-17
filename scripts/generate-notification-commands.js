#!/usr/bin/env node

/**
 * Generate shell commands to send notifications to at-risk DorkFi accounts.
 *
 * Fetches all user health data, filters for "on watch" (critical/high/moderate)
 * and "liquidatable" accounts, then outputs `send-liquidation-warning.js`
 * commands for each address.
 *
 * Usage:
 *   node scripts/generate-notification-commands.js --chain <voi|algorand> [options]
 *
 * Options:
 *   --chain <voi|algorand>       Target chain (required)
 *   --risk <levels>              Comma-separated risk levels to include
 *                                (default: liquidatable,critical,high,moderate)
 *   --threshold <number>         Max health factor to include (overrides --risk)
 *   --submit                     Add --submit flag to generated commands
 *   --output <file>              Write commands to file instead of stdout
 *   --json                       Output JSON report instead of shell commands
 *   --exclude <addrs>            Comma-separated addresses to exclude
 */

import { getAllUsers } from "../lib/positions.js";

const RISK_LEVELS = ["liquidatable", "critical", "high", "moderate"];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    chain: null,
    riskLevels: [...RISK_LEVELS],
    threshold: null,
    submit: false,
    output: null,
    json: false,
    exclude: new Set(),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" && args[i + 1]) {
      opts.chain = args[++i];
    } else if (args[i] === "--risk" && args[i + 1]) {
      opts.riskLevels = args[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (args[i] === "--threshold" && args[i + 1]) {
      opts.threshold = parseFloat(args[++i]);
    } else if (args[i] === "--submit") {
      opts.submit = true;
    } else if (args[i] === "--output" && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === "--json") {
      opts.json = true;
    } else if (args[i] === "--exclude" && args[i + 1]) {
      for (const a of args[++i].split(",")) opts.exclude.add(a.trim());
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/generate-notification-commands.js --chain <voi|algorand> [options]

  --chain <voi|algorand>       Target chain (required)
  --risk <levels>              Comma-separated risk levels (default: liquidatable,critical,high,moderate)
  --threshold <number>         Max health factor to include (overrides --risk)
  --submit                     Add --submit flag to generated commands
  --output <file>              Write output to file instead of stdout
  --json                       Output JSON report instead of shell commands
  --exclude <addrs>            Comma-separated addresses to skip`);
      process.exit(0);
    }
  }

  if (!opts.chain || !["voi", "algorand"].includes(opts.chain)) {
    console.error("Error: --chain <voi|algorand> is required.");
    process.exit(1);
  }

  return opts;
}

function matchesFilter(user, opts) {
  if (user.healthFactor === null) return false;
  if (opts.exclude.has(user.address)) return false;

  if (opts.threshold !== null) {
    return user.healthFactor <= opts.threshold;
  }

  return opts.riskLevels.includes(user.riskLevel);
}

function formatHealthFactor(hf) {
  if (hf === null) return "N/A";
  return hf.toFixed(4);
}

async function main() {
  const opts = parseArgs();

  console.error(`Fetching all users on ${opts.chain}...`);
  const { users } = await getAllUsers(opts.chain);

  const atRisk = users.filter((u) => matchesFilter(u, opts));

  console.error(`Total users:  ${users.length}`);
  console.error(`At-risk:      ${atRisk.length}`);
  if (opts.threshold !== null) {
    console.error(`Threshold:    HF <= ${opts.threshold}`);
  } else {
    console.error(`Risk levels:  ${opts.riskLevels.join(", ")}`);
  }
  console.error("");

  if (atRisk.length === 0) {
    console.error("No accounts match the filter criteria.");
    process.exit(0);
  }

  const grouped = {
    liquidatable: atRisk.filter((u) => u.riskLevel === "liquidatable"),
    critical: atRisk.filter((u) => u.riskLevel === "critical"),
    high: atRisk.filter((u) => u.riskLevel === "high"),
    moderate: atRisk.filter((u) => u.riskLevel === "moderate"),
  };

  const submitFlag = opts.submit ? " --submit" : "";
  const lines = [];

  if (opts.json) {
    const report = {
      timestamp: new Date().toISOString(),
      chain: opts.chain,
      filter: opts.threshold !== null
        ? { threshold: opts.threshold }
        : { riskLevels: opts.riskLevels },
      totalUsers: users.length,
      summary: {
        liquidatable: grouped.liquidatable.length,
        critical: grouped.critical.length,
        high: grouped.high.length,
        moderate: grouped.moderate.length,
        total: atRisk.length,
      },
      accounts: atRisk.map((u) => ({
        address: u.address,
        healthFactor: u.healthFactor,
        riskLevel: u.riskLevel,
        totalCollateralUSD: u.totalCollateralUSD,
        totalBorrowUSD: u.totalBorrowUSD,
        poolCount: u.poolCount,
        command: `node scripts/send-liquidation-warning.js --chain ${opts.chain} --address ${u.address}${submitFlag}`,
      })),
    };
    const output = JSON.stringify(report, null, 2);
    if (opts.output) {
      const fs = await import("node:fs");
      fs.writeFileSync(opts.output, output + "\n");
      console.error(`JSON report written to ${opts.output}`);
    } else {
      console.log(output);
    }
    process.exit(0);
  }

  lines.push("#!/usr/bin/env bash");
  lines.push(`# DorkFi notification commands — ${opts.chain}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(`# Total at-risk accounts: ${atRisk.length}`);
  lines.push("");

  for (const [level, label] of [
    ["liquidatable", "LIQUIDATABLE (HF <= 1.0)"],
    ["critical", "CRITICAL (HF <= 1.1)"],
    ["high", "HIGH (HF <= 1.2)"],
    ["moderate", "MODERATE (HF <= 1.5)"],
  ]) {
    const accounts = grouped[level];
    if (accounts.length === 0) continue;

    lines.push(`# ── ${label} — ${accounts.length} account(s) ──`);
    for (const u of accounts) {
      lines.push(
        `# HF: ${formatHealthFactor(u.healthFactor)} | ` +
          `Collateral: $${u.totalCollateralUSD.toFixed(2)} | ` +
          `Borrow: $${u.totalBorrowUSD.toFixed(2)}`,
      );
      lines.push(
        `node scripts/send-liquidation-warning.js --chain ${opts.chain} --address ${u.address}${submitFlag}`,
      );
      lines.push("");
    }
  }

  const output = lines.join("\n");
  if (opts.output) {
    const fs = await import("node:fs");
    fs.writeFileSync(opts.output, output + "\n");
    console.error(`Commands written to ${opts.output}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
