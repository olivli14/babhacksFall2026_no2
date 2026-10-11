// AI-generated (Claude Code). Turns a spoken/typed sentence into a structured mandate.
// The ElevenLabs agent normally sends structured fields; this is the fallback parser.
const { CATEGORIES } = require("./synthetic");

const CATEGORY_WORDS = {
  coffee: /coffee|espresso|beans?|roast/i,
  office_supplies: /office|paper|supplies|stationery|pens?/i,
  electronics: /electronics?|gadgets?|hubs?|cables?/i,
  digital_goods: /digital|api|credits|software|subscriptions?/i,
  gift_cards: /gift ?cards?/i,
  travel: /travel|flights?|hotels?/i,
};

function parseMandate(text = "") {
  const money = [...text.matchAll(/\$?\s?(\d+(?:\.\d{1,2})?)\s*(dollars|usd|bucks)?/gi)].map((m) => ({ v: parseFloat(m[1]), i: m.index }));
  let dailyCap = null, perTxCap = null;
  for (const m of money) {
    const after = text.slice(m.i, m.i + 30).toLowerCase();
    if (/a day|per day|daily|each day/.test(after)) dailyCap = m.v;
    else if (/per (purchase|order|transaction|item)|each (purchase|order)|under/.test(after) || /under\s*\$?\s?$/.test(text.slice(Math.max(0, m.i - 8), m.i).toLowerCase())) perTxCap = m.v;
  }
  if (dailyCap == null && money.length) dailyCap = Math.max(...money.map((m) => m.v));
  if (dailyCap == null) dailyCap = 100;
  if (perTxCap == null) perTxCap = dailyCap;
  const categories = CATEGORIES.filter((c) => CATEGORY_WORDS[c].test(text));
  const merchantRule = /used before|we'?ve used|known|trusted|usual/i.test(text) ? "known_only" : "any";
  const days = /week/i.test(text) ? 7 : /month/i.test(text) ? 30 : 1;
  return {
    text,
    perTxCap,
    dailyCap,
    categories: categories.length ? categories : ["coffee"],
    merchantRule,
    expiry: Math.floor(Date.now() / 1000) + days * 86400 + 3600,
  };
}

function readBack(m) {
  return `Okay. I can spend up to $${m.dailyCap} a day, at most $${m.perTxCap} per purchase, on ${m.categories.map((c) => c.replace("_", " ")).join(" and ")}` +
    `${m.merchantRule === "known_only" ? ", only from merchants we've used before" : ""}. Please approve with your wallet signature.`;
}

module.exports = { parseMandate, readBack };
