// webhook.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { ethers, JsonRpcProvider } = require('ethers');
const fs = require('fs');
const axios = require('axios');
const SWAP_ROUTER_ABI = require('./ISwapRouter.json');
const TOKEN_ABI = require('./erc20.json');

const {
    executeSwap,
    updateAvgEntry,
    TOKENS,
    USDC,
    SAFE_ADDRESS,
    RPC_URL,
    RED_BUY_RATIO,
    GREEN_SELL_THRESHOLD,
    GREEN_SELL_RATIO,
    avgEntryPrice,
    saveAvgEntry,
    checkGasBalance,
} = require('./shared');

const app = express();
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {

    await checkGasBalance();

    console.log('\n📩 Webhook triggered');
    console.log('🔧 Received payload:', req.body);

    const { token, open, close } = req.body;
    const config = TOKENS[token];

    if (!config) {
        console.log('❌ Unknown token:', token);
        return res.status(400).json({ error: 'Unknown token' });
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

        const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${config.coingeckoId}&vs_currencies=usd`);
        const currentPrice = priceRes.data[config.coingeckoId]?.usd;
        console.log(`💹 Current price of ${config.symbol}: $${currentPrice}`);

        if (action === 'buy') {
            if (redBuyAmount <= 0) {
                console.log('⚠️ Not enough USDC to buy. Aborting.');
                return res.status(200).json({ success: false, message: 'Insufficient USDC to buy' });
            }
            console.log(`🛒 Triggering buy swap for $${redBuyAmount} ${config.symbol}`);
            await executeSwap(config, 'buy', redBuyAmount);
            updateAvgEntry(config.symbol, redBuyAmount, currentPrice);
            console.log('✅ Buy executed and avg entry updated');
        } else {
            console.log(`📤 Evaluating sell for ${config.symbol}`);
            const entry = avgEntryPrice[config.symbol];
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
                    return res.status(200).json({ success: false, message: 'No balance to sell' });
                }

                console.log(`🚀 Selling ${amountToSell} ${config.symbol}`);
                await executeSwap(config, 'sell', amountToSell);
                console.log('✅ Sell executed');
            } else {
                console.log('🛑 Gain threshold not met. No sell triggered.');
            }
        }

        res.status(200).json({ success: true, action });
    } catch (err) {
        console.error('🔥 Swap failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook server running on port ${PORT}`);
});
