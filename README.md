# Recourse

Buyer protection for AI agents that pay with stablecoins on BNB Chain. Every payment is risk-scored: low risk settles instantly, medium risk sits in a timed escrow, high risk needs a voice confirmation and waits for delivery proof, and very high risk or policy violations are blocked and logged onchain. Disputes are filed by voice and decided on evidence by an arbiter that can **only** refund the payer or release to the merchant. See `recourse-plan.md` for the full pitch.

> AI-generated code (Claude Code); files carry a header comment. Synthetic data only.

## Layout

| Path | What |
|---|---|
| `contracts/` | `MockUSD` (test stablecoin), `AgentWallet` (mandate caps, categories, expiry, risk co-signature), `RecourseEscrow` (hold / delivery proof / dispute / limited-arbiter resolve), `Reputation` (onchain outcomes) |
| `backend/risk.js` | Risk engine: ~20 signals from plan §5 (wallet age, funding source, flagged hops, unverified contract, price deviation, prompt injection, pay-to mismatch, velocity, onchain disputes lost…) → route |
| `backend/disputes.js` | Reason codes `INR`, `SNAD`, `UNAUTH_AGENT`, `DUP`, `DIGITAL_ND` decided on evidence |
| `backend/server.js` | REST API, ElevenLabs webhook tools (`/tools/*`), ElevenLabs TTS proxy |
| `backend/synthetic.js` | Synthetic merchants, listings and demo scenarios |
| `dashboard/index.html` | Single-page demo dashboard (Chart.js), browser mic + speech fallback |
| `elevenlabs/` | Voice agent prompt; `scripts/setup-elevenlabs.js` creates the agent |

## Run locally (2 commands)

```bash
npm install
npm run demo:local      # Hardhat node + deploy + backend on http://localhost:8787
```
`npm test` runs the contract tests.

## Deploy to BSC Testnet

Keys live in the macOS keychain, never in files:

```bash
security add-generic-password -a "$USER" -s recourse-deployer-key -w '<testnet private key>'
# optional separate role keys: recourse-agent-key, recourse-risk-key, recourse-arbiter-key
npm run deploy:bsc                         # writes deployments/bscTestnet.json
RECOURSE_NETWORK=bscTestnet npm start      # dashboard links txs to testnet.bscscan.com
```
Get testnet BNB from the BNB Chain faucet first. If separate role keys are added, deploy *after* adding them.

## ElevenLabs

- **TTS for risk readouts** (works immediately): `security add-generic-password -a "$USER" -s recourse-elevenlabs-key -w '<key>'`, restart the backend. Without a key the dashboard uses browser speech.
- **Voice agent with webhook tools**: expose the backend (`cloudflared tunnel --url http://localhost:8787` or ngrok), then `PUBLIC_URL=https://… node scripts/setup-elevenlabs.js`. It stores the agent id in the keychain and the dashboard shows the widget.
- **Manual setup** (if the script's request is rejected): create an agent in the ElevenLabs dashboard, paste `elevenlabs/prompt.md` as the system prompt, and add four webhook tools, all `POST` to `<PUBLIC_URL>/tools/<name>`:
  - `create_mandate` `{ text }`
  - `get_payment_status` `{ payment_id? }`
  - `confirm_payment` `{ approve: boolean, payment_id? }`
  - `file_dispute` `{ description, reason_code?, merchant_name? }`

Voice is never the only proof: the mandate only activates after **Approve & sign** on the dashboard.

## Demo script (3 min)

1. **Mandate:** speak/type "You can spend up to $100 a day on coffee and office supplies" → Propose → readback → **Approve & sign** (setMandate tx).
2. **Happy path:** *trusted coffee* → score 0 → instant settle.
3. **Risky merchant:** *risky coffee* → score 76 → voice readout of reasons → "yes" → escrow (Held in escrow KPI).
4. **Dispute:** "My package never came." → `INR` → no delivery proof + no tracking + sweep pattern → refund onchain; QuickBrew "disputes lost" = 1.
5. **Prompt injection:** *injection* → blocked (`PROMPT_INJECTION`, `ADDRESS_MISMATCH`), logged onchain.
6. Extras: *office medium* → timed escrow; *off mandate* → policy block; ⏩ advance 25h → Release.

Restarting `demo:local` resets everything (fresh chain).

## Honest limits

- The backend holds the agent, risk co-signer and arbiter keys for the demo; in production these are separate services.
- Delivery proof comes from the arbiter acting as a delivery oracle (simulated tracking).
- Context.dev merchant check is simulated via synthetic site data (`siteAddress`, return policy, contact).
- Instant-settled payments keep merchant finality: disputes on them are recorded, not clawed back.
