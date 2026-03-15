import { abi, CONTRACT } from "ulujs";
import { findMarket, getAlgodClient, getChainConfig, simulateABICall, ABI_METHODS } from "./client.js";
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
export async function prepareSupply(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const config = getChainConfig(chain);
  const algod = getAlgodClient(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const poolAddrStr = appAddrStr(market.poolId);
  const { ci, lending, token } = makeBuilders(algod, market, sender);
  const foreignApps = getForeignApps(config);

  const approveAmount = baseAmount + baseAmount / 10n;

  let customTx;

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
      if (p1 > 0) {
        const txnO = (await token.createBalanceBox(sender)).obj;
        buildN.push({ ...txnO, payment: 28500, note: encodeNote("nt200 createBalanceBox") });
      }
      {
        const txnO = (await token.deposit(baseAmount)).obj;
        buildN.push({ ...txnO, payment: baseAmount, note: encodeNote("nt200 deposit") });
      }
    } else if (market.tokenStandard === "asa") {
      const payment = p1 > 0 ? 28501 : 0;
      const txnO = (await token.deposit(baseAmount)).obj;
      buildN.push({
        ...txnO,
        payment,
        aamt: baseAmount,
        xaid: market.assetId,
        note: encodeNote("nt200 deposit"),
      });
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
  }

  if (!customTx?.success) {
    throw new Error("Failed to build supply transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "supply",
      chain,
      symbol,
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
export async function prepareBorrow(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
      symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      poolId: market.poolId,
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
export async function prepareRepay(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
      symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      poolId: market.poolId,
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
export async function prepareRepayOnBehalf(chain, symbol, amount, borrower, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
      symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      borrower,
      poolId: market.poolId,
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
export async function prepareRepayAll(chain, symbol, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
  if (borrowAmount === 0n) throw new Error(`No outstanding borrows for ${symbol}`);

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
      symbol,
      borrowAmount: borrowAmount.toString(),
      poolId: market.poolId,
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
export async function prepareWithdraw(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
      symbol,
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
 * Build unsigned withdraw_reserves transaction.
 * Owner/admin function to withdraw accumulated reserves from a market.
 */
export async function prepareWithdrawReserves(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
      symbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      poolId: market.poolId,
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
export async function prepareSyncUserMarket(chain, symbol, user, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

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
      symbol,
      user,
      poolId: market.poolId,
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
  borrower,
  collateralSymbol,
  debtSymbol,
  amount,
  sender
) {
  const collateralMarket = findMarket(chain, collateralSymbol);
  if (!collateralMarket) throw new Error(`Collateral market "${collateralSymbol}" not found on ${chain}`);
  const debtMarket = findMarket(chain, debtSymbol);
  if (!debtMarket) throw new Error(`Debt market "${debtSymbol}" not found on ${chain}`);

  if (collateralMarket.poolId !== debtMarket.poolId) {
    throw new Error("Collateral and debt markets must be in the same pool");
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
    buildN.push({ ...txnO, payment: 2e6, note: encodeNote("lending liquidate") });
  }

  ci.setFee(1e5);
  ci.setEnableGroupResourceSharing(true);
  ci.setExtraTxns(buildN);
  if (config.networkId === "algorand-mainnet") {
    ci.setBeaconId(ALGORAND_BEACON_ID);
  }

  const customTx = await ci.custom();

  if (!customTx.success) {
    throw new Error("Failed to build liquidation transaction");
  }

  return {
    transactions: customTx.txns,
    details: {
      action: "liquidation",
      chain,
      borrower,
      collateralSymbol,
      debtSymbol,
      amount: amount.toString(),
      amountBaseUnits: baseAmount.toString(),
      poolId: debtMarket.poolId,
      sender,
    },
  };
}
