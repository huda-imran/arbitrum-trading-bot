require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { ethers, JsonRpcProvider } = require('ethers');
const TOKEN_ABI = require('./erc20.json');

const {
    executeSwap,
    updateAvgEntry,
    getAvgEntry,
    TOKENS,
    USDC,
    SAFE_ADDRESS,
    RPC_URL,
    RED_BUY_RATIO,
    GREEN_SELL_THRESHOLD,
    GREEN_SELL_RATIO,
    checkGasBalance,
    fetchPriceCached,
} = require('./shared');

const app = express();
app.use(bodyParser.json());

// ✅ Respond immediately to TradingView
app.post('/webhook', (req, res) => {
    console.log('📩 Headers:', req.headers);
    res.status(200).json({ success: true });

    handleWebhook(req.body).catch(err => {
        console.error('🔥 Error in webhook handler:', err);
    });
});

async function handleWebhook(payload) {
    await checkGasBalance();

    console.log('\n📩 Webhook triggered');
    console.log('🔧 Received payload:', payload);

    const { token, open, close } = payload;
    const config = TOKENS[token];

    if (!config) {
        console.log('❌ Unknown token:', token);
        return;
    }

    try {
        console.log(`🔄 Handling token: ${token} (${config.symbol})`);
        console.log(`🔍 Open: ${open}, Close: ${close}`);

        const provider = new JsonRpcProvider(RPC_URL);
        const usdc = new ethers.Contract(USDC.address, TOKEN_ABI, provider);
        const usdcBal = await usdc.balanceOf(SAFE_ADDRESS);
        const usdcAmount = parseFloat(ethers.formatUnits(usdcBal, USDC.decimals));

        console.log(`💰 USDC balance: ${usdcAmount}`);
        const redBuyAmount = usdcAmount * RED_BUY_RATIO;
        console.log(`📉 Red buy amount (5%): ${redBuyAmount}`);

        const action = parseFloat(close) > parseFloat(open) ? 'sell' : 'buy';
        console.log(`📊 Candle action: ${action.toUpperCase()}`);

        const currentPrice = await fetchPriceCached(config.coingeckoId);
        console.log(`💹 Current price of ${config.symbol}: $${currentPrice}`);

        if (action === 'buy') {
            if (redBuyAmount <= 0) {
                console.log('⚠️ Not enough USDC to buy. Aborting.');
                return;
            }
            console.log(`🛒 Triggering buy swap for $${redBuyAmount} ${config.symbol}`);
            await executeSwap(config, 'buy', redBuyAmount);
            await updateAvgEntry(config.symbol, redBuyAmount, currentPrice);
            console.log('✅ Buy executed and avg entry updated');
        } else {
            console.log(`📤 Evaluating sell for ${config.symbol}`);
            const entry = await getAvgEntry(config.symbol);

            if (!entry || entry.totalAmount === 0) {
                console.log('⚠️ No avg entry data available. Skipping sell.');
                return;
            }

            const avg = entry.totalCostUSD / entry.totalAmount;
            const gain = ((currentPrice - avg) / avg);
            console.log(`📈 Avg Entry: $${avg.toFixed(2)}, Current: $${currentPrice}, Gain: ${(gain * 100).toFixed(2)}%`);

            if (gain >= GREEN_SELL_THRESHOLD) {
                const token = new ethers.Contract(config.address, TOKEN_ABI, provider);
                const balance = await token.balanceOf(SAFE_ADDRESS);
                const tokenBalance = parseFloat(ethers.formatUnits(balance, config.decimals));
                const amountToSell = tokenBalance * GREEN_SELL_RATIO;

                console.log(`📦 Token balance: ${tokenBalance}`);
                if (amountToSell <= 0) {
                    console.log('⚠️ Token balance is zero. Aborting sell.');
                    return;
                }

                console.log(`🚀 Selling ${amountToSell} ${config.symbol}`);
                await executeSwap(config, 'sell', amountToSell);
                console.log('✅ Sell executed');
            } else {
                console.log('🛑 Gain threshold not met. No sell triggered.');
            }
        }

        console.log(`✅ Action complete: ${action}`);
    } catch (err) {
        console.error('🔥 Swap failed:', err.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook server running on port ${PORT}`);
});