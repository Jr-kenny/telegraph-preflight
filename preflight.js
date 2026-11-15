// Telegraph Preflight — Mission 01 Exchange + Mission 14 Web3 Native & DeFi
// Telegraph Hackathon Season II, Apps & Agents track, Sepolia testnet only.
//
// Usage:
//   TELEGRAPH_PRIVATE_KEY=0x... node preflight.js <chain> <token-address>
//     [--treasury <wallet-or-name>] [--handle <x-handle>]
//     [--pool "<pair> on <chain>"] [--source <contract-source-file>] [--out <dir>]
//
// The private key comes ONLY from the TELEGRAPH_PRIVATE_KEY environment variable.
// It is never logged, never written to a file, and never committed.
// Each paid Telegraph call costs $0.01 testnet USDC. A 4-call run costs $0.04.
// Spend guards: no single payment over $0.10, no run over $0.10 total.
//
// What it does: four paid Engine Ask + x402 calls on the Sepolia testnet node,
// then a LIST / REVIEW / REJECT memo (Mission 01) and a HOLD / REVIEW / REJECT
// preflight (Mission 14) from the same evidence, with receipts and total cost.
//
// Honesty rule: a leg that comes back inconclusive, missing, or thin forces
// REVIEW. A token is never labelled LIST or HOLD on a thin audit leg alone.
// SMART_CONTRACT_AUDIT has no typed response format on the live node, so the
// audit leg is SECURITY_REVIEW_GENERAL, with optional CODE_REVIEW_GENERAL
// when contract source is supplied via --source.

import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

export const NODE = "https://devnode.telegraphprotocol.com";
export const NETWORK = "eip155:11155111";
export const USDC_SEPOLIA = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
export const MAX_SINGLE_PAYMENT_ATOMIC = 100000n; // $0.10
export const TOTAL_CAP_ATOMIC = 100000n; // $0.10 per run
export const SUPPORTED_CHAINS = ["ethereum", "polygon", "arbitrum", "base"];

export const INTENTS = {
  WASH: "WASH_TRADING_DETECTION_GENERAL",
  SECURITY: "SECURITY_REVIEW_GENERAL",
  CODE_REVIEW: "CODE_REVIEW_GENERAL",
  LIQUIDITY: "LIQUIDITY_DEPTH_VERIFY_GENERAL",
  SANCTIONS: "SANCTIONS_SCREENING_MATCH_GENERAL",
  SOCIAL_BOT: "SOCIAL_BOT_DETECTION_GENERAL",
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function usageError(message) {
  return { ok: false, error: message };
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { chain: null, token: null, treasury: null, handle: null, pool: null, source: null, out: "." };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--treasury") opts.treasury = args[++i];
    else if (a === "--handle") opts.handle = args[++i];
    else if (a === "--pool") opts.pool = args[++i];
    else if (a === "--source") opts.source = args[++i];
    else if (a === "--out") opts.out = args[++i];
    else if (a === "--help" || a === "-h") return { help: true };
    else if (a.startsWith("--")) return usageError(`Unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length < 2) {
    return usageError("Missing arguments. Usage: node preflight.js <chain> <token-address> [--treasury <wallet>] [--handle <x-handle>] [--pool \"<pair> on <chain>\"] [--source <contract-source-file>] [--out <dir>]");
  }
  [opts.chain, opts.token] = positional;
  if (positional.length > 2) return usageError(`Unexpected extra argument: ${positional[2]}`);
  opts.chain = opts.chain.toLowerCase();
  if (!SUPPORTED_CHAINS.includes(opts.chain)) {
    return usageError(`Unsupported chain "${opts.chain}". Supported: ${SUPPORTED_CHAINS.join(", ")}. Note: ONCHAIN_METRIC_VERIFY accepts only ethereum, polygon and arbitrum, and is not part of this tool.`);
  }
  if (!ADDRESS_RE.test(opts.token)) {
    return usageError(`Invalid token address "${opts.token}". Expected a 0x address with 40 hex characters.`);
  }
  if (opts.treasury && !ADDRESS_RE.test(opts.treasury) && opts.treasury.length < 2) {
    return usageError(`Invalid treasury value "${opts.treasury}". Use a wallet address or a project name.`);
  }
  if (opts.source && !fs.existsSync(opts.source)) {
    return usageError(`Contract source file not found: ${opts.source}`);
  }
  return { ok: true, opts };
}

function legStatus(result, fieldStatus) {
  const missing = Object.entries(fieldStatus || {})
    .filter(([, v]) => v === "missing")
    .map(([k]) => k);
  return { missing };
}

// Decide one leg's verdict: clean | review | reject | failed
export function judgeLeg(intent, result, fieldStatus) {
  const { missing } = legStatus(result, fieldStatus);
  if (!result) return { verdict: "failed", reason: "No result returned for this leg." };
  if (intent === INTENTS.WASH) {
    if (result.verdict === "wash_trading" || result.verdict === "likely_wash_trading") {
      if (result.wash_volume_pct != null) {
        return { verdict: "reject", reason: `Wash-trading verdict ${result.verdict}, wash volume ${result.wash_volume_pct}%.` };
      }
      return { verdict: "review", reason: `Wash-trading verdict ${result.verdict}, but no wash_volume_pct was quoted, so the size of the problem is unproven.` };
    }
    if (result.verdict === "inconclusive") {
      return { verdict: "review", reason: "Wash-trading check was inconclusive. Not a clean pass." };
    }
    if (result.verdict === "organic") {
      return missing.length
        ? { verdict: "review", reason: `Verdict organic, but fields missing: ${missing.join(", ")}.` }
        : { verdict: "clean", reason: "Verdict organic." };
    }
    return { verdict: "review", reason: `Unexpected wash verdict: ${result.verdict}.` };
  }
  if (intent === INTENTS.SECURITY) {
    const thin = result.vulnerability_count == null || result.issues == null;
    if (result.verdict === "Insecure") return { verdict: "reject", reason: "Security review verdict: Insecure." };
    if (result.verdict === "Needs changes") {
      return { verdict: "review", reason: "Security review verdict: Needs changes." };
    }
    if (thin) {
      return { verdict: "review", reason: "Security review said Secure, but vulnerability_count and issues came back missing — the review was thin (the miner scanned the address string, not contract code). This is not a full audit." };
    }
    if (result.vulnerability_count === 0) return { verdict: "clean", reason: "Security review Secure, 0 vulnerabilities reported." };
    return { verdict: "review", reason: `Security review Secure, but ${result.vulnerability_count} vulnerabilities reported.` };
  }
  if (intent === INTENTS.CODE_REVIEW) {
    if (result.verdict === "Request changes") return { verdict: "review", reason: "Code review verdict: Request changes." };
    if (!result.findings || result.findings.length === 0) {
      return { verdict: "review", reason: "Code review returned no findings — thin result, not proof of a clean contract." };
    }
    return { verdict: "review", reason: `Code review returned ${result.findings.length} finding(s); read them before listing.` };
  }
  if (intent === INTENTS.LIQUIDITY) {
    if (result.liquidity_usd == null) return { verdict: "review", reason: "Liquidity depth returned no liquidity_usd value." };
    if (result.liquidity_usd < 10000) return { verdict: "review", reason: `Liquidity is only $${Number(result.liquidity_usd).toLocaleString()} — very thin for a listing.` };
    return { verdict: "clean", reason: `Liquidity $${Number(result.liquidity_usd).toLocaleString()}.` };
  }
  if (intent === INTENTS.SANCTIONS) {
    if (result.matched === true) return { verdict: "reject", reason: `Sanctions match: ${JSON.stringify(result.matches ?? result.match_score ?? "")}.` };
    return { verdict: "clean", reason: `No sanctions match (score ${result.match_score ?? 0}).` };
  }
  if (intent === INTENTS.SOCIAL_BOT) {
    if (result.verdict === "bot" || result.verdict === "likely_bot") {
      return { verdict: "review", reason: `Project account looks like a bot (${result.verdict}, score ${result.bot_score ?? "?"}).` };
    }
    return { verdict: "clean", reason: `Project account verdict: ${result.verdict ?? "unknown"}.` };
  }
  return { verdict: "review", reason: "Unjudged leg." };
}

// Cross-leg consistency: legs must not contradict each other. If the wash leg
// reports no DEX market for the token, a liquidity figure for that token
// cannot be trusted as clean, however plausible it looks.
export function applyConsistencyChecks(legs) {
  const wash = legs.find((l) => l.intent === INTENTS.WASH);
  const liq = legs.find((l) => l.intent === INTENTS.LIQUIDITY);
  const noMarket = wash?.result?.summary && /no .* market found/i.test(wash.result.summary);
  if (noMarket && liq && liq.judgement.verdict === "clean") {
    liq.judgement = { verdict: "review", reason: `Liquidity figure $${Number(liq.result?.liquidity_usd ?? 0).toLocaleString()} conflicts with the wash leg, which found no DEX market for this token — the figure is not trusted.` };
    liq.consistency_flag = "conflicts with wash leg (no DEX market found)";
  }
  return legs;
}

export function decideMemo(legs) {
  const byIntent = Object.fromEntries(legs.map((l) => [l.intent, l]));
  const failed = legs.filter((l) => l.judgement.verdict === "failed");
  const rejects = legs.filter((l) => l.judgement.verdict === "reject");
  const reviews = legs.filter((l) => l.judgement.verdict === "review");
  const notes = [];
  if (failed.length) notes.push(`Failed leg(s): ${failed.map((l) => l.intent).join(", ")} — treated as REVIEW, not as a pass.`);
  if (rejects.length) notes.push(`Rejecting leg(s): ${rejects.map((l) => l.intent).join(", ")}.`);
  if (reviews.length) notes.push(`Review leg(s): ${reviews.map((l) => l.intent).join(", ")}.`);

  const security = byIntent[INTENTS.SECURITY];
  const auditThin = security && security.judgement.verdict === "review";
  if (auditThin) notes.push("Audit leg is thin: SECURITY_REVIEW on a bare address is not a full Solidity audit. Do not list on this leg alone.");

  let memo, preflight;
  if (rejects.length) { memo = "REJECT"; preflight = "REJECT"; }
  else if (reviews.length || failed.length) { memo = "REVIEW"; preflight = "REVIEW"; }
  else { memo = "LIST"; preflight = "HOLD"; }
  return { memo, preflight, notes };
}

export function renderMemo(report) {
  const lines = [];
  lines.push(`# Preflight memo — ${report.token} on ${report.chain}`);
  lines.push("");
  lines.push(`Network: Sepolia testnet (eip155:11155111) — testnet result, not mainnet.`);
  lines.push(`Mission 01 (Exchange) verdict: **${report.decision.memo}**`);
  lines.push(`Mission 14 (Web3 Native & DeFi) verdict: **${report.decision.preflight}**`);
  lines.push("");
  lines.push(`Total cost: $${report.total_cost_usd.toFixed(2)} testnet USDC (${report.receipts_returned ?? report.legs.length} of ${report.legs.length} calls returned a receipt).`);
  lines.push("");
  for (const leg of report.legs) {
    lines.push(`## ${leg.intent}`);
    lines.push(`- Leg verdict: ${leg.judgement.verdict.toUpperCase()} — ${leg.judgement.reason}`);
    lines.push(`- Cost: $${(leg.cost_usd ?? 0).toFixed(2)} — ${leg.duration_ms ?? "?"} ms — signal_hash: ${leg.signal_hash ?? "none"}`);
    lines.push(`- Receipt verified: ${leg.signal_verified === true ? "yes" : leg.signal_verified === false ? "no" : "not checked"}`);
    if (leg.result) lines.push(`- Result: ${JSON.stringify(leg.result)}`);
    if (leg.error) lines.push(`- Error: ${leg.error}`);
    lines.push("");
  }
  if (report.decision.notes.length) {
    lines.push("## Notes");
    for (const n of report.decision.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push(`Run at: ${report.run_at_utc} — wallet: ${report.wallet} (testnet only).`);
  return lines.join("\n");
}

async function verifySignal(hash) {
  try {
    const res = await fetch(`${NODE}/engine/v1/signal/${hash}`);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.verification?.verified === true || body?.verified === true;
  } catch {
    return null;
  }
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    console.log("Usage: TELEGRAPH_PRIVATE_KEY=0x... node preflight.js <chain> <token-address> [--treasury <wallet>] [--handle <x-handle>] [--pool \"<pair> on <chain>\"] [--source <contract-source-file>] [--out <dir>]");
    process.exit(0);
  }
  if (!parsed.ok) {
    console.error(`Error: ${parsed.error}`);
    console.log("");
    console.log("# Preflight memo — failed input");
    console.log("");
    console.log(`Mission 01 verdict: **REVIEW** (input rejected, no paid calls made)`);
    console.log(`Mission 14 verdict: **REVIEW** (input rejected, no paid calls made)`);
    console.log("");
    console.log(`- ${parsed.error}`);
    process.exit(2);
  }
  const { chain, token, treasury, handle, pool, source, out } = parsed.opts;

  const rawKey = process.env.TELEGRAPH_PRIVATE_KEY;
  if (!rawKey || !/^0x[0-9a-fA-F]{64}$/.test(rawKey.trim())) {
    console.error("Error: TELEGRAPH_PRIVATE_KEY is missing or not a 0x 64-hex private key. Set it in the environment; never put it in a file in this repo.");
    process.exit(2);
  }
  const account = privateKeyToAccount(rawKey.trim());
  console.error(`Wallet: ${account.address} (testnet only)`);

  let sourceCode = null;
  if (source) {
    sourceCode = fs.readFileSync(source, "utf8");
    if (sourceCode.length > 8000) sourceCode = sourceCode.slice(0, 8000) + "\n// [truncated to 8000 chars for the review call]";
  }

  const walletClient = createWalletClient({ account, chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
  void walletClient;

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
    spendControls: {
      allowedAssets: [{ network: NETWORK, asset: USDC_SEPOLIA, maxAmountPerPayment: "100000" }],
    },
  });

  const calls = [
    { intent: INTENTS.WASH, params: { subject: `${token} on ${chain}` } },
    { intent: INTENTS.SECURITY, params: { target: token } },
    { intent: INTENTS.LIQUIDITY, params: { pool: pool || `${token} on ${chain}`, chain } },
    { intent: INTENTS.SANCTIONS, params: { name: treasury || token } },
  ];
  if (sourceCode) calls.push({ intent: INTENTS.CODE_REVIEW, params: { code: sourceCode } });
  if (handle) calls.push({ intent: INTENTS.SOCIAL_BOT, params: { account: handle } });

  let totalPaidAtomic = 0n;
  const legs = [];

  for (const call of calls) {
    // Probe the 402 challenge first and check the price before paying.
    let challenge = { http_status: null };
    try {
      const probe = await fetch(`${NODE}/engine/v1/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: call.intent, params: call.params }),
      });
      const pr = probe.headers.get("payment-required");
      challenge.http_status = probe.status;
      if (pr) {
        const decoded = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
        const entry = (decoded.accepts || []).find((a) => a.network === NETWORK && a.scheme === "exact");
        if (entry) {
          challenge = { http_status: probe.status, amount_atomic: entry.amount, pay_to: entry.payTo, asset: entry.asset };
          if (BigInt(entry.amount) > MAX_SINGLE_PAYMENT_ATOMIC) throw new Error(`Payment for ${call.intent} is $${(Number(entry.amount) / 1e6).toFixed(2)} — over the $0.10 per-payment cap. Aborting.`);
          if (totalPaidAtomic + BigInt(entry.amount) > TOTAL_CAP_ATOMIC) throw new Error(`Total spend cap $0.10 would be exceeded by ${call.intent}. Aborting.`);
        }
      }
    } catch (e) {
      if (e.message.includes("cap") || e.message.includes("Aborting")) throw e;
      challenge = { http_status: challenge.http_status, note: `challenge probe failed: ${String(e).slice(0, 200)}` };
    }

    const t0 = Date.now();
    let res, bodyText;
    try {
      res = await fetchWithPayment(`${NODE}/engine/v1/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: call.intent, params: call.params }),
      });
      bodyText = await res.text();
    } catch (e) {
      legs.push({ intent: call.intent, params: call.params, judgement: { verdict: "failed", reason: `Request failed: ${String(e).slice(0, 300)}` }, cost_usd: 0, duration_ms: Date.now() - t0, signal_hash: null, signal_verified: null, result: null, error: String(e).slice(0, 300) });
      continue;
    }
    const duration_ms = Date.now() - t0;
    let body = null;
    try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText.slice(0, 1000) }; }

    // A leg only counts as paid when it comes back 200 with a signal_hash
    // (i.e. a receipt). A 402 or other non-200 means no payment settled:
    // cost $0.00, leg failed, and the challenge amount is NOT added to the total.
    if (res.status !== 200 || !body?.signal_hash) {
      const detail = body?.error ?? body?.message ?? bodyText.slice(0, 300);
      legs.push({
        intent: call.intent, params: call.params,
        judgement: { verdict: "failed", reason: `Leg returned HTTP ${res.status} with no receipt. ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}` },
        cost_usd: 0, duration_ms, signal_hash: null, signal_verified: null,
        result: null, field_status: null, miner: null, receipt_present: false,
        error: `HTTP ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`,
      });
      console.error(`${call.intent}: ${res.status} $0.00 ${duration_ms}ms no receipt`);
      continue;
    }

    totalPaidAtomic += BigInt(challenge.amount_atomic ?? 10000);
    const cost_usd = body?.cost_usd != null ? Number(body.cost_usd) : Number(challenge.amount_atomic ?? 10000) / 1e6;

    let signal_verified = null;
    if (body?.signal_hash) signal_verified = await verifySignal(body.signal_hash);

    const result = body?.result ?? null;
    const judgement = body?.result_shape === "raw"
      ? { verdict: "review", reason: "Result came back raw (no typed response format) — unusable as a clean leg." }
      : judgeLeg(call.intent, result, body?.field_status);
    legs.push({
      intent: call.intent, params: call.params, judgement,
      cost_usd, duration_ms, signal_hash: body?.signal_hash ?? null, signal_verified,
      result, field_status: body?.field_status ?? null,
      miner: body?.miner_name ?? body?.miner_id ?? null,
      receipt_present: !!res.headers.get("x-telegraph-receipt"),
    });
    console.error(`${call.intent}: ${res.status} $${cost_usd.toFixed(2)} ${duration_ms}ms ${body?.signal_hash ? "receipt ok" : "no signal_hash"}`);
  }

  applyConsistencyChecks(legs);

  const receipts = legs.filter((l) => l.signal_hash).length;
  const report = {
    tool: "telegraph-preflight",
    network: NETWORK,
    network_label: "Sepolia testnet",
    chain, token, treasury: treasury || null, handle: handle || null,
    wallet: account.address,
    run_at_utc: new Date().toISOString(),
    legs,
    receipts_returned: receipts,
    total_cost_usd: Number((Number(totalPaidAtomic) / 1e6).toFixed(4)),
    decision: null,
  };
  report.decision = decideMemo(legs);
  const memo = renderMemo(report);

  fs.mkdirSync(out, { recursive: true });
  const base = path.join(out, `preflight-${token.toLowerCase()}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, memo);
  console.log(memo);
  console.error(`\nWrote ${base}.json and ${base}.md — total $${report.total_cost_usd.toFixed(2)} testnet USDC.`);
}

main().catch((e) => {
  console.error(`Error: ${String(e && e.message ? e.message : e).slice(0, 500)}`);
  process.exit(1);
});
