// AI-generated (Claude Code). Recourse backend: risk routing, disputes, ElevenLabs webhook tools, dashboard API.
const path = require("path");
const express = require("express");
const { ethers } = require("ethers");
const { Chain } = require("./chain");
const { getSecret } = require("./secrets");
const { scorePayment, confirmationScript, ROUTES, short } = require("./risk");
const { REASON_CODES, classify, decide } = require("./disputes");
const { parseMandate, readBack } = require("./intent");
const { CATEGORIES, MERCHANTS, LISTINGS, SCENARIOS } = require("./synthetic");

const PORT = Number(process.env.PORT || 8787);
const WINDOWS = { [ROUTES.TIMED_ESCROW]: 86400, [ROUTES.DELIVERY_ESCROW]: 7 * 86400 };

const chain = new Chain();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "dashboard")));

// ---------- in-memory state (the chain is the source of truth for money) ----------
const state = { mandate: null, pendingMandate: null, payments: [], log: [] };
let seq = 0;

function log(kind, message, extra = {}) {
  const entry = { at: Date.now(), kind, message, ...extra };
  state.log.unshift(entry);
  state.log.length = Math.min(state.log.length, 200);
  console.log(`[${kind}] ${message}`);
  return entry;
}

const findPayment = (id) => state.payments.find((p) => p.id === id);
const merchantAddrs = Object.fromEntries(Object.values(MERCHANTS).map((m) => [m.id, m.address]));

function latestDisputable(merchantHint) {
  const open = state.payments.filter((p) => ["escrowed", "settled"].includes(p.status));
  if (merchantHint) {
    const h = merchantHint.toLowerCase();
    const hit = open.find((p) => p.merchantName.toLowerCase().includes(h) || p.merchantId.includes(h));
    if (hit) return hit;
  }
  return open.find((p) => p.status === "escrowed") || open[0];
}

// ---------- mandate ----------
function proposeMandate(fields) {
  const m = fields.text && fields.daily_cap == null ? parseMandate(fields.text) : {
    text: fields.text || "",
    dailyCap: Number(fields.daily_cap ?? 100),
    perTxCap: Number(fields.per_tx_cap ?? fields.daily_cap ?? 100),
    categories: (Array.isArray(fields.categories) ? fields.categories : String(fields.categories || "coffee").split(/[,\s]+/))
      .map((c) => c.trim().toLowerCase().replace(/\s+/g, "_")).filter((c) => CATEGORIES.includes(c)),
    merchantRule: fields.merchant_rule === "known_only" ? "known_only" : "any",
    expiry: Math.floor(Date.now() / 1000) + Number(fields.days ?? 1) * 86400 + 3600,
  };
  if (!m.categories.length) m.categories = ["coffee"];
  m.hash = ethers.id(JSON.stringify({ ...m, hash: undefined }));
  state.pendingMandate = m;
  const message = readBack(m);
  log("mandate", `Mandate proposed: ${message}`);
  return { status: "awaiting_signature", mandate: m, message };
}

async function signMandate() {
  const m = state.pendingMandate;
  if (!m) throw new Error("No mandate waiting for a signature");
  // Expiry is measured against chain time (the local chain may have been fast-forwarded).
  const now = (await chain.provider.getBlock("latest")).timestamp;
  m.expiry = now + Math.max(1, Math.round((m.expiry - Date.now() / 1000) / 86400)) * 86400 + 3600;
  const mask = m.categories.reduce((acc, c) => acc | (1n << BigInt(CATEGORIES.indexOf(c))), 0n);
  const tx = await chain.setMandate(m, mask, m.hash);
  m.tx = tx;
  state.mandate = m;
  state.pendingMandate = null;
  log("mandate", `Mandate signed and set onchain ($${m.perTxCap}/tx, $${m.dailyCap}/day, ${m.categories.join(", ")})`, { tx });
  return { status: "active", mandate: m };
}

// ---------- purchases ----------
async function purchase({ scenario, listing: listingKey, qty }) {
  const sc = scenario ? SCENARIOS[scenario] : null;
  if (scenario && !sc) throw new Error(`Unknown scenario ${scenario}`);
  const listing = LISTINGS[sc ? sc.listing : listingKey];
  if (!listing) throw new Error("Unknown listing");
  const merchant = MERCHANTS[listing.merchantId];
  const quantity = Number(qty || (sc && sc.qty) || 1);
  const onchainRep = await chain.repOf(merchant.address);
  const chainNow = (await chain.provider.getBlock("latest")).timestamp;
  const risk = scorePayment({ mandate: state.mandate, merchant, listing, qty: quantity, payTo: listing.payTo, history: state.payments, onchainRep, chainNow });

  const id = `P${String(++seq).padStart(3, "0")}`;
  const p = {
    id,
    pid: ethers.id(`recourse:${chain.deployment.contracts.AgentWallet}:${id}:${Date.now()}`),
    createdAt: Date.now(),
    merchantId: merchant.id, merchantName: merchant.name, merchantAddress: merchant.address,
    payTo: listing.payTo || merchant.address,
    item: listing.title, qty: quantity, amount: risk.amount, category: listing.category,
    score: risk.score, route: risk.routeName, reasons: risk.reasons, blockReasons: risk.blockReasons,
    listingSnapshot: listing.text, status: "scoring", txs: [],
  };
  state.payments.unshift(p);
  log("risk", `${id} ${merchant.name} $${p.amount} → score ${p.score}, route ${p.route}`, { paymentId: id });

  if (risk.route === ROUTES.BLOCK) {
    const why = risk.blockReasons.map((b) => b.code).join(",");
    const tx = await chain.logBlocked({ pid: p.pid, merchant: p.payTo, amount: p.amount, score: p.score, reasons: why });
    p.txs.push({ label: "blocked + logged", ...tx });
    p.status = "blocked";
    log("block", `${id} blocked: ${risk.blockReasons.map((b) => b.detail).join("; ")}`, { paymentId: id, tx });
    return { payment: p, message: `I blocked that payment. ${risk.blockReasons.map((b) => b.detail).join(". ")}.` };
  }
  if (risk.needsVoiceConfirmation) {
    p.status = "awaiting_confirmation";
    p.confirmationScript = confirmationScript(merchant, risk);
    log("voice", `${id} needs voice confirmation`, { paymentId: id });
    return { payment: p, message: p.confirmationScript };
  }
  await execute(p);
  return { payment: p, message: describe(p) };
}

async function execute(p) {
  try {
    await executeOnchain(p);
  } catch (e) {
    p.status = "failed";
    p.error = e.shortMessage || e.message;
    throw e;
  }
}

async function executeOnchain(p) {
  const route = { instant: ROUTES.INSTANT, timed_escrow: ROUTES.TIMED_ESCROW, delivery_escrow: ROUTES.DELIVERY_ESCROW }[p.route];
  const reasons = p.reasons.map((r) => r.code).join(",") || "LOW_RISK";
  const tx = await chain.pay({
    pid: p.pid, merchant: p.payTo, amount: p.amount, category: CATEGORIES.indexOf(p.category),
    route, score: p.score, window: WINDOWS[route] || 0, reasons,
  });
  p.txs.push({ label: route === ROUTES.INSTANT ? "settled" : "escrowed", ...tx });
  p.status = route === ROUTES.INSTANT ? "settled" : "escrowed";
  if (route !== ROUTES.INSTANT) p.releaseAfter = Date.now() + WINDOWS[route] * 1000;
  log(route === ROUTES.INSTANT ? "settle" : "escrow", `${p.id} ${p.status}: $${p.amount} → ${p.merchantName}`, { paymentId: p.id, tx });
}

async function confirm({ payment_id, approve }) {
  const p = payment_id ? findPayment(payment_id) : state.payments.find((x) => x.status === "awaiting_confirmation");
  if (!p || p.status !== "awaiting_confirmation") throw new Error("No payment is waiting for confirmation");
  const yes = approve === true || /^(y|yes|true|approve|continue|ok)/i.test(String(approve));
  if (!yes) {
    p.status = "rejected";
    log("voice", `${p.id} rejected by the human`, { paymentId: p.id });
    return { payment: p, message: `Cancelled. Nothing was paid to ${p.merchantName}.` };
  }
  log("voice", `${p.id} approved by voice`, { paymentId: p.id });
  await execute(p);
  return { payment: p, message: `Done. $${p.amount.toFixed(2)} is held in escrow and will only go to ${p.merchantName} once delivery is proven.` };
}

async function deliver({ payment_id }) {
  const p = findPayment(payment_id);
  if (!p || p.status !== "escrowed") throw new Error("Payment is not in escrow");
  const proof = ethers.id(`tracking:${p.id}:DELIVERED:${Date.now()}`);
  const tx = await chain.confirmDelivery(p.pid, proof);
  p.delivered = true; p.deliveredAt = Date.now(); p.deliveryProof = proof;
  p.txs.push({ label: "delivery proof", ...tx });
  log("delivery", `${p.id} delivery proof recorded`, { paymentId: p.id, tx });
  if (p.route === "delivery_escrow") await release({ payment_id: p.id });
  return { payment: p, message: `Delivery confirmed for ${p.id}.` };
}

async function release({ payment_id }) {
  const p = findPayment(payment_id);
  if (!p || p.status !== "escrowed") throw new Error("Payment is not in escrow");
  const tx = await chain.release(p.pid);
  p.status = "released";
  p.txs.push({ label: "released", ...tx });
  log("settle", `${p.id} released to ${p.merchantName}`, { paymentId: p.id, tx });
  return { payment: p, message: `Released $${p.amount.toFixed(2)} to ${p.merchantName}.` };
}

// ---------- disputes ----------
async function fileDispute({ description, reason_code, payment_id, merchant_name }) {
  const p = payment_id ? findPayment(payment_id) : latestDisputable(merchant_name);
  if (!p) throw new Error("I couldn't find a payment to dispute");
  const code = (reason_code && REASON_CODES[String(reason_code).toUpperCase()]) ? String(reason_code).toUpperCase() : classify(description);
  p.dispute = { code, label: REASON_CODES[code].label, statement: description || "", filedAt: Date.now() };
  p.disputedAt = Date.now();
  log("dispute", `${p.id} dispute filed: ${code} (${REASON_CODES[code].label}) "${description || ""}"`, { paymentId: p.id });

  if (p.status === "settled") {
    // Low-risk payments keep merchant finality: no clawback, but the claim is recorded.
    p.dispute.outcome = "recorded";
    p.dispute.rationale = "Instant-settled payment: merchant keeps finality. Claim recorded and sent to the merchant for a voluntary refund.";
    return { payment: p, message: `${p.id} settled instantly, so I can't pull the money back. I've recorded the ${code} claim and asked ${p.merchantName} for a refund.` };
  }
  if (p.status !== "escrowed") throw new Error(`${p.id} is ${p.status}; only escrowed payments can be disputed`);

  const d1 = await chain.dispute(p.pid, REASON_CODES[code].id);
  p.txs.push({ label: `dispute ${code}`, ...d1 });
  const merchant = MERCHANTS[p.merchantId];
  const buyerRep = await chain.repOf(chain.deployment.contracts.AgentWallet);
  const decision = decide({ code, payment: p, merchant, buyerRep, mandate: state.mandate, history: state.payments, statement: description });
  const d2 = await chain.resolve(p.pid, decision.buyerWins, decision.rationale);
  p.txs.push({ label: decision.buyerWins ? "refunded to buyer" : "released to merchant", ...d2 });
  p.status = decision.buyerWins ? "refunded" : "released";
  Object.assign(p.dispute, { outcome: decision.buyerWins ? "buyer_won" : "merchant_won", rationale: decision.rationale, evidence: decision.evidence });
  log("decision", `${p.id} ${decision.rationale}`, { paymentId: p.id, tx: d2 });

  const why = decision.evidence.filter((e) => e.favors === (decision.buyerWins ? "buyer" : "merchant")).map((e) => e.label).join("; ");
  const message = decision.buyerWins
    ? `I filed this as ${REASON_CODES[code].label}. Evidence: ${why}. $${p.amount.toFixed(2)} has been refunded to your wallet, and the merchant's reputation has been updated onchain.`
    : `I filed this as ${REASON_CODES[code].label}, but the evidence favors the merchant: ${why}. The funds were released to ${p.merchantName}.`;
  return { payment: p, decision, message };
}

function describe(p) {
  if (!p) return "No payment found.";
  const base = `${p.id}: $${p.amount.toFixed(2)} to ${p.merchantName} for ${p.item}, risk ${p.score}, route ${p.route.replace("_", " ")}, status ${p.status.replace("_", " ")}.`;
  return p.dispute ? `${base} Dispute ${p.dispute.code}: ${p.dispute.outcome || "open"}.` : base;
}

// ---------- HTTP helpers ----------
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn({ ...req.query, ...req.body }));
  } catch (e) {
    const msg = e.shortMessage || e.reason || e.message;
    log("error", msg);
    res.status(400).json({ error: msg, message: msg });
  }
};

// Dashboard API
app.get("/api/state", handle(async () => {
  const snap = await chain.snapshot(merchantAddrs);
  return {
    network: chain.network,
    contracts: chain.deployment.contracts,
    explorer: Object.fromEntries(Object.entries(chain.deployment.contracts).map(([k, a]) => [k, chain.addrUrl(a)])),
    mandate: state.mandate, pendingMandate: state.pendingMandate,
    payments: state.payments, log: state.log.slice(0, 60),
    chain: snap,
    merchants: Object.values(MERCHANTS).map((m) => ({ id: m.id, name: m.name, address: m.address, short: short(m.address), ...snap.merchants[m.id] })),
    scenarios: SCENARIOS,
    voice: { agentId: getSecret("recourse-elevenlabs-agent-id"), tts: !!getSecret("recourse-elevenlabs-key") },
  };
}));
app.post("/api/mandate", handle((b) => proposeMandate(b)));
app.post("/api/mandate/sign", handle(() => signMandate()));
app.post("/api/agent/purchase", handle((b) => purchase(b)));
app.post("/api/confirm", handle((b) => confirm(b)));
app.post("/api/deliver", handle((b) => deliver(b)));
app.post("/api/release", handle((b) => release(b)));
app.post("/api/dispute", handle((b) => fileDispute(b)));
app.post("/api/time/advance", handle(async ({ hours }) => {
  await chain.fastForward(Number(hours || 25) * 3600);
  for (const p of state.payments) if (p.releaseAfter) p.releaseAfter -= Number(hours || 25) * 3600e3;
  log("time", `Local chain advanced ${hours || 25}h`);
  return { ok: true };
}));

// ElevenLabs webhook (server) tools. Each returns a `message` the voice agent can read out.
app.post("/tools/create_mandate", handle((b) => proposeMandate(b)));
app.post("/tools/confirm_payment", handle((b) => confirm(b)));
app.post("/tools/file_dispute", handle((b) => fileDispute(b)));
app.post("/tools/get_payment_status", handle(async ({ payment_id }) => {
  const p = payment_id ? findPayment(payment_id) : state.payments[0];
  const pending = state.payments.find((x) => x.status === "awaiting_confirmation");
  return { payment: p || null, pending_confirmation: pending ? { id: pending.id, script: pending.confirmationScript } : null, message: pending ? pending.confirmationScript : describe(p) };
}));
app.post("/tools/purchase", handle((b) => purchase(b)));

// ElevenLabs text-to-speech for risk readouts (key from keychain). Dashboard falls back to browser speech.
app.post("/api/tts", async (req, res) => {
  const key = getSecret("recourse-elevenlabs-key");
  if (!key) return res.status(404).json({ error: "no ElevenLabs key" });
  const voice = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // "Sarah", a premade voice usable on the free tier
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: String(req.body.text || "").slice(0, 800), model_id: "eleven_turbo_v2_5" }),
    });
    if (!r.ok) return res.status(502).json({ error: `ElevenLabs ${r.status}` });
    res.set("content-type", "audio/mpeg").send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Recourse backend on http://localhost:${PORT} (network: ${chain.network})`);
  console.log(`AgentWallet ${chain.deployment.contracts.AgentWallet}`);
});
