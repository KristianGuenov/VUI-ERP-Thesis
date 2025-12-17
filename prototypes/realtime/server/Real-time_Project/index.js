// ------------------------------
// index.js (Realtime + Tools + Validation + Audio)
// ------------------------------

import express from "express";
import WebSocket from "ws";
import cors from "cors";
import fetch from "node-fetch";
import events from "events";
import "dotenv/config";

import { workOrderTools } from "./workOrderTools.js";
import { executeWorkOrderFunction } from "./executeWorkOrderFunction.js";
import { getWorkOrder, resetWorkOrders } from "./workOrders.js";

// Avoid MaxListeners warnings
events.EventEmitter.defaultMaxListeners = 25;

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

let aiSocket = null;
let clients = [];

let lastAudioBytes = 0;
let responsePending = false;

/* -------------------------------------------------------------------------- */
/*                               Helper funcs                                 */
/* -------------------------------------------------------------------------- */

function normalizeOrderId(raw) {
  if (!raw) return raw;
  return String(raw)
    .replace(/\band\b/gi, " ")
    .replace(/\s+/g, "")
    .trim();
}

function broadcastToClients(obj) {
  const text = JSON.stringify(obj);
  for (const res of clients) {
    res.write(`data: ${text}\n\n`);
  }
}

/* -------------------------------------------------------------------------- */
/*                         OpenAI Realtime Connection                         */
/* -------------------------------------------------------------------------- */

async function connectRealtime() {
  console.log("Connecting to OpenAI Realtime...");

  try {
    const sessionRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "verse"
      })
    });

    const session = await sessionRes.json();

    if (!session?.client_secret?.value) {
      console.error("Could not obtain session client secret");
      return setTimeout(connectRealtime, 3000);
    }

    aiSocket = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        headers: {
          Authorization: `Bearer ${session.client_secret.value}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    aiSocket.on("open", () => {
      console.log("Connected to OpenAI Realtime");

      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "verse",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: null, // you handle VAD on the client

          tools: workOrderTools,
          tool_choice: "auto",

          instructions: `
You are an English-speaking SAP PM assistant.

GENERAL BEHAVIOR
- Keep responses concise and in English.
- Always reflect the *actual* backend/tool result. Do NOT claim changes if tools failed.

MANDATORY CONFIRMATION RULES (SENSITIVE ACTIONS)
Before calling ANY of these tools:
- report_time
- add_time_to_work_order
- complete_work_order (including force=true)
- end_task_session
- end_assistant_session

You MUST:
1) Repeat back what you are about to do with the key parameters (order id, operation id, minutes, and whether it's force/termination).
2) Ask the user a direct confirmation question: "Please confirm: yes or no?"
3) WAIT for the user's explicit "yes" before calling the tool.
4) If the user says "no", do not call the tool. Ask what they want instead.

WORK ORDER IDS & DIGIT MODE
- Whenever the user gives a work order ID or any long number (>4 digits), always:
  1) Repeat it back digit-by-digit.
  2) Ask for explicit confirmation (yes/no).
  3) ONLY THEN call tools that take order_id.
- If backend reports work order does NOT exist:
  "Work order <ID> does not exist in the system. Please repeat it slowly, digit by digit."
  Do NOT pretend success.

MUTATION CONFIRMATION (REQUIRED)
- If a tool result indicates a mutation occurred (mutated=true), your reply MUST begin with the tool field:
  action_summary
  This action_summary MUST be repeated verbatim as the first sentence, and it always starts with:
  "I confirm I have ..."

TOOL USAGE
- If the user mentions an operation by description, match it to the correct operation_id.
- If multiple operations match, ask which one.
- If the user does not mention order_id, use the last referenced work order if available, but still confirm it.

AUTO-DETAILS
- If the user asks about details / what needs to be done / what the order is about:
  call get_work_order_details.
          `
        }
      };

      aiSocket.send(JSON.stringify(sessionUpdate));
    });

    aiSocket.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    aiSocket.on("close", () => {
      console.log("AI socket closed, reconnecting...");
      aiSocket = null;
      responsePending = false;
      lastAudioBytes = 0;
      setTimeout(connectRealtime, 3000);
    });

    /* ---------------------------------------------------------------------- */
    /*                          MESSAGE HANDLER                               */
    /* ---------------------------------------------------------------------- */

    aiSocket.on("message", async (msg) => {
      const text = msg.toString();
      let parsed;

      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      const type = parsed.type;

      if (type === "error") {
        console.error("Model error:", parsed.error);
      }

      if (type === "response.done") {
        responsePending = false;
      }

      /* ------------------------------------------------------------------ */
      /*                 FUNCTION CALL HANDLING                              */
      /* ------------------------------------------------------------------ */

      if (
        type === "response.function_call_arguments.delta" ||
        type === "response.function_call_arguments.done"
      ) {
        if (type === "response.function_call_arguments.delta") return;

        console.log("\n===============================");
        console.log("🔧 FUNCTION CALL");
        console.log("===============================");
        console.log("Function:", parsed.name);

        let args = {};
        try {
          args = JSON.parse(parsed.arguments);
        } catch (err) {
          console.log("❌ Error parsing arguments:", err);
          return;
        }

        // Normalize order ID if present
        if (args.order_id) {
          args.order_id = normalizeOrderId(args.order_id);
        }

        console.log("Arguments (normalized):", args);

        // Validate work order exists BEFORE executing tool (when applicable)
        if (args.order_id) {
          const wo = getWorkOrder(args.order_id);
          if (!wo) {
            console.log(`❌ Work order ${args.order_id} does not exist. Skipping tool call.`);

            aiSocket.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
                output_audio_format: "pcm16",
                instructions: `
The work order ${args.order_id} does not exist in the backend.
Tell the user clearly:
"Work order ${args.order_id} does not exist in the system. Please repeat the work order number slowly, digit by digit, so I can try again."
                `
              }
            }));

            return;
          }
        }

        const result = await executeWorkOrderFunction(parsed.name, args);

        console.log("→ Result:");
        console.log(JSON.stringify(result, null, 2));

        // If a control event was returned, broadcast it to the client
        if (result?.control_event?.mode) {
          broadcastToClients({
            type: "session.control",
            mode: result.control_event.mode,     // "soft_end" | "hard_end"
            reason: result.control_event.reason || "",
            last_order_id: result.control_event.last_order_id ?? null
          });
        }

        // Build assistant response with strict mutation rule
        aiSocket.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text", "audio"],
            output_audio_format: "pcm16",
            instructions: `
Tool result JSON:
${JSON.stringify(result)}

RESPONSE RULES:
- If result.ok=false: explain the error and ask what to do next.
- If result.mutated=true: your reply MUST start with result.action_summary (verbatim) as the first sentence.
- Then give a concise follow-up: what changed and what the next step is.
- If result.mutated=false and result.control_event exists:
  briefly confirm that the session has ended and explain what the user should do next (e.g., say "Assistant" to resume for soft end).
- If result.mutated=false without control_event: give a concise informational summary.

Do not claim any change that is not in the tool result.
            `
          }
        }));

        return;
      }

      /* ------------------------------------------------------------------ */
      /*                       FORWARD TO CLIENT                            */
      /* ------------------------------------------------------------------ */

      for (const res of clients) {
        res.write(`data: ${text}\n\n`);
      }
    });

  } catch (err) {
    console.error("Failed to connect:", err.message);
    setTimeout(connectRealtime, 5000);
  }
}

/* -------------------------------------------------------------------------- */
/*                            API ROUTES (iPhone)                             */
/* -------------------------------------------------------------------------- */

app.post("/audio", (req, res) => {
  const { base64 } = req.body;

  if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN)
    return res.status(503).send("AI not connected");

  if (!base64)
    return res.status(400).json({ ok: false, error: "empty_audio" });

  const bytes = Buffer.from(base64, "base64").length;
  lastAudioBytes += bytes;

  aiSocket.send(JSON.stringify({
    type: "input_audio_buffer.append",
    audio: base64
  }));

  res.json({ ok: true });
});

app.post("/respond", (req, res) => {
  if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN)
    return res.status(503).send("AI not connected");

  if (responsePending)
    return res.status(429).json({ ok: false, error: "response_in_progress" });

  if (lastAudioBytes < 4800)
    return res.status(400).json({ ok: false, error: "audio_too_short" });

  aiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

  aiSocket.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["text", "audio"],
      output_audio_format: "pcm16",
      instructions:
        "You are a friendly SAP PM assistant. Speak clearly. Keep responses concise and always in English."
    }
  }));

  responsePending = true;
  lastAudioBytes = 0;

  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/*                           DEBUG & WORK ORDER API                           */
/* -------------------------------------------------------------------------- */

app.get("/workorder/:id", (req, res) => {
  const wo = getWorkOrder(req.params.id);
  if (!wo) return res.status(404).json({ error: "Work order not found" });
  res.json(wo);
});

app.get("/debug/reset", (req, res) => {
  resetWorkOrders();
  res.json({ status: "reset" });
});

/* -------------------------------------------------------------------------- */
/*                                  SSE STREAM                                */
/* -------------------------------------------------------------------------- */

app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.push(res);
  console.log(`Client connected (${clients.length})`);

  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clients = clients.filter((c) => c !== res);
    console.log(`Client disconnected (${clients.length})`);
  });
});

/* -------------------------------------------------------------------------- */
/*                                START SERVER                                */
/* -------------------------------------------------------------------------- */

const PORT = 3000;
app.listen(PORT, () => console.log(`Voice server running on port ${PORT}`));

connectRealtime();
