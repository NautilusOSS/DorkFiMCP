import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getMarkets, getMarketOnChain, getIsPaused } from "./lib/markets.js";
import { getPosition, getHealthFactor, getUserOnChain, getGlobalUserOnChain, getAllUsers } from "./lib/positions.js";
import { getLiquidationCandidates } from "./lib/liquidation.js";
import { fetchTVL } from "./lib/api.js";
import {
  prepareSupply,
  prepareBorrow,
  prepareRepay,
  prepareRepayOnBehalf,
  prepareRepayAll,
  prepareWithdraw,
  prepareFetchPriceFeed,
  prepareSyncMarket,
  prepareWithdrawReserves,
  prepareSyncUserMarket,
  prepareLiquidation,
} from "./lib/builders.js";

const server = new McpServer({
  name: "dorkfi-mcp",
  version: "0.3.0",
});

const ChainEnum = z.enum(["voi", "algorand"]);

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  return { content: [{ type: "text", text: err.message || String(err) }], isError: true };
}

/** Lending pool app id (e.g. 47139778, 47139781 on Voi). */
const poolId = z.number().int().describe("Lending pool application id");
/** On-chain market id = ARC-200 / token contract id for that pool row (same as contractId in data/contracts.json). */
const marketId = z.number().int().describe("Market id (uint64 passed to pool; equals contractId in contracts.json)");

// --- Market tools ---

server.tool(
  "get_markets",
  "List DorkFi lending markets with live data. Each row includes poolId + marketId. Omit poolId/marketId to list all; pass both to fetch one market.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId: z.number().int().optional().describe("Lending pool app id"),
    marketId: z.number().int().optional().describe("Market id (contractId)"),
  },
  async ({ chain, poolId: pid, marketId: mid }) => {
    const filter =
      pid != null && mid != null ? { poolId: pid, marketId: mid } : null;
    const markets = await getMarkets(chain, filter);
    return { content: [{ type: "text", text: JSON.stringify(markets, null, 2) }] };
  }
);

server.tool(
  "get_market",
  "Get one lending market's full on-chain data via get_market(pool, marketId). Identify market by poolId + marketId (not symbol).",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
  },
  async ({ chain, poolId: pid, marketId: mid }) => {
    const market = await getMarketOnChain(chain, pid, mid);
    return { content: [{ type: "text", text: JSON.stringify(market, null, 2) }] };
  }
);

server.tool(
  "is_paused",
  "Check if DorkFi lending pool contracts are paused by calling the is_paused ABI method via algod simulate. Returns pause status for each pool.",
  {
    chain: ChainEnum.describe("Blockchain network"),
  },
  async ({ chain }) => {
    try { return ok(await getIsPaused(chain)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_tvl",
  "Get total value locked (TVL) across DorkFi lending pools. Returns TVL per market and aggregate totals.",
  {
    chain: ChainEnum.optional().describe("Filter by chain, or omit for all chains"),
  },
  async ({ chain }) => {
    try { return ok(await fetchTVL(chain)); } catch (e) { return fail(e); }
  }
);

// --- Position tools ---

server.tool(
  "get_position",
  "Get a user's DorkFi lending positions. Optional poolId + marketId narrows to one market row.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    address: z.string().describe("User wallet address"),
    poolId: z.number().int().optional().describe("Lending pool app id"),
    marketId: z.number().int().optional().describe("Market id (contractId)"),
  },
  async ({ chain, address, poolId: pid, marketId: mid }) => {
    const filter =
      pid != null && mid != null ? { poolId: pid, marketId: mid } : null;
    if ((pid != null) !== (mid != null)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "get_position requires both poolId and marketId, or neither",
            }),
          },
        ],
        isError: true,
      };
    }
    const position = await getPosition(chain, address, filter);
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
    try { return ok(await getHealthFactor(chain, address)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_user",
  "Get on-chain get_user for one market. Use poolId + marketId from get_markets (not symbol alone — WAD exists in two pools on Voi).",
  {
    chain: ChainEnum.describe("Blockchain network"),
    address: z.string().describe("User wallet address"),
    poolId,
    marketId,
  },
  async ({ chain, address, poolId: pid, marketId: mid }) => {
    const user = await getUserOnChain(chain, address, pid, mid);
    return { content: [{ type: "text", text: JSON.stringify(user, null, 2) }] };
  }
);

server.tool(
  "get_global_user",
  "Get a user's aggregate on-chain collateral and borrow values across all pools by calling the pool contract's get_global_user ABI method via algod simulate.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    address: z.string().describe("User wallet address"),
  },
  async ({ chain, address }) => {
    try { return ok(await getGlobalUserOnChain(chain, address)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_users",
  "List all DorkFi users with aggregate health factors, collateral, borrows, and risk levels. Sorted by health factor (most at-risk first).",
  {
    chain: ChainEnum.describe("Blockchain network"),
  },
  async ({ chain }) => {
    try { return ok(await getAllUsers(chain)); } catch (e) { return fail(e); }
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
    try {
      return ok(await getLiquidationCandidates(chain, { threshold, limit, addresses: addresses || [] }));
    } catch (e) { return fail(e); }
  }
);

// --- Transaction preparation ---

server.tool(
  "deposit_txn",
  "Build unsigned deposit (supply) txs. Market = poolId + marketId from get_markets.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Sender wallet address"),
  },
  async ({ chain, poolId: pid, marketId: mid, amount, sender }) => {
    const result = await prepareSupply(chain, pid, mid, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "borrow_txn",
  "Build unsigned borrow txs.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Borrower wallet address"),
  },
  async ({ chain, poolId: pid, marketId: mid, amount, sender }) => {
    const result = await prepareBorrow(chain, pid, mid, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "repay_txn",
  "Build unsigned repay txs.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Repayer wallet address"),
  },
  async ({ chain, poolId: pid, marketId: mid, amount, sender }) => {
    const result = await prepareRepay(chain, pid, mid, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "repay_on_behalf_txn",
  "Build unsigned repay-on-behalf txs.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    amount: z.string().describe("Amount in human-readable units"),
    borrower: z.string().describe("Borrower address"),
    sender: z.string().describe("Repayer wallet address"),
  },
  async ({ chain, poolId: pid, marketId: mid, amount, borrower, sender }) => {
    const result = await prepareRepayOnBehalf(chain, pid, mid, amount, borrower, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "repay_all_txn",
  "Build unsigned repay_all txs.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    sender: z.string().describe("Repayer wallet address"),
  },
  async ({ chain, poolId: pid, marketId: mid, sender }) => {
    const result = await prepareRepayAll(chain, pid, mid, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "withdraw_txn",
  "Build unsigned withdraw txs.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    amount: z.string().describe("Amount in human-readable units"),
    sender: z.string().describe("Withdrawer wallet address"),
  },
  async ({ chain, poolId: pid, marketId: mid, amount, sender }) => {
    const result = await prepareWithdraw(chain, pid, mid, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "fetch_price_feed_txn",
  "Build unsigned fetch_price_feed tx.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    sender: z.string().describe("Transaction sender"),
  },
  async ({ chain, poolId: pid, marketId: mid, sender }) => {
    const result = await prepareFetchPriceFeed(chain, pid, mid, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "sync_market_txn",
  "Build unsigned sync_market tx.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    sender: z.string().describe("Transaction sender"),
  },
  async ({ chain, poolId: pid, marketId: mid, sender }) => {
    const result = await prepareSyncMarket(chain, pid, mid, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "withdraw_reserves_txn",
  "Build unsigned withdraw_reserves (admin).",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    amount: z.string().describe("Reserves amount (human units)"),
    sender: z.string().describe("Owner/admin address"),
  },
  async ({ chain, poolId: pid, marketId: mid, amount, sender }) => {
    const result = await prepareWithdrawReserves(chain, pid, mid, amount, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "sync_user_market_for_price_change_txn",
  "Build unsigned sync_user_market_for_price_change tx.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    marketId,
    user: z.string().describe("User to sync"),
    sender: z.string().describe("Transaction sender"),
  },
  async ({ chain, poolId: pid, marketId: mid, user, sender }) => {
    const result = await prepareSyncUserMarket(chain, pid, mid, user, sender);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "liquidate_txn",
  "Liquidate: repay debt in debtMarketId, seize collateral in collateralMarketId. Same poolId for both. marketId = contractId from get_markets.",
  {
    chain: ChainEnum.describe("Blockchain network"),
    poolId,
    debtMarketId: z
      .number()
      .int()
      .describe("Debt market id (e.g. WAD = 47138068 in pool 47139781)"),
    collateralMarketId: z
      .number()
      .int()
      .describe("Collateral market id (e.g. CORN = 412682)"),
    borrower: z.string().describe("Borrower to liquidate"),
    amount: z.string().describe("Debt to repay (human units)"),
    sender: z.string().describe("Liquidator address"),
  },
  async ({
    chain,
    poolId: pid,
    debtMarketId,
    collateralMarketId,
    borrower,
    amount,
    sender,
  }) => {
    const result = await prepareLiquidation(
      chain,
      pid,
      debtMarketId,
      collateralMarketId,
      borrower,
      amount,
      sender
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
