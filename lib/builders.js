import { abi, CONTRACT } from "ulujs";
import {
  resolveMarket,
  getAlgodClient,
  getChainConfig,
  simulateABICall,
  ABI_METHODS,
} from "./client.js";
import algosdk from "algosdk";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const lendingPoolABI = require("../data/lending-pool-abi.json");

const ALGORAND_BEACON_ID = 3209233839;

function toBaseUnits(amount, decimals) {
  const parts = String(amount).split(".");
  const whole = parts[0];
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + frac);
}

function makeSigner(addr) {
  return { addr, sk: new Uint8Array() };
}

function appAddr(appId) {
  return algosdk.getApplicationAddress(appId);
}

function appAddrStr(appId) {
  const addr = algosdk.getApplicationAddress(appId);
  return algosdk.encodeAddress(addr.publicKey);
}

function encodeNote(text) {
  return new TextEncoder().encode(text);
}

function getForeignApps(config) {
  return config.oracleApps || [];
}

function makeBuilders(algod, market, sender) {
  const signer = makeSigner(sender);
  const lendingABI = { ...lendingPoolABI, events: [] };
  return {
    ci: new CONTRACT(market.poolId, algod, undefined, abi.custom, signer),
    lending: new CONTRACT(market.poolId, algod, undefined, lendingABI, signer, true, false, true),
    token: new CONTRACT(market.contractId, algod, undefined, abi.nt200, signer, true, false, true),
  };
}

/**
 * Build unsigned supply (deposit) transactions.
 * Follows the next-branch dorkfi-app deposit flow:
 *   - network tokens: createBalanceBox(user) + nt200.deposit (wraps native VOI/ALGO)
 *   - asa tokens: nt200.deposit (wraps ASA)
 *   - arc200 tokens: no wrapping needed
 * Then: arc200_approve → lending.deposit
 * Retries with multiple param combos for box creation / approve / deposit cost.
 */
export async function prepareSupply(chain, poolId, marketId, amount, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const poolAddrStr = appAddrStr(market.poolId);
  const { ci, lending, token } = makeBuilders(algod, market, sender);
  const foreignApps = getForeignApps(config);

  const approveAmount = baseAmount + baseAmount / 10n;

  let needsBalanceBox = false;
  let adjustedDepositAmount = baseAmount;

  if (market.tokenStandard === "network" || market.tokenStandard === "asa") {
    const balR = await token.arc200_balanceOf(sender);
    if (balR.success) {
      const existingBalance = BigInt(balR.returnValue);
      if (existingBalance >= baseAmount) {
        adjustedDepositAmount = 0n;
      } else {
        adjustedDepositAmount = baseAmount - existingBalance;
      }
    } else {
      needsBalanceBox = true;
    }
  }

  let customTx;
  const errors = [];

  for (const [p1, p2, p3] of [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 0, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ]) {
    const buildN = [];

    if (market.tokenStandard === "network") {
      const wantBox = needsBalanceBox ? true : p1 > 0;
      if (wantBox) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28500, note: encodeNote("nt200 createBalanceBox") });
      }
      if (adjustedDepositAmount > 0n) {
        const txnO = (await token.deposit(adjustedDepositAmount)).obj;
        buildN.push({ ...txnO, payment: adjustedDepositAmount, note: encodeNote("nt200 deposit") });
      }
    } else if (market.tokenStandard === "asa") {
      if (adjustedDepositAmount > 0n) {
        const payment = p1 > 0 ? 28501 : 0;
        const txnO = (await token.deposit(adjustedDepositAmount)).obj;
        buildN.push({
          ...txnO,
          payment,
          aamt: adjustedDepositAmount,
          xaid: market.assetId,
          note: encodeNote("nt200 deposit"),
        });
      }
    }

    {
      const txnO = (await token.arc200_approve(poolAddrStr, approveAmount)).obj;
      buildN.push({ ...txnO, payment: p2 > 0 ? 28502 : 0, note: encodeNote("arc200 approve") });
    }

    {
      const payment = p3 > 0 ? 9e5 : 1e5;
      const txnO = (await lending.deposit(market.contractId, baseAmount)).obj;
      buildN.push({ ...txnO, payment, note: encodeNote("lending deposit"), foreignApps });
    }

    ci.setFee(20000);
    ci.setEnableGroupResourceSharing(true);
    ci.setExtraTxns(buildN);
    if (config.networkId === "algorand-mainnet") {
      ci.setBeaconId(ALGORAND_BEACON_ID);
    }

    customTx = await ci.custom();
    if (customTx.success) break;
    errors.push(`[${p1},${p2},${p3}]: ${customTx?.error || customTx?.message || JSON.stringify(customTx)}`);
  }

  if (!customTx?.success) {
    throw new Error(`Failed to build supply transaction. Attempts:\n${errors.join("\n")}`);
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "supply",
      chain,
      marketId: market.contractId,
      symbol: market.symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      poolId: market.poolId,
      contractId: market.contractId,
      nTokenId: market.nTokenId,
      sender,
    },
  };
}

/**
 * Build unsigned borrow transactions.
 * After borrowing ARC-200 tokens from the pool, unwraps to native/ASA for
 * network and asa token standards.
 */
export async function prepareBorrow(chain, poolId, marketId, amount, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const { ci, lending, token } = makeBuilders(algod, market, sender);
  const foreignApps = getForeignApps(config);

  let customTx;

  for (const [p1, p2] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]) {
    const buildN = [];

    if (p1 > 0 && market.tokenStandard !== "arc200") {
      const txnO = (await token.createBalanceBox(sender)).obj;
      buildN.push({ ...txnO, payment: 28500, note: encodeNote("nt200 createBalanceBox") });
    }

    {
      const borrowCost = p2 > 0 ? 9e5 : 1e5;
      const txnO = (await lending.borrow(market.contractId, baseAmount)).obj;
      buildN.push({ ...txnO, payment: borrowCost, note: encodeNote("lending borrow"), foreignApps });
    }

    if (market.tokenStandard !== "arc200") {
      const txnO = (await token.withdraw(baseAmount)).obj;
      buildN.push({ ...txnO, note: encodeNote("nt200 withdraw") });
    }

    ci.setFee(20000);
    ci.setEnableGroupResourceSharing(true);
    ci.setExtraTxns(buildN);
    if (config.networkId === "algorand-mainnet") {
      ci.setBeaconId(ALGORAND_BEACON_ID);
    }

    customTx = await ci.custom();
    if (customTx.success) break;
  }

  if (!customTx?.success) {
    throw new Error("Failed to build borrow transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "borrow",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned repay transactions.
 * Wraps native/ASA tokens before repaying, matching the supply wrapping logic.
 * Then approves the pool and calls lending.repay.
 */
export async function prepareRepay(chain, poolId, marketId, amount, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const poolAddrStr = appAddrStr(market.poolId);
  const { ci, lending, token } = makeBuilders(algod, market, sender);

  let customTx;

  for (const [p1, p2] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const buildN = [];

    if (market.tokenStandard === "network") {
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28500, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(baseAmount)).obj;
        buildN.push({ ...txnO, payment: baseAmount, note: encodeNote("nt200 deposit") });
      }
    } else if (market.tokenStandard === "asa") {
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28501, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(baseAmount)).obj;
        buildN.push({
          ...txnO,
          aamt: baseAmount,
          xaid: market.assetId,
          note: encodeNote("nt200 deposit"),
        });
      }
    }

    {
      const txnO = (await token.arc200_approve(poolAddrStr, baseAmount)).obj;
      buildN.push({ ...txnO, payment: p2 > 0 ? 28502 : 0, note: encodeNote("arc200 approve") });
    }

    {
      const txnO = (await lending.repay(market.contractId, baseAmount)).obj;
      buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending repay") });
    }

    ci.setFee(1e5);
    ci.setEnableGroupResourceSharing(true);
    ci.setExtraTxns(buildN);
    if (config.networkId === "algorand-mainnet") {
      ci.setBeaconId(ALGORAND_BEACON_ID);
    }

    customTx = await ci.custom();
    if (customTx.success) break;
  }

  if (!customTx?.success) {
    throw new Error("Failed to build repay transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "repay",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned repay-on-behalf transactions.
 * The sender repays another borrower's debt. Wraps tokens if needed,
 * approves the pool, then calls lending.repay_on_behalf.
 */
export async function prepareRepayOnBehalf(chain, poolId, marketId, amount, borrower, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const poolAddrStr = appAddrStr(market.poolId);
  const { ci, lending, token } = makeBuilders(algod, market, sender);

  let customTx;

  for (const [p1, p2] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const buildN = [];

    if (market.tokenStandard === "network") {
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28500, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(baseAmount)).obj;
        buildN.push({ ...txnO, payment: baseAmount, note: encodeNote("nt200 deposit") });
      }
    } else if (market.tokenStandard === "asa") {
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28501, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(baseAmount)).obj;
        buildN.push({
          ...txnO,
          aamt: baseAmount,
          xaid: market.assetId,
          note: encodeNote("nt200 deposit"),
        });
      }
    }

    {
      const txnO = (await token.arc200_approve(poolAddrStr, baseAmount)).obj;
      buildN.push({ ...txnO, payment: p2 > 0 ? 28502 : 0, note: encodeNote("arc200 approve") });
    }

    {
      const txnO = (await lending.repay_on_behalf(market.contractId, baseAmount, borrower)).obj;
      buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending repay_on_behalf") });
    }

    ci.setFee(1e5);
    ci.setEnableGroupResourceSharing(true);
    ci.setExtraTxns(buildN);
    if (config.networkId === "algorand-mainnet") {
      ci.setBeaconId(ALGORAND_BEACON_ID);
    }

    customTx = await ci.custom();
    if (customTx.success) break;
  }

  if (!customTx?.success) {
    throw new Error("Failed to build repay-on-behalf transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "repay_on_behalf",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      borrower,
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned repay-all transactions.
 * Queries the user's full borrow amount on-chain, wraps tokens if needed,
 * approves the pool, then calls lending.repay_all.
 */
export async function prepareRepayAll(chain, poolId, marketId, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const poolAddrStr = appAddrStr(market.poolId);
  const { ci, lending, token } = makeBuilders(algod, market, sender);

  const mr = await simulateABICall(
    chain,
    market.poolId,
    ABI_METHODS.get_user_borrow_amount,
    [sender, market.contractId]
  );
  const borrowAmount = BigInt(mr.returnValue);
  if (borrowAmount === 0n)
    throw new Error(`No outstanding borrows for pool ${poolId} market ${marketId} (${market.symbol})`);

  const wrapAmount = borrowAmount + borrowAmount / 100n;

  let customTx;

  for (const [p1, p2] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const buildN = [];

    if (market.tokenStandard === "network") {
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28500, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(wrapAmount)).obj;
        buildN.push({ ...txnO, payment: wrapAmount, note: encodeNote("nt200 deposit") });
      }
    } else if (market.tokenStandard === "asa") {
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28501, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(wrapAmount)).obj;
        buildN.push({
          ...txnO,
          aamt: wrapAmount,
          xaid: market.assetId,
          note: encodeNote("nt200 deposit"),
        });
      }
    }

    {
      const txnO = (await token.arc200_approve(poolAddrStr, wrapAmount)).obj;
      buildN.push({ ...txnO, payment: p2 > 0 ? 28502 : 0, note: encodeNote("arc200 approve") });
    }

    {
      const txnO = (await lending.repay_all(market.contractId)).obj;
      buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending repay_all") });
    }

    ci.setFee(1e5);
    ci.setEnableGroupResourceSharing(true);
    ci.setExtraTxns(buildN);
    if (config.networkId === "algorand-mainnet") {
      ci.setBeaconId(ALGORAND_BEACON_ID);
    }

    customTx = await ci.custom();
    if (customTx.success) break;
  }

  if (!customTx?.success) {
    throw new Error("Failed to build repay-all transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "repay_all",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      borrowAmount: borrowAmount.toString(),
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned withdraw transactions.
 * Withdraws from the lending pool, then unwraps to native/ASA for
 * non-arc200 token standards.
 */
export async function prepareWithdraw(chain, poolId, marketId, amount, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const { ci, lending, token } = makeBuilders(algod, market, sender);

  const buildN = [];

  {
    const txnO = (await lending.withdraw(market.contractId, baseAmount)).obj;
    buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending withdraw") });
  }

  if (market.tokenStandard !== "arc200") {
    const txnO = (await token.withdraw(baseAmount)).obj;
    buildN.push({ ...txnO, note: encodeNote("nt200 withdraw") });
  }

  ci.setFee(20000);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  const customTx = await ci.custom();

  if (!customTx.success) {
    throw new Error("Failed to build withdraw transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "withdraw",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      contractId: market.contractId,
      nTokenId: market.nTokenId,
      sender,
    },
  };
}

/**
 * Build unsigned fetch_price_feed transaction.
 * Triggers the contract to fetch the latest oracle price for a market.
 */
export async function prepareFetchPriceFeed(chain, poolId, marketId, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const signer = makeSigner(sender);
  const lendingABI = { ...lendingPoolABI, events: [] };
  const ci = new CONTRACT(market.poolId, algod, undefined, abi.custom, signer);
  const lending = new CONTRACT(market.poolId, algod, undefined, lendingABI, signer, true, false, true);
  const foreignApps = getForeignApps(config);

  const buildN = [];

  {
    const txnO = (await lending.fetch_price_feed(market.contractId)).obj;
    buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending fetch_price_feed"), foreignApps });
  }

  ci.setFee(20000);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  const customTx = await ci.custom();

  if (!customTx.success) {
    throw new Error("Failed to build fetch_price_feed transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "fetch_price_feed",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned sync_market transaction.
 * Updates market indices and state (interest accrual, etc.).
 */
export async function prepareSyncMarket(chain, poolId, marketId, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const signer = makeSigner(sender);
  const lendingABI = { ...lendingPoolABI, events: [] };
  const ci = new CONTRACT(market.poolId, algod, undefined, abi.custom, signer);
  const lending = new CONTRACT(market.poolId, algod, undefined, lendingABI, signer, true, false, true);
  const foreignApps = getForeignApps(config);

  const buildN = [];

  {
    const txnO = (await lending.sync_market(market.contractId)).obj;
    buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending sync_market"), foreignApps });
  }

  ci.setFee(20000);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  const customTx = await ci.custom();

  if (!customTx.success) {
    throw new Error("Failed to build sync_market transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "sync_market",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned withdraw_reserves transaction.
 * Owner/admin function to withdraw accumulated reserves from a market.
 */
export async function prepareWithdrawReserves(chain, poolId, marketId, amount, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const signer = makeSigner(sender);
  const lendingABI = { ...lendingPoolABI, events: [] };
  const ci = new CONTRACT(market.poolId, algod, undefined, abi.custom, signer);
  const lending = new CONTRACT(market.poolId, algod, undefined, lendingABI, signer, true, false, true);

  const buildN = [];

  {
    const txnO = (await lending.withdraw_reserves(market.contractId, baseAmount)).obj;
    buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending withdraw_reserves") });
  }

  ci.setFee(20000);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  const customTx = await ci.custom();

  if (!customTx.success) {
    throw new Error("Failed to build withdraw_reserves transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "withdraw_reserves",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned sync_user_market_for_price_change transaction.
 * Updates a user's collateral/borrow values in a market after an oracle
 * price change. Simple app call with no wrapping or approval needed.
 */
export async function prepareSyncUserMarket(chain, poolId, marketId, user, sender) {
  const market = resolveMarket(chain, poolId, marketId);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const signer = makeSigner(sender);
  const lendingABI = { ...lendingPoolABI, events: [] };
  const ci = new CONTRACT(market.poolId, algod, undefined, abi.custom, signer);
  const lending = new CONTRACT(market.poolId, algod, undefined, lendingABI, signer, true, false, true);
  const foreignApps = getForeignApps(config);

  const buildN = [];

  {
    const txnO = (await lending.sync_user_market_for_price_change(user, market.contractId)).obj;
    buildN.push({ ...txnO, payment: 1e5, note: encodeNote("lending sync_user_market"), foreignApps });
  }

  ci.setFee(20000);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  const customTx = await ci.custom();

  if (!customTx.success) {
    throw new Error("Failed to build sync_user_market transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "sync_user_market_for_price_change",
      chain,
      poolId: market.poolId,
      marketId: market.contractId,
      symbol: market.symbol,
      user,
      contractId: market.contractId,
      sender,
    },
  };
}

/**
 * Build unsigned liquidation transactions.
 * Wraps debt tokens if needed, approves the pool, then calls
 * liquidate_cross_market (debt_market first, collateral_market second).
 */
export async function prepareLiquidation(
  chain,
  poolId,
  debtMarketId,
  collateralMarketId,
  borrower,
  amount,
  sender
) {
  const debtMarket = resolveMarket(chain, poolId, debtMarketId);
  const collateralMarket = resolveMarket(chain, poolId, collateralMarketId);
  if (debtMarket.poolId !== collateralMarket.poolId) {
    throw new Error("debt and collateral markets must belong to the same poolId");
  }

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, debtMarket.decimals);
  const poolAddr = appAddr(debtMarket.poolId);

  const signer = makeSigner(sender);
  const lendingABI = { ...lendingPoolABI, events: [] };
  const ci = new CONTRACT(debtMarket.poolId, algod, undefined, abi.custom, signer);
  const lending = new CONTRACT(debtMarket.poolId, algod, undefined, lendingABI, signer, true, false, true);
  const debtToken = new CONTRACT(debtMarket.contractId, algod, undefined, abi.nt200, signer, true, false, true);

  const buildN = [];

  if (debtMarket.tokenStandard === "network") {
    {
      const txnO = (await debtToken.deposit(baseAmount)).obj;
      buildN.push({ ...txnO, payment: baseAmount, note: encodeNote("nt200 deposit") });
    }
  } else if (debtMarket.tokenStandard === "asa") {
    const txnO = (await debtToken.deposit(baseAmount)).obj;
    buildN.push({
      ...txnO,
      aamt: baseAmount,
      xaid: debtMarket.assetId,
      note: encodeNote("nt200 deposit"),
    });
  }

  {
    const txnO = (await debtToken.arc200_approve(poolAddr, baseAmount)).obj;
    buildN.push({ ...txnO, note: encodeNote("arc200 approve") });
  }

  {
    const txnO = (await lending.liquidate_cross_market(
      debtMarket.contractId,
      collateralMarket.contractId,
      borrower,
      baseAmount,
      0n
    )).obj;
    // Pool expects modest inbound pay for liquidate (matches working liquidateCrossMarket tests).
    buildN.push({ ...txnO, payment: 2e5, note: encodeNote("lending liquidate") });
  }

  // Per-txn fee: ~8000 is smallest that simulates for WAD/CORN liquidate group on Voi; below that algod rejects (underpaid).
  ci.setFee(8_000);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  let customTx = await ci.custom();
  if (!customTx.success) {
    ci.setFee(100_000);
    customTx = await ci.custom();
  }

  if (!customTx.success) {
    const err =
      customTx.error ||
      customTx.message ||
      (typeof customTx === "object" ? JSON.stringify(customTx, null, 2).slice(0, 2000) : String(customTx));
    throw new Error(`Failed to build liquidation transaction: ${err}`);
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "liquidation",
      chain,
      poolId: debtMarket.poolId,
      debtMarketId: debtMarket.contractId,
      collateralMarketId: collateralMarket.contractId,
      debtSymbol: debtMarket.symbol,
      collateralSymbol: collateralMarket.symbol,
      borrower,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      sender,
    },
  };
}
