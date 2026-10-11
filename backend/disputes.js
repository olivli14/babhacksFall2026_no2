// AI-generated (Claude Code). Dispute engine: reason codes (plan §5c) decided on evidence.
const REASON_CODES = {
  INR: { id: 1, label: "Item not received" },
  SNAD: { id: 2, label: "Significantly not as described" },
  UNAUTH_AGENT: { id: 3, label: "Agent bought outside the mandate" },
  DUP: { id: 4, label: "Duplicate charge" },
  DIGITAL_ND: { id: 5, label: "Digital goods / API call not delivered" },
};

function classify(text = "") {
  const t = text.toLowerCase();
  if (/(charged|billed|paid) (me )?twice|double|duplicate/.test(t)) return "DUP";
  if (/(didn'?t|did not|never) (ask|authori[sz]e|approve|want)|not what i (asked|approved)/.test(t)) return "UNAUTH_AGENT";
  if (/(download|license|api|key|credits?|digital)/.test(t) && /(never|didn'?t|not|no)/.test(t)) return "DIGITAL_ND";
  if (/never (came|arrived|showed)|not (arrived|received|delivered)|didn'?t (arrive|come|show)|hasn'?t (arrived|come)|where is my|lost/.test(t)) return "INR";
  if (/broken|damaged|wrong|fake|not as described|different|counterfeit|stale|empty/.test(t)) return "SNAD";
  return "INR";
}

/**
 * Decide a dispute. Returns { buyerWins, rationale, evidence[] }.
 * The arbiter can only refund to the payer or release to the merchant; this only picks which.
 */
function decide({ code, payment, merchant, buyerRep, mandate, history, statement }) {
  const evidence = [];
  const ev = (label, favors) => evidence.push({ label, favors });
  let buyer = 0, seller = 0;

  // Buyer-side friendly-fraud signals apply to every code.
  if (buyerRep && buyerRep.disputesWon >= 3) { seller += 2; ev(`Buyer has won ${buyerRep.disputesWon} prior disputes (serial-claim risk)`, "merchant"); }
  if (payment.delivered && payment.disputedAt && payment.deliveredAt && payment.disputedAt > payment.deliveredAt && code === "INR") {
    seller += 3; ev("Dispute filed after a signed delivery confirmation", "merchant");
  }

  switch (code) {
    case "INR":
    case "DIGITAL_ND":
      if (payment.delivered) { seller += 3; ev(`Delivery proof onchain (${payment.deliveryProof.slice(0, 10)}…)`, "merchant"); }
      else { buyer += 3; ev("No delivery proof or tracking event recorded", "buyer"); }
      if (!merchant.shipsWithTracking) { buyer += 1; ev("Merchant provides no tracking", "buyer"); }
      if (merchant.sweepsAfterPayment) { buyer += 2; ev("Merchant swept received funds to fresh addresses (exit-scam pattern)", "buyer"); }
      break;
    case "SNAD":
      if (merchant.disputeRate > 0.05) { buyer += 2; ev(`Merchant dispute rate ${(merchant.disputeRate * 100).toFixed(1)}%`, "buyer"); }
      if (/(broken|damaged|fake|empty|counterfeit)/i.test(statement || "")) { buyer += 2; ev("Buyer describes a material defect vs. listing snapshot", "buyer"); }
      else { seller += 1; ev("Complaint does not contradict the listing snapshot", "merchant"); }
      break;
    case "UNAUTH_AGENT":
      if (!mandate || !mandate.categories.includes(payment.category) || payment.amount > mandate.perTxCap) { buyer += 4; ev("Cart does not match the signed mandate", "buyer"); }
      else { seller += 3; ev("Cart matches the signed mandate (category and caps)", "merchant"); }
      break;
    case "DUP": {
      const twin = history.find((p) => p.id !== payment.id && p.merchantId === payment.merchantId && p.amount === payment.amount && Math.abs(p.createdAt - payment.createdAt) < 10 * 60e3 && p.route !== "block");
      if (twin) { buyer += 4; ev(`Matching charge ${twin.id} within 10 minutes`, "buyer"); }
      else { seller += 3; ev("No matching charge in the onchain log", "merchant"); }
      break;
    }
  }

  const buyerWins = buyer > seller;
  const rationale = `${code}: ${buyerWins ? "refund to buyer" : "release to merchant"} (buyer ${buyer} vs merchant ${seller})`;
  return { buyerWins, rationale, evidence, scores: { buyer, merchant: seller } };
}

module.exports = { REASON_CODES, classify, decide };
