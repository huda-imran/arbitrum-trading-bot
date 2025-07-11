// cron-worker.js
require('dotenv').config();
const { ethers, JsonRpcProvider } = require('ethers');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const { createSafeClient } = require('@safe-global/sdk-starter-kit');
const TOKEN_ABI = require('./erc20.json');
const {
    executeSwap,
    updateAvgEntry,
    TOKENS,
    USDC,
    SAFE_ADDRESS,
    RPC_URL,
    PRIVATE_KEY,
    PAYOUT_WALLET,
    DCA_SPLIT_RATIO,
    DCA_DURATION_DAYS,
    DCA_TOKEN_SPLIT,
    MONTHLY_SKIM_RATIO,
    avgEntryPrice,
    saveAvgEntry,
    dcaState,
    saveDCAState
} = require('./shared');

const DAILY_DCA_CRON = '0 10 * * *';
const MONTHLY_SKIM_CRON = '0 0 1 * *';

cron.schedule(DAILY_DCA_CRON, runDailyCron);
cron.schedule(MONTHLY_SKIM_CRON, runMonthlyCron);

console.log("⏱️ Cron worker started...");

async function runDailyCron() {
    const provider = new JsonRpcProvider(RPC_URL);
    const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
    const usdcBal = await usdc.balanceOf(SAFE_ADDRESS);
    const usdcAmount = parseFloat(ethers.formatUnits(usdcBal, USDC.decimals));

    if (dcaState.counter === 0) {
        dcaState.pool = usdcAmount * DCA_SPLIT_RATIO;
    }

    const daily = dcaState.pool / DCA_DURATION_DAYS;
    const btcAmt = daily * DCA_TOKEN_SPLIT;
    const ethAmt = daily * DCA_TOKEN_SPLIT;

    await executeSwap(TOKENS.BTC, 'buy', btcAmt);
    await executeSwap(TOKENS.ETH, 'buy', ethAmt);
    updateAvgEntry('WBTC', btcAmt, await getPrice('wrapped-bitcoin'));
    updateAvgEntry('WETH', ethAmt, await getPrice('weth'));

    dcaState.counter++;
    if (dcaState.counter >= DCA_DURATION_DAYS) dcaState.counter = 0;
    saveDCAState();
}

async function runMonthlyCron() {
    const provider = new JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const safeClient = await createSafeClient({ provider: RPC_URL, signer: PRIVATE_KEY, safeAddress: SAFE_ADDRESS });

    const ids = Object.values(TOKENS).map(t => t.coingeckoId).join(',');
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const prices = response.data;

    let totalValueUSD = 0;
    for (const key in TOKENS) {
        const t = TOKENS[key];
        const token = new ethers.Contract(t.address, TOKEN_ABI, provider);
        const balance = await token.balanceOf(SAFE_ADDRESS);
        const humanBalance = parseFloat(ethers.formatUnits(balance, t.decimals));
        const priceUSD = prices[t.coingeckoId]?.usd || 0;
        totalValueUSD += humanBalance * priceUSD;
    }

    const payoutAmount = totalValueUSD * MONTHLY_SKIM_RATIO;
    const amountOut = ethers.parseUnits(payoutAmount.toFixed(USDC.decimals), USDC.decimals);

    const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
    const approveData = usdc.interface.encodeFunctionData('approve', [PAYOUT_WALLET, amountOut]);
    const transferData = usdc.interface.encodeFunctionData('transfer', [PAYOUT_WALLET, amountOut]);

    const txs = [
        { to: USDC.address, data: approveData, value: '0' },
        { to: USDC.address, data: transferData, value: '0' }
    ];

    const txResult = await safeClient.send({ transactions: txs });
    console.log(`✅ Skim TX submitted: ${txResult.transactions?.safeTxHash}`);
}

async function getPrice(id) {
    const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    return res.data[id].usd;
}
