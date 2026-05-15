import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { logEvent, saveFinalState, safeClone } from "../experimentLogger.js";

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());

// ===============================================================
// Types
// ===============================================================

type Operation = {
  id: string;
  description: string;
  status: string;
};

type WorkOrder = {
  id: string;
  status: string;
  description: string;
  timeReported: number;
  operations: Operation[];
  notes: Array<{
    text: string;
    timestamp: number;
  }>;
};

type Trial = {
  trialId: string;
  condition: string;
  prototype: string;
  environment: string;
  scenarioId: string;
  repetition: number;
  status: string;
  workOrderId: string;
  serverAudioStartedAt: string | null;
  finalAcknowledgementAt: string | null;
};

type CommandResult = {
  reply: string;
  ok: boolean;
  mutated: boolean;
  toolName?: string | undefined;
  args?: Record<string, unknown> | undefined;
  resultType?: string | undefined;
  error?: string | undefined;
  requiresTtsFinalAck: boolean;
};

type PendingAction = {
  toolName: string;
  args: Record<string, unknown>;
  execute: () => CommandResult;
};

// ===============================================================
// State Management
// ===============================================================

const statePath = path.join(process.cwd(), "workorders.json");

function loadState(): WorkOrder[] {
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as WorkOrder[];
}

function saveState(state: WorkOrder[]) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function loadCommonScenarios(): any[] {
  const filePath = path.resolve("experiment", "scenarios", "common_scenarios.json");

  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing scenario file: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as any[];
}

function getScenarioById(scenarioId: string): any {
  const scenarios = loadCommonScenarios();
  const scenario = scenarios.find((item) => item.scenarioId === scenarioId);

  if (!scenario) {
    throw new Error(`Scenario ${scenarioId} not found in common_scenarios.json`);
  }

  return scenario;
}

// ===============================================================
// Experiment State
// ===============================================================

let activeTrial: Trial | null = null;
let awaitingFinalAcknowledgement = false;
let pendingAction: PendingAction | null = null;

const context = {
  lastOrderId: null as string | null,
  currentOperationByOrder: {} as Record<string, number>,
};

function trialMetadata(extra: Record<string, unknown> = {}) {
  if (!activeTrial) return extra;

  return {
    trialId: activeTrial.trialId,
    condition: activeTrial.condition,
    prototype: activeTrial.prototype,
    environment: activeTrial.environment,
    scenarioId: activeTrial.scenarioId,
    repetition: activeTrial.repetition,
    ...extra,
  };
}

function logTrialEvent(eventType: string, extra: Record<string, unknown> = {}) {
  if (!activeTrial) return null;
  return logEvent(trialMetadata({ eventType, ...extra }));
}

function resetContext() {
  context.lastOrderId = null;
  context.currentOperationByOrder = {};
  pendingAction = null;
  awaitingFinalAcknowledgement = false;
}

function touchOrderContext(orderId: string) {
  context.lastOrderId = orderId;

  if (context.currentOperationByOrder[orderId] == null) {
    context.currentOperationByOrder[orderId] = 0;
  }
}

// ===============================================================
// Utility extractors
// ===============================================================

function extractOrderId(text: string): string | null {
  const compact = text
    .toUpperCase()
    .replace(/\bW\s*O\b/g, "WO")
    .replace(/WORK ORDER/g, "WO")
    .replace(/\s+/g, " ");

  const directMatch = compact.match(/WO[-\s]*(\d{4})/i);
  if (directMatch?.[1]) {
    return `WO-${directMatch[1]}`;
  }

  const spokenDigitMap: Record<string, string> = {
    zero: "0",
    oh: "0",
    o: "0",
    one: "1",
    won: "1",
    two: "2",
    to: "2",
    too: "2",
    three: "3",
    four: "4",
    for: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    ate: "8",
    nine: "9",
  };

  const words = text
    .toLowerCase()
    .replace(/[-.,:;]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const woIndex = words.findIndex((word, index) => {
    return word === "wo" || (word === "w" && words[index + 1] === "o");
  });

  if (woIndex === -1) return null;

  const startIndex = words[woIndex] === "w" ? woIndex + 2 : woIndex + 1;
  const digits: string[] = [];

  for (let i = startIndex; i < words.length && digits.length < 4; i++) {
    const word = words[i];
    if (word === undefined) continue;

    if (/^\d+$/.test(word)) {
      digits.push(...word.split(""));
    } else if (spokenDigitMap[word]) {
      digits.push(spokenDigitMap[word]);
    }
  }

  if (digits.length >= 4) {
    return `WO-${digits.slice(0, 4).join("")}`;
  }

  return null;
}

function extractMinutes(text: string): number | null {
  const digitMatch = text.match(/(\d+)\s*(minutes|min|minute)/i);
  if (digitMatch?.[1]) {
    return Number.parseInt(digitMatch[1], 10);
  }

  const numberWords: Record<string, number> = {
    zero: 0,
    one: 1,
    won: 1,
    two: 2,
    to: 2,
    too: 2,
    three: 3,
    four: 4,
    for: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    ate: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fourty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  const words = text
    .toLowerCase()
    .replace(/[-.,:;]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (word === "minutes" || word === "minute" || word === "min") {
      const previous = words[i - 1];
      const twoPrevious = words[i - 2];

      if (previous && numberWords[previous] !== undefined) {
        if (
          twoPrevious &&
          numberWords[twoPrevious] !== undefined &&
          numberWords[twoPrevious] >= 20
        ) {
          return numberWords[twoPrevious] + numberWords[previous];
        }

        return numberWords[previous];
      }

      if (previous && /^\d+$/.test(previous)) {
        return Number.parseInt(previous, 10);
      }
    }
  }

  return null;
}

function extractOperationId(text: string): string | null {
  const directMatch = text.match(/(op[-\s]*[a-z0-9]+)/i);
  if (directMatch?.[1]) {
    return directMatch[1].replace(/\s+/g, "").toUpperCase();
  }

  const compact = text
    .toUpperCase()
    .replace(/\bO\s*P\b/g, "OP")
    .replace(/\s+/g, " ");

  const compactMatch = compact.match(/OP[-\s]*([A-Z0-9]+)/i);
  if (compactMatch?.[1]) {
    return `OP-${compactMatch[1]}`;
  }

  return null;
}

function isConfirmationYes(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return (
    lower === "yes" ||
    lower === "confirm" ||
    lower === "yes confirm" ||
    lower === "yes, confirm" ||
    lower.includes("yes confirm") ||
    lower.includes("yes, confirm")
  );
}

function isConfirmationNo(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return lower === "no" || lower.includes("cancel") || lower.includes("do not");
}

function extractDescriptionText(text: string): string | null {
  const match = text.match(/description.*?(to|as)\s+(.*)$/i);
  return match?.[2]?.trim() ?? null;
}

function extractNoteText(text: string, orderId: string): string {
  let note = text;

  note = note.replace(/add\s+note/i, "");
  note = note.replace(/note/i, "");
  note = note.replace(new RegExp(`to\\s+${orderId}`, "i"), "");
  note = note.replace(new RegExp(`${orderId}`, "i"), "");
  note = note.replace(/^[:\s]+/, "");
  note = note.trim();

  if (!note) {
    const match = text.match(/note.*?(to|as)\s+(.*)$/i);
    note = match?.[2]?.trim() ?? text.trim();
  }

  return note;
}

// ===============================================================
// Result helpers
// ===============================================================

function mutationResult(
  reply: string,
  toolName: string,
  args: Record<string, unknown>,
  resultType: string
): CommandResult {
  return {
    reply,
    ok: true,
    mutated: true,
    toolName,
    args,
    resultType,
    requiresTtsFinalAck: true,
  };
}

function readResult(
  reply: string,
  toolName: string,
  args: Record<string, unknown>,
  resultType: string
): CommandResult {
  return {
    reply,
    ok: true,
    mutated: false,
    toolName,
    args,
    resultType,
    requiresTtsFinalAck: true,
  };
}

function rejectedResult(
  reply: string,
  toolName?: string,
  args?: Record<string, unknown>,
  error = "REJECTED"
): CommandResult {
  return {
    reply,
    ok: false,
    mutated: false,
    toolName,
    args,
    error,
    requiresTtsFinalAck: true,
  };
}

// ===============================================================
// Work Order Command Functions
// ===============================================================

function updateStatus(orderId: string, status: string): CommandResult {
  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const toolName = status === "open" ? "open_work_order" : "start_work_order";
  const args = { order_id: orderId, status };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, toolName, args, "WORK_ORDER_NOT_FOUND");
  }

  wo.status = status;
  saveState(state);
  touchOrderContext(orderId);

  return mutationResult(
    `Work order ${orderId} status changed to ${status}.`,
    toolName,
    args,
    status === "open" ? "WORK_ORDER_OPENED" : "WORK_ORDER_STARTED"
  );
}

function updateDescription(orderId: string, description: string): CommandResult {
  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId, description };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "update_description", args, "WORK_ORDER_NOT_FOUND");
  }

  wo.description = description;
  saveState(state);
  touchOrderContext(orderId);

  return mutationResult(
    `Description updated for work order ${orderId}.`,
    "update_description",
    args,
    "DESCRIPTION_UPDATED"
  );
}

function reportTime(orderId: string, minutes: number): CommandResult {
  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId, minutes };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "add_time_to_work_order", args, "WORK_ORDER_NOT_FOUND");
  }

  wo.timeReported += minutes;
  saveState(state);
  touchOrderContext(orderId);

  return mutationResult(
    `${minutes} minutes added to work order ${orderId}.`,
    "add_time_to_work_order",
    args,
    "TIME_REPORTED_ORDER"
  );
}

function closeOperation(orderId: string, operationId: string): CommandResult {
  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId, operation_id: operationId };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "close_operation", args, "WORK_ORDER_NOT_FOUND");
  }

  const op = wo.operations.find((o) => o.id === operationId);
  if (!op) {
    return rejectedResult(`Operation ${operationId} not found.`, "close_operation", args, "OPERATION_NOT_FOUND");
  }

  op.status = "closed";
  saveState(state);
  touchOrderContext(orderId);

  return mutationResult(
    `Operation ${operationId} closed in work order ${orderId}.`,
    "close_operation",
    args,
    "OPERATION_CLOSED"
  );
}

function closeWorkOrder(orderId: string): CommandResult {
  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "complete_work_order", args, "WORK_ORDER_NOT_FOUND");
  }

  wo.status = "closed";
  wo.operations = wo.operations.map((op) => ({ ...op, status: "closed" }));

  saveState(state);
  touchOrderContext(orderId);

  return mutationResult(
    `Work order ${orderId} is now fully closed.`,
    "complete_work_order",
    args,
    "WORK_ORDER_COMPLETED"
  );
}

function addNote(orderId: string, note: string): CommandResult {
  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId, note };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "add_note", args, "WORK_ORDER_NOT_FOUND");
  }

  wo.notes.push({
    text: note,
    timestamp: Date.now(),
  });

  saveState(state);
  touchOrderContext(orderId);

  return mutationResult(
    `Note added to work order ${orderId}.`,
    "add_note",
    args,
    "NOTE_ADDED"
  );
}

// ===============================================================
// Read-only helpers
// ===============================================================

function getStatusFor(orderId: string | null): CommandResult {
  if (!orderId) {
    return rejectedResult("Which work order do you mean?", "get_work_order_status", {}, "MISSING_ORDER_ID");
  }

  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "get_work_order_status", args, "WORK_ORDER_NOT_FOUND");
  }

  touchOrderContext(orderId);

  return readResult(
    `Work order ${orderId} is ${wo.status} with ${wo.operations.length} operations and ${wo.timeReported} minutes reported.`,
    "get_work_order_status",
    args,
    "WORK_ORDER_STATUS"
  );
}

function nextOperationFor(orderId: string | null): CommandResult {
  if (!orderId) {
    return rejectedResult("Which work order should I navigate?", "get_next_operation", {}, "MISSING_ORDER_ID");
  }

  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "get_next_operation", args, "WORK_ORDER_NOT_FOUND");
  }

  if (!wo.operations.length) {
    return rejectedResult(`Work order ${orderId} has no operations.`, "get_next_operation", args, "NO_OPERATIONS");
  }

  touchOrderContext(orderId);

  const currentIndex = context.currentOperationByOrder[orderId] ?? 0;
  const nextIndex = Math.min(currentIndex + 1, wo.operations.length - 1);
  context.currentOperationByOrder[orderId] = nextIndex;

  const op = wo.operations[nextIndex];
  if (!op) {
    return rejectedResult(`Work order ${orderId} has no operation at index ${nextIndex}.`, "get_next_operation", args, "OPERATION_NOT_FOUND");
  }

  return readResult(
    `Next operation for ${orderId} is ${op.id}: ${op.description}. Status is ${op.status}.`,
    "get_next_operation",
    { order_id: orderId, operation_id: op.id },
    "NEXT_OPERATION_FOUND"
  );
}

function summaryFor(orderId: string | null): CommandResult {
  if (!orderId) {
    return rejectedResult("Which work order do you want a summary of?", "get_work_order_details", {}, "MISSING_ORDER_ID");
  }

  const state = loadState();
  const wo = state.find((w) => w.id === orderId);
  const args = { order_id: orderId };

  if (!wo) {
    return rejectedResult(`Work order ${orderId} not found.`, "get_work_order_details", args, "WORK_ORDER_NOT_FOUND");
  }

  touchOrderContext(orderId);

  const totalOps = wo.operations.length;
  const closedOps = wo.operations.filter((op) => op.status === "closed").length;
  const openOps = totalOps - closedOps;

  return readResult(
    `Summary for ${orderId}: status ${wo.status}, ${wo.timeReported} minutes reported, ${closedOps} of ${totalOps} operations closed and ${openOps} still open.`,
    "get_work_order_details",
    args,
    "WORK_ORDER_DETAILS"
  );
}

// ===============================================================
// Confirmation handling
// ===============================================================

function requestConfirmation(action: PendingAction): CommandResult {
  pendingAction = action;

  logTrialEvent("confirmation_prompted", {
    source: "asr_tts_parser",
    toolName: action.toolName,
    args: safeClone(action.args),
  });

  return {
    reply: "Please confirm: yes or no?",
    ok: true,
    mutated: false,
    toolName: action.toolName,
    args: action.args,
    resultType: "CONFIRMATION_REQUESTED",
    requiresTtsFinalAck: false,
  };
}

function executePendingAction(): CommandResult {
  if (!pendingAction) {
    return rejectedResult("There is no pending action to confirm.", undefined, undefined, "NO_PENDING_ACTION");
  }

  const action = pendingAction;
  pendingAction = null;

  logTrialEvent("confirmation_received", {
    source: "asr_tts_parser",
    text: "yes confirm",
    toolName: action.toolName,
    args: safeClone(action.args),
  });

  return action.execute();
}

// ===============================================================
// Parser
// ===============================================================

function interpret(text: string): CommandResult {
  const lower = text.toLowerCase();
  const explicitOrderId = extractOrderId(text);
  const orderId = explicitOrderId ?? context.lastOrderId;

  if (pendingAction && isConfirmationYes(text)) {
    return executePendingAction();
  }

  if (pendingAction && isConfirmationNo(text)) {
    const cancelled = pendingAction;
    pendingAction = null;

    return readResult(
      "Cancelled. No changes were made.",
      cancelled.toolName,
      cancelled.args,
      "CONFIRMATION_CANCELLED"
    );
  }

  if (lower.includes("start work order") || lower.includes("start wo")) {
    if (!orderId) return rejectedResult("Which work order should I start?", "start_work_order", {}, "MISSING_ORDER_ID");
    return updateStatus(orderId, "in_progress");
  }

  if (lower.includes("open work order") || lower.includes("open wo")) {
    if (!orderId) return rejectedResult("Which work order should I open?", "open_work_order", {}, "MISSING_ORDER_ID");
    return updateStatus(orderId, "open");
  }

  if (lower.includes("close work order") || lower.includes("close wo")) {
    if (!orderId) return rejectedResult("Which work order should I close?", "complete_work_order", {}, "MISSING_ORDER_ID");

    return requestConfirmation({
      toolName: "complete_work_order",
      args: { order_id: orderId },
      execute: () => closeWorkOrder(orderId),
    });
  }

  if (
    lower.includes("what's the status") ||
    lower.includes("whats the status") ||
    lower.includes("what is the status") ||
    lower.includes("status of") ||
    (lower.includes("status") && lower.includes("what"))
  ) {
    return getStatusFor(orderId);
  }

  if (
    (lower.includes("add") ||
      lower.includes("append") ||
      lower.includes("report") ||
      lower.includes("record") ||
      lower.includes("log")) &&
    (lower.includes("minutes") || lower.includes("minute") || lower.includes("min"))
  ) {
    const minutes = extractMinutes(text);

    if (!orderId || minutes == null) {
      return rejectedResult("I couldn't understand time reporting.", "add_time_to_work_order", {}, "MISSING_TIME_ARGUMENTS");
    }

    return requestConfirmation({
      toolName: "add_time_to_work_order",
      args: { order_id: orderId, minutes },
      execute: () => reportTime(orderId, minutes),
    });
  }

  if (lower.includes("close operation") || lower.includes("close op")) {
    const operationId = extractOperationId(text);

    if (!orderId || !operationId) {
      return rejectedResult("I couldn't understand the operation to close.", "close_operation", {}, "MISSING_OPERATION_ARGUMENTS");
    }

    return requestConfirmation({
      toolName: "close_operation",
      args: { order_id: orderId, operation_id: operationId },
      execute: () => closeOperation(orderId, operationId),
    });
  }

  if (
    lower.includes("next operation") ||
    lower.includes("next step") ||
    lower.includes("go to next operation")
  ) {
    return nextOperationFor(orderId);
  }

  if (lower.includes("summary") || lower.includes("show summary")) {
    return summaryFor(orderId);
  }

  if (lower.includes("description")) {
    if (!orderId) {
      return rejectedResult("Which work order do you want to update?", "update_description", {}, "MISSING_ORDER_ID");
    }

    const newDescription = extractDescriptionText(text);

    if (!newDescription) {
      return rejectedResult("Please provide a new description.", "update_description", { order_id: orderId }, "MISSING_DESCRIPTION");
    }

    return updateDescription(orderId, newDescription);
  }

  if (lower.includes("note")) {
    if (!orderId) {
      return rejectedResult("Which work order should I add a note to?", "add_note", {}, "MISSING_ORDER_ID");
    }

    const note = extractNoteText(text, orderId);
    return addNote(orderId, note);
  }

  return rejectedResult("I didn't understand that command.", undefined, undefined, "UNKNOWN_COMMAND");
}

function logCommandResult(result: CommandResult) {
  if (!activeTrial) return;

  if (result.toolName && result.resultType !== "CONFIRMATION_REQUESTED") {
    logTrialEvent("tool_call_requested", {
      toolName: result.toolName,
      args: safeClone(result.args ?? {}),
    });

    logTrialEvent("tool_call_result", {
      toolName: result.toolName,
      args: safeClone(result.args ?? {}),
      ok: result.ok,
      mutated: result.mutated,
      resultType: result.resultType ?? null,
      error: result.error ?? null,
    });

    if (result.mutated) {
      logTrialEvent("operation_executed", {
        toolName: result.toolName,
        args: safeClone(result.args ?? {}),
        resultType: result.resultType ?? null,
      });
    } else if (!result.ok) {
      logTrialEvent("operation_rejected", {
        toolName: result.toolName,
        args: safeClone(result.args ?? {}),
        reason: result.error ?? "UNKNOWN_REJECTION",
      });
    }
  }

  if (result.requiresTtsFinalAck) {
    awaitingFinalAcknowledgement = true;
  }
}

// ===============================================================
// ASR Endpoint
// ===============================================================

app.post("/asr", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      logTrialEvent("trial_failure_observed", {
        failureType: "missing_audio_file",
        fatal: false,
        route: "/asr",
      });

      return res.status(400).json({ error: "missing_audio_file" });
    }

    if (activeTrial && !activeTrial.serverAudioStartedAt) {
      activeTrial.serverAudioStartedAt = new Date().toISOString();

      logTrialEvent("audio_first_packet_received", {
        route: "/asr",
        fileSizeBytes: req.file.size,
      });
    }

    const file = await toFile(req.file.buffer, req.file.originalname);

    const transcript = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      temperature: 0,
    });

    const transcriptText = String((transcript as { text?: string }).text ?? "");

    logTrialEvent("audio_committed", {
      route: "/asr",
      transcript: transcriptText,
    });

    return res.json({ text: transcriptText });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logTrialEvent("trial_failure_observed", {
      failureType: "asr_error",
      fatal: true,
      route: "/asr",
      error: message,
    });

    return res.status(500).json({ error: message });
  }
});

// ===============================================================
// Agent Endpoint
// ===============================================================

app.post("/agent", (req, res) => {
  const inputText = String(req.body?.text ?? "");

  logTrialEvent("response_requested", {
    route: "/agent",
    inputText,
  });

  const result = interpret(inputText);
  logCommandResult(result);

  const fullState = loadState();

  console.log("=========== UPDATED WORKORDER JSON ===========");
  console.log(JSON.stringify(fullState, null, 2));
  console.log("==============================================");

  return res.json({
    reply: result.reply,
    json: fullState,
  });
});

// ===============================================================
// State Endpoint
// ===============================================================

app.get("/state", (_req, res) => {
  return res.json(loadState());
});

// ===============================================================
// TTS Endpoint
// ===============================================================

app.post("/tts", async (req, res) => {
  try {
    const inputText = String(req.body?.text ?? "");

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: inputText,
    });

    const buffer = Buffer.from(await speech.arrayBuffer());

    if (awaitingFinalAcknowledgement) {
      logTrialEvent("final_acknowledgement_completed", {
        route: "/tts",
        responseText: inputText,
        audioBytes: buffer.length,
      });

      awaitingFinalAcknowledgement = false;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    return res.send(buffer);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logTrialEvent("trial_failure_observed", {
      failureType: "tts_error",
      fatal: true,
      route: "/tts",
      error: message,
    });

    return res.status(500).json({ error: message });
  }
});

// ===============================================================
// Experiment API Routes
// ===============================================================

app.post("/experiment/start-trial", (req, res) => {
  try {
    const { trialId, condition, prototype, environment, scenarioId, repetition } = req.body ?? {};

    if (!trialId || !condition || !prototype || !environment || !scenarioId || repetition == null) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_trial_metadata",
      });
    }

    const scenario = getScenarioById(String(scenarioId));

    if (!Array.isArray(scenario.initialState)) {
      return res.status(400).json({
        ok: false,
        error: "scenario_missing_initial_state",
        scenarioId,
      });
    }

    saveState(scenario.initialState as WorkOrder[]);
    resetContext();

    activeTrial = {
      trialId: String(trialId),
      condition: String(condition),
      prototype: String(prototype),
      environment: String(environment),
      scenarioId: String(scenarioId),
      repetition: Number(repetition),
      status: "running",
      workOrderId: String(scenario.workOrderId),
      serverAudioStartedAt: null,
      finalAcknowledgementAt: null,
    };

    logTrialEvent("trial_started", {
      workOrderId: scenario.workOrderId,
      numericHeavy: Boolean(scenario.numericHeavy),
      includedInConfirmationCompliance: Boolean(scenario.includedInConfirmationCompliance),
    });

    return res.json({ ok: true, activeTrial });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post("/experiment/end-trial", (_req, res) => {
  try {
    if (!activeTrial) {
      return res.status(400).json({ ok: false, error: "no_active_trial" });
    }

    const finalState = loadState();
    const scenario = getScenarioById(activeTrial.scenarioId);
    const workOrder = finalState.find((wo) => wo.id === scenario.workOrderId) ?? null;

    const finalStatePath = saveFinalState(activeTrial.trialId, {
      trial: safeClone(activeTrial),
      workOrder: safeClone(workOrder),
      allWorkOrders: safeClone(finalState),
    });

    logTrialEvent("trial_completed", {
      finalStatePath,
    });

    const completedTrial = activeTrial;
    activeTrial = null;
    resetContext();

    return res.json({ ok: true, trial: completedTrial, finalStatePath });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post("/experiment/fail-trial", (req, res) => {
  try {
    if (!activeTrial) {
      return res.status(400).json({ ok: false, error: "no_active_trial" });
    }

    const failureType = String(req.body?.failureType ?? "manual_failure");
    const reason = String(req.body?.reason ?? "Trial marked as failed manually");

    const finalState = loadState();
    const scenario = getScenarioById(activeTrial.scenarioId);
    const workOrder = finalState.find((wo) => wo.id === scenario.workOrderId) ?? null;

    const finalStatePath = saveFinalState(activeTrial.trialId, {
      trial: safeClone(activeTrial),
      failureType,
      reason,
      workOrder: safeClone(workOrder),
      allWorkOrders: safeClone(finalState),
    });

    logTrialEvent("trial_failed", {
      failureType,
      reason,
      finalStatePath,
    });

    const failedTrial = activeTrial;
    activeTrial = null;
    resetContext();

    return res.json({ ok: true, trial: failedTrial, finalStatePath });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.get("/experiment/current-trial", (_req, res) => {
  return res.json({ ok: true, activeTrial });
});

app.post("/experiment/reset", (_req, res) => {
  activeTrial = null;
  resetContext();

  return res.json({ ok: true, status: "experiment_reset" });
});

// ===============================================================

app.listen(3000, () => {
  console.log("🚀 ASR → Parser → TTS server running on http://localhost:3000");
});
