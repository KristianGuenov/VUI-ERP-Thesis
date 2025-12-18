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
// Config
// ===============================================================
const AGENT_MODE = (process.env.AGENT_MODE ?? "llm").toLowerCase(); // "llm" | "rules"
const LOG_PATH = process.env.LOG_PATH ?? path.join(process.cwd(), "runs.jsonl");
const BASELINE_STATE_PATH =
  process.env.BASELINE_STATE_PATH ?? path.join(process.cwd(), "workorders.baseline.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ""; // optional protection for /reset

// Print full state after each agent run
const PRINT_STATE_AFTER_AGENT = (process.env.PRINT_STATE_AFTER_AGENT ?? "true").toLowerCase() === "true";

// ===============================================================
// State Management (canonical schema)
// ===============================================================
const statePath = path.join(process.cwd(), "workorders.json");

function loadState(): any[] {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state: any[]) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function stateHash(state: any): string {
  const canon = JSON.stringify(state);
  return crypto.createHash("sha256").update(canon).digest("hex");
}

function ensureBaselineAvailable() {
  if (!fs.existsSync(BASELINE_STATE_PATH)) return;
  if (!fs.existsSync(statePath)) fs.copyFileSync(BASELINE_STATE_PATH, statePath);
}

function maybeResetOnStart() {
  const reset = (process.env.RESET_STATE_ON_START ?? "false").toLowerCase() === "true";
  if (!reset) return;
  if (!fs.existsSync(BASELINE_STATE_PATH)) return;
  fs.copyFileSync(BASELINE_STATE_PATH, statePath);
}

ensureBaselineAvailable();
maybeResetOnStart();

// ===============================================================
// JSONL logging
// ===============================================================
function appendRunLog(entry: Record<string, any>) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch (e) {
    console.warn("⚠️ Logging failed:", (e as any)?.message ?? e);
  }
}

// ===============================================================
// Session Context (single-user prototype, in-memory)
// ===============================================================
type PendingAction =
  | {
      kind: "CONFIRM_ORDER";
      orderId: string;
      originalText: string;
      mode: "rules" | "llm";
    }
  | {
      kind: "CONFIRM_TIME";
      orderId: string;
      minutes: number;
      mode: "rules" | "llm";
    };

const context = {
  lastOrderId: null as string | null,
  currentOperationByOrder: {} as Record<string, number>,
  currentTechnicianId: "TECH001",
  confirmedOrderIds: new Set<string>(),
  pending: null as PendingAction | null
};

function touchOrderContext(orderId: string, wo?: any) {
  context.lastOrderId = orderId;
  if (context.currentOperationByOrder[orderId] == null) {
    context.currentOperationByOrder[orderId] = 0;
  }
  if (wo?.OrderHeader?.assigned_to) {
    context.currentTechnicianId = wo.OrderHeader.assigned_to;
  }
}

function resolveOrderId(orderId?: string | null) {
  return (orderId ?? context.lastOrderId) ?? null;
}

// ===============================================================
// Helpers
// ===============================================================
function nowIso() {
  return new Date().toISOString();
}

function findWO(state: any[], orderId: string) {
  return state.find((w) => w?.OrderHeader?.order_id === orderId) ?? null;
}

function workOrderExists(orderId: string): boolean {
  const state = loadState();
  return Boolean(findWO(state, orderId));
}

function ensureTotals(wo: any) {
  if (!wo.Totals) {
    wo.Totals = { total_planned_time_minutes: 0, total_actual_time_minutes: 0 };
  }
  if (typeof wo.Totals.total_actual_time_minutes !== "number") {
    wo.Totals.total_actual_time_minutes = 0;
  }
  if (typeof wo.Totals.total_planned_time_minutes !== "number") {
    wo.Totals.total_planned_time_minutes = 0;
  }
}

function updateLastChanged(wo: any) {
  if (!wo.OrderHeader) wo.OrderHeader = {};
  wo.OrderHeader.last_changed = nowIso();
}

function mapStatusToUserStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "open") return "PLANNED";
  if (s === "in_progress") return "IN_PROCESS";
  if (s === "paused") return "PAUSED";
  if (s === "closed") return "COMPLETED";
  return "PLANNED";
}

function userStatusToSpeech(us: string) {
  if (us === "PLANNED") return "planned";
  if (us === "IN_PROCESS") return "in process";
  if (us === "PAUSED") return "paused";
  if (us === "COMPLETED") return "completed";
  return us.toLowerCase();
}

function formatISODateOnly(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toMidnightUTCISO(dateOnly: string): string {
  return `${dateOnly}T00:00:00Z`;
}

// ===============================================================
// Confirmation helpers (FIXED: no more strict full-string match)
// ===============================================================
function spellOrderId(orderId: string): string {
  return orderId
    .toUpperCase()
    .split("")
    .map((ch) => (ch === "-" ? "dash" : ch))
    .join(" ");
}

function isAffirmative(text: string): boolean {
  // Accept "yes", "yes confirm", "I confirm", "ok", "okay", "correct", etc.
  return /\b(yes|yeah|yep|ok|okay|correct|right|confirm|confirmed|sure)\b/i.test(text);
}

function isNegative(text: string): boolean {
  // Accept "no", "nope", "cancel", "wrong", etc.
  return /\b(no|nope|cancel|wrong|incorrect|stop|negative)\b/i.test(text);
}

// ===============================================================
// Extractors
// ===============================================================
function extractExplicitOrderId(text: string): string | null {
  const match = text.match(/\b(wo[-\s]*\d+)\b/i);
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, "").toUpperCase();
}

function extractMinutes(text: string): number | null {
  const m = text.match(/\b(\d+)\s*(minutes|min)\b/i);
  if (m?.[1]) return parseInt(m[1], 10);

  const h = text.match(/\b(\d+)\s*(hours|hour|h)\b/i);
  if (h?.[1]) return parseInt(h[1], 10) * 60;

  if (/\b(an|a)\s+hour\b/i.test(text)) return 60;
  if (/\bone\s+hour\b/i.test(text)) return 60;
  if (/\btwo\s+hours?\b/i.test(text)) return 120;
  if (/\bthree\s+hours?\b/i.test(text)) return 180;
  if (/\bhalf\s+an?\s+hour\b/i.test(text)) return 30;

  return null;
}

function extractDueDateISO(text: string): string | null {
  const t = text.trim().toLowerCase();

  if (/\btoday\b/.test(t)) return toMidnightUTCISO(formatISODateOnly(new Date()));
  if (/\btomorrow\b/.test(t)) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return toMidnightUTCISO(formatISODateOnly(d));
  }

  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return toMidnightUTCISO(iso[1]);

  const after = t.match(/\bdue date\b.*?\b(to|as|is)\b\s+(.+)$/i);
  const candidate = (after?.[2] ?? "").trim();
  if (candidate) {
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms)) return toMidnightUTCISO(formatISODateOnly(new Date(ms)));
  }

  if (/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return toMidnightUTCISO(formatISODateOnly(new Date(ms)));
  }

  return null;
}

// ===============================================================
// Core work order functions
// ===============================================================
function updateStatus(orderId: string, status: string) {
  const state = loadState();
  const wo = findWO(state, orderId);
  if (!wo) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;

  const us = mapStatusToUserStatus(status);
  wo.OrderHeader.status.user_status = [us];

  updateLastChanged(wo);
  saveState(state);

  touchOrderContext(orderId, wo);
  context.confirmedOrderIds.add(orderId);

  return `I confirm I have set work order ${orderId} to ${userStatusToSpeech(us)}.`;
}

function reportTime(orderId: string, minutes: number) {
  const state = loadState();
  const wo = findWO(state, orderId);
  if (!wo) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;

  ensureTotals(wo);
  wo.Totals.total_actual_time_minutes += minutes;

  if (!Array.isArray(wo.TimeConfirmations)) wo.TimeConfirmations = [];
  wo.TimeConfirmations.push({
    confirmation_id: `WO-${Date.now()}`,
    operation_id: null,
    technician_id: wo.OrderHeader.assigned_to ?? context.currentTechnicianId,
    start_time: null,
    end_time: null,
    duration_minutes: minutes,
    final_confirmation: false,
    level: "ORDER"
  });

  updateLastChanged(wo);
  saveState(state);

  touchOrderContext(orderId, wo);
  context.confirmedOrderIds.add(orderId);

  return `I confirm I have added ${minutes} minutes to work order ${orderId}.`;
}

function getStatusFor(orderId: string | null): string {
  if (!orderId) return "Which work order do you mean?";

  const state = loadState();
  const wo = findWO(state, orderId);
  if (!wo) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;

  touchOrderContext(orderId, wo);

  ensureTotals(wo);
  const us = wo.OrderHeader.status?.user_status?.[0] ?? "PLANNED";
  const totalOps = (wo.Operations ?? []).length;
  const doneOps = (wo.Operations ?? []).filter((o: any) => o.status === "completed").length;

  return `Work order ${orderId} is ${userStatusToSpeech(us)}. ${doneOps} of ${totalOps} operations completed. ${wo.Totals.total_actual_time_minutes} minutes reported.`;
}

function setDueDate(orderId: string, dueDateISO: string) {
  const state = loadState();
  const wo = findWO(state, orderId);
  if (!wo) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;

  wo.OrderHeader.due_date = dueDateISO;
  updateLastChanged(wo);
  saveState(state);

  touchOrderContext(orderId, wo);
  context.confirmedOrderIds.add(orderId);

  return `I confirm I have set the due date for work order ${orderId} to ${dueDateISO.substring(0, 10)}.`;
}

function getNextTaskForTechnician(technicianId: string) {
  const state = loadState();

  const candidates = state.filter((wo) => {
    const assigned = wo?.OrderHeader?.assigned_to ?? null;
    const us = wo?.OrderHeader?.status?.user_status?.[0] ?? "";
    return assigned === technicianId && us !== "COMPLETED";
  });

  if (candidates.length === 0) {
    return `There are no open work orders assigned to ${technicianId}.`;
  }

  candidates.sort((a, b) => {
    const da = Date.parse(a.OrderHeader?.due_date ?? a.OrderHeader?.created_on ?? "1970-01-01T00:00:00Z");
    const db = Date.parse(b.OrderHeader?.due_date ?? b.OrderHeader?.created_on ?? "1970-01-01T00:00:00Z");
    return da - db;
  });

  const current = context.lastOrderId;
  const idx = current ? candidates.findIndex((wo) => wo.OrderHeader.order_id === current) : -1;
  const next = idx >= 0 && idx < candidates.length - 1 ? candidates[idx + 1] : candidates[0];

  touchOrderContext(next.OrderHeader.order_id, next);
  context.confirmedOrderIds.add(next.OrderHeader.order_id);

  const due = next.OrderHeader?.due_date ? next.OrderHeader.due_date.substring(0, 10) : "not set";
  return `Next work order for ${technicianId} is ${next.OrderHeader.order_id}: ${next.OrderHeader.description}. Due date: ${due}.`;
}

// ===============================================================
// Preflight: first-time WO confirmation + INVALID WO rejection
// ===============================================================
function maybeRequireOrderConfirmation(userText: string, mode: "rules" | "llm", skip: boolean): string | null {
  if (skip) return null;

  const explicit = extractExplicitOrderId(userText);
  if (!explicit) return null;

  // ✅ NEW: invalid work order check
  if (!workOrderExists(explicit)) {
    return `Work order ${explicit} does not exist in the system. Please repeat the work order number.`;
  }

  if (context.confirmedOrderIds.has(explicit)) return null;

  context.pending = {
    kind: "CONFIRM_ORDER",
    orderId: explicit,
    originalText: userText,
    mode
  };

  return `You said work order ${spellOrderId(explicit)}. Please confirm: yes or no.`;
}

// ===============================================================
// Rules-mode interpreter
// ===============================================================
function interpretRules(userText: string): string {
  const explicit = extractExplicitOrderId(userText);
  const orderId = resolveOrderId(explicit);

  // If user explicitly stated an order id but it's invalid, reject.
  if (explicit && !workOrderExists(explicit)) {
    return `Work order ${explicit} does not exist in the system. Please repeat the work order number.`;
  }

  if (/\b(what\s+is\s+next|what's\s+next|whats\s+next|next\s+task|next\s+work\s*order)\b/i.test(userText)) {
    return getNextTaskForTechnician(context.currentTechnicianId);
  }

  if (/\bdue date\b/i.test(userText) && (/\bset\b/i.test(userText) || /\bchange\b/i.test(userText) || /\bupdate\b/i.test(userText))) {
    if (!orderId) return "Which work order should I update the due date for?";
    if (!workOrderExists(orderId)) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;

    const iso = extractDueDateISO(userText);
    if (!iso) return "I couldn't understand the due date. Please say e.g. 'set due date to today' or 'set due date to 2025-12-18'.";
    return setDueDate(orderId, iso);
  }

  if (/\b(status|what is the status|whats the status)\b/i.test(userText)) {
    if (!orderId) return "Which work order do you mean?";
    if (!workOrderExists(orderId)) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;
    return getStatusFor(orderId);
  }

  if (/\badd\b/i.test(userText) && (/\bmin\b/i.test(userText) || /\bminute\b/i.test(userText) || /\bhour\b/i.test(userText) || /\bh\b/i.test(userText))) {
    if (!orderId) return "No current work order selected. Please say the work order number first.";
    if (!workOrderExists(orderId)) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;

    const minutes = extractMinutes(userText);
    if (minutes == null) return "I couldn't understand how much time to add.";

    context.pending = { kind: "CONFIRM_TIME", orderId, minutes, mode: "rules" };
    return `Please confirm: add ${minutes} minutes to work order ${orderId}. Say yes or no.`;
  }

  if (/\b(start work order|start wo)\b/i.test(userText)) {
    if (!orderId) return "Which work order should I start?";
    if (!workOrderExists(orderId)) return `Work order ${orderId} does not exist in the system. Please repeat the work order number.`;
    return updateStatus(orderId, "in_progress");
  }

  return "I didn't understand that command.";
}

// ===============================================================
// LLM tools
// ===============================================================
const tools: any[] = [
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
      name: "reportTime",
      description: "Add reported time in minutes to a work order.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" }, minutes: { type: "number" } },
        required: ["minutes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "setDueDate",
      description: "Set due date for a work order. Provide dueDateISO like 2025-12-18T00:00:00Z.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" }, dueDateISO: { type: "string" } },
        required: ["dueDateISO"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getNextTask",
      description: "Get the next work order assigned to a technician (sorted by due_date then created_on).",
      parameters: {
        type: "object",
        properties: { technicianId: { type: "string" } },
        required: []
      }
    }
  }
];

function execTool(toolName: string, args: any): { result: string; safetyBlock: boolean } {
  const resolvedOrderId = resolveOrderId(args?.orderId);

  switch (toolName) {
    case "getStatus": {
      if (!resolvedOrderId) return { result: "Which work order do you mean?", safetyBlock: true };
      if (!workOrderExists(resolvedOrderId)) {
        return { result: `Work order ${resolvedOrderId} does not exist in the system. Please repeat the work order number.`, safetyBlock: true };
      }
      return { result: getStatusFor(resolvedOrderId), safetyBlock: false };
    }

    case "reportTime": {
      const minutes = Number(args?.minutes);
      if (!Number.isFinite(minutes)) return { result: "I couldn't understand how many minutes to add.", safetyBlock: true };
      if (!resolvedOrderId) return { result: "Which work order should I report time to?", safetyBlock: true };
      if (!workOrderExists(resolvedOrderId)) {
        return { result: `Work order ${resolvedOrderId} does not exist in the system. Please repeat the work order number.`, safetyBlock: true };
      }

      context.pending = { kind: "CONFIRM_TIME", orderId: resolvedOrderId, minutes, mode: "llm" };
      return {
        result: `Please confirm: add ${minutes} minutes to work order ${resolvedOrderId}. Say yes or no.`,
        safetyBlock: true
      };
    }

    case "setDueDate": {
      const dueDateISO = String(args?.dueDateISO ?? "");
      if (!dueDateISO) return { result: "Missing due date.", safetyBlock: true };
      if (!resolvedOrderId) return { result: "Which work order should I update the due date for?", safetyBlock: true };
      if (!workOrderExists(resolvedOrderId)) {
        return { result: `Work order ${resolvedOrderId} does not exist in the system. Please repeat the work order number.`, safetyBlock: true };
      }
      return { result: setDueDate(resolvedOrderId, dueDateISO), safetyBlock: false };
    }

    case "getNextTask": {
      const tech = String(args?.technicianId ?? context.currentTechnicianId);
      return { result: getNextTaskForTechnician(tech), safetyBlock: false };
    }

    default:
      return { result: `Unknown tool: ${toolName}`, safetyBlock: true };
  }
}

async function runLLMAgent(userText: string): Promise<{ reply: string }> {
  const maxTurns = 4;

  const messages: any[] = [
    {
      role: "system",
      content: [
        "You are an industrial work order voice assistant.",
        "Keep replies concise.",
        "Work order ids look like WO-1001.",
        "If user asks for next task, use getNextTask.",
        "If user says add one hour / add time, use reportTime with minutes.",
        "If user asks to set due date to today or a date, use setDueDate with ISO like YYYY-MM-DDT00:00:00Z.",
        "If the user provides an invalid work order id, tell them it does not exist."
      ].join(" ")
    },
    { role: "system", content: `Context: lastOrderId=${context.lastOrderId ?? "null"}, technician=${context.currentTechnicianId}` },
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
    if (!msg) return { reply: "No response from the assistant." };

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: (msg.content ?? "Done.").trim() };
    }

    messages.push(msg);

    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name;
      const rawArgs = tc.function?.arguments ?? "{}";
      let args: any = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }

      const { result, safetyBlock } = execTool(toolName, args);

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result
      });

      if (safetyBlock) {
        return { reply: result };
      }
    }
  }

  return { reply: "I reached the maximum number of steps. Please repeat or simplify the request." };
}

// ===============================================================
// Central processing (pending confirms + first-time WO confirm)
// ===============================================================
async function processText(userText: string, mode: "rules" | "llm", skipOrderConfirm: boolean) {
  // 1) Handle pending confirmation first
  if (context.pending) {
    const p = context.pending;

    if (isAffirmative(userText)) {
      context.pending = null;

      if (p.kind === "CONFIRM_ORDER") {
        context.confirmedOrderIds.add(p.orderId);

        const state = loadState();
        const wo = findWO(state, p.orderId);
        touchOrderContext(p.orderId, wo);

        // re-run original request without re-confirming order id
        return await processText(p.originalText, p.mode, true);
      }

      if (p.kind === "CONFIRM_TIME") {
        return reportTime(p.orderId, p.minutes);
      }

      return "Confirmed.";
    }

    if (isNegative(userText)) {
      context.pending = null;
      return "Cancelled. Please repeat your request.";
    }

    return "Please answer yes or no.";
  }

  // 2) First-time order confirmation (only if user explicitly stated an order ID)
  const confirmPrompt = maybeRequireOrderConfirmation(userText, mode, skipOrderConfirm);
  if (confirmPrompt) return confirmPrompt;

  // 3) Normal processing
  if (mode === "rules") {
    return interpretRules(userText);
  }

  const out = await runLLMAgent(userText);
  return out.reply;
}

// ===============================================================
// Routes
// ===============================================================
app.get("/", (_req, res) => {
  res.send("ASR → Agent (rules/LLM) → TTS server ✅");
});

app.post("/asr", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file?.buffer || req.file.buffer.length < 2048) {
      return res.status(400).json({
        error: "empty_or_too_small_audio",
        bytes: req.file?.buffer?.length ?? 0,
        filename: req.file?.originalname ?? null
      });
    }

    const file = await toFile(req.file.buffer, req.file.originalname || "audio.m4a");
    const transcript = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      temperature: 0
    });

    return res.json({ text: (transcript as any).text });
  } catch (e: any) {
    console.log(e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/agent", async (req, res) => {
  const startedAt = Date.now();
  const userText = String(req.body.text ?? "").trim();

  if (!userText) return res.status(400).json({ reply: "Missing 'text'." });

  const beforeState = loadState();
  const beforeHash = stateHash(beforeState);

  try {
    const mode = AGENT_MODE === "rules" ? "rules" : "llm";
    const reply = await processText(userText, mode, false);

    const afterState = loadState();
    const afterHash = stateHash(afterState);

    if (PRINT_STATE_AFTER_AGENT) {
      console.log("\n===============================");
      console.log("📦 STATE AFTER COMMAND");
      console.log("===============================");
      console.log(JSON.stringify(afterState, null, 2));
      console.log("===============================\n");
    }

    appendRunLog({
      ts: new Date().toISOString(),
      mode,
      userText,
      ms_total: Date.now() - startedAt,
      reply,
      state_before_hash: beforeHash,
      state_after_hash: afterHash,
      context: {
        lastOrderId: context.lastOrderId,
        technician: context.currentTechnicianId,
        pending: context.pending ? { kind: context.pending.kind } : null
      }
    });

    return res.json({ reply, json: afterState });
  } catch (e: any) {
    console.error("Agent error:", e);
    appendRunLog({
      ts: new Date().toISOString(),
      mode: AGENT_MODE,
      userText,
      ms_total: Date.now() - startedAt,
      error: e.message ?? String(e),
      state_before_hash: beforeHash,
      context: {
        lastOrderId: context.lastOrderId,
        technician: context.currentTechnicianId
      }
    });
    return res.status(500).json({ reply: "Agent error.", error: e.message });
  }
});

app.get("/state", (_req, res) => res.json(loadState()));

app.post("/reset", (req, res) => {
  if (ADMIN_TOKEN) {
    const token = String(req.headers["x-admin-token"] ?? "");
    if (token !== ADMIN_TOKEN) return res.status(403).json({ error: "Forbidden" });
  }

  if (!fs.existsSync(BASELINE_STATE_PATH)) {
    return res.status(400).json({ error: `Baseline not found at ${BASELINE_STATE_PATH}` });
  }

  fs.copyFileSync(BASELINE_STATE_PATH, statePath);

  context.lastOrderId = null;
  context.currentOperationByOrder = {};
  context.currentTechnicianId = "TECH001";
  context.confirmedOrderIds = new Set<string>();
  context.pending = null;

  return res.json({ ok: true, json: loadState() });
});

app.post("/tts", async (req, res) => {
  try {
    const { text } = req.body;

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => {
  console.log(`🚀 Server running on http://localhost:3000`);
  console.log(`🧪 AGENT_MODE=${AGENT_MODE} (set env AGENT_MODE=llm or AGENT_MODE=rules)`);
  console.log(`🧾 Logging to ${LOG_PATH}`);
  console.log(`🧷 Baseline path: ${BASELINE_STATE_PATH}`);
  console.log(`🖨️ PRINT_STATE_AFTER_AGENT=${PRINT_STATE_AFTER_AGENT}`);
});
