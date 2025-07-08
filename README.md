# DCA + Candle-Based Trading Bot (with Gnosis Safe Integration)

This Node.js-based trading bot automates token swaps using candle signals, daily DCA (Dollar Cost Averaging), and monthly skimming logic. 

---

## 🔧 Features

### Candle-Based Webhook Trading

- On each 1-day candle update via webhook:
  - **Red candle:** Buys token using 5% of the USDC balance.
  - **Green candle:** If profit ≥ 6% from average entry price, sells 5% of that token.

### Daily DCA

- Runs every day at 10:00 AM.
- Splits 80% of current USDC over 30 days.
- Buys WETH and WBTC (50/50).
- Tracks average entry prices and progress in JSON files.

### Monthly Skimming

- Runs on the 1st of each month.
- Calculates total portfolio value.
- Sends 0.05% of the portfolio value in USDC to the payout wallet.

---

## 💾 Local Storage

- `avgEntry.json` — stores average entry prices for WETH and WBTC.
- `dcaState.json` — tracks daily DCA progress.

---

## 🔄 Swap Execution

- Signs and executes transactions via a Gnosis Safe.
- Handles token approvals and confirmations automatically.

---

## 📁 Environment Variables

Create a `.env` file in the root folder with the following:

```env
PORT=3000
RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
SIGNER_PRIVATE_KEY=your_private_key
SIGNER_ADDRESS=0xYourSignerAddress
SAFE_ADDRESS=0xYourSafeAddress
