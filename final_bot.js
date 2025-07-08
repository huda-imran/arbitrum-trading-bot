require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { ethers, JsonRpcProvider } = require('ethers');
const cron = require('node-cron');
const fs = require('fs');
const { createSafeClient } = require('@safe-global/sdk-starter-kit');
const SWAP_ROUTER_ABI = require('./ISwapRouter.json');
const TOKEN_ABI = require('./erc20.json');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- Configurable Parameters ---
const DCA_DURATION_DAYS = 30;
const DCA_SPLIT_RATIO = 0.8;
const DCA_TOKEN_SPLIT = 0.5;
const RED_BUY_RATIO = 0.05;
const GREEN_SELL_RATIO = 0.05;
const GREEN_SELL_THRESHOLD = 0.06;
const MONTHLY_SKIM_RATIO = 0.0005;
const DAILY_DCA_CRON = '0 10 * * *';
const MONTHLY_SKIM_CRON = '0 0 1 * *';
const SWAP_FEE = 500;
const SWAP_DEADLINE_SEC = 600;

const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const PAYOUT_WALLET = process.env.PAYOUT_WALLET;

const USDC = {
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
    symbol: 'USDC'
};

const SWAP_ROUTER_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

const TOKENS = {
    BTC: {
        address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        decimals: 8,
        symbol: 'WBTC',
        pair: 'USDC',
        coingeckoId: 'wrapped-bitcoin'
    },
    ETH: {
        address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
        decimals: 18,
        symbol: 'WETH',
        pair: 'USDC',
        coingeckoId: 'weth'
    },
    USDC
};

let avgEntryPrice = fs.existsSync('./avgEntry.json') ? JSON.parse(fs.readFileSync('./avgEntry.json')) : {
    WETH: { totalCostUSD: 0, totalAmount: 0 },
    WBTC: { totalCostUSD: 0, totalAmount: 0 }
};

function saveAvgEntry() {
    fs.writeFileSync('./avgEntry.json', JSON.stringify(avgEntryPrice, null, 2));
}

let dcaState = fs.existsSync('./dcaState.json') ? JSON.parse(fs.readFileSync('./dcaState.json')) : {
    counter: 0,
    pool: 0
};

function saveDCAState() {
    fs.writeFileSync('./dcaState.json', JSON.stringify(dcaState, null, 2));
}

app.post('/webhook', async(req, res) => {
    console.log('📩 Webhook triggered with data:', req.body);
    const { token, open, close } = req.body;
    const config = TOKENS[token];
    if (!config) {
        console.log('❌ Unknown token received:', token);
        return res.status(400).json({ error: 'Unknown token' });
    }

    try {
        const provider = new JsonRpcProvider(RPC_URL);
        const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
        const usdcBal = await usdc.balanceOf(SAFE_ADDRESS);
        const usdcAmount = parseFloat(ethers.formatUnits(usdcBal, USDC.decimals));
        const redBuyAmount = usdcAmount * RED_BUY_RATIO;

        console.log(`💰 USDC balance: ${usdcAmount}, Red buy amount: ${redBuyAmount}`);

        const action = parseFloat(close) > parseFloat(open) ? 'sell' : 'buy';
        console.log(`🟢 Candle action determined: ${action}`);

        const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${config.coingeckoId}&vs_currencies=usd`);
        const currentPrice = priceRes.data[config.coingeckoId] ?.usd;
        console.log(`📈 Current ${config.symbol} price: $${currentPrice}`);

        if (action === 'buy') {
            console.log("🛒 Buy logic triggered");
            console.log("await executeSwap(config, 'buy', redBuyAmount);");
            await executeSwap(config, 'buy', redBuyAmount);
            updateAvgEntry(config.symbol, redBuyAmount, currentPrice);
        } else {
            console.log("📤 Sell logic triggered");
            const entry = avgEntryPrice[config.symbol];
            const avg = entry.totalCostUSD / entry.totalAmount;
            const gain = ((currentPrice - avg) / avg);
            console.log(`📊 Entry avg: $${avg}, Gain: ${(gain * 100).toFixed(2)}%`);

            if (gain >= GREEN_SELL_THRESHOLD) {
                const token = new ethers.Contract(config.address, TOKEN_ABI, provider);
                const balance = await token.balanceOf(SAFE_ADDRESS);
                const amountToSell = Number(balance) * GREEN_SELL_RATIO;
                console.log(`📤 Eligible to sell ${amountToSell / (10 ** config.decimals)} ${config.symbol}`);
                await executeSwap(config, 'sell', amountToSell / (10 ** config.decimals));
            } else {
                console.log("📉 Sell threshold not met.");
            }
        }

        res.status(200).json({ success: true, action });
    } catch (err) {
        console.error('🔥 Swap failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

async function executeSwap(tokenConfig, action, amountOverrideUSD) {
    const provider = new JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const safeClient = await createSafeClient({ provider: RPC_URL, signer: PRIVATE_KEY, safeAddress: SAFE_ADDRESS });

    const tokenInConfig = action === 'sell' ? tokenConfig : TOKENS.USDC;
    const tokenOutConfig = action === 'sell' ? TOKENS.USDC : tokenConfig;

    const tokenIn = new ethers.Contract(tokenInConfig.address, TOKEN_ABI, provider);
    const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${tokenInConfig.coingeckoId || 'tether'}&vs_currencies=usd`);
    const price = priceRes.data[tokenInConfig.coingeckoId || 'tether'].usd;

    const decimals = tokenInConfig.decimals;
    const amountIn = ethers.parseUnits(((amountOverrideUSD / price).toFixed(decimals)), decimals);

    const allowance = await tokenIn.allowance(SAFE_ADDRESS, SWAP_ROUTER_ADDRESS);
    const router = new ethers.Interface(SWAP_ROUTER_ABI);
    const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC;

    const approveData = tokenIn.interface.encodeFunctionData('approve', [SWAP_ROUTER_ADDRESS, amountIn]);
    const swapData = router.encodeFunctionData('exactInputSingle', [{
        tokenIn: tokenInConfig.address,
        tokenOut: tokenOutConfig.address,
        fee: SWAP_FEE,
        recipient: SAFE_ADDRESS,
        deadline,
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    }]);

    const txs = [];
    if (allowance < amountIn) txs.push({ to: tokenInConfig.address, data: approveData, value: '0' });
    txs.push({ to: SWAP_ROUTER_ADDRESS, data: swapData, value: '0' });

    const txResult = await safeClient.send({ transactions: txs });
    const safeTxHash = txResult.transactions ?.safeTxHash;

    const pending = await safeClient.getPendingTransactions();
    for (const tx of pending.results) {
        if (tx.safeTxHash === safeTxHash) {
            await safeClient.confirm({ safeTxHash });
            console.log('✅ Safe swap confirmed.');
        }
    }
}

function updateAvgEntry(symbol, costUSD, priceUSD) {
    const amountToken = costUSD / priceUSD;
    avgEntryPrice[symbol].totalCostUSD += costUSD;
    avgEntryPrice[symbol].totalAmount += amountToken;
    saveAvgEntry();
}

cron.schedule(DAILY_DCA_CRON, runDailyCron);
cron.schedule(MONTHLY_SKIM_CRON, runMonthlyCron);

async function runDailyCron() {
    console.log('📆 Running DCA step...');
    const provider = new JsonRpcProvider(RPC_URL);
    const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
    const usdcBal = await usdc.balanceOf(SAFE_ADDRESS);
    const usdcAmount = parseFloat(ethers.formatUnits(usdcBal, USDC.decimals));

    console.log(`💸 Current USDC: ${usdcAmount}`);

    if (dcaState.counter === 0) {
        dcaState.pool = usdcAmount * DCA_SPLIT_RATIO;
        console.log(`🎯 Initialized DCA pool: ${dcaState.pool}`);
    }

    const daily = dcaState.pool / DCA_DURATION_DAYS;
    const btcAmt = daily * DCA_TOKEN_SPLIT;
    const ethAmt = daily * DCA_TOKEN_SPLIT;
    console.log(`🪙 Daily DCA amounts - BTC: $${btcAmt}, ETH: $${ethAmt}`);

    await executeSwap(TOKENS.BTC, 'buy', btcAmt);
    await executeSwap(TOKENS.ETH, 'buy', ethAmt);
    updateAvgEntry('WBTC', btcAmt, await getPrice('wrapped-bitcoin'));
    updateAvgEntry('WETH', ethAmt, await getPrice('weth'));

    dcaState.counter++;
    if (dcaState.counter >= DCA_DURATION_DAYS) dcaState.counter = 0;
    saveDCAState();
}

async function runMonthlyCron() {
    console.log('🧮 Monthly skim started...');
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
        const priceUSD = prices[t.coingeckoId] ?.usd || 0;
        totalValueUSD += humanBalance * priceUSD;
        console.log(`💎 ${t.symbol}: ${humanBalance} × $${priceUSD} = $${(humanBalance * priceUSD).toFixed(2)}`);
    }

    console.log(`💰 Total portfolio value: $${totalValueUSD}`);
    const payoutAmount = totalValueUSD * MONTHLY_SKIM_RATIO;
    console.log(`📤 Payout (0.05%): $${payoutAmount}`);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});