import {
  findMarket,
  getAlgodClient,
  getChainConfig,
  ABI_METHODS,
  algosdk,
} from "./client.js";

function toBaseUnits(amount, decimals) {
  const parts = String(amount).split(".");
  const whole = parts[0];
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + frac);
}

function encodeNote(text) {
  return new TextEncoder().encode(text);
}

async function getParams(chain) {
  const algod = getAlgodClient(chain);
  return algod.getTransactionParams().do();
}

function appAddr(appId) {
  return algosdk.getApplicationAddress(appId);
}

function buildAppCallTxn(sender, appId, method, args, params, options = {}) {
  const sel = method.getSelector();
  const encodedArgs = [sel];
  for (let i = 0; i < args.length; i++) {
    const type = algosdk.ABIType.from(method.args[i].type.toString());
    encodedArgs.push(type.encode(args[i]));
  }

  const txn = algosdk.makeApplicationCallTxnFromObject({
    from: sender,
    appIndex: appId,
    appArgs: encodedArgs,
    suggestedParams: params,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    note: options.note ? encodeNote(options.note) : undefined,
  });

  if (options.foreignApps) {
    txn.appForeignApps = options.foreignApps;
  }

  return txn;
}

function txnToBase64(txn) {
  return Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64");
}

function assignGroupId(txns) {
  const group = algosdk.assignGroupID(txns);
  return group;
}

export async function prepareSupply(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const params = await getParams(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const poolAddr = appAddr(market.poolId);

  const txns = [];

  // 1. Approve the lending pool to spend tokens
  txns.push(
    buildAppCallTxn(
      sender,
      market.contractId,
      ABI_METHODS.arc200_approve,
      [poolAddr, baseAmount],
      params,
      { note: "dorkfi: approve for supply", foreignApps: [market.poolId] }
    )
  );

  // 2. Transfer tokens to pool (ARC-200 transfer)
  txns.push(
    buildAppCallTxn(
      sender,
      market.contractId,
      ABI_METHODS.arc200_transfer,
      [poolAddr, 0n],
      params,
      { note: "dorkfi: transfer for supply", foreignApps: [market.poolId] }
    )
  );

  // 3. Deposit into lending pool
  txns.push(
    buildAppCallTxn(
      sender,
      market.poolId,
      ABI_METHODS.deposit,
      [market.contractId, baseAmount],
      params,
      {
        note: "dorkfi: supply",
        foreignApps: [market.contractId, market.nTokenId],
      }
    )
  );

  const grouped = assignGroupId(txns);
  return {
    transactions: grouped.map(txnToBase64),
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

export async function prepareBorrow(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const params = await getParams(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);

  const txns = [];

  txns.push(
    buildAppCallTxn(
      sender,
      market.poolId,
      ABI_METHODS.borrow,
      [market.contractId, baseAmount],
      params,
      {
        note: "dorkfi: borrow",
        foreignApps: [market.contractId, market.nTokenId],
      }
    )
  );

  const grouped = assignGroupId(txns);
  return {
    transactions: grouped.map(txnToBase64),
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

export async function prepareRepay(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const params = await getParams(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);
  const poolAddr = appAddr(market.poolId);

  const txns = [];

  // 1. Approve pool to pull tokens
  txns.push(
    buildAppCallTxn(
      sender,
      market.contractId,
      ABI_METHODS.arc200_approve,
      [poolAddr, baseAmount],
      params,
      { note: "dorkfi: approve for repay", foreignApps: [market.poolId] }
    )
  );

  // 2. Repay into the pool
  txns.push(
    buildAppCallTxn(
      sender,
      market.poolId,
      ABI_METHODS.repay,
      [market.contractId, baseAmount],
      params,
      {
        note: "dorkfi: repay",
        foreignApps: [market.contractId, market.nTokenId],
      }
    )
  );

  const grouped = assignGroupId(txns);
  return {
    transactions: grouped.map(txnToBase64),
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

export async function prepareWithdraw(chain, symbol, amount, sender) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const params = await getParams(chain);
  const baseAmount = toBaseUnits(amount, market.decimals);

  const txns = [];

  // 1. Withdraw from lending pool
  txns.push(
    buildAppCallTxn(
      sender,
      market.poolId,
      ABI_METHODS.withdraw,
      [market.contractId, baseAmount],
      params,
      {
        note: "dorkfi: withdraw",
        foreignApps: [market.contractId, market.nTokenId],
      }
    )
  );

  // 2. If the token is a wrapped network token, unwrap it
  if (market.tokenStandard !== "arc200") {
    txns.push(
      buildAppCallTxn(
        sender,
        market.contractId,
        ABI_METHODS.arc200_transfer,
        [sender, 0n],
        params,
        { note: "dorkfi: unwrap after withdraw" }
      )
    );
  }

  const grouped = assignGroupId(txns);
  return {
    transactions: grouped.map(txnToBase64),
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

  const params = await getParams(chain);
  const baseAmount = toBaseUnits(amount, debtMarket.decimals);
  const poolAddr = appAddr(debtMarket.poolId);

  const txns = [];

  // 1. Approve pool to pull debt tokens
  txns.push(
    buildAppCallTxn(
      sender,
      debtMarket.contractId,
      ABI_METHODS.arc200_approve,
      [poolAddr, baseAmount],
      params,
      { note: "dorkfi: approve for liquidation" }
    )
  );

  // 2. Liquidate (cross-market: collateral_market, debt_market, borrower, amount, min_collateral)
  txns.push(
    buildAppCallTxn(
      sender,
      debtMarket.poolId,
      ABI_METHODS.liquidate_cross_market,
      [collateralMarket.contractId, debtMarket.contractId, borrower, baseAmount, 0n],
      params,
      {
        note: "dorkfi: liquidate",
        foreignApps: [
          collateralMarket.contractId,
          debtMarket.contractId,
          collateralMarket.nTokenId,
          debtMarket.nTokenId,
        ],
      }
    )
  );

  const grouped = assignGroupId(txns);
  return {
    transactions: grouped.map(txnToBase64),
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
