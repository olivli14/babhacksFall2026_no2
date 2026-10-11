// AI-generated (Claude Code). Risk engine: scores a payment from synthetic signals (plan §5) and picks a route.
// Weights and thresholds are illustrative demo values only.
const { MARKET_PRICES, KNOWN_MERCHANTS } = require("./synthetic");

const ROUTES = { INSTANT: 0, TIMED_ESCROW: 1, DELIVERY_ESCROW: 2, BLOCK: 3 };
const ROUTE_NAMES = ["instant", "timed_escrow", "delivery_escrow", "block"];

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior) instructions/i,
  /send (the )?payment to/i,
  /you are (now )?an? (ai|assistant|agent)/i,
  /system prompt/i,
  /0x[a-fA-F0-9]{40}/,
];

function scorePayment({ mandate, merchant, listing, qty, payTo, history, onchainRep, chainNow = Date.now() / 1000, now = Date.now() }) {
  const reasons = [];
  const block = [];
  const add = (code, points, detail) => reasons.push({ code, points, detail });
  const amount = +(listing.unitPrice * qty).toFixed(2);

  // Policy (mirrors the AgentWallet contract so we can log the block instead of reverting).
  if (!mandate) block.push({ code: "POLICY_NO_MANDATE", detail: "No signed spending mandate" });
  else {
    if (chainNow > mandate.expiry) block.push({ code: "POLICY_EXPIRED", detail: "Mandate expired" });
    if (!mandate.categories.includes(listing.category))
      block.push({ code: "POLICY_CATEGORY", detail: `"${listing.category}" is not in the mandate (${mandate.categories.join(", ")})` });
    if (amount > mandate.perTxCap)
      block.push({ code: "POLICY_PER_TX_CAP", detail: `$${amount} is over the $${mandate.perTxCap} per-purchase cap` });
    const spentToday = history.filter((p) => p.route !== "block" && p.status !== "rejected" && p.status !== "awaiting_confirmation" && now - p.createdAt < 86400e3)
      .reduce((s, p) => s + p.amount, 0);
    if (spentToday + amount > mandate.dailyCap)
      block.push({ code: "POLICY_DAILY_CAP", detail: `$${(spentToday + amount).toFixed(2)} would exceed the $${mandate.dailyCap} daily cap` });
    if (mandate.merchantRule === "known_only" && !KNOWN_MERCHANTS.has(merchant.id))
      block.push({ code: "POLICY_MERCHANT_RULE", detail: "Mandate allows only merchants used before" });
  }

  // Agent-specific signals.
  const hits = INJECTION_PATTERNS.filter((re) => re.test(listing.text));
  if (hits.length) block.push({ code: "PROMPT_INJECTION", detail: "Listing contains instructions aimed at the agent" });
  if (payTo && payTo.toLowerCase() !== merchant.siteAddress.toLowerCase())
    block.push({ code: "ADDRESS_MISMATCH", detail: `Pay-to ${short(payTo)} differs from the address on the merchant's site ${short(merchant.siteAddress)}` });

  // Wallet history signals (card "new account" / "BIN" equivalents).
  const w = merchant.wallet;
  if (w.ageDays < 7) add("NEW_WALLET", 20, `Merchant wallet is ${w.ageDays} days old`);
  else if (w.ageDays < 60) add("YOUNG_WALLET", 8, `Merchant wallet is ${w.ageDays} days old`);
  if (w.txCount < 20) add("LOW_HISTORY", 8, `Only ${w.txCount} past transactions`);
  const funding = { mixer: [30, "a mixer"], faucet: [12, "a faucet"], bridge: [8, "a bridge"] }[w.fundingSource];
  if (funding) add("FUNDING_SOURCE", funding[0], `First funds came from ${funding[1]}`);
  if (merchant.flaggedHops === 1) block.push({ code: "FLAGGED_PROXIMITY", detail: "1 hop from a flagged address" });
  else if (merchant.flaggedHops === 2) add("FLAGGED_PROXIMITY", 15, "2 hops from a flagged address");
  if (merchant.selfPurchasing) add("SELF_PURCHASING", 15, "Merchant's buyers were funded by the merchant (fake reputation)");
  if (merchant.isContract && !merchant.verified) add("UNVERIFIED_CONTRACT", 12, "Paying an unverified contract");
  if (merchant.newBuyerBurst) add("NEW_BUYER_BURST", 8, "Burst of first-time buyers in the last hour");

  // Commerce signals.
  const market = MARKET_PRICES[listing.sku];
  if (market) {
    const dev = (listing.unitPrice - market) / market;
    if (dev > 0.3) add("PRICE_DEVIATION", 15, `Price is ${Math.round(dev * 100)}% above the market average`);
    else if (dev > 0.15) add("PRICE_DEVIATION", 8, `Price is ${Math.round(dev * 100)}% above the market average`);
  }
  if (merchant.discovery !== "known_marketplace") add("UNTRUSTED_DISCOVERY", 8, "Agent found this merchant on a random page");
  if (!KNOWN_MERCHANTS.has(merchant.id)) add("FIRST_TIME_MERCHANT", 5, "Never bought from this merchant before");
  if (merchant.disputeRate > 0.05) add("DISPUTE_RATE", 12, `Dispute rate ${(merchant.disputeRate * 100).toFixed(1)}%`);
  if (onchainRep && onchainRep.disputesLost > 0)
    add("ONCHAIN_DISPUTES_LOST", 15 * onchainRep.disputesLost, `Lost ${onchainRep.disputesLost} dispute(s) onchain`);

  const recent = history.filter((p) => p.merchantId === merchant.id && now - p.createdAt < 10 * 60e3).length;
  if (recent >= 3) add("VELOCITY", 10, `${recent} payments to this merchant in 10 minutes`);
  const dup = history.find((p) => p.merchantId === merchant.id && p.amount === amount && now - p.createdAt < 2 * 60e3 && p.route !== "block");
  if (dup) add("POSSIBLE_DUPLICATE", 10, `Same amount to same merchant ${Math.round((now - dup.createdAt) / 1000)}s ago`);

  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  let route;
  if (block.length || score >= 80) route = ROUTES.BLOCK;
  else if (score >= 50) route = ROUTES.DELIVERY_ESCROW;
  else if (score >= 25) route = ROUTES.TIMED_ESCROW;
  else route = ROUTES.INSTANT;
  if (!block.length && score >= 80) block.push({ code: "SCORE_TOO_HIGH", detail: `Risk score ${score} ≥ 80` });

  return {
    amount,
    score: block.some((b) => b.code !== "SCORE_TOO_HIGH") ? 100 : score,
    route,
    routeName: ROUTE_NAMES[route],
    reasons,
    // Security reasons first: they're the story, cap overruns are secondary.
    blockReasons: [...block.filter((b) => !b.code.startsWith("POLICY_")), ...block.filter((b) => b.code.startsWith("POLICY_"))],
    needsVoiceConfirmation: route === ROUTES.DELIVERY_ESCROW,
  };
}

function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ""; }

function confirmationScript(merchant, risk) {
  const top = [...risk.reasons].sort((a, b) => b.points - a.points).slice(0, 3).map((r) => r.detail.replace(/\.$/, ""));
  return `Heads up before I pay ${merchant.name} $${risk.amount.toFixed(2)}. ${top.join(". ")}. ` +
    `Risk score is ${risk.score} out of 100. If you continue, the money will be held in escrow until delivery is proven. Do you want to continue?`;
}

module.exports = { scorePayment, confirmationScript, ROUTES, ROUTE_NAMES, short };
