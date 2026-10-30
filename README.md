# ⚡ BSV AI Token Swap (aitokenswap for Bitcoin SV)

> Real on-chain BSV Satoshis micropayments in exchange for executing AI queries via **Google Gemini Pro**.

Inspired by `aitokenswap.com`, this platform creates an open, decentralized AI inference marketplace powered by the Bitcoin SV (BSV) blockchain. 

- **AI Buyers** ask questions and pay micropayments (e.g. 500 satoshis ~ $0.00025) directly from their **BSV Desktop** wallet.
- **AI Providers** connect their compute nodes, receive satoshis straight into their **BSV Desktop** receiving address, and execute queries using **Google Gemini Pro**.
- **The AI Gateway** manages provider discovery, issues 402 payment invoices, verifies on-chain mempool transactions, and delivers responses with an on-chain receipt.

---

## 🏗️ Architecture

```
[ AI Buyer (Web UI / Laptop) ]
         │
         │ 1. Prompt Request
         ▼
[ BSV AI Gateway ] ─── 2. Returns 402 Invoice (500 sats + Provider Address)
         │
         │ 3. Buyer opens BSV Desktop -> Sends 500 sats to Provider Address
         ▼
[ BSV Network (WhatsOnChain / Mempool) ]
         ▲
         │ 4. Gateway verifies on-chain transaction & prevents replay
         ▼
[ AI Provider Node (Gemini Pro) ]
         │ 5. Executes prompt via Gemini Pro
         ▼
[ Buyer Receives Verified Answer + WhatsOnChain TXID ]
```

---

## 🚀 Quick Start Guide

### 1. Installation
```bash
npm install
```

### 2. Configure Environment (`.env`)
Copy `.env.example` to `.env` and fill in your details:

```env
# Network: 'mainnet' or 'testnet'
BSV_NETWORK=mainnet

# Gateway Port
PORT=3300

# Provider Settings
PROVIDER_NAME=Gemini-Pro-Node-1

# IMPORTANT: Put your Provider's BSV Desktop receiving address here:
PROVIDER_BSV_ADDRESS=1YourProviderAddressHere...

# IMPORTANT: Put your Google Gemini Pro API Key here:
GEMINI_API_KEY=AIzaSy...

# Model to use
GEMINI_MODEL=gemini-1.5-pro

# Provider Daemon Port
PROVIDER_PORT=4001
GATEWAY_URL=http://localhost:3300
```

---

## 🎬 How to Run the Hackathon Demo

### Step 1: Start the AI Gateway
On the main machine or server:
```bash
npm run gateway
```
* Dashboard will be live at: **`http://localhost:3300`**

### Step 2: Start the Gemini Pro Provider Node
On the provider's machine (or in a separate terminal on the same machine):
```bash
npm run provider
```
The provider will register itself with the Gateway, display its BSV Desktop address, and start listening for incoming inference requests.

### Step 3: Open the Web App & Ask a Question
1. Open **`http://localhost:3300`** in your browser.
2. Select **Gemini 1.5 Pro** from the model dropdown.
3. Type your prompt (e.g. *"Explain quantum computing in 3 bullets"*).
4. Click **⚡ Swap Sats & Ask AI**.

### Step 4: Pay with BSV Desktop
An on-chain invoice appears with:
- **Provider Address** (with 1-click Copy button)
- **Amount** (e.g. `500 satoshis`)
- **Payment QR code**

1. Open **BSV Desktop** on your laptop.
2. Go to the **Send** tab.
3. Paste the **Provider Address** and enter `500` satoshis (or `0.00000500` BSV).
4. Click **Send**.
5. You have two ways to complete:
   - **Option A (Auto-Detect):** Click **Auto-Detect Mempool Payment** on the web page. The Gateway scans the mempool and triggers inference the moment your TX propagates!
   - **Option B (Instant Manual):** Copy the TXID from BSV Desktop's History tab, paste it into the TXID box, and click **Verify & Run**.

### Step 5: Instant AI Execution & On-Chain Receipt
- The Provider's BSV Desktop wallet receives the real satoshis.
- The Provider's node executes the prompt with **Gemini Pro**.
- The answer streams back to the Buyer's screen with a direct link to **WhatsOnChain** (`https://whatsonchain.com/tx/...`).

---

## ⚡ Fast Developer Demo Mode (1-Click Burner Wallet)
For lightning-fast demonstrations where you don't want to switch to the BSV Desktop window:
- In the Web UI under the invoice, open **Developer Fast-Pay**.
- Paste a funded BSV private key (WIF).
- Click **1-Click Sign & Broadcast**. The web app builds, signs, and broadcasts the BSV transaction via `@bsv/sdk`, verifies it, and outputs the Gemini Pro response in under 2 seconds!

---

## 🧪 Testing
Run the comprehensive test suite to verify wallets, address generation, replay attack prevention, and Gemini Pro fallback:
```bash
npm test
```
# blockchain
# blockchain
# blockchain
# blockchain
# blockchain
# blockchain
