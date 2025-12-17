import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

app.use(express.json());

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

// ===============================================================
// Conversational Context (multi-turn memory)
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

// ===============================================================
// Utility extractors
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

  wo.notes.push({
    text: note,
    timestamp: Date.now(),
  });

  saveState(state);
  touchOrderContext(orderId);
  return `Note added to work order ${orderId}.`;
}

// ===============================================================
// Read-only helpers: status query, operation navigation, summary
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
// Natural Language Parser (rule-based)
// ===============================================================
function interpret(text: string): string {
  const lower = text.toLowerCase();
  const explicitOrderId = extractOrderId(lower);
  const orderId = explicitOrderId ?? context.lastOrderId;

  // 1. START WORK ORDER
  if (lower.includes("start work order") || lower.includes("start wo")) {
    if (!orderId) return "Which work order should I start?";
    return updateStatus(orderId, "in_progress");
  }

  // 2. OPEN WORK ORDER
  if (lower.includes("open work order") || lower.includes("open wo")) {
    if (!orderId) return "Which work order should I open?";
    return updateStatus(orderId, "open");
  }

  // 3. CLOSE WORK ORDER
  if (lower.includes("close work order") || lower.includes("close wo")) {
    if (!orderId) return "Which work order should I close?";
    return closeWorkOrder(orderId);
  }

  // 4. STATUS QUESTIONS
  if (
    (lower.includes("what's the status") ||
      lower.includes("whats the status") ||
      lower.includes("what is the status") ||
      lower.includes("status of") ||
      (lower.includes("status") && lower.includes("what")))
  ) {
    return getStatusFor(orderId);
  }

  // 5. REPORT TIME
  if (lower.includes("add") && lower.includes("minutes")) {
    const minutes = extractMinutes(lower);
    if (!orderId || minutes == null) return "I couldn't understand time reporting.";
    return reportTime(orderId, minutes);
  }

  // 6. CLOSE OPERATION
  if (lower.includes("close operation") || lower.includes("close op")) {
    const opId = extractOperationId(lower);
    if (!orderId || !opId) return "I couldn't understand the operation to close.";
    return closeOperation(orderId, opId);
  }

  // 7. OPERATION NAVIGATION: NEXT
  if (
    lower.includes("next operation") ||
    lower.includes("next step") ||
    lower.includes("go to next operation")
  ) {
    return nextOperationFor(orderId);
  }

  // 8. SUMMARY
  if (lower.includes("summary") || lower.includes("show summary")) {
    return summaryFor(orderId);
  }

  // 9. UPDATE DESCRIPTION (fixed extraction)
  if (lower.includes("description")) {
    if (!orderId) return "Which work order do you want to update?";

    const descMatch = text.match(/description.*?(to|as)\s+(.*)$/i);

    if (!descMatch || !descMatch[2]) {
      return "Please provide a new description.";
    }

    const newDesc = descMatch[2].trim();
    return updateDescription(orderId, newDesc);
  }

  // 10. ADD NOTE
  if (lower.includes("note")) {
    if (!orderId) return "Which work order should I add a note to?";

    const noteMatch = text.match(/note.*?(to|as)\s+(.*)$/i);
    const note = noteMatch?.[2]?.trim() ?? text.replace(/.*note/i, "").trim();

    return addNote(orderId, note);
  }

  return "I didn't understand that command.";
}

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
// AGENT ENDPOINT (Parser + JSON logging)
// ===============================================================
app.post("/agent", (req, res) => {
  const reply = interpret(req.body.text ?? "");

  const fullState = loadState();

  console.log("=========== UPDATED WORKORDER JSON ===========");
  console.log(JSON.stringify(fullState, null, 2));
  console.log("==============================================");

  return res.json({
    reply,
    json: fullState,
  });
});

// ===============================================================
// FULL STATE VIEW ENDPOINT (/state)
// ===============================================================
app.get("/state", (_req, res) => {
  return res.json(loadState());
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
app.listen(3000, () =>
  console.log("🚀 ASR → Parser → TTS server running on http://localhost:3000")
);
