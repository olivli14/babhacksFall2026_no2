// AI-generated (Claude Code). Creates the Recourse voice agent with webhook tools pointing at PUBLIC_URL.
// Usage: PUBLIC_URL=https://<your-tunnel> node scripts/setup-elevenlabs.js
// Key from keychain: security add-generic-password -a "$USER" -s recourse-elevenlabs-key -w '<key>'
// NOTE: request shape follows the ElevenLabs Agents API as we understand it; if it is rejected,
// create the agent in the dashboard by hand (README → "ElevenLabs manual setup").
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getSecret } = require("../backend/secrets");

const key = getSecret("recourse-elevenlabs-key");
const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
if (!key) throw new Error("Missing keychain item recourse-elevenlabs-key");
if (!base.startsWith("https://")) throw new Error("Set PUBLIC_URL to your public https tunnel (e.g. cloudflared/ngrok)");

const str = (description) => ({ type: "string", description });
const tool = (name, description, properties, required = []) => ({
  type: "webhook",
  name,
  description,
  api_schema: {
    url: `${base}/tools/${name}`,
    method: "POST",
    request_body_schema: { type: "object", description: `${name} arguments`, properties, required },
  },
});

const tools = [
  tool("create_mandate", "Turn the user's spoken spending limits into a mandate awaiting their wallet signature.", {
    text: str("The user's exact words describing their limits"),
  }, ["text"]),
  tool("get_payment_status", "Get the latest payment and any payment waiting for voice confirmation.", {
    payment_id: str("Optional payment ID like P002"),
  }),
  tool("confirm_payment", "Approve or reject the high-risk payment waiting for confirmation.", {
    approve: { type: "boolean", description: "true only if the user clearly said yes" },
    payment_id: str("Optional payment ID"),
  }, ["approve"]),
  tool("file_dispute", "File a dispute for an order and get the evidence-based decision.", {
    description: str("What the user said happened, in their words"),
    reason_code: str("One of INR, SNAD, UNAUTH_AGENT, DUP, DIGITAL_ND if clear"),
    merchant_name: str("Merchant the user mentioned, if any"),
  }, ["description"]),
];

const body = {
  name: "Recourse",
  conversation_config: {
    agent: {
      first_message: "Hi, this is Recourse. I can set your agent's spending limits, confirm risky payments, or help with a problem order. What do you need?",
      language: "en",
      prompt: { prompt: fs.readFileSync(path.join(__dirname, "..", "elevenlabs", "prompt.md"), "utf8"), tools },
    },
  },
};

(async () => {
  const r = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) { console.error(JSON.stringify(j, null, 2)); process.exit(1); }
  console.log("Created agent", j.agent_id);
  if (process.platform === "darwin") {
    execFileSync("security", ["add-generic-password", "-U", "-a", process.env.USER, "-s", "recourse-elevenlabs-agent-id", "-w", j.agent_id]);
    console.log("Saved agent id to keychain (recourse-elevenlabs-agent-id). Restart the backend to show the widget.");
  }
})();
