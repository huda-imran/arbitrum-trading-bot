require('dotenv').config();
const { ethers, JsonRpcProvider } = require('ethers');
const cron = require('node-cron');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const { createSafeClient } = require('@safe-global/sdk-starter-kit');
const TOKEN_ABI = require('./erc20.json');

const {
    executeSwap,
    updateAvgEntry,
    getAvgEntry,
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
    dcaState,
    saveDCAState,
    checkGasBalance
} = require('./shared');

const limiter = new Bottleneck({ minTime: 1500 });

const DAILY_DCA_CRON = '0 10 * * *';
const MONTHLY_SKIM_CRON = '0 0 1 * *';

cron.schedule(DAILY_DCA_CRON, runDailyCron);
cron.schedule(MONTHLY_SKIM_CRON, runMonthlyCron);

console.log("⏱️ Cron worker started...");

async function runDailyCron() {
    await checkGasBalance();

    const provider = new JsonRpcProvider(RPC_URL);
    const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
    const usdcBal = await usdc.balanceOf(SAFE_ADDRESS);
    const usdcAmount = parseFloat(ethers.formatUnits(usdcBal, USDC.decimals));

    console.log(`💰 USDC Balance: $${usdcAmount.toFixed(2)}`);

    if (dcaState.counter === 0) {
        dcaState.pool = usdcAmount * DCA_SPLIT_RATIO;
        console.log(`📊 New DCA Pool Set: $${dcaState.pool.toFixed(2)} (${(DCA_SPLIT_RATIO * 100).toFixed(1)}% of USDC)`);
    }

    const daily = dcaState.pool / DCA_DURATION_DAYS;
    console.log(`📆 Daily DCA Allocation: $${daily.toFixed(2)} (${DCA_DURATION_DAYS} day plan)`);

    const btcAmt = daily * DCA_TOKEN_SPLIT;
    const ethAmt = daily * DCA_TOKEN_SPLIT;

    console.log(`🔁 Swap Plan → BTC: $${btcAmt.toFixed(2)}, ETH: $${ethAmt.toFixed(2)} (Split Ratio: ${DCA_TOKEN_SPLIT * 100}%)`);

    await executeSwap(TOKENS.BTC, 'buy', btcAmt);
    await executeSwap(TOKENS.ETH, 'buy', ethAmt);

    const btcPrice = await getPrice('wrapped-bitcoin');
    const ethPrice = await getPrice('weth');

    console.log(`📈 Prices → BTC: $${btcPrice}, ETH: $${ethPrice}`);

    await updateAvgEntry('WBTC', btcAmt, btcPrice);
    await updateAvgEntry('WETH', ethAmt, ethPrice);

    dcaState.counter++;
    console.log(`📤 DCA Counter updated: ${dcaState.counter}/${DCA_DURATION_DAYS}`);

    if (dcaState.counter >= DCA_DURATION_DAYS) {
        dcaState.counter = 0;
        console.log(`♻️ DCA cycle complete. Counter reset.`);
    }

    saveDCAState();
}

async function runMonthlyCron() {
    await checkGasBalance();

    const provider = new JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const safeClient = await createSafeClient({
        provider: RPC_URL,
        signer: PRIVATE_KEY,
        safeAddress: SAFE_ADDRESS
    });

    const ids = Object.values(TOKENS).map(t => t.coingeckoId).join(',');
    const response = await limiter.schedule(() =>
        axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
    );

    const prices = response.data;
    let totalValueUSD = 0;
    console.log(`\n📊 Calculating total portfolio value:`);

    for (const key in TOKENS) {
        const t = TOKENS[key];
        const token = new ethers.Contract(t.address, TOKEN_ABI, provider);
        const balance = await token.balanceOf(SAFE_ADDRESS);
        const humanBalance = parseFloat(ethers.formatUnits(balance, t.decimals));
        const priceUSD = prices[t.coingeckoId]?.usd || 0;
        const valueUSD = humanBalance * priceUSD;

        console.log(`- ${t.symbol}: ${humanBalance.toFixed(8)} × $${priceUSD.toFixed(2)} = $${valueUSD.toFixed(2)}`);
        totalValueUSD += valueUSD;
    }

    console.log(`💼 Total Portfolio Value: $${totalValueUSD.toFixed(2)}`);

    const payoutAmount = totalValueUSD * MONTHLY_SKIM_RATIO;
    console.log(`💸 Skimming ${MONTHLY_SKIM_RATIO * 100}% → USDC Payout: $${payoutAmount.toFixed(6)}`);

    const amountOut = ethers.parseUnits(payoutAmount.toFixed(USDC.decimals), USDC.decimals);

    const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
    const approveData = usdc.interface.encodeFunctionData('approve', [PAYOUT_WALLET, amountOut]);
    const transferData = usdc.interface.encodeFunctionData('transfer', [PAYOUT_WALLET, amountOut]);

    const txs = [
        { to: USDC.address, data: approveData, value: '0' },
        { to: USDC.address, data: transferData, value: '0' }
    ];

    const txResult = await safeClient.send({ transactions: txs });
    console.log(`✅ Skim TX submitted. Safe Tx Hash: ${txResult.transactions?.safeTxHash || 'N/A'}`);
}

async function getPrice(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const res = await limiter.schedule(() => axios.get(url));
    return res.data[id].usd;
}

// Manual test triggers
if (process.argv.includes('--daily')) {
    runDailyCron().then(() => {
        console.log('✅ Daily DCA test complete');
        process.exit(0);
    });
}

if (process.argv.includes('--monthly')) {
    runMonthlyCron().then(() => {
        console.log('✅ Monthly Skim test complete');
        process.exit(0);
    });
}
