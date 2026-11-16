// server.js — OneShot live demo API (Telegraph Hackathon Season II)
// Serves the demo page (docs/) and a small API that runs a real preflight.
//
//   GET  /                 the demo page (docs/index.html)
//   GET  /api/health       { ok: true }
//   POST /api/run          { chain, token } -> starts a real preflight run.
//                          With Accept: text/event-stream it streams live
//                          progress events and ends with a `result` event
//                          holding the full report + verify object.
//                          With Accept: application/json (or anything else)
//                          it waits for the run and returns the full result
//                          JSON directly. Bad input -> 400, $0 spent.
//                          The result is the full preflight report JSON
//                          (execution.record, execution.record_hash,
//                          execution.anchor_tx_hash, decision.memo/preflight,
//                          legs with signal hashes and costs) plus a
//                          `verify` object { passed, output }, plus a few
//                          convenience aliases at the top level
//                          (runId, runSeq, recordHash, anchorTx, ...).
//   GET  /api/runs/:id     one run (for polling if the stream drops)
//   GET  /api/runs         past runs (newest first)
//
// Rate limits (in-memory, no extra dependency): 1 run per IP per 5 minutes,
// 20 runs total per day, and only one run at a time (the preflight writes
// a shared run sequence and pays from one wallet). 429 when limited.
// The private key comes ONLY from TELEGRAPH_PRIVATE_KEY in the environment.
// It is never logged, never written to a file, and never returned. Any
// captured child output is redacted of the key before it is stored or sent.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RESULTS_DIR = path.join(ROOT, "results");
const DOCS_DIR = path.join(ROOT, "docs");
// The demo treasury — the dedicated OneShot hackathon wallet. A hackathon
// gets its own wallet, separate from the routine-farming wallet. Runs #1–#7
// anchored from the farming wallet (already on-chain, cannot change); every
// demo run from run #8 on anchors from this hackathon wallet.
const TREASURY = "0x5598196977FB3b9D7E86Ca2495d9e3622A77F38C";
const SUPPORTED_CHAINS = ["ethereum", "polygon", "arbitrum", "base"];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PER_IP_WINDOW_MS = 5 * 60 * 1000; // 1 run per IP per 5 minutes
const DAILY_CAP = 20; // 20 runs total per day (testnet USDC is $0.04/run)
const RUN_TIMEOUT_MS = 300 * 1000; // a run takes ~60-90s; 5 min is the cap

const PRIVATE_KEY = process.env.TELEGRAPH_PRIVATE_KEY || "";
const KEY_IS_SET = /^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY.trim());

function redact(text) {
  if (!text) return text;
  let out = String(text);
  if (PRIVATE_KEY) {
    out = out.split(PRIVATE_KEY).join("[REDACTED]");
    out = out.split(PRIVATE_KEY.replace(/^0x/, "")).join("[REDACTED]");
  }
  return out;
}

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; req.ip must be the real client IP
app.use(express.json({ limit: "16kb" }));

// CORS: the demo page is served from GitHub Pages (a different origin), so
// the API must accept cross-origin calls. Public demo, no credentials.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Rate limiting (in-memory) --------------------------------------------
const perIp = new Map(); // ip -> last run start timestamp
let daily = { date: "", count: 0 };
let runInProgress = null; // run id, or null

function dailyCount() {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.date !== today) daily = { date: today, count: 0 };
  return daily.count;
}

function checkLimits(ip) {
  const now = Date.now();
  const last = perIp.get(ip);
  if (last && now - last < PER_IP_WINDOW_MS) {
    const waitSec = Math.ceil((PER_IP_WINDOW_MS - (now - last)) / 1000);
    return { limited: true, status: 429, message: `Rate limited: one run per 5 minutes per visitor. Try again in about ${Math.ceil(waitSec / 60)} minute(s).` };
  }
  if (dailyCount() >= DAILY_CAP) {
    return { limited: true, status: 429, message: "Daily limit reached: 20 runs a day, so the demo wallet is not drained. Try again tomorrow." };
  }
  if (runInProgress) {
    return { limited: true, status: 429, message: "A run is already in progress. Wait for it to finish, then try again." };
  }
  return { limited: false };
}

// --- Run store (in-memory; the results/ files are the durable record) -----
const runs = new Map(); // id -> run object
let runCounter = 0;

function newRunId() {
  runCounter += 1;
  return `r${Date.now().toString(36)}${runCounter.toString(36)}`;
}

// Read a past run report from results/ and return a short summary.
function readRunSummaries() {
  let files = [];
  try {
    files = fs.readdirSync(RESULTS_DIR).filter((f) => f.startsWith("preflight-") && f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"));
      out.push({
        runSeq: report.execution?.record?.run_seq ?? null,
        token: report.token,
        chain: report.chain,
        memo: report.decision?.memo ?? null,
        preflight: report.decision?.preflight ?? null,
        totalCostUsd: report.total_cost_usd ?? null,
        recordHash: report.execution?.record_hash ?? null,
        anchorTx: report.execution?.anchor_tx_hash ?? null,
        anchorBlock: report.execution?.anchor_block ?? null,
        runAt: report.run_at_utc ?? null,
      });
    } catch { /* skip unreadable files */ }
  }
  out.sort((a, b) => (b.runSeq ?? 0) - (a.runSeq ?? 0));
  return out.slice(0, 50);
}

// The run itself: spawn the v2 preflight, then verify.js on its report.
// Progress lines (the child's stderr, redacted) are pushed to listeners.
function startRun(chain, token, ip) {
  const id = newRunId();
  const run = {
    id,
    ip,
    chain,
    token: token.toLowerCase(),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: [],
    result: null,
    error: null,
    listeners: new Set(),
  };
  run.finished = new Promise((resolve) => { run._resolve = resolve; });
  runs.set(id, run);
  runInProgress = id;
  perIp.set(ip, Date.now());
  dailyCount();
  daily.count += 1;

  const push = (line) => {
    const clean = redact(line).trim();
    if (!clean) return;
    run.progress.push(clean);
    if (run.progress.length > 200) run.progress.splice(0, run.progress.length - 200);
    for (const fn of run.listeners) fn(clean);
  };
  run._push = push;
  push(`Run started: ${chain} ${token.toLowerCase()}`);

  const child = spawn("node", ["preflight.js", chain, token, "--treasury", TREASURY, "--out", "results"], {
    cwd: ROOT,
    env: process.env, // TELEGRAPH_PRIVATE_KEY is already in the environment
    timeout: RUN_TIMEOUT_MS,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, RUN_TIMEOUT_MS);

  let stderrTail = "";
  child.stdout.on("data", () => { /* the memo goes to the report file, not the stream */ });
  child.stderr.on("data", (chunk) => {
    const text = redact(chunk.toString());
    stderrTail = (stderrTail + text).slice(-2000);
    for (const line of text.split("\n")) push(line);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    finishRun(run, "failed", `Could not start the preflight: ${redact(String(err)).slice(0, 300)}`);
  });
  child.on("close", async (code) => {
    clearTimeout(timer);
    if (timedOut) {
      finishRun(run, "failed", "The run timed out after 5 minutes. No result was produced.");
      return;
    }
    if (code !== 0) {
      finishRun(run, "failed", `The preflight exited with code ${code}. ${stderrTail.trim().slice(-500) || "No further detail."}`);
      return;
    }
    const reportPath = path.join(RESULTS_DIR, `preflight-${token.toLowerCase()}.json`);
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch (e) {
      finishRun(run, "failed", `The preflight finished but its report could not be read: ${String(e).slice(0, 200)}`);
      return;
    }
    push("Preflight finished — verifying the execution record…");
    const verify = await runVerify(reportPath);
    const ex = report.execution || {};
    const memoPath = path.join(RESULTS_DIR, `preflight-${token.toLowerCase()}.md`);
    let memo = null;
    try { memo = fs.readFileSync(memoPath, "utf8"); } catch { /* memo is optional */ }
    // The API contract: the full preflight report JSON, plus a verify object.
    // The report itself carries execution.record, execution.record_hash,
    // execution.anchor_tx_hash, decision.memo/preflight, and the legs with
    // signal hashes and costs. A few convenience aliases are included at
    // the top level (same values, shorter names) for the demo page.
    run.result = {
      ...report,
      verify: { passed: verify.exitCode === 0, output: verify.output },
      runId: id,
      runSeq: ex.record?.run_seq ?? null,
      recordHash: ex.record_hash ?? null,
      anchorTx: ex.anchor_tx_hash ?? null,
      anchorBlock: ex.anchor_block ?? null,
      anchorGasUsed: ex.anchor_gas_used ?? null,
      anchorNote: ex.anchor_note ?? null,
      totalCostUsd: report.total_cost_usd,
      runAt: report.run_at_utc,
      memo,
    };
    finishRun(run, "done", null);
  });

  return run;
}

function finishRun(run, status, error) {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  if (error) run.error = error;
  if (runInProgress === run.id) runInProgress = null;
  run._resolve(run);
  for (const fn of run.listeners) fn(null); // null = stream closed
}

function runVerify(reportPath) {
  return new Promise((resolve) => {
    const child = spawn("node", ["verify.js", reportPath], { cwd: ROOT, timeout: 120000 });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { out += c.toString(); });
    child.on("error", (e) => resolve({ exitCode: 1, output: `Could not run verify.js: ${redact(String(e)).slice(0, 200)}` }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: redact(out).trim() }));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* done */ } }, 120000);
  });
}

// Public view of a run (what the API returns).
function publicRun(run) {
  return {
    id: run.id,
    chain: run.chain,
    token: run.token,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    progress: run.progress,
    error: run.error,
    result: run.result,
  };
}

// --- Routes -----------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/runs", (_req, res) => res.json({ runs: readRunSummaries() }));

app.get("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "No run with that id on this server. Past runs are listed at GET /api/runs." });
  res.json(publicRun(run));
});

app.post("/api/run", (req, res) => {
  const { chain, token } = req.body || {};
  if (typeof chain !== "string" || !SUPPORTED_CHAINS.includes(chain.toLowerCase())) {
    return res.status(400).json({ error: `Invalid chain "${chain}". Supported: ${SUPPORTED_CHAINS.join(", ")}. Nothing was spent, no run started.` });
  }
  if (typeof token !== "string" || !ADDRESS_RE.test(token.trim())) {
    return res.status(400).json({ error: `Invalid token address "${token}". Expected a 0x address with 40 hex characters. Nothing was spent, no run started.` });
  }
  if (!KEY_IS_SET) {
    return res.status(503).json({ error: "This demo server has no wallet key configured (TELEGRAPH_PRIVATE_KEY is missing), so it cannot run a preflight. The page below still shows the two verified runs." });
  }
  const ip = req.ip || "unknown";
  const limit = checkLimits(ip);
  if (limit.limited) return res.status(limit.status).json({ error: limit.message });

  const run = startRun(chain.toLowerCase(), token.trim(), ip);

  const wantsStream = (req.headers.accept || "").includes("text/event-stream");
  if (!wantsStream) {
    // Plain JSON: wait for the run and return the full result.
    run.finished.then((done) => {
      if (done.status === "done") return res.json({ status: "done", ...done.result });
      return res.status(500).json({ status: "failed", id: done.id, error: done.error || "The run failed." });
    });
    return;
  }

  // SSE: stream live progress, end with the full result.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "started", id: run.id, chain: run.chain, token: run.token });
  // Replay lines already pushed (e.g. "Run started") so nothing is missed.
  for (const line of run.progress) send({ type: "progress", line });
  const onLine = (line) => {
    if (line === null) return; // stream closed
    send({ type: "progress", line });
  };
  run.listeners.add(onLine);
  run.finished.then((done) => {
    run.listeners.delete(onLine);
    if (done.status === "done") send({ type: "result", result: done.result });
    else send({ type: "error", error: done.error || "The run failed." });
    send({ type: "done" });
    res.end();
  });
  // Clean up when the RESPONSE closes (client disconnects or the run ends).
  // NOTE: this must be res.on("close"), not req.on("close") — the request
  // stream closes as soon as the small POST body arrives, which would drop
  // the listener before any leg lines are emitted.
  res.on("close", () => run.listeners.delete(onLine));
});

// The demo page (and its assets) at /.
app.use(express.static(DOCS_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(DOCS_DIR, "index.html")));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`OneShot demo API listening on port ${PORT}`);
  console.log(`Wallet key configured: ${KEY_IS_SET ? "yes" : "NO — POST /api/run will return 503 until TELEGRAPH_PRIVATE_KEY is set"}`);
  console.log(`Docs served from ${DOCS_DIR}; runs written to ${RESULTS_DIR}`);
});
