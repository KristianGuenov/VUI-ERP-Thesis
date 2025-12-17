import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

app.use(express.json());

// ===============================================================
// Config (A/B mode, baseline, logging, safety)
// ===============================================================
const AGENT_MODE = (process.env.AGENT_MODE ?? "llm").toLowerCase(); // "llm" | "rules"
const LOG_PATH = process.env.LOG_PATH ?? path.join(process.cwd(), "runs.jsonl");
const BASELINE_STATE_PATH =
  process.env.BASELINE_STATE_PATH ?? path.join(process.cwd(), "workorders.baseline.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ""; // optional, used for /reset protection

// Confirmation thresholds
const MAX_MINUTES_WITHOUT_CONFIRM = Number(process.env.MAX_MINUTES_WITHOUT_CONFIRM ?? 240); // 4 hours

// ===============================================================
// State Management
// ===============================================================
const statePath = path.join(process.cwd(), "workorders.json");

function loadState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state: any) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function stateHash(state: any): string {
  const canon = JSON.stringify(state);
  return crypto.createHash("sha256").update(canon).digest("hex");
}

function ensureBaselineAvailable() {
  if (!fs.existsSync(BASELINE_STATE_PATH)) return;
  if (!fs.existsSync(statePath)) {
    fs.copyFileSync(BASELINE_STATE_PATH, statePath);
  }
}

// Optional: reset to baseline at server start (for controlled experiments)
function maybeResetOnStart() {
  const reset = (process.env.RESET_STATE_ON_START ?? "false").toLowerCase() === "true";
  if (!reset) return;
  if (!fs.existsSync(BASELINE_STATE_PATH)) return;
  fs.copyFileSync(BASELINE_STATE_PATH, statePath);
}

ensureBaselineAvailable();
maybeResetOnStart();

// ===============================================================
// JSONL logging (scientific runs)
// ===============================================================
function appendRunLog(entry: Record<string, any>) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch (e) {
    // Do not crash prototype if logging fails
    console.warn("⚠️ Logging failed:", (e as any)?.message ?? e);
  }
}

// ===============================================================
// Conversational Context (multi-turn memory, in-memory)
// ===============================================================
const context = {
  lastOrderId: null as string | null,
  currentOperationByOrder: {} as Record<string, number>,
};

function touchOrderContext(orderId: string) {
  context.lastOrderId = orderId;
  if (context.currentOperationByOrder[orderId] == null) {
    context.currentOperationByOrder[orderId] = 0;
  }
}

function resolveOrderId(orderId?: string | null) {
  return (orderId ?? context.lastOrderId) ?? null;
}

// ===============================================================
// Utility extractors (used by rule-based mode only)
// ===============================================================
function extractOrderId(text: string): string | null {
  const match = text.match(/(wo[-\s]*\d+)/i);
  if (!match || !match[1]) return null;
  return match[1].replace(/\s+/g, "").toUpperCase();
}

function extractMinutes(text: string): number | null {
  const match = text.match(/(\d+)\s*(minutes|min)/i);
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

function extractOperationId(text: string): string | null {
  const match = text.match(/(op[-\s]*\w+)/i);
  if (!match || !match[1]) return null;
  return match[1].replace(/\s+/g, "").toUpperCase();
}

// ===============================================================
// Work Order Command Functions (also update context)
// ===============================================================
function updateStatus(orderId: string, status: string) {
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  wo.status = status;
  saveState(state);
  touchOrderContext(orderId);
  return `Work order ${orderId} status changed to ${status}.`;
}

function updateDescription(orderId: string, description: string) {
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  wo.description = description;
  saveState(state);
  touchOrderContext(orderId);
  return `Description updated for work order ${orderId}.`;
}

function reportTime(orderId: string, minutes: number) {
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  wo.timeReported += minutes;
  saveState(state);
  touchOrderContext(orderId);
  return `${minutes} minutes added to work order ${orderId}.`;
}

function closeOperation(orderId: string, operationId: string) {
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  const op = wo.operations.find((o: any) => o.id === operationId);
  if (!op) return `Operation ${operationId} not found.`;

  op.status = "closed";
  saveState(state);
  touchOrderContext(orderId);
  return `Operation ${operationId} closed in work order ${orderId}.`;
}

function closeWorkOrder(orderId: string) {
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  wo.status = "closed";
  wo.operations = wo.operations.map((o: any) => ({ ...o, status: "closed" }));
  saveState(state);
  touchOrderContext(orderId);
  return `Work order ${orderId} is now fully closed.`;
}

function addNote(orderId: string, note: string) {
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  wo.notes.push({ text: note, timestamp: Date.now() });
  saveState(state);
  touchOrderContext(orderId);
  return `Note added to work order ${orderId}.`;
}

// ===============================================================
// Read-only helpers
// ===============================================================
function getStatusFor(orderId: string | null): string {
  if (!orderId) return "Which work order do you mean?";
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;
  touchOrderContext(orderId);
  return `Work order ${orderId} is ${wo.status} with ${wo.operations.length} operations and ${wo.timeReported} minutes reported.`;
}

function nextOperationFor(orderId: string | null): string {
  if (!orderId) return "Which work order should I navigate?";
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;
  if (!wo.operations || wo.operations.length === 0) {
    return `Work order ${orderId} has no operations.`;
  }

  touchOrderContext(orderId);
  const currentIndex = context.currentOperationByOrder[orderId] ?? 0;
  const nextIndex = Math.min(currentIndex + 1, wo.operations.length - 1);
  context.currentOperationByOrder[orderId] = nextIndex;

  const op = wo.operations[nextIndex];
  return `Next operation for ${orderId} is ${op.id}: ${op.description}. Status is ${op.status}.`;
}

function summaryFor(orderId: string | null): string {
  if (!orderId) return "Which work order do you want a summary of?";
  const state = loadState();
  const wo = state.find((w: any) => w.id === orderId);
  if (!wo) return `Work order ${orderId} not found.`;

  touchOrderContext(orderId);
  const totalOps = wo.operations.length;
  const closedOps = wo.operations.filter((o: any) => o.status === "closed").length;
  const openOps = totalOps - closedOps;

  return `Summary for ${orderId}: status ${wo.status}, ${wo.timeReported} minutes reported, ${closedOps} of ${totalOps} operations closed and ${openOps} still open.`;
}

// ===============================================================
// Rule-based agent (kept for A/B comparisons)
// ===============================================================
function interpretRules(text: string): string {
  const lower = text.toLowerCase();
  const explicitOrderId = extractOrderId(lower);
  const orderId = explicitOrderId ?? context.lastOrderId;

  if (lower.includes("start work order") || lower.includes("start wo")) {
    if (!orderId) return "Which work order should I start?";
    return updateStatus(orderId, "in_progress");
  }

  if (lower.includes("open work order") || lower.includes("open wo")) {
    if (!orderId) return "Which work order should I open?";
    return updateStatus(orderId, "open");
  }

  if (lower.includes("close work order") || lower.includes("close wo")) {
    if (!orderId) return "Which work order should I close?";
    return closeWorkOrder(orderId);
  }

  if (
    lower.includes("what's the status") ||
    lower.includes("whats the status") ||
    lower.includes("what is the status") ||
    lower.includes("status of") ||
    (lower.includes("status") && lower.includes("what"))
  ) {
    return getStatusFor(orderId ?? null);
  }

  if (lower.includes("add") && lower.includes("minutes")) {
    const minutes = extractMinutes(lower);
    if (!orderId || minutes == null) return "I couldn't understand time reporting.";
    return reportTime(orderId, minutes);
  }

  if (lower.includes("close operation") || lower.includes("close op")) {
    const opId = extractOperationId(lower);
    if (!orderId || !opId) return "I couldn't understand the operation to close.";
    return closeOperation(orderId, opId);
  }

  if (lower.includes("next operation") || lower.includes("next step") || lower.includes("go to next operation")) {
    return nextOperationFor(orderId ?? null);
  }

  if (lower.includes("summary") || lower.includes("show summary")) {
    return summaryFor(orderId ?? null);
  }

  if (lower.includes("description")) {
    if (!orderId) return "Which work order do you want to update?";
    const descMatch = text.match(/description.*?(to|as)\s+(.*)$/i);
    if (!descMatch || !descMatch[2]) return "Please provide a new description.";
    return updateDescription(orderId, descMatch[2].trim());
  }

  if (lower.includes("note")) {
    if (!orderId) return "Which work order should I add a note to?";
    const noteMatch = text.match(/note.*?(to|as)\s+(.*)$/i);
    const note = noteMatch?.[2]?.trim() ?? text.replace(/.*note/i, "").trim();
    return addNote(orderId, note);
  }

  return "I didn't understand that command.";
}

// ===============================================================
// LLM Agent (non-realtime) — tool loop + minimal safety
// ===============================================================
const tools: any[] = [
  {
    type: "function",
    function: {
      name: "updateStatus",
      description: "Change a work order status (open | in_progress | closed).",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Work order id (e.g., WO-1001). Optional if referring to last order." },
          status: { type: "string", enum: ["open", "in_progress", "closed"] }
        },
        required: ["status"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "updateDescription",
      description: "Update a work order description.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          description: { type: "string" }
        },
        required: ["description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reportTime",
      description: "Add reported time in minutes to a work order.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          minutes: { type: "number" }
        },
        required: ["minutes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "closeOperation",
      description: "Close a specific operation within a work order.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          operationId: { type: "string" }
        },
        required: ["operationId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "closeWorkOrder",
      description: "Close a work order and mark all operations closed.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addNote",
      description: "Add a technician note to a work order.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          note: { type: "string" }
        },
        required: ["note"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getStatus",
      description: "Read status for referenced work order (explicit orderId or last discussed).",
      parameters: { type: "object", properties: { orderId: { type: "string" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "nextOperation",
      description: "Navigate to the next operation for referenced work order.",
      parameters: { type: "object", properties: { orderId: { type: "string" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "summary",
      description: "Provide a summary for referenced work order.",
      parameters: { type: "object", properties: { orderId: { type: "string" } }, required: [] }
    }
  }
];

function userExplicitlyRequestsClose(userText: string): boolean {
  const t = userText.toLowerCase();
  return t.includes("close work order") || t.includes("close wo") || t.includes("close operation") || t.includes("close op");
}

function userExplicitlyRequestsTime(userText: string): boolean {
  const t = userText.toLowerCase();
  return t.includes("add") && (t.includes("minutes") || t.includes("min"));
}

function execTool(name: string, args: any, userText: string): { result: string; safetyBlock: boolean } {
  const resolvedOrderId = resolveOrderId(args?.orderId);

  // Guardrail: destructive close actions require explicit "close"
  if ((name === "closeWorkOrder" || name === "closeOperation") && !userExplicitlyRequestsClose(userText)) {
    return { result: "Please confirm: do you want to close it? Say 'close work order' or 'close operation'.", safetyBlock: true };
  }

  // Guardrail: large time requires explicit confirmation
  if (name === "reportTime") {
    const minutes = Number(args?.minutes);
    if (!Number.isFinite(minutes)) {
      return { result: "I couldn't understand how many minutes to add.", safetyBlock: true };
    }
    if (minutes > MAX_MINUTES_WITHOUT_CONFIRM && !userExplicitlyRequestsTime(userText)) {
      return {
        result: `That is ${minutes} minutes. Please confirm by saying: "add ${minutes} minutes to ${resolvedOrderId ?? "the work order"}".`,
        safetyBlock: true
      };
    }
  }

  switch (name) {
    case "updateStatus": {
      if (!resolvedOrderId) return { result: "Which work order should I update?", safetyBlock: true };
      return { result: updateStatus(resolvedOrderId, args.status), safetyBlock: false };
    }
    case "updateDescription": {
      if (!resolvedOrderId) return { result: "Which work order do you want to update?", safetyBlock: true };
      return { result: updateDescription(resolvedOrderId, args.description), safetyBlock: false };
    }
    case "reportTime": {
      if (!resolvedOrderId) return { result: "Which work order should I report time to?", safetyBlock: true };
      return { result: reportTime(resolvedOrderId, Number(args.minutes)), safetyBlock: false };
    }
    case "closeOperation": {
      if (!resolvedOrderId) return { result: "Which work order is that operation in?", safetyBlock: true };
      return { result: closeOperation(resolvedOrderId, args.operationId), safetyBlock: false };
    }
    case "closeWorkOrder": {
      if (!resolvedOrderId) return { result: "Which work order should I close?", safetyBlock: true };
      return { result: closeWorkOrder(resolvedOrderId), safetyBlock: false };
    }
    case "addNote": {
      if (!resolvedOrderId) return { result: "Which work order should I add the note to?", safetyBlock: true };
      return { result: addNote(resolvedOrderId, args.note), safetyBlock: false };
    }
    case "getStatus": {
      return { result: getStatusFor(resolvedOrderId), safetyBlock: false };
    }
    case "nextOperation": {
      return { result: nextOperationFor(resolvedOrderId), safetyBlock: false };
    }
    case "summary": {
      return { result: summaryFor(resolvedOrderId), safetyBlock: false };
    }
    default:
      return { result: `Unknown tool: ${name}`, safetyBlock: true };
  }
}

async function runLLMAgent(userText: string): Promise<{
  reply: string;
  json: any;
  toolCalls: any[];
  toolResults: any[];
}> {
  const maxTurns = 4;

  const toolCalls: any[] = [];
  const toolResults: any[] = [];

  const messages: any[] = [
    {
      role: "system",
      content:
        [
          "You are an industrial work order voice assistant.",
          "Use tools to perform actions on work orders and operations.",
          "If orderId is missing, you may use the last discussed order context, but ask a clarification if unsure.",
          "Keep the final spoken answer concise.",
          "Work order ids look like WO-1001; operations look like OP-1 or OP-A."
        ].join(" ")
    },
    { role: "system", content: `Context: lastOrderId=${context.lastOrderId ?? "null"}` },
    { role: "system", content: `State snapshot: ${JSON.stringify(loadState())}` },
    { role: "user", content: userText }
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0
    });

    const msg: any = resp.choices?.[0]?.message;
    if (!msg) {
      return { reply: "No response from the assistant.", json: loadState(), toolCalls, toolResults };
    }

    // finalize
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: (msg.content ?? "Done.").trim(), json: loadState(), toolCalls, toolResults };
    }

    // add assistant message that contains tool calls
    messages.push(msg);

    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name;
      const rawArgs = tc.function?.arguments ?? "{}";
      let args: any = {};
      try { args = JSON.parse(rawArgs); } catch { args = {}; }

      toolCalls.push({ id: tc.id, name: toolName, args });

      const { result, safetyBlock } = execTool(toolName, args, userText);

      toolResults.push({ id: tc.id, name: toolName, result, safetyBlock });

      messages.push({
        role: "tool",
        tool_call_id: tc.id, // required by SDK typing
        content: result
      });

      // If we blocked due to safety/confirmation, stop here and return that message as final reply.
      if (safetyBlock) {
        return { reply: result, json: loadState(), toolCalls, toolResults };
      }
    }
  }

  return {
    reply: "I reached the maximum number of steps. Please repeat or simplify the request.",
    json: loadState(),
    toolCalls,
    toolResults
  };
}

// ===============================================================
// Root test
// ===============================================================
app.get("/", (_req, res) => {
  res.send("ASR → Agent (rules/LLM) → TTS server ✅");
});

// ===============================================================
// ASR Endpoint
// ===============================================================
app.post("/asr", upload.single("audio"), async (req, res) => {
  try {
    const file = await toFile(req.file!.buffer, req.file!.originalname);
    const transcript = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      temperature: 0,
    });

    return res.json({ text: (transcript as any).text });
  } catch (e: any) {
    console.log(e);
    return res.status(500).json({ error: e.message });
  }
});

// ===============================================================
// AGENT Endpoint — A/B mode + full logging + JSON output
// ===============================================================
app.post("/agent", async (req, res) => {
  const startedAt = Date.now();
  const userText = String(req.body.text ?? "").trim();

  if (!userText) {
    return res.status(400).json({ reply: "Missing 'text'." });
  }

  const beforeState = loadState();
  const beforeHash = stateHash(beforeState);

  try {
    if (AGENT_MODE === "rules") {
      const reply = interpretRules(userText);
      const afterState = loadState();
      const afterHash = stateHash(afterState);

      console.log("=========== UPDATED WORKORDER JSON (rules) ===========");
      console.log(JSON.stringify(afterState, null, 2));
      console.log("======================================================");

      appendRunLog({
        ts: new Date().toISOString(),
        mode: "rules",
        userText,
        ms_total: Date.now() - startedAt,
        reply,
        state_before_hash: beforeHash,
        state_after_hash: afterHash,
        context: { ...context }
      });

      return res.json({ reply, json: afterState });
    }

    // default: LLM mode
    const llmOut = await runLLMAgent(userText);
    const afterState = llmOut.json;
    const afterHash = stateHash(afterState);

    console.log("=========== UPDATED WORKORDER JSON (llm) ===========");
    console.log(JSON.stringify(afterState, null, 2));
    console.log("===================================================");

    appendRunLog({
      ts: new Date().toISOString(),
      mode: "llm",
      userText,
      ms_total: Date.now() - startedAt,
      reply: llmOut.reply,
      tool_calls: llmOut.toolCalls,
      tool_results: llmOut.toolResults,
      state_before_hash: beforeHash,
      state_after_hash: afterHash,
      context: { ...context }
    });

    return res.json({ reply: llmOut.reply, json: afterState });
  } catch (e: any) {
    console.error("Agent error:", e);
    appendRunLog({
      ts: new Date().toISOString(),
      mode: AGENT_MODE,
      userText,
      ms_total: Date.now() - startedAt,
      error: e.message ?? String(e),
      state_before_hash: beforeHash,
      context: { ...context }
    });
    return res.status(500).json({ reply: "Agent error.", error: e.message });
  }
});

// ===============================================================
// FULL STATE VIEW ENDPOINT (/state)
// ===============================================================
app.get("/state", (_req, res) => {
  return res.json(loadState());
});

// ===============================================================
// RESET STATE TO BASELINE (for repeatable experiments)
// Requires ADMIN_TOKEN if set
// ===============================================================
app.post("/reset", (req, res) => {
  if (ADMIN_TOKEN) {
    const token = String(req.headers["x-admin-token"] ?? "");
    if (token !== ADMIN_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  if (!fs.existsSync(BASELINE_STATE_PATH)) {
    return res.status(400).json({ error: `Baseline not found at ${BASELINE_STATE_PATH}` });
  }

  fs.copyFileSync(BASELINE_STATE_PATH, statePath);
  // also reset context for clean trials
  context.lastOrderId = null;
  context.currentOperationByOrder = {};

  return res.json({ ok: true, json: loadState() });
});

// ===============================================================
// TTS Endpoint (non-streaming – full MP3 per request)
// ===============================================================
app.post("/tts", async (req, res) => {
  try {
    const { text } = req.body;

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// ===============================================================
app.listen(3000, () => {
  console.log(`🚀 Server running on http://localhost:3000`);
  console.log(`🧪 AGENT_MODE=${AGENT_MODE} (set env AGENT_MODE=llm or AGENT_MODE=rules)`);
  console.log(`🧾 Logging to ${LOG_PATH}`);
  console.log(`🧷 Baseline path: ${BASELINE_STATE_PATH}`);
});
