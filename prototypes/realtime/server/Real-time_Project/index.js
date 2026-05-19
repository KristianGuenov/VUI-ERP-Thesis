// ------------------------------
// index.js (Realtime + Tools + Validation + Audio)
// ------------------------------

import express from "express";
import WebSocket from "ws";
import cors from "cors";
import events from "events";
import "dotenv/config";

import { workOrderTools } from "./workOrderTools.js";
import { executeWorkOrderFunction } from "./executeWorkOrderFunction.js";
import {
  getWorkOrder,
  listWorkOrders,
  resetWorkOrders,
  setExperimentWorkOrders
} from "./workOrders.js";
import { logEvent, saveFinalState, safeClone } from "./experimentLogger.js";
import fs from "fs";
import path from "path";

// Avoid MaxListeners warnings
events.EventEmitter.defaultMaxListeners = 25;

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";

const VALID_WORK_ORDER_IDS = new Set(["WO-1001", "WO-2002", "WO-3003"]);

const SENSITIVE_TOOLS = new Set([
  "report_time",
  "add_time_to_work_order",
  "close_operation",
  "complete_work_order",
  "end_task_session",
  "end_assistant_session"
]);

let aiSocket = null;
let clients = [];

let lastAudioBytes = 0;
let responsePending = false;

let activeTrial = null;
let awaitingFinalAcknowledgement = false;

let confirmationPromptLoggedForActiveTrial = false;
let confirmationReceivedForActiveTrial = false;
let sensitiveToolExecutedForActiveTrial = false;
let pendingSensitiveAction = null;
let pendingCancellationRequested = false;

const processedFunctionCalls = new Set();

/* -------------------------------------------------------------------------- */
/*                               Helper funcs                                 */
/* -------------------------------------------------------------------------- */

function normalizeOrderId(raw) {
  if (!raw) return raw;

  const text = String(raw)
    .trim()
    .toUpperCase()
    .replace(/\bWORK\s*ORDER\b/g, "WO")
    .replace(/\s+/g, "")
    .replace(/_/g, "-");

  const woMatch = text.match(/^WO-?(\d{4})$/);
  if (woMatch) {
    return `WO-${woMatch[1]}`;
  }

  const digitOnlyMatch = text.match(/^(\d{4})$/);
  if (digitOnlyMatch) {
    return `WO-${digitOnlyMatch[1]}`;
  }

  return text;
}

function isValidWorkOrderId(orderId) {
  return VALID_WORK_ORDER_IDS.has(normalizeOrderId(orderId));
}

function isSensitiveTool(toolName) {
  return SENSITIVE_TOOLS.has(toolName);
}

function normalizeArgs(args = {}) {
  const normalized = { ...args };

  if (normalized.order_id) {
    normalized.order_id = normalizeOrderId(normalized.order_id);
  }

  return normalized;
}

function argsMatch(a = {}, b = {}) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (String(a[key]) !== String(b[key])) return false;
  }

  return true;
}

function pendingActionMatches(name, args) {
  if (!pendingSensitiveAction) return false;

  return (
    pendingSensitiveAction.name === name &&
    argsMatch(pendingSensitiveAction.args, args)
  );
}

function isAffirmativeConfirmationText(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    normalized === "yes" ||
    normalized === "yes confirm" ||
    normalized === "confirm" ||
    normalized === "i confirm" ||
    normalized === "yes i confirm" ||
    normalized.includes("yes confirm") ||
    normalized.includes("yes i confirm")
  );
}

function isNegativeConfirmationText(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    normalized === "no" ||
    normalized === "cancel" ||
    normalized === "no cancel" ||
    normalized.includes("cancel") ||
    normalized.includes("do not") ||
    normalized.includes("dont") ||
    normalized.includes("don't")
  );
}

function broadcastToClients(obj) {
  const text = JSON.stringify(obj);
  for (const res of clients) {
    res.write(`data: ${text}\n\n`);
  }
}

function forwardRealtimeEventToClients(parsed, rawText) {
  for (const res of clients) {
    res.write(`data: ${rawText}\n\n`);
  }

  // Compatibility for older iOS client code that may still listen for old event names.
  if (parsed?.type === "response.output_audio.delta") {
    broadcastToClients({
      ...parsed,
      type: "response.audio.delta"
    });
  }

  if (parsed?.type === "response.output_audio.done") {
    broadcastToClients({
      ...parsed,
      type: "response.audio.done"
    });
  }

  if (parsed?.type === "response.output_audio_transcript.delta") {
    broadcastToClients({
      ...parsed,
      type: "response.audio_transcript.delta"
    });
  }

  if (parsed?.type === "response.output_audio_transcript.done") {
    broadcastToClients({
      ...parsed,
      type: "response.audio_transcript.done"
    });
  }
}

function loadCommonScenarios() {
  const filePath = path.resolve("experiment", "scenarios", "common_scenarios.json");

  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing scenario file: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getScenarioById(scenarioId) {
  const scenarios = loadCommonScenarios();
  const scenario = scenarios.find((item) => item.scenarioId === scenarioId);

  if (!scenario) {
    throw new Error(`Scenario ${scenarioId} not found in common_scenarios.json`);
  }

  return scenario;
}

function getActiveScenario() {
  if (!activeTrial?.scenarioId) return null;

  try {
    return getScenarioById(activeTrial.scenarioId);
  } catch {
    return null;
  }
}

function scenarioNeedsConfirmation(scenario) {
  if (!scenario) return false;

  if (scenario.includedInConfirmationCompliance === true) {
    return true;
  }

  const allowedOperations = scenario.allowedOperations || [];

  return allowedOperations.some((operation) => {
    const toolName = operation.toolName || operation.name;
    return SENSITIVE_TOOLS.has(toolName);
  });
}

function trialMetadata(extra = {}) {
  if (!activeTrial) return extra;

  return {
    trialId: activeTrial.trialId,
    condition: activeTrial.condition,
    prototype: activeTrial.prototype,
    environment: activeTrial.environment,
    scenarioId: activeTrial.scenarioId,
    repetition: activeTrial.repetition,
    ...extra
  };
}

function logTrialEvent(eventType, extra = {}) {
  if (!activeTrial) return null;
  return logEvent(trialMetadata({ eventType, ...extra }));
}

function extractEventText(parsed) {
  const candidates = [
    parsed?.delta,
    parsed?.text,
    parsed?.transcript,
    parsed?.item?.text,
    parsed?.item?.transcript,
    parsed?.response?.text
  ].filter((value) => typeof value === "string");

  if (Array.isArray(parsed?.item?.content)) {
    for (const content of parsed.item.content) {
      if (typeof content?.text === "string") candidates.push(content.text);
      if (typeof content?.transcript === "string") candidates.push(content.transcript);
    }
  }

  if (Array.isArray(parsed?.response?.output)) {
    for (const output of parsed.response.output) {
      if (typeof output?.text === "string") candidates.push(output.text);
      if (typeof output?.transcript === "string") candidates.push(output.transcript);

      if (Array.isArray(output?.content)) {
        for (const content of output.content) {
          if (typeof content?.text === "string") candidates.push(content.text);
          if (typeof content?.transcript === "string") candidates.push(content.transcript);
        }
      }
    }
  }

  return candidates.join(" ").trim();
}

function logConfirmationPromptIfNeeded(source, extra = {}) {
  if (!activeTrial) return;
  if (confirmationPromptLoggedForActiveTrial) return;

  const scenario = getActiveScenario();
  if (!scenarioNeedsConfirmation(scenario)) return;

  logTrialEvent("confirmation_prompted", {
    source,
    ...extra
  });

  confirmationPromptLoggedForActiveTrial = true;
}

function logConfirmationReceivedIfNeeded(source, text) {
  if (!activeTrial) return;

  const scenario = getActiveScenario();
  if (!scenarioNeedsConfirmation(scenario)) return;

  logConfirmationPromptIfNeeded("user_confirmation_implies_prior_prompt", {
    note: "User confirmation was detected before sensitive tool execution; assistant prompt text was not available in the Realtime transcript stream."
  });

  logTrialEvent("confirmation_received", {
    source,
    text
  });

  confirmationReceivedForActiveTrial = true;
}

function maybeLogConfirmationEvents(parsed) {
  if (!activeTrial) return;

  const observedText = extractEventText(parsed);
  if (!observedText) return;

  const lower = observedText.toLowerCase();

  if (
    lower.includes("confirm") &&
    (lower.includes("yes or no") || lower.includes("yes/no") || lower.includes("please confirm"))
  ) {
    logConfirmationPromptIfNeeded("assistant_text_detected", {
      text: observedText
    });
  }

  if ((parsed.type || "").includes("input_audio_transcription")) {
    if (isAffirmativeConfirmationText(observedText)) {
      logConfirmationReceivedIfNeeded("user_transcript_detected", observedText);
    }

    if (isNegativeConfirmationText(observedText)) {
      pendingCancellationRequested = true;

      logTrialEvent("confirmation_received", {
        source: "user_transcript_detected",
        text: observedText,
        decision: "no"
      });
    }
  }
}

function responseContainsFunctionCall(parsed) {
  return Array.isArray(parsed?.response?.output) &&
    parsed.response.output.some((item) => item?.type === "function_call");
}

function maybeLogConfirmationPromptFallback(parsed) {
  if (!activeTrial) return;
  if (confirmationPromptLoggedForActiveTrial) return;
  if (confirmationReceivedForActiveTrial) return;
  if (sensitiveToolExecutedForActiveTrial) return;

  const scenario = getActiveScenario();
  if (!scenarioNeedsConfirmation(scenario)) return;

  // If the response already contains a function call, the model skipped confirmation.
  // Do not log a fake prompt in that case. Server-side gate will handle it.
  if (responseContainsFunctionCall(parsed)) return;

  logTrialEvent("confirmation_prompted", {
    source: "response_done_fallback_sensitive_scenario",
    responseId: parsed.response?.id ?? parsed.response_id ?? null,
    note: "Assistant response completed before user confirmation and before sensitive tool execution; prompt text was not available in the Realtime transcript stream."
  });

  confirmationPromptLoggedForActiveTrial = true;
}

function resetTrialRuntimeFlags() {
  lastAudioBytes = 0;
  responsePending = false;
  awaitingFinalAcknowledgement = false;
  confirmationPromptLoggedForActiveTrial = false;
  confirmationReceivedForActiveTrial = false;
  sensitiveToolExecutedForActiveTrial = false;
  pendingSensitiveAction = null;
  pendingCancellationRequested = false;
  processedFunctionCalls.clear();
}

function createAudioResponse(instructions) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions
    }
  };
}

function createFunctionCallOutput(callId, output) {
  if (!callId) return;

  aiSocket.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output)
    }
  }));
}

function getSessionInstructions() {
  return `
You are an English-speaking SAP PM assistant for a controlled thesis experiment.

GENERAL BEHAVIOR
- Keep responses concise and in English.
- Always reflect the actual backend/tool result. Do NOT claim changes if tools failed.
- Use the exact work order IDs from the experiment. The only valid work order IDs are:
  - WO-1001
  - WO-2002
  - WO-3003
- Never add extra digits to work order IDs.
- Never convert WO-1001 into WO-10001.
- Keep the hyphenated WO format exactly: WO-1001, WO-2002, WO-3003.

MANDATORY CONFIRMATION RULES FOR SENSITIVE ACTIONS
Before calling ANY of these tools:
- report_time
- add_time_to_work_order
- close_operation
- complete_work_order
- end_task_session
- end_assistant_session

You MUST:
1) Repeat back what you are about to do with the key parameters: order ID, operation ID, and minutes where relevant.
2) Ask the user exactly: "Please confirm: yes or no?"
3) WAIT for the user's explicit "yes" before calling the tool.
4) If the user says "no", do not call the tool. Ask what they want instead.

IMPORTANT SERVER-SIDE RULE
- Even if you accidentally call a sensitive tool before confirmation, the server will block it.
- After the user says yes, call the same tool again with the same arguments.

WORK ORDER ID RULES
- Work order IDs are not free-form numbers.
- Use only WO-1001, WO-2002, or WO-3003.
- If the user says "WO one thousand one", interpret it as WO-1001.
- If the user says "WO two thousand two", interpret it as WO-2002.
- If the user says "WO three thousand three", interpret it as WO-3003.
- If the backend reports work order does NOT exist:
  "Work order <ID> does not exist in the system. Please repeat the work order ID."
  Do NOT pretend success.

MUTATION CONFIRMATION REQUIRED
- If a tool result indicates a mutation occurred, mutated=true, your reply MUST begin with the tool field action_summary.
- This action_summary MUST be repeated verbatim as the first sentence, and it always starts with:
  "I confirm I have ..."

TOOL USAGE
- If the user mentions an operation by ID, use the exact operation ID:
  - OP-2
  - OP-B
  - OP-11
- If the user mentions an operation by description, match it to the correct operation_id.
- If multiple operations match, ask which one.
- If the user does not mention order_id, use the last referenced work order only if it is clear.

AUTO-DETAILS
- If the user asks about details, what needs to be done, or what the order is about:
  call get_work_order_details.
`;
}

function getToolResponseInstructions(result) {
  return `
Tool result JSON:
${JSON.stringify(result)}

RESPONSE RULES:
- If result.ok=false: explain the error and ask what to do next.
- If result.mutated=true: your reply MUST start with result.action_summary verbatim as the first sentence.
- Then give a concise follow-up: what changed and what the next step is.
- If result.mutated=false and result.control_event exists:
  briefly confirm that the session has ended and explain what the user should do next.
- If result.mutated=false without control_event: give a concise informational summary.
- Do not claim any change that is not in the tool result.
`;
}

function getConfirmationPromptInstructions(name, args) {
  const orderId = args.order_id ? ` work order ${args.order_id}` : "";
  const operationId = args.operation_id ? ` operation ${args.operation_id}` : "";
  const minutes = args.minutes != null ? ` ${args.minutes} minutes` : "";

  return `
The requested action is sensitive and has NOT been executed yet.

Action: ${name}
Parameters: ${JSON.stringify(args)}

Ask the user exactly this, in one short sentence:
"Please confirm: yes or no?"

Do not call any tool in this response.
Do not claim the action was completed.
You may briefly mention what will be done: ${name}${minutes}${operationId}${orderId}.
`;
}

function getCancellationInstructions() {
  return `
The user declined or cancelled the pending sensitive action.
Tell the user: "Cancelled. No changes were made."
Do not call any tool.
`;
}

/* -------------------------------------------------------------------------- */
/*                         Tool Execution Helpers                             */
/* -------------------------------------------------------------------------- */

function validateWorkOrderArgsBeforeExecution(name, args, callId = null) {
  if (!args.order_id) {
    return true;
  }

  if (!isValidWorkOrderId(args.order_id)) {
    console.log(`❌ Invalid work order ID ${args.order_id}. Skipping tool call.`);

    const result = {
      ok: false,
      mutated: false,
      error: "INVALID_WORK_ORDER_ID",
      order_id: args.order_id,
      valid_order_ids: Array.from(VALID_WORK_ORDER_IDS)
    };

    logTrialEvent("operation_rejected", {
      toolName: name,
      args: safeClone(args),
      reason: "INVALID_WORK_ORDER_ID",
      order_id: args.order_id
    });

    logTrialEvent("trial_failure_observed", {
      failureType: "invalid_work_order_id",
      fatal: false,
      toolName: name,
      order_id: args.order_id
    });

    createFunctionCallOutput(callId, result);

    aiSocket.send(JSON.stringify(createAudioResponse(`
The work order ${args.order_id} is not one of the valid experiment IDs.
Tell the user clearly:
"Work order ${args.order_id} does not exist in the system. Please repeat the work order ID."
    `)));

    return false;
  }

  const wo = getWorkOrder(args.order_id);

  if (!wo) {
    console.log(`❌ Work order ${args.order_id} does not exist. Skipping tool call.`);

    const result = {
      ok: false,
      mutated: false,
      error: "WORK_ORDER_NOT_FOUND",
      order_id: args.order_id
    };

    logTrialEvent("operation_rejected", {
      toolName: name,
      args: safeClone(args),
      reason: "WORK_ORDER_NOT_FOUND",
      order_id: args.order_id
    });

    logTrialEvent("trial_failure_observed", {
      failureType: "work_order_not_found",
      fatal: false,
      toolName: name,
      order_id: args.order_id
    });

    createFunctionCallOutput(callId, result);

    aiSocket.send(JSON.stringify(createAudioResponse(`
The work order ${args.order_id} does not exist in the backend.
Tell the user clearly:
"Work order ${args.order_id} does not exist in the system. Please repeat the work order ID."
    `)));

    return false;
  }

  return true;
}

async function executeToolAndRespond(name, args, callId = null, source = "model_function_call") {
  console.log("Arguments (normalized):", args);

  logTrialEvent("tool_call_requested", {
    toolName: name,
    args: safeClone(args),
    source
  });

  const canExecute = validateWorkOrderArgsBeforeExecution(name, args, callId);
  if (!canExecute) return;

  const result = await executeWorkOrderFunction(name, args);

  createFunctionCallOutput(callId, result);

  logTrialEvent("tool_call_result", {
    toolName: name,
    args: safeClone(args),
    ok: Boolean(result?.ok),
    mutated: Boolean(result?.mutated),
    resultType: result?.type ?? null,
    error: result?.error ?? null
  });

  if (result?.mutated === true) {
    logTrialEvent("operation_executed", {
      toolName: name,
      args: safeClone(args),
      resultType: result?.type ?? null
    });

    if (SENSITIVE_TOOLS.has(name)) {
      sensitiveToolExecutedForActiveTrial = true;
    }
  } else if (result?.ok === false) {
    logTrialEvent("operation_rejected", {
      toolName: name,
      args: safeClone(args),
      reason: result?.error ?? "UNKNOWN_REJECTION",
      result: safeClone(result)
    });
  }

  console.log("→ Result:");
  console.log(JSON.stringify(result, null, 2));

  if (result?.control_event?.mode) {
    broadcastToClients({
      type: "session.control",
      mode: result.control_event.mode,
      reason: result.control_event.reason || "",
      last_order_id: result.control_event.last_order_id ?? null
    });
  }

  if (activeTrial) {
    awaitingFinalAcknowledgement = true;
  }

  aiSocket.send(JSON.stringify(createAudioResponse(getToolResponseInstructions(result))));
}

function holdSensitiveActionForConfirmation(name, args, callId = null) {
  pendingSensitiveAction = {
    name,
    args: safeClone(args),
    createdAt: new Date().toISOString()
  };

  logConfirmationPromptIfNeeded("server_enforced_sensitive_tool_gate", {
    toolName: name,
    args: safeClone(args),
    note: "Sensitive tool call was blocked until explicit user confirmation."
  });

  createFunctionCallOutput(callId, {
    ok: false,
    mutated: false,
    requires_confirmation: true,
    toolName: name,
    args,
    message: "Sensitive action requires explicit user confirmation before execution."
  });

  aiSocket.send(JSON.stringify(createAudioResponse(getConfirmationPromptInstructions(name, args))));
}

async function executePendingSensitiveActionIfPossible() {
  if (!pendingSensitiveAction) return false;
  if (!confirmationReceivedForActiveTrial) return false;

  const action = pendingSensitiveAction;
  pendingSensitiveAction = null;

  await executeToolAndRespond(
    action.name,
    action.args,
    null,
    "server_executed_after_confirmation"
  );

  return true;
}

function cancelPendingSensitiveActionIfNeeded() {
  if (!pendingSensitiveAction) return false;
  if (!pendingCancellationRequested) return false;

  const cancelledAction = pendingSensitiveAction;
  pendingSensitiveAction = null;
  pendingCancellationRequested = false;

  logTrialEvent("operation_rejected", {
    toolName: cancelledAction.name,
    args: safeClone(cancelledAction.args),
    reason: "USER_CANCELLED_PENDING_SENSITIVE_ACTION"
  });

  aiSocket.send(JSON.stringify(createAudioResponse(getCancellationInstructions())));

  return true;
}

/* -------------------------------------------------------------------------- */
/*                         Function Call Handling                             */
/* -------------------------------------------------------------------------- */

async function handleFunctionCall({ name, argumentsText, callId }) {
  if (!name) return;

  const dedupeKey = callId || `${name}:${argumentsText}`;
  if (processedFunctionCalls.has(dedupeKey)) return;
  processedFunctionCalls.add(dedupeKey);

  console.log("\n===============================");
  console.log("🔧 FUNCTION CALL");
  console.log("===============================");
  console.log("Function:", name);

  let args = {};
  try {
    args = JSON.parse(argumentsText || "{}");
  } catch (err) {
    console.log("❌ Error parsing arguments:", err);

    logTrialEvent("trial_failure_observed", {
      failureType: "tool_arguments_parse_error",
      fatal: true,
      toolName: name,
      error: err.message
    });

    return;
  }

  args = normalizeArgs(args);

  const canExecute = validateWorkOrderArgsBeforeExecution(name, args, callId);
  if (!canExecute) return;

  if (isSensitiveTool(name)) {
    if (confirmationReceivedForActiveTrial) {
      pendingSensitiveAction = null;

      await executeToolAndRespond(
        name,
        args,
        callId,
        pendingActionMatches(name, args)
          ? "model_recalled_pending_action_after_confirmation"
          : "model_function_call_after_confirmation"
      );

      return;
    }

    holdSensitiveActionForConfirmation(name, args, callId);
    return;
  }

  await executeToolAndRespond(name, args, callId, "model_function_call");
}

async function handleFunctionCallsFromResponseDone(parsed) {
  const outputs = parsed?.response?.output;

  if (!Array.isArray(outputs)) return;

  for (const item of outputs) {
    if (item?.type !== "function_call") continue;

    await handleFunctionCall({
      name: item.name,
      argumentsText: item.arguments,
      callId: item.call_id
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                         OpenAI Realtime Connection                         */
/* -------------------------------------------------------------------------- */

async function connectRealtime() {
  console.log("Connecting to OpenAI Realtime...");

  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY in .env");
      return setTimeout(connectRealtime, 3000);
    }

    processedFunctionCalls.clear();

    aiSocket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    aiSocket.on("open", () => {
      console.log("Connected to OpenAI Realtime");

      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000
              },
              transcription: {
                model: "gpt-4o-mini-transcribe"
              },
              turn_detection: null
            },
            output: {
              format: {
                type: "audio/pcm",
                rate: 24000
              },
              voice: REALTIME_VOICE
            }
          },
          tools: workOrderTools,
          tool_choice: "auto",
          instructions: getSessionInstructions()
        }
      };

      aiSocket.send(JSON.stringify(sessionUpdate));
    });

    aiSocket.on("error", (err) => {
      console.error("WebSocket error:", err.message);

      logTrialEvent("trial_failure_observed", {
        failureType: "websocket_error",
        fatal: true,
        error: err.message
      });
    });

    aiSocket.on("close", () => {
      console.log("AI socket closed, reconnecting...");

      logTrialEvent("trial_failure_observed", {
        failureType: "websocket_closed",
        fatal: true
      });

      aiSocket = null;
      resetTrialRuntimeFlags();

      setTimeout(connectRealtime, 3000);
    });

    aiSocket.on("message", async (msg) => {
      const text = msg.toString();
      let parsed;

      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      const type = parsed.type;

      maybeLogConfirmationEvents(parsed);

      if (type === "error") {
        console.error("Model error:", parsed.error);

        logTrialEvent("trial_failure_observed", {
          failureType: "model_error",
          fatal: true,
          error: parsed.error ?? null
        });
      }

      if (type === "session.updated") {
        console.log("Realtime session updated.");
      }

      if (
        type === "response.function_call_arguments.delta" ||
        type === "response.function_call_arguments.done"
      ) {
        if (type === "response.function_call_arguments.delta") return;

        await handleFunctionCall({
          name: parsed.name,
          argumentsText: parsed.arguments,
          callId: parsed.call_id
        });

        return;
      }

      if (type === "response.done") {
        responsePending = false;

        logTrialEvent("response_done", {
          responseId: parsed.response?.id ?? parsed.response_id ?? null,
          status: parsed.response?.status ?? null
        });

        maybeLogConfirmationPromptFallback(parsed);

        await handleFunctionCallsFromResponseDone(parsed);

        cancelPendingSensitiveActionIfNeeded();

        await executePendingSensitiveActionIfPossible();

        if (awaitingFinalAcknowledgement) {
          logTrialEvent("final_acknowledgement_completed", {
            responseId: parsed.response?.id ?? parsed.response_id ?? null
          });

          awaitingFinalAcknowledgement = false;
        }
      }

      forwardRealtimeEventToClients(parsed, text);
    });

  } catch (err) {
    console.error("Failed to connect:", err.message);

    logTrialEvent("trial_failure_observed", {
      failureType: "realtime_connection_failed",
      fatal: true,
      error: err.message
    });

    setTimeout(connectRealtime, 5000);
  }
}

/* -------------------------------------------------------------------------- */
/*                            API ROUTES (iPhone)                             */
/* -------------------------------------------------------------------------- */

app.post("/audio", (req, res) => {
  const { base64 } = req.body;

  if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN) {
    logTrialEvent("trial_failure_observed", {
      failureType: "ai_not_connected",
      fatal: true,
      route: "/audio"
    });

    return res.status(503).send("AI not connected");
  }

  if (!base64) {
    logTrialEvent("trial_failure_observed", {
      failureType: "empty_audio",
      fatal: false,
      route: "/audio"
    });

    return res.status(400).json({ ok: false, error: "empty_audio" });
  }

  const bytes = Buffer.from(base64, "base64").length;
  lastAudioBytes += bytes;

  if (activeTrial && !activeTrial.serverAudioStartedAt) {
    activeTrial.serverAudioStartedAt = new Date().toISOString();

    logTrialEvent("audio_first_packet_received", {
      bytes,
      totalAudioBytes: lastAudioBytes
    });
  }

  aiSocket.send(JSON.stringify({
    type: "input_audio_buffer.append",
    audio: base64
  }));

  res.json({ ok: true });
});

app.post("/respond", (req, res) => {
  if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN) {
    logTrialEvent("trial_failure_observed", {
      failureType: "ai_not_connected",
      fatal: true,
      route: "/respond"
    });

    return res.status(503).send("AI not connected");
  }

  if (responsePending) {
    logTrialEvent("trial_failure_observed", {
      failureType: "response_in_progress",
      fatal: false,
      route: "/respond"
    });

    return res.status(429).json({ ok: false, error: "response_in_progress" });
  }

  if (lastAudioBytes < 4800) {
    logTrialEvent("trial_failure_observed", {
      failureType: "audio_too_short",
      fatal: false,
      route: "/respond",
      totalAudioBytes: lastAudioBytes
    });

    return res.status(400).json({ ok: false, error: "audio_too_short" });
  }

  logTrialEvent("audio_committed", {
    totalAudioBytes: lastAudioBytes
  });

  aiSocket.send(JSON.stringify({
    type: "input_audio_buffer.commit"
  }));

  aiSocket.send(JSON.stringify(createAudioResponse(
    "You are a friendly SAP PM assistant. Speak clearly. Keep responses concise and always in English."
  )));

  logTrialEvent("response_requested");

  responsePending = true;
  lastAudioBytes = 0;

  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/*                          EXPERIMENT API ROUTES                             */
/* -------------------------------------------------------------------------- */

app.post("/experiment/start-trial", (req, res) => {
  try {
    const { trialId, condition, prototype, environment, scenarioId, repetition } = req.body;

    if (!trialId || !condition || !prototype || !environment || !scenarioId || repetition == null) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_trial_metadata",
        required: ["trialId", "condition", "prototype", "environment", "scenarioId", "repetition"]
      });
    }

    const scenario = getScenarioById(scenarioId);

    if (!scenario.initialWorkOrder) {
      return res.status(400).json({
        ok: false,
        error: "scenario_missing_initial_work_order",
        scenarioId
      });
    }

    setExperimentWorkOrders([scenario.initialWorkOrder]);

    resetTrialRuntimeFlags();

    activeTrial = {
      trialId,
      condition,
      prototype,
      environment,
      scenarioId,
      repetition,
      status: "running",
      workOrderId: scenario.workOrderId,
      serverAudioStartedAt: null,
      finalAcknowledgementAt: null
    };

    logTrialEvent("trial_started", {
      workOrderId: scenario.workOrderId,
      numericHeavy: Boolean(scenario.numericHeavy),
      includedInConfirmationCompliance: Boolean(scenario.includedInConfirmationCompliance)
    });

    res.json({ ok: true, activeTrial });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/experiment/end-trial", (req, res) => {
  try {
    if (!activeTrial) {
      return res.status(400).json({ ok: false, error: "no_active_trial" });
    }

    const scenario = getScenarioById(activeTrial.scenarioId);
    const workOrder = scenario.workOrderId ? getWorkOrder(scenario.workOrderId) : null;

    const finalStatePath = saveFinalState(activeTrial.trialId, {
      trial: safeClone(activeTrial),
      workOrder: workOrder ? safeClone(workOrder) : null,
      allWorkOrders: safeClone(listWorkOrders())
    });

    logTrialEvent("trial_completed", {
      finalStatePath
    });

    const completedTrial = activeTrial;

    activeTrial = null;
    resetTrialRuntimeFlags();

    res.json({ ok: true, trial: completedTrial, finalStatePath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/experiment/fail-trial", (req, res) => {
  try {
    if (!activeTrial) {
      return res.status(400).json({ ok: false, error: "no_active_trial" });
    }

    const { failureType = "manual_failure", reason = "Trial marked as failed manually" } = req.body || {};
    const scenario = getScenarioById(activeTrial.scenarioId);
    const workOrder = scenario.workOrderId ? getWorkOrder(scenario.workOrderId) : null;

    const finalStatePath = saveFinalState(activeTrial.trialId, {
      trial: safeClone(activeTrial),
      failureType,
      reason,
      workOrder: workOrder ? safeClone(workOrder) : null,
      allWorkOrders: safeClone(listWorkOrders())
    });

    logTrialEvent("trial_failed", {
      failureType,
      reason,
      finalStatePath
    });

    const failedTrial = activeTrial;

    activeTrial = null;
    resetTrialRuntimeFlags();

    res.json({ ok: true, trial: failedTrial, finalStatePath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/experiment/current-trial", (req, res) => {
  res.json({ ok: true, activeTrial });
});

app.post("/experiment/reset", (req, res) => {
  activeTrial = null;
  resetTrialRuntimeFlags();
  resetWorkOrders();

  res.json({ ok: true, status: "experiment_reset" });
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

app.get("/debug/realtime", (req, res) => {
  res.json({
    ok: true,
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    socketReadyState: aiSocket?.readyState ?? null,
    socketOpen: aiSocket?.readyState === WebSocket.OPEN,
    validWorkOrderIds: Array.from(VALID_WORK_ORDER_IDS),
    pendingSensitiveAction: pendingSensitiveAction
      ? {
          name: pendingSensitiveAction.name,
          args: pendingSensitiveAction.args
        }
      : null,
    confirmationPromptLoggedForActiveTrial,
    confirmationReceivedForActiveTrial,
    sensitiveToolExecutedForActiveTrial
  });
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