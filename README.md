# ⚡ PromptBazaar

> Decentralized AI compute marketplace powered by Bitcoin SV (BSV) micropayments and **sCrypt TokenChannel** smart contracts.

PromptBazaar is an open, real-time AI inference marketplace on BSV. 

- **AI Buyers** ask questions and pay for streamed response chunks in real time through an on-chain **TokenChannel (2-of-2 UTXO)** smart contract, approved with a single click via **BSV Desktop**.
- **AI Providers** monetize their compute by either hosting models directly on the gateway with server-encrypted API keys (OpenAI / Gemini) or running standalone self-hosted provider nodes.
- **Real-Time Earnings** are streamed directly to providers' BRC-29 payout addresses and can be internalized into BSV Desktop with one-click AtomicBEEF settlement.
- **Zero Passwords**: Authentication is identity-key-based (`02...`/`03...` compressed public key) via **BSV Desktop**.

---

## 🏗️ Architecture: TokenChannel Smart Contract Flow

```
[ AI Customer (Browser) ]
         │
         │ 1. Picks Model/Provider & Prepares Channel
         ▼
[ BSV AI Gateway ] ──── 2. Issues Channel Proposal (sCrypt TokenChannel 2-of-2)
         │
         │ 3. Customer approves deposit (e.g. 2,000 sats) in BSV Desktop
         ▼
[ BSV Blockchain (Mempool / Contract UTXO) ]
         │
         │ 4. Channel is OPEN. Customer queries AI:
         │    Customer sends prompt -> Provider streams chunk -> Customer signs state
         ▼
[ AI Provider (Hosted / Node) ] ──── Executes via Gemini / OpenAI
         │
         │ 5. Channel closes or settles -> Settle TX broadcast on-chain
         ▼
[ Settle TX: Provider receives earned sats · Unused deposit refunds to Customer ]
```

---

## 📋 Prerequisites

1. **Node.js**: v18.0.0 or newer (Node.js v20+ with native `node:sqlite` recommended).
2. **BSV Desktop**: The official [BSV Desktop wallet](https://bsvblockchain.org/) running locally on your machine (default port: `http://localhost:3321`). Make sure your wallet is unlocked and has a small balance for channel deposits and transaction fees (e.g., 2,000–10,000 satoshis on Mainnet or Testnet).

---

## ⚙️ Configuration (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Review or update settings in `.env`:

```env
# Network: 'mainnet' or 'testnet'
BSV_NETWORK=mainnet

# Gateway Port (Default: 3300)
PORT=3300

# Directory for SQLite database (app.db) and hosted channel states
DATA_DIR=./data

# Optional: 32-byte encryption key (64 hex characters) to encrypt stored API keys.
# If left empty, a development master key is automatically created at ./data/master.key
MASTER_KEY=

# Optional: Set to true when serving behind HTTPS/TLS reverse proxy
COOKIE_SECURE=false
TRUST_PROXY=false
```

---

## 🚀 Running the Application

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Start the AI Gateway
```bash
npm start
```
*(Alternative alias: `npm run gateway`)*

The gateway starts at **`http://localhost:3300`**.

### Step 3: Open the App & Sign In
1. Open your browser and navigate to **`http://localhost:3300`**.
2. If not already signed in, click **Sign In with BSV Desktop**. Approve the signature prompt in BSV Desktop to authenticate (no password required).

### Step 4: Choose Your Path

#### Option A: Use AI as a Customer
1. Go to **Ask AI** (`/`) or browse providers on the **Marketplace** (`/market.html`).
2. Select your desired AI model (e.g., *Gemini 1.5 Pro*, *Gemini 2.5 Flash*, *GPT-4o Mini*).
3. Enter your prompt.
4. Click **Open Channel & Ask**:
   - BSV Desktop will prompt you to approve locking your deposit into the smart contract.
   - Once confirmed, the answer streams back chunk-by-chunk.
   - You only pay for the exact tokens received. Unspent satoshis remain yours to use or refund when the channel closes.

#### Option B: Become a Hosted Provider (No CLI needed)
1. Navigate to **Become a Provider** (`/provider.html`).
2. Enter your display name.
3. Add your **Google Gemini** or **OpenAI** API key and click **Test** (keys are validated, encrypted server-side with AES-256-GCM, and never sent back to the browser).
4. Select the models you want to offer and customize your pricing (sats per 1,000 input/output tokens and minimum query fee).
5. Click **Save and publish**.
6. Your node is now live in the **Marketplace**! As customers use your node, incoming payments and channels will appear in real time in your **Earnings** dashboard.

#### Option C: Run a Standalone Provider Node (CLI Daemon)
If you prefer running a dedicated external worker node on another server or terminal:
```bash
# Configure GEMINI_API_KEY or OPENAI_API_KEY in .env, then:
npm run provider
```
The node generates its own channel signing keys, registers with the gateway, and listens for delegated compute tasks.

---

## 🛠️ Developer Scripts & Tools

| Command | Description |
| :--- | :--- |
| `npm start` | Starts the central AI Gateway and web application on `http://localhost:3300` |
| `npm run gateway` | Explicit alias to run the gateway server (`node src/gateway/server.js`) |
| `npm run provider` | Starts an external CLI provider daemon node (`node src/provider/agent.js`) |
| `npm run clean` | Cleans database (`app.db`), sessions, and runtime channel states for a fresh demo |
| `npm test` | Runs the core test suite (wallets, smart contracts, pricing, and routing) |
| `npm run test:channel` | Runs the end-to-end TokenChannel payment channel integration test |
| `npm run test:network` | Runs the complete multi-user network integration test |
| `npm run build:contracts` | Compiles sCrypt smart contracts (`contracts/` -> `contracts/dist/`) |
| `npm run test:contracts` | Runs sCrypt contract unit tests |

---

## 🔒 Security & Smart Contract Guarantees

- **Non-Custodial**: The gateway never holds customer deposits or provider funds. Satoshis are locked directly into the audited sCrypt `TokenChannel` smart contract.
- **Pay-Per-Stream**: Customers sign payment increments per received chunk using an ephemeral session key. If streaming stops, payments stop immediately.
- **Identity Payouts (BRC-29)**: Providers receive settlement payouts directly to their BSV Desktop identity key via BRC-29 derivation, internalizable as an AtomicBEEF transaction.
- **Key Security**: Upstream provider API keys are encrypted at rest using AES-256-GCM backed by `MASTER_KEY` and are never exposed to clients.
