#!/usr/bin/env node

/**
 * Audit a single account by enVoi name across all DorkFi lending markets.
 *
 * Resolves an enVoi name (e.g. "shelly.voi") to its on-chain address, then
 * delegates to audit-account.js with the resolved address plus any extra
 * options passed through.
 *
 * Usage:
 *   node scripts/audit-name.js <name.voi> [options]
 *
 * Options:
 *   All options from audit-account.js are forwarded as-is.
 *   --chain <voi|algorand>   Scan a single chain (default: both)
 *   --submit                 Sign and submit sync transactions
 *   --dry-run                Build txns but don't submit (default)
 *   --json                   Output raw JSON
 *   --concurrency <N>        Max parallel operations (default: 4)
 *   --output, -o <path>      Write output to file
 *
 * Environment:
 *   MN   25-word Algorand mnemonic for signing (required for --submit)
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ENVOI_RESOLVER_APP = 797609;
const VOI_ALGOD = "https://mainnet-api.voi.nodely.dev";

async function resolveEnvoiName(name) {
  const algodUrl = VOI_ALGOD;
  const label = name.replace(/\.voi$/i, "");

  const boxName = new TextEncoder().encode(label);
  const b64 = Buffer.from(boxName).toString("base64");

  const resp = await fetch(
    `${algodUrl}/v2/applications/${ENVOI_RESOLVER_APP}/box?name=b64:${b64}`,
    { headers: { "X-Algo-API-Token": "" } },
  );

  if (!resp.ok) {
    throw new Error(
      `Failed to resolve "${name}" — ${resp.status} ${resp.statusText}`,
    );
  }

  const { value } = await resp.json();
  const raw = Buffer.from(value, "base64");

  const addrBytes = raw.slice(0, 32);
  const { default: algosdk } = await import("algosdk");
  const address = algosdk.encodeAddress(addrBytes);
  return address;
}

function parseNameArg() {
  const args = process.argv.slice(2);
  let name = null;
  const rest = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      console.log(`Usage: node scripts/audit-name.js <name.voi> [options]

  <name.voi>               enVoi name to resolve and audit (e.g. shelly.voi)

  All other options are forwarded to audit-account.js:
  --chain <voi|algorand>   Scan a single chain (default: both)
  --submit                 Sign and submit sync transactions
  --dry-run                Build txns but don't submit (default)
  --json                   Output raw JSON
  --concurrency <N>        Max parallel operations (default: 4)
  --output, -o <path>      Write output to file

Environment:
  MN   25-word Algorand mnemonic for signing (required for --submit)`);
      process.exit(0);
    }

    if (!args[i].startsWith("--") && !name) {
      name = args[i];
    } else {
      rest.push(args[i]);
    }
  }

  if (!name) {
    console.error("Error: Please provide an enVoi name to audit (e.g. shelly.voi).");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  if (!name.endsWith(".voi")) {
    name += ".voi";
  }

  return { name, rest };
}

async function main() {
  const { name, rest } = parseNameArg();

  console.error(`Resolving enVoi name "${name}"...`);
  const address = await resolveEnvoiName(name);
  console.error(`Resolved to ${address}\n`);

  const thisFile = fileURLToPath(import.meta.url);
  const auditScript = path.join(path.dirname(thisFile), "audit-account.js");

  try {
    execFileSync("node", [auditScript, address, ...rest], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
