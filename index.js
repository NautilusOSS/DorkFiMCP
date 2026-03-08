import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getMarkets } from "./lib/markets.js";
import { getPosition, getHealthFactor } from "./lib/positions.js";
import { getLiquidationCandidates } from "./lib/liquidation.js";
import { fetchTVL } from "./lib/api.js";
import {
  prepareSupply,
  prepareBorrow,
  prepareRepay,
  prepareWithdraw,
  prepareLiquidation,
} from "./lib/builders.js";

const server = new McpServer({
  name: "dorkfi-mcp",
  version: "0.2.0",
});

const ChainEnum = z.enum(["voi", "algorand"]);

// --- Market tools ---

server.tool(
  "get_markets",
  "List DorkFi lending markets with live data (rates, deposits, borrows, prices). Optionally filter by symbol.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    symbol: z.string().optional().describe("Filter by token symbol (e.g. VOI, USDC)"),
  },
  async ({ chain, symbol }) => {
    const markets = await getMarkets(chain, symbol);
    return { content: [{ type: "text", text: JSON.stringify(markets, null, 2) }] };
  }
);

server.tool(
  "get_tvl",
  "Get total value locked (TVL) across DorkFi lending pools. Returns TVL per market and aggregate totals.",
  {
    chain: ChainEnum.optional().describe("Filter by chain, or omit for all chains"),
  },
  async ({ chain }) => {
    const tvl = await fetchTVL(chain);
    return { content: [{ type: "text", text: JSON.stringify(tvl, null, 2) }] };
  }
);

// --- Position tools ---

server.tool(
  "get_position",
  "Get a user's DorkFi lending positions across all markets. Returns per-pool health factors and portfolio summary.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    address: z.string().describe("User wallet address"),
    symbol: z.string().optional().describe("Filter by token symbol"),
  },
  async ({ chain, address, symbol }) => {
    const position = await getPosition(chain, address, symbol);
    return { content: [{ type: "text", text: JSON.stringify(position, null, 2) }] };
  }
);

server.tool(
  "get_health_factor",
  "Check a user's health factor and risk level per pool. Health factor <= 1.0 means the position is liquidatable.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    address: z.string().describe("User wallet address"),
  },
  async ({ chain, address }) => {
    const health = await getHealthFactor(chain, address);
    return { content: [{ type: "text", text: JSON.stringify(health, null, 2) }] };
  }
);

// --- Liquidation tools ---

server.tool(
  "get_liquidation_candidates",
  "Find accounts eligible for liquidation using pre-indexed health data. Returns those below the health factor threshold.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    threshold: z
      .number()
      .optional()
      .default(1.1)
      .describe("Health factor threshold (default 1.1)"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max results to return (default 50)"),
    addresses: z
      .array(z.string())
      .optional()
      .describe("Specific addresses to check instead of scanning all"),
  },
  async ({ chain, threshold, limit, addresses }) => {
    const result = await getLiquidationCandidates(chain, {
      threshold,
      limit,
      addresses: addresses || [],
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Transaction preparation tools ---

server.tool(
  "deposit_txn",
  "Build unsigned transactions to deposit (supply) tokens into a DorkFi lending market. Returns base64-encoded transactions for signing via UluWalletMCP.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    symbol: z.string().describe("Token symbol to supply (e.g. VOI, USDC)"),
    amount: z.string().describe("Amount in human-readable units (e.g. '100' for 100 VOI)"),
    sender: z.string().describe("Sender wallet address"),
  },
  async ({ chain, symbol, amount, sender }) => {
    const result = await prepareSupply(chain, symbol, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "borrow_txn",
  "Build unsigned transactions to borrow tokens from a DorkFi lending market. Requires sufficient collateral. Returns base64-encoded transactions for signing.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    symbol: z.string().describe("Token symbol to borrow"),
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Borrower wallet address"),
  },
  async ({ chain, symbol, amount, sender }) => {
    const result = await prepareBorrow(chain, symbol, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "repay_txn",
  "Build unsigned transactions to repay borrowed tokens to a DorkFi lending market. Returns base64-encoded transactions for signing.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    symbol: z.string().describe("Token symbol to repay"),
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Repayer wallet address"),
  },
  async ({ chain, symbol, amount, sender }) => {
    const result = await prepareRepay(chain, symbol, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "withdraw_txn",
  "Build unsigned transactions to withdraw supplied tokens from a DorkFi lending market. Returns base64-encoded transactions for signing.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    symbol: z.string().describe("Token symbol to withdraw"),
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Withdrawer wallet address"),
  },
  async ({ chain, symbol, amount, sender }) => {
    const result = await prepareWithdraw(chain, symbol, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "liquidate_txn",
  "Build unsigned transactions to liquidate an undercollateralized position. The liquidator repays part of the debt and receives collateral at a bonus. Returns base64-encoded transactions for signing.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    borrower: z.string().describe("Address of the borrower to liquidate"),
    collateral_symbol: z.string().describe("Collateral token to seize"),
    debt_symbol: z.string().describe("Debt token to repay"),
    amount: z.string().describe("Amount of debt to repay in human-readable units"),
    sender: z.string().describe("Liquidator wallet address"),
  },
  async ({ chain, borrower, collateral_symbol, debt_symbol, amount, sender }) => {
    const result = await prepareLiquidation(
      chain,
      borrower,
      collateral_symbol,
      debt_symbol,
      amount,
      sender
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
