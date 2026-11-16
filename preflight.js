// OneShot — execution-integrity preflight for Telegraph Hackathon Season II
// Mission 01 Exchange + Mission 14 Web3 Native & DeFi, Apps & Agents track.
// Sepolia testnet only.
//
// OneShot is the idea: a token-risk check whose verdict you can trust because
// the execution itself is proven, not just the purchases. Telegraph gives you
// receipts (signal hashes) for each paid check. OneShot adds the proof that
// the memo actually came from those signals:
//   1. a canonical execution record (JSON) of the whole run, SHA-256 hashed;
//   2. the hash anchored on-chain on Sepolia (a 0-value self-transaction
//      carrying the hash as calldata), so the record is tamper-evident;
//   3. a verify command (verify.js) that recomputes the hash, checks the
//      anchor, re-fetches every signal from the Telegraph node, and re-runs
//      the verdict rules to confirm the memo matches the evidence.
// Every run is numbered in order (run sequence, persisted in the output dir),
// so a run cannot be silently re-rolled to get a better verdict.
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
// The Sepolia anchor transaction costs Sepolia ETH gas (testnet, free) — it
// does NOT count toward the $0.10 USDC spend cap.
//
// What it checks (paid, via Telegraph):
//   wash trading, security review, liquidity depth, sanctions screening.
// What it checks (free, no key):
//   honeypot sell simulation (honeypot.is) — a 100% sell-tax honeypot is
//   invisible to every Telegraph intent, so this leg catches it;
//   DexScreener cross-check on the liquidity figure — a plausible-looking
//   miner number is not trusted blindly.
//
// Honesty rule: a leg that comes back inconclusive, missing, or thin forces
// REVIEW. A token is never labelled LIST or HOLD on a thin audit leg alone.
// SMART_CONTRACT_AUDIT has no typed response format on the live node, so the
// audit leg is SECURITY_REVIEW_GENERAL, with optional CODE_REVIEW_GENERAL
// when contract source is supplied via --source.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

export const TOOL_NAME = "oneshot";
export const TOOL_VERSION = "2.0.0";
export const NODE = "https://devnode.telegraphprotocol.com";
export const NETWORK = "eip155:11155111";
export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
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
  HONEYPOT: "HONEYPOT_SELL_SIMULATION",
};

// honeypot.is chain ids (https://api.honeypot.is/v2/IsHoneypot)
export const HONEYPOT_CHAIN_IDS = { ethereum: 1, polygon: 137, arbitrum: 42161, base: 8453 };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// --- Canonical JSON + hashing (OneShot execution record) -------------------
// Deterministic stringify: object keys sorted recursively, so the same
// record always hashes to the same value no matter who builds it.
export function canonicalize(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

export function sha256Hex(str) {
  return `0x${createHash("sha256").update(str, "utf8").digest("hex")}`;
}

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
  if (intent === INTENTS.HONEYPOT) {
    return judgeHoneypot(result);
  }
  return { verdict: "review", reason: "Unjudged leg." };
}

// Honeypot sell simulation (honeypot.is, free, no key). The raw API response
// is the `result` here: { honeypotResult, simulationResult, simulationSuccess,
// simulationError, ... }. A token that cannot be proven sellable is not a
// clean pass — and a failed simulation is a reject, because the whole point
// of the check is that the sell must work.
export function judgeHoneypot(result) {
  if (!result || typeof result !== "object") {
    return { verdict: "review", reason: "Honeypot check unavailable — sell simulation could not be verified." };
  }
  const hr = result.honeypotResult || {};
  const sr = result.simulationResult || {};
  const simOk = result.simulationSuccess;
  if (hr.isHoneypot === true) {
    return { verdict: "reject", reason: "honeypot.is flags this token as a honeypot — the sell simulation marks it untradeable." };
  }
  if (typeof sr.sellTax === "number" && sr.sellTax >= 99) {
    return { verdict: "reject", reason: `Sell tax is ${sr.sellTax}% — selling would lose almost everything.` };
  }
  if (simOk === false) {
    const err = result.simulationError ? ` (${String(result.simulationError).slice(0, 200)})` : "";
    return { verdict: "reject", reason: `Sell simulation failed${err} — the token could not be proven sellable.` };
  }
  if (simOk !== true || typeof sr.sellTax !== "number") {
    return { verdict: "review", reason: "Honeypot check returned no usable sell simulation — sell could not be verified." };
  }
  return { verdict: "clean", reason: `Sell simulation succeeded, sell tax ${sr.sellTax}%, not a honeypot.` };
}

// Fetch the honeypot.is v2 result for a token. Returns { ok, data } or
// { ok: false, error }. The www host is Cloudflare-protected and returns
// HTML; the api host returns JSON.
export async function fetchHoneypot(token, chain) {
  const chainId = HONEYPOT_CHAIN_IDS[chain];
  if (!chainId) return { ok: false, error: `No honeypot.is chain id for ${chain}` };
  try {
    const res = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${chainId}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, error: `honeypot.is HTTP ${res.status}` };
    const data = await res.json();
    if (!data || typeof data !== "object" || (!data.token && !data.honeypotResult && !data.simulationResult && data.simulationSuccess === undefined)) {
      return { ok: false, error: "honeypot.is returned no usable data for this token" };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `honeypot.is unreachable: ${String(e).slice(0, 200)}` };
  }
}

// The ask response's shaped result for the liquidity leg is only
// { liquidity_usd } — the pool address lives in the signal's payload.
// Fetch it from the signal so the pair confirmation can run.
async function fetchSignalPoolAddress(signalHash) {
  try {
    const res = await fetch(`${NODE}/engine/v1/signal/${signalHash}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.payload?.response?.pool_address ?? null;
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// DexScreener cross-check on the liquidity leg. The token endpoint does not
// always surface the main pool (for USDC it returns 3 ethereum pairs topped
// at ~$5.7M while the real WETH/USDC pool holds ~$77M), so a >10x
// disagreement is confirmed against the exact pool before downgrading —
// otherwise the check would flag genuinely liquid tokens. The cross-check
// can only downgrade clean -> review, never upgrade review -> clean.
export async function applyDexScreenerCrossCheck(legs, chain, token) {
  const liq = legs.find((l) => l.intent === INTENTS.LIQUIDITY);
  if (!liq) return legs;
  const figure = liq.result?.liquidity_usd;
  if (typeof figure !== "number") {
    liq.cross_check = { source: "dexscreener", outcome: "skipped", note: "No liquidity figure to cross-check." };
    return legs;
  }
  let dex;
  try {
    dex = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
  } catch (e) {
    liq.cross_check = { source: "dexscreener", outcome: "unavailable", note: `Cross-check unavailable: ${String(e).slice(0, 150)}` };
    return legs;
  }
  const pairs = (dex?.pairs || []).filter((p) => p.chainId === chain);
  const liquidities = pairs.map((p) => Number(p?.liquidity?.usd) || 0).filter((n) => Number.isFinite(n));
  const dexMax = liquidities.length ? Math.max(...liquidities) : 0;
  const base = { source: "dexscreener", dex_max_usd: dexMax, dex_pairs_on_chain: pairs.length, telegraph_usd: figure };
  if (!pairs.length || dexMax <= 0) {
    if (liq.judgement.verdict === "clean") {
      liq.judgement = { verdict: "review", reason: `DexScreener shows no pairs / $0 liquidity for this token on ${chain}, but Telegraph reported $${Number(figure).toLocaleString()} — the figure is not trusted.` };
    }
    liq.cross_check = { ...base, outcome: "conflicting-no-market" };
    return legs;
  }
  const ratio = figure / dexMax;
  if (ratio <= 10 && ratio >= 0.1) {
    liq.cross_check = { ...base, outcome: "agree", note: `DexScreener top pair on ${chain} ($${dexMax.toLocaleString()}) is within 10x of Telegraph $${Number(figure).toLocaleString()}.` };
    return legs;
  }
  // >10x apart: confirm against the exact pool from the Telegraph result
  // before downgrading, so a real pool is not flagged by an incomplete list.
  // The pool address is not in the ask result — fetch it from the signal.
  let poolAddress = liq.result?.pool_address || null;
  if (!poolAddress && liq.signal_hash) {
    poolAddress = await fetchSignalPoolAddress(liq.signal_hash);
  }
  let pairConfirmed = null;
  if (poolAddress) {
    try {
      const pairData = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${poolAddress}`);
      const p = (pairData?.pairs || [])[0];
      const pairLiq = Number(p?.liquidity?.usd) || 0;
      if (pairLiq > 0) pairConfirmed = pairLiq;
    } catch { /* fall through to downgrade */ }
  }
  if (pairConfirmed) {
    const pr = figure / pairConfirmed;
    if (pr <= 10 && pr >= 0.1) {
      liq.cross_check = { ...base, outcome: "confirmed-by-pair", pair_address: poolAddress, pair_liquidity_usd: pairConfirmed, note: `Token-endpoint top pair ($${dexMax.toLocaleString()}) disagreed, but the exact pool on DexScreener holds $${pairConfirmed.toLocaleString()}, within 10x of Telegraph $${Number(figure).toLocaleString()}.` };
      return legs;
    }
  }
  if (liq.judgement.verdict === "clean") {
    liq.judgement = { verdict: "review", reason: `Liquidity figures conflict: Telegraph reported $${Number(figure).toLocaleString()}, DexScreener top pair on ${chain} shows $${dexMax.toLocaleString()} (more than 10x apart) — the figure is not trusted.` };
  }
  liq.cross_check = { ...base, outcome: "conflicting-figures", pair_address: poolAddress, pair_liquidity_usd: pairConfirmed };
  return legs;
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

// Map a raw Telegraph signal payload.response back to the shape the ask
// call returns (body.result), so verify.js can re-judge the re-fetched
// signal with the same judgeLeg. The ask layer normalises the security
// leg: an empty findings list becomes vulnerability_count null / issues
// null (thin), not 0 / [].
export function normalizeSignalResult(intent, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (intent === INTENTS.WASH) {
    return { subject: raw.subject ?? null, verdict: raw.verdict ?? null, wash_volume_pct: raw.wash_volume_pct ?? null, signals: raw.signals && raw.signals.length ? raw.signals : null, summary: raw.summary ?? null };
  }
  if (intent === INTENTS.SECURITY) {
    const findings = Array.isArray(raw.findings) ? raw.findings : null;
    const vc = raw.vulnerability_count ?? (findings && findings.length ? findings.length : null);
    const issues = raw.issues ?? (findings && findings.length ? findings : null);
    // The ask layer capitalises the verdict ("secure" -> "Secure") and
    // turns an empty findings list into nulls (thin), not 0 / [].
    const verdict = raw.verdict ? raw.verdict.charAt(0).toUpperCase() + raw.verdict.slice(1) : null;
    return { verdict, vulnerability_count: vc, issues, summary: raw.answer ?? raw.summary ?? raw.reason ?? null };
  }
  if (intent === INTENTS.CODE_REVIEW) {
    return { verdict: raw.verdict ?? null, findings: raw.findings && raw.findings.length ? raw.findings : null };
  }
  if (intent === INTENTS.LIQUIDITY) {
    return { liquidity_usd: raw.liquidity_usd ?? null };
  }
  if (intent === INTENTS.SANCTIONS) {
    return { name: raw.name ?? null, matched: raw.matched ?? null, matches: raw.matches && raw.matches.length ? raw.matches : null, lists: raw.lists && raw.lists.length ? raw.lists : null, match_score: raw.match_score ?? null };
  }
  if (intent === INTENTS.SOCIAL_BOT) {
    return { verdict: raw.verdict ?? null, bot_score: raw.bot_score ?? null };
  }
  return null;
}

// Run sequence: persisted in the output dir so runs are numbered in order.
// A run cannot be silently re-rolled — every execution gets the next number.
export function readRunSeq(outDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(outDir, "run-sequence.json"), "utf8"));
    return Number(data.last_run_seq) || 0;
  } catch {
    return 0;
  }
}

export function writeRunSeq(outDir, seq) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "run-sequence.json"), JSON.stringify({ last_run_seq: seq, updated_at_utc: new Date().toISOString() }, null, 2));
}

export function renderMemo(report) {
  const lines = [];
  lines.push(`# OneShot execution record — ${report.token} on ${report.chain}`);
  lines.push("");
  lines.push(`Network: Sepolia testnet (eip155:11155111) — testnet result, not mainnet.`);
  lines.push(`Mission 01 (Exchange) verdict: **${report.decision.memo}**`);
  lines.push(`Mission 14 (Web3 Native & DeFi) verdict: **${report.decision.preflight}**`);
  lines.push("");
  lines.push(`Total cost: $${report.total_cost_usd.toFixed(2)} testnet USDC (${report.receipts_returned ?? report.legs.length} of ${report.legs.length} paid calls returned a receipt).`);
  lines.push("");
  for (const leg of report.legs) {
    lines.push(`## ${leg.intent}`);
    lines.push(`- Leg verdict: ${leg.judgement.verdict.toUpperCase()} — ${leg.judgement.reason}`);
    if (leg.source) lines.push(`- Source: ${leg.source} (free check, no Telegraph payment)`);
    else lines.push(`- Cost: $${(leg.cost_usd ?? 0).toFixed(2)} — ${leg.duration_ms ?? "?"} ms — signal_hash: ${leg.signal_hash ?? "none"}`);
    lines.push(`- Receipt verified: ${leg.signal_verified === true ? "yes" : leg.signal_verified === false ? "no" : "not checked"}`);
    if (leg.source === "honeypot.is" && leg.result) {
      const r = leg.result;
      const sr = r.simulationResult || {};
      lines.push(`- Result: isHoneypot=${r.honeypotResult?.isHoneypot ?? "?"}, sellTax=${sr.sellTax ?? "?"}%, buyTax=${sr.buyTax ?? "?"}%, simulationSuccess=${r.simulationSuccess ?? "?"}${r.simulationError ? `, error: ${r.simulationError}` : ""}`);
    } else if (leg.result) {
      lines.push(`- Result: ${JSON.stringify(leg.result)}`);
    }
    if (leg.cross_check) {
      const cc = leg.cross_check;
      lines.push(`- DexScreener cross-check: ${cc.outcome}${cc.note ? ` — ${cc.note}` : ""}`);
    }
    if (leg.consistency_flag) lines.push(`- Consistency flag: ${leg.consistency_flag}`);
    if (leg.error) lines.push(`- Error: ${leg.error}`);
    lines.push("");
  }
  if (report.decision.notes.length) {
    lines.push("## Notes");
    for (const n of report.decision.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  const ex = report.execution;
  if (ex) {
    lines.push("## Execution integrity — OneShot");
    lines.push(`- Execution record hash (SHA-256): ${ex.record_hash}`);
    lines.push(`- Run sequence: #${ex.record.run_seq}`);
    if (ex.anchor_tx_hash) {
      lines.push(`- Anchor tx (Sepolia): ${ex.anchor_tx_hash}`);
      lines.push(`- Anchor: https://sepolia.etherscan.io/tx/${ex.anchor_tx_hash} (gas used: ${ex.anchor_gas_used ?? "?"}, block ${ex.anchor_block ?? "?"})`);
    } else {
      lines.push(`- Anchor tx: not anchored — ${ex.anchor_note ?? "no anchor"}`);
    }
    lines.push(`- Verify it yourself: node verify.js ${ex.verify_path}`);
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

// Fetch the full signal body (the receipt). Returns null on failure.
// The signal's payload.response is the authoritative miner response — the
// ask call's shaped result is sometimes lossy (null fields) while the
// signal carries the full data.
export async function fetchSignalBody(hash) {
  try {
    const res = await fetch(`${NODE}/engine/v1/signal/${hash}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    return await res.json();
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
    console.log("# OneShot execution record — failed input");
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

  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

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

    // Prefer the signal's payload as the authoritative result: the ask
    // call's shaped result is sometimes lossy (null fields) while the
    // signal — the receipt — carries the full miner response. The verdict
    // must be judged on the evidence that can be re-fetched and verified,
    // not on a lossy copy of it. Fall back to the ask result if the signal
    // cannot be fetched.
    let signal_verified = null;
    let result = body?.result ?? null;
    let resultSource = "ask";
    if (body?.signal_hash) {
      const sigBody = await fetchSignalBody(body.signal_hash);
      signal_verified = sigBody ? (sigBody?.verification?.verified === true || sigBody?.verified === true) : await verifySignal(body.signal_hash);
      const raw = sigBody?.payload?.response ?? sigBody?.result ?? null;
      const normalized = normalizeSignalResult(call.intent, raw);
      if (normalized) {
        result = normalized;
        resultSource = "signal";
      }
    }

    const judgement = body?.result_shape === "raw"
      ? { verdict: "review", reason: "Result came back raw (no typed response format) — unusable as a clean leg." }
      : judgeLeg(call.intent, result, body?.field_status);
    legs.push({
      intent: call.intent, params: call.params, judgement,
      cost_usd, duration_ms, signal_hash: body?.signal_hash ?? null, signal_verified,
      result, result_source: resultSource, field_status: body?.field_status ?? null,
      result_shape: body?.result_shape ?? null,
      miner: body?.miner_name ?? body?.miner_id ?? null,
      receipt_present: !!res.headers.get("x-telegraph-receipt"),
    });
    console.error(`${call.intent}: ${res.status} $${cost_usd.toFixed(2)} ${duration_ms}ms ${body?.signal_hash ? "receipt ok" : "no signal_hash"}`);
  }

  // Free leg: honeypot sell simulation (honeypot.is, no key). Runs after the
  // paid legs, before the verdict, so a honeypot forces REJECT.
  {
    const t0 = Date.now();
    const hp = await fetchHoneypot(token, chain);
    if (hp.ok) {
      const judgement = judgeHoneypot(hp.data);
      legs.push({
        intent: INTENTS.HONEYPOT, source: "honeypot.is", judgement,
        cost_usd: 0, duration_ms: Date.now() - t0, signal_hash: null, signal_verified: null,
        result: {
          honeypotResult: hp.data.honeypotResult ?? null,
          simulationResult: hp.data.simulationResult ?? null,
          simulationSuccess: hp.data.simulationSuccess ?? null,
          simulationError: hp.data.simulationError ?? null,
        },
        raw_response: hp.data,
      });
      console.error(`${INTENTS.HONEYPOT}: ${judgement.verdict} ${Date.now() - t0}ms`);
    } else {
      legs.push({
        intent: INTENTS.HONEYPOT, source: "honeypot.is",
        judgement: { verdict: "review", reason: "Honeypot check unavailable — sell simulation could not be verified." },
        cost_usd: 0, duration_ms: Date.now() - t0, signal_hash: null, signal_verified: null,
        result: null, error: hp.error,
      });
      console.error(`${INTENTS.HONEYPOT}: unavailable ${Date.now() - t0}ms (${hp.error})`);
    }
  }

  applyConsistencyChecks(legs);
  await applyDexScreenerCrossCheck(legs, chain, token);

  const receipts = legs.filter((l) => l.signal_hash).length;
  const report = {
    tool: TOOL_NAME,
    tool_version: TOOL_VERSION,
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

  // OneShot execution record: canonical JSON of the whole run, SHA-256
  // hashed, then anchored on Sepolia. The record is the provable object;
  // the anchor only proves this exact record existed at this time.
  fs.mkdirSync(out, { recursive: true });
  const runSeq = readRunSeq(out) + 1;
  writeRunSeq(out, runSeq);
  const record = {
    tool: TOOL_NAME,
    tool_version: TOOL_VERSION,
    chain, token, treasury: treasury || null,
    wallet: account.address,
    run_seq: runSeq,
    run_at_utc: report.run_at_utc,
    legs,
    decision: report.decision,
    total_cost_usd: report.total_cost_usd,
    receipts_returned: receipts,
  };
  const recordHash = sha256Hex(canonicalize(record));
  const base = path.join(out, `preflight-${token.toLowerCase()}`);
  const verifyPath = `${base}.json`;
  let anchor = { tx_hash: null, status: null, gas_used: null, block_number: null, anchored_at_utc: null, note: null };
  if (receipts > 0) {
    try {
      const txHash = await walletClient.sendTransaction({ to: account.address, value: 0n, data: recordHash });
      console.error(`Anchor tx sent: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      anchor = {
        tx_hash: txHash,
        status: receipt.status === "success" ? 1 : 0,
        gas_used: receipt.gasUsed.toString(),
        block_number: Number(receipt.blockNumber),
        anchored_at_utc: new Date().toISOString(),
        note: null,
      };
      console.error(`Anchor confirmed: ${txHash} (gas ${receipt.gasUsed}, block ${receipt.blockNumber})`);
    } catch (e) {
      anchor.note = `anchor failed: ${String(e).slice(0, 200)}`;
      console.error(`Anchor failed: ${String(e).slice(0, 200)}`);
    }
  } else {
    anchor.note = "not anchored: no paid receipts — nothing to prove";
  }
  report.execution = {
    record,
    record_hash: recordHash,
    anchor_tx_hash: anchor.tx_hash,
    anchor_tx_status: anchor.status,
    anchor_gas_used: anchor.gas_used,
    anchor_block: anchor.block_number,
    anchored_at_utc: anchor.anchored_at_utc,
    anchor_note: anchor.note,
    verify_path: verifyPath,
  };

  const memo = renderMemo(report);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, memo);
  console.log(memo);
  console.error(`\nWrote ${base}.json and ${base}.md — total $${report.total_cost_usd.toFixed(2)} testnet USDC. Run #${runSeq}, record ${recordHash}.`);
}

// Only run main() when executed directly, so verify.js can import the
// judgement / normalisation helpers without starting a preflight run.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`Error: ${String(e && e.message ? e.message : e).slice(0, 500)}`);
    process.exit(1);
  });
}
