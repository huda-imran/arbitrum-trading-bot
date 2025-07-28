// shared.js
const fs = require('fs');
const { ethers, JsonRpcProvider } = require('ethers');
const axios = require('axios');
const { createSafeClient } = require('@safe-global/sdk-starter-kit');
const SWAP_ROUTER_ABI = require('./ISwapRouter.json');
const TOKEN_ABI = require('./erc20.json');

const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const PAYOUT_WALLET = process.env.SIGNER_ADDRESS;

const USDC = {
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
    symbol: 'USDC',
    coingeckoId: 'usd-coin'
};

const SWAP_ROUTER_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const DCA_SPLIT_RATIO = 0.8;
const DCA_DURATION_DAYS = 30;
const DCA_TOKEN_SPLIT = 0.5;
const GREEN_SELL_THRESHOLD = 0.06;
const GREEN_SELL_RATIO = 0.05;
const RED_BUY_RATIO = 0.05;
const MONTHLY_SKIM_RATIO = 0.0005;
const SWAP_FEE = 500;
const SWAP_DEADLINE_SEC = 600;
const MIN_ETH_THRESHOLD = 0.005; // set threshold

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

let avgEntryPrice = fs.existsSync('./avgEntry.json')
    ? JSON.parse(fs.readFileSync('./avgEntry.json'))
    : { WETH: { totalCostUSD: 0, totalAmount: 0 }, WBTC: { totalCostUSD: 0, totalAmount: 0 } };

function saveAvgEntry() {
    fs.writeFileSync('./avgEntry.json', JSON.stringify(avgEntryPrice, null, 2));
}

let dcaState = fs.existsSync('./dcaState.json')
    ? JSON.parse(fs.readFileSync('./dcaState.json'))
    : { counter: 0, pool: 0 };

function saveDCAState() {
    fs.writeFileSync('./dcaState.json', JSON.stringify(dcaState, null, 2));
}

async function checkGasBalance() {
    const provider = new JsonRpcProvider(RPC_URL);
    const balance = await provider.getBalance(SAFE_ADDRESS);
    const ethBalance = parseFloat(ethers.formatEther(balance));


    if (ethBalance < MIN_ETH_THRESHOLD) {
        console.log(`⚠️ Low ETH balance on SAFE wallet: ${ethBalance} ETH`);
        // Optionally send an alert (e.g., email, Telegram, etc.)
    } else {
        console.log(`✅ ETH balance on SAFE wallet is healthy: ${ethBalance} ETH`);
    }
}


async function executeSwap(tokenConfig, action, amountOverrideUSD) {
    console.log(`\n🔁 Starting swap | Action: ${action.toUpperCase()} | Token: ${tokenConfig.symbol} | Amount (USD): $${amountOverrideUSD}`);

    const provider = new JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const safeClient = await createSafeClient({ provider: RPC_URL, signer: PRIVATE_KEY, safeAddress: SAFE_ADDRESS });
    console.log(`🔐 Safe client initialized`);

    const tokenInConfig = action === 'sell' ? tokenConfig : USDC;
    const tokenOutConfig = action === 'sell' ? USDC : tokenConfig;

    const tokenIn = new ethers.Contract(tokenInConfig.address, TOKEN_ABI, provider);
    console.log(`📥 Token In: ${tokenInConfig.symbol}`);
    console.log(`📤 Token Out: ${tokenOutConfig.symbol}`);

    const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${tokenInConfig.coingeckoId || 'tether'}&vs_currencies=usd`);
    const price = priceRes.data[tokenInConfig.coingeckoId || 'tether'].usd;
    console.log(`💲 Price of ${tokenInConfig.symbol}: $${price}`);

    const decimals = tokenInConfig.decimals;
    const amountIn = ethers.parseUnits(((amountOverrideUSD / price).toFixed(decimals)), decimals);
    console.log(`🔢 Calculated amountIn: ${ethers.formatUnits(amountIn, decimals)} ${tokenInConfig.symbol}`);

    const allowance = await tokenIn.allowance(SAFE_ADDRESS, SWAP_ROUTER_ADDRESS);
    console.log(`🔎 Current allowance: ${ethers.formatUnits(allowance, decimals)} ${tokenInConfig.symbol}`);

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
    if (allowance < amountIn) {
        console.log(`🔐 Approval required. Appending approve transaction`);
        txs.push({ to: tokenInConfig.address, data: approveData, value: '0' });
    } else {
        console.log(`✅ Sufficient allowance. No approval needed`);
    }

    txs.push({ to: SWAP_ROUTER_ADDRESS, data: swapData, value: '0' });
    console.log(`🔄 Swap transaction prepared. Sending via Safe...`);

    const txResult = await safeClient.send({ transactions: txs });
    const safeTxHash = txResult.transactions?.safeTxHash;
    console.log(`📬 Safe transaction submitted. Hash: ${safeTxHash}`);

    const pending = await safeClient.getPendingTransactions();
    console.log(`⌛ Awaiting confirmation...`);

    for (const tx of pending.results) {
        if (tx.safeTxHash === safeTxHash) {
            await safeClient.confirm({ safeTxHash });
            console.log(`✅ Safe swap confirmed for hash: ${safeTxHash}`);
        }
    }

    console.log(`🎉 Swap complete for ${action.toUpperCase()} of ${tokenConfig.symbol}`);
}


function updateAvgEntry(symbol, costUSD, priceUSD) {
    const amountToken = costUSD / priceUSD;
    avgEntryPrice[symbol].totalCostUSD += costUSD;
    avgEntryPrice[symbol].totalAmount += amountToken;
    saveAvgEntry();
}

module.exports = {
    checkGasBalance,
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
    GREEN_SELL_THRESHOLD,
    GREEN_SELL_RATIO,
    RED_BUY_RATIO,
    MONTHLY_SKIM_RATIO,
    avgEntryPrice,
    saveAvgEntry,
    dcaState,
    saveDCAState
};
