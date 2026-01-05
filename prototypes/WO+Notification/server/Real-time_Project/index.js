// ------------------------------
// index.js (Work Orders + Notifications + Realtime + SSE + QR + Photos + Vision)
// ------------------------------

import express from "express";
import WebSocket from "ws";
import cors from "cors";
import events from "events";
import "dotenv/config";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { workOrderTools } from "./workOrderTools.js";
import { executeWorkOrderFunction } from "./executeWorkOrderFunction.js";
import { getWorkOrder, resetWorkOrders } from "./workOrders.js";

events.EventEmitter.defaultMaxListeners = 25;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* -------------------------------------------------------------------------- */
/*                               Storage paths                                */
/* -------------------------------------------------------------------------- */

const STORE_ROOT = path.join(__dirname, "stored_notifications");
const STORE_PHOTOS = path.join(STORE_ROOT, "photos");
const STORE_NOTIFS = path.join(STORE_ROOT, "notifications");

function ensureDirs() {
  for (const dir of [STORE_ROOT, STORE_PHOTOS, STORE_NOTIFS]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

app.use("/stored_notifications", express.static(STORE_ROOT));

/* -------------------------------------------------------------------------- */
/*                                   SSE                                      */
/* -------------------------------------------------------------------------- */

let clients = [];

function broadcastToClients(obj) {
  const text = JSON.stringify(obj);
  for (const res of clients) res.write(`data: ${text}\n\n`);
}

/* -------------------------------------------------------------------------- */
/*                         Work order helper / validation                      */
/* -------------------------------------------------------------------------- */

function normalizeOrderId(raw) {
  if (!raw) return raw;
  return String(raw).replace(/\band\b/gi, " ").replace(/\s+/g, "").trim();
}
const workOrderToolNames = new Set(workOrderTools.map((t) => t.name));

/* -------------------------------------------------------------------------- */
/*                            Notification "model"                             */
/* -------------------------------------------------------------------------- */

const NotificationModes = { minimal: "minimal", full: "full" };

function nowISO() {
  return new Date().toISOString();
}

function genNotificationId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const rand = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `N-${y}${mo}${da}-${hh}${mm}${ss}-${rand}`;
}

let notificationDraft = null;

function ensureDraft(mode = NotificationModes.minimal) {
  if (!notificationDraft) {
    notificationDraft = {
      notificationId: genNotificationId(),
      createdAt: nowISO(),
      mode,
      notificationType: "",
      shortText: "",
      priority: "",
      equipmentID: "",
      functionalLocation: "",
      plant: "",
      reportedBy: "",
      photos: [],
      // New: keep last vision insights on server (optional, but handy for debugging)
      vision: [],
    };
  }
  if (mode) notificationDraft.mode = mode;
  return notificationDraft;
}

function computeMissingRequired(draft) {
  if (!draft) return ["notificationType", "shortText", "priority", "equipmentID_or_functionalLocation"];

  const missing = [];
  const hasText = (v) => typeof v === "string" && v.trim().length > 0;

  if (!hasText(draft.notificationType)) missing.push("notificationType");
  if (!hasText(draft.shortText)) missing.push("shortText");
  if (!hasText(draft.priority)) missing.push("priority");

  const hasEquip = hasText(draft.equipmentID);
  const hasFloc = hasText(draft.functionalLocation);
  if (!hasEquip && !hasFloc) missing.push("equipmentID_or_functionalLocation");

  return missing;
}

function broadcastNotificationState(actionSummary = "") {
  const mode = notificationDraft?.mode ?? NotificationModes.minimal;
  const missingRequired = computeMissingRequired(notificationDraft);
  broadcastToClients({ type: "notification.state", mode, missingRequired, actionSummary, draft: notificationDraft });
}

function broadcastNotificationCreated(actionSummary, notificationJson) {
  const mode = notificationDraft?.mode ?? NotificationModes.minimal;
  const missingRequired = computeMissingRequired(notificationDraft);
  broadcastToClients({ type: "notification.created", mode, missingRequired, actionSummary, draft: notificationDraft, notificationJson });
}

function normalizeFieldName(field) {
  const f = String(field || "").trim();
  const map = {
    type: "notificationType",
    notification_type: "notificationType",
    short_text: "shortText",
    shorttext: "shortText",
    priority: "priority",
    equipment: "equipmentID",
    equipment_id: "equipmentID",
    equipmentid: "equipmentID",
    functional_location: "functionalLocation",
    functionallocation: "functionalLocation",
    plant: "plant",
    reported_by: "reportedBy",
    reporter: "reportedBy",
  };
  return map[f.toLowerCase()] || f;
}

const NOTIF_ALLOWED_FIELDS = new Set([
  "notificationType",
  "shortText",
  "priority",
  "equipmentID",
  "functionalLocation",
  "plant",
  "reportedBy",
]);

function sanitizeFieldValue(field, raw) {
  const s = raw == null ? "" : String(raw);
  // Do not trim shortText while typing (required-check uses trim anyway)
  if (field === "shortText") return s;
  return s.trim();
}

function setDraftFields(draft, fieldsObj) {
  const applied = {};
  for (const [kRaw, vRaw] of Object.entries(fieldsObj || {})) {
    const k = normalizeFieldName(kRaw);
    if (!NOTIF_ALLOWED_FIELDS.has(k)) continue;
    const v = sanitizeFieldValue(k, vRaw);
    draft[k] = v;
    applied[k] = v;
  }
  return applied;
}

function applyFieldUpdateFromBody(draft, body) {
  if (!body || typeof body !== "object") return {};
  if (body.fields && typeof body.fields === "object") return setDraftFields(draft, body.fields);
  if (typeof body.field === "string") {
    const k = normalizeFieldName(body.field);
    if (!NOTIF_ALLOWED_FIELDS.has(k)) return {};
    const v = sanitizeFieldValue(k, body.value);
    draft[k] = v;
    return { [k]: v };
  }
  return {};
}

/* -------------------------------------------------------------------------- */
/*                                   QR resolve                               */
/* -------------------------------------------------------------------------- */

function resolveQrToFields(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, fields: {}, reason: "empty" };

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const obj = JSON.parse(text);
      const fields = {};

      const put = (k, v, trim = true) => {
        if (v == null) return;
        const s = String(v);
        const out = trim ? s.trim() : s;
        if (!out) return;
        fields[k] = out;
      };

      if (obj.Notification && typeof obj.Notification === "object") {
        const n = obj.Notification;
        put("equipmentID", n.equipment_id);
        put("functionalLocation", n.functional_location);
        put("plant", n.plant);
        put("notificationType", n.notification_type);
        put("priority", n.priority);
        put("shortText", n.short_text, false);
      }

      if (obj.schema === "sap.pm.qr.v1") {
        const asset = obj.asset && typeof obj.asset === "object" ? obj.asset : {};
        const defaults = obj.defaults && typeof obj.defaults === "object" ? obj.defaults : {};

        put("equipmentID", asset.equipment_id ?? asset.equipmentID);
        put("functionalLocation", asset.functional_location ?? asset.functionalLocation ?? asset.floc);
        put("plant", asset.plant ?? asset.werks);

        put("notificationType", defaults.notification_type ?? defaults.notificationType);
        put("priority", defaults.priority);
        put("shortText", defaults.short_text ?? defaults.shortText, false);
      }

      put("equipmentID", obj.equipmentID ?? obj.equipment_id);
      put("functionalLocation", obj.functionalLocation ?? obj.functional_location ?? obj.floc);
      put("plant", obj.plant ?? obj.werks);
      put("notificationType", obj.notificationType ?? obj.notification_type);
      put("priority", obj.priority);
      put("shortText", obj.shortText ?? obj.short_text, false);

      const hasAny = Object.keys(fields).length > 0;
      return { ok: hasAny, fields, reason: hasAny ? "json" : "json_no_fields" };
    } catch {
      return { ok: false, fields: {}, reason: "json_parse_failed" };
    }
  }

  return { ok: false, fields: {}, reason: "unrecognized" };
}

/* -------------------------------------------------------------------------- */
/*                           Vision fallback (NEW)                             */
/* -------------------------------------------------------------------------- */

const VISION_AUTO_ANALYZE = String(process.env.VISION_AUTO_ANALYZE ?? "1") === "1";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";

/**
 * Calls OpenAI Responses API to analyze the image and return structured JSON:
 * {
 *   ok: true,
 *   summary: "...",
 *   confidence: 0.0..1.0,
 *   labels: ["pump","motor",...],
 *   suggestedFields: { equipmentID, functionalLocation, plant, shortText, notificationType, priority },
 *   evidence: { ...short evidence notes... }
 * }
 */
async function visionAnalyzeImage({ base64, mimeType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY_missing" };
  }

  const prompt = `
You are assisting SAP PM notification creation from a maintenance photo.

Goal:
- Provide a concise summary of what the image likely shows.
- Extract any visible identifiers (equipment tag, nameplate, barcode text if visible, functional location markings).
- Suggest SAP fields if you can infer them.

Return STRICT JSON ONLY with this schema:
{
  "ok": true,
  "summary": "string",
  "confidence": number,
  "labels": ["string"],
  "suggestedFields": {
    "equipmentID": "string or empty",
    "functionalLocation": "string or empty",
    "plant": "string or empty",
    "shortText": "string or empty"
  },
  "evidence": {
    "equipmentID": "why/where you got it (short)",
    "functionalLocation": "why/where you got it (short)",
    "plant": "why/where you got it (short)",
    "shortText": "why you propose it (short)"
  }
}

Rules:
- If unsure, set suggestedFields values to "".
- confidence in [0,1].
- Keep summary under 25 words.
`;

  const body = {
    model: OPENAI_VISION_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:${mimeType};base64,${base64}` },
        ],
      },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return { ok: false, error: `vision_http_${resp.status}`, detail: t.slice(0, 800) };
  }

  const j = await resp.json();

  // Extract text robustly
  let text = "";
  if (typeof j.output_text === "string") text = j.output_text;
  if (!text && Array.isArray(j.output)) {
    const chunks = [];
    for (const item of j.output) {
      if (item && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
        }
      }
    }
    text = chunks.join("\n");
  }

  // Pull first JSON object from text if needed
  const trimmed = String(text || "").trim();
  let parsed = null;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {}
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "vision_parse_failed", raw: trimmed.slice(0, 1000) };
  }

  // Normalize output
  const out = {
    ok: true,
    summary: String(parsed.summary ?? ""),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
    labels: Array.isArray(parsed.labels) ? parsed.labels.map(String).slice(0, 12) : [],
    suggestedFields: {
      equipmentID: String(parsed.suggestedFields?.equipmentID ?? ""),
      functionalLocation: String(parsed.suggestedFields?.functionalLocation ?? ""),
      plant: String(parsed.suggestedFields?.plant ?? ""),
      shortText: String(parsed.suggestedFields?.shortText ?? ""),
    },
    evidence: {
      equipmentID: String(parsed.evidence?.equipmentID ?? ""),
      functionalLocation: String(parsed.evidence?.functionalLocation ?? ""),
      plant: String(parsed.evidence?.plant ?? ""),
      shortText: String(parsed.evidence?.shortText ?? ""),
    },
  };

  return out;
}

/**
 * Apply vision suggested fields only if draft currently has those fields empty.
 */
function applyVisionSuggestionsSafely(draft, suggestedFields) {
  const applied = {};
  const hasText = (v) => typeof v === "string" && v.trim().length > 0;

  const candidates = {
    equipmentID: suggestedFields?.equipmentID ?? "",
    functionalLocation: suggestedFields?.functionalLocation ?? "",
    plant: suggestedFields?.plant ?? "",
    shortText: suggestedFields?.shortText ?? "",
  };

  // Only apply if the draft is empty for that field
  if (!hasText(draft.equipmentID) && hasText(candidates.equipmentID)) {
    draft.equipmentID = candidates.equipmentID.trim();
    applied.equipmentID = draft.equipmentID;
  }
  if (!hasText(draft.functionalLocation) && hasText(candidates.functionalLocation)) {
    draft.functionalLocation = candidates.functionalLocation.trim();
    applied.functionalLocation = draft.functionalLocation;
  }
  if (!hasText(draft.plant) && hasText(candidates.plant)) {
    draft.plant = candidates.plant.trim();
    applied.plant = draft.plant;
  }
  if (!hasText(draft.shortText) && hasText(candidates.shortText)) {
    // keep as-is (do not trim aggressively)
    draft.shortText = candidates.shortText;
    applied.shortText = draft.shortText;
  }

  return applied;
}

async function runVisionForPhotoAndBroadcast({ draft, photoEntry, source }) {
  try {
    const absPath = path.join(__dirname, photoEntry.serverPath);
    if (!fs.existsSync(absPath)) {
      broadcastToClients({
        type: "notification.vision_result",
        ok: false,
        filename: photoEntry.filename,
        error: "file_missing",
      });
      return;
    }

    const buf = fs.readFileSync(absPath);
    const base64 = buf.toString("base64");
    const mimeType = photoEntry.mimeType || "image/jpeg";

    const vision = await visionAnalyzeImage({ base64, mimeType });

    if (!vision.ok) {
      broadcastToClients({
        type: "notification.vision_result",
        ok: false,
        filename: photoEntry.filename,
        error: vision.error || "vision_failed",
        detail: vision.detail || "",
      });
      return;
    }

    const appliedFields = applyVisionSuggestionsSafely(draft, vision.suggestedFields);

    const result = {
      type: "notification.vision_result",
      ok: true,
      filename: photoEntry.filename,
      serverPath: photoEntry.serverPath,
      source: source || "auto",
      summary: vision.summary,
      confidence: vision.confidence,
      labels: vision.labels,
      suggestedFields: vision.suggestedFields,
      evidence: vision.evidence,
      appliedFields,
      createdAt: nowISO(),
    };

    draft.vision = Array.isArray(draft.vision) ? draft.vision : [];
    draft.vision.push(result);

    broadcastToClients(result);

    if (Object.keys(appliedFields).length > 0) {
      broadcastNotificationState(`Vision applied fields: ${Object.keys(appliedFields).join(", ")}.`);
    } else {
      broadcastNotificationState(`Vision completed for ${photoEntry.filename}.`);
    }
  } catch (err) {
    broadcastToClients({
      type: "notification.vision_result",
      ok: false,
      filename: photoEntry?.filename || "",
      error: "vision_exception",
      detail: err?.message ?? String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                               Realtime tools                               */
/* -------------------------------------------------------------------------- */

const notificationTools = [
  { type: "function", name: "notification_start", description: "Start a new notification draft.", parameters: { type: "object", properties: { mode: { type: "string", enum: ["minimal", "full"] } }, required: ["mode"], additionalProperties: false } },
  { type: "function", name: "notification_set_mode", description: "Switch mode minimal/full.", parameters: { type: "object", properties: { mode: { type: "string", enum: ["minimal", "full"] } }, required: ["mode"], additionalProperties: false } },
  { type: "function", name: "notification_set_field", description: "Set a notification draft field.", parameters: { type: "object", properties: { field: { type: "string" }, value: { type: "string" } }, required: ["field", "value"], additionalProperties: false } },
  { type: "function", name: "notification_clear_field", description: "Clear a notification draft field.", parameters: { type: "object", properties: { field: { type: "string" } }, required: ["field"], additionalProperties: false } },

  // Device action requests
  { type: "function", name: "notification_request_photo_capture", description: "Ask iOS client to open camera.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: [], additionalProperties: false } },
  { type: "function", name: "notification_request_qr_scan", description: "Ask iOS client to open QR scanner.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: [], additionalProperties: false } },

  // NEW: on-demand vision analysis
  { type: "function", name: "notification_analyze_last_photo", description: "Run vision fallback analysis on the most recent attached photo.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },

  { type: "function", name: "notification_finalize", description: "Finalize notification and persist JSON.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
];

async function executeNotificationFunction(name, args) {
  try {
    if (name === "notification_start") {
      const mode = args?.mode === "full" ? NotificationModes.full : NotificationModes.minimal;
      notificationDraft = null;
      ensureDraft(mode);
      const action_summary = `I confirm I have started a new notification draft in ${mode} mode.`;
      broadcastNotificationState(action_summary);
      return { ok: true, mutated: true, action_summary, draft: notificationDraft, missingRequired: computeMissingRequired(notificationDraft) };
    }

    if (name === "notification_set_mode") {
      const mode = args?.mode === "full" ? NotificationModes.full : NotificationModes.minimal;
      ensureDraft(mode);
      const action_summary = `I confirm I have set the notification mode to ${mode}.`;
      broadcastNotificationState(action_summary);
      return { ok: true, mutated: true, action_summary, draft: notificationDraft, missingRequired: computeMissingRequired(notificationDraft) };
    }

    if (name === "notification_set_field") {
      const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
      const field = normalizeFieldName(args?.field);
      if (!NOTIF_ALLOWED_FIELDS.has(field)) {
        const action_summary = `Cannot set field "${field}" because it is not supported.`;
        broadcastNotificationState(action_summary);
        return { ok: false, mutated: false, action_summary, draft };
      }
      const value = sanitizeFieldValue(field, args?.value);
      draft[field] = value;
      const action_summary = `I confirm I have set ${field}.`;
      broadcastNotificationState(action_summary);
      return { ok: true, mutated: true, action_summary, draft, missingRequired: computeMissingRequired(draft) };
    }

    if (name === "notification_clear_field") {
      const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
      const field = normalizeFieldName(args?.field);
      if (!NOTIF_ALLOWED_FIELDS.has(field)) {
        const action_summary = `Cannot clear field "${field}" because it is not supported.`;
        broadcastNotificationState(action_summary);
        return { ok: false, mutated: false, action_summary, draft };
      }
      draft[field] = "";
      const action_summary = `I confirm I have cleared ${field}.`;
      broadcastNotificationState(action_summary);
      return { ok: true, mutated: true, action_summary, draft, missingRequired: computeMissingRequired(draft) };
    }

    if (name === "notification_request_photo_capture") {
      ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
      const requestId = `REQ-${Date.now()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
      const reason = String(args?.reason ?? "Take a photo now");
      broadcastToClients({ type: "notification.photo_request", requestId, reason });
      return { ok: true, mutated: false, action_summary: "Photo capture requested.", requestId, reason };
    }

    if (name === "notification_request_qr_scan") {
      ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
      const requestId = `QR-${Date.now()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
      const reason = String(args?.reason ?? "Scan QR code");
      broadcastToClients({ type: "notification.qr_request", requestId, reason });
      return { ok: true, mutated: false, action_summary: "QR scan requested.", requestId, reason };
    }

    // NEW: on-demand vision analysis
    if (name === "notification_analyze_last_photo") {
      const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
      const last = Array.isArray(draft.photos) ? draft.photos[draft.photos.length - 1] : null;
      if (!last) {
        const action_summary = "No photos available to analyze.";
        broadcastNotificationState(action_summary);
        return { ok: false, mutated: false, action_summary, draft };
      }

      await runVisionForPhotoAndBroadcast({ draft, photoEntry: last, source: "tool" });

      const action_summary = `Vision analysis started for ${last.filename}.`;
      // State broadcast happens inside runVisionForPhotoAndBroadcast as well
      return { ok: true, mutated: false, action_summary, filename: last.filename };
    }

    if (name === "notification_finalize") {
      const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
      const missing = computeMissingRequired(draft);
      if (missing.length > 0) {
        const action_summary = `Cannot finalize: missing required fields: ${missing.join(", ")}.`;
        broadcastNotificationState(action_summary);
        return { ok: false, mutated: false, action_summary, missingRequired: missing, draft };
      }

      const notificationJson = {
        Notification: {
          notification_id: draft.notificationId,
          mode: draft.mode,
          created_at: draft.createdAt,
          notification_type: draft.notificationType,
          short_text: draft.shortText,
          priority: draft.priority,
          equipment_id: draft.equipmentID,
          functional_location: draft.functionalLocation,
          plant: draft.plant,
          reported_by: draft.reportedBy,
          attachments: draft.photos.map((p) => ({
            filename: p.filename,
            path: p.serverPath,
            mimeType: p.mimeType,
            sizeBytes: p.sizeBytes,
            note: p.note,
            source: p.source,
            addedAt: p.addedAt,
          })),
        },
      };

      const outPath = path.join(STORE_NOTIFS, `${draft.notificationId}.json`);
      fs.writeFileSync(outPath, JSON.stringify(notificationJson, null, 2), "utf8");

      const action_summary = `I confirm I have finalized the notification ${draft.notificationId}.`;
      broadcastNotificationCreated(action_summary, notificationJson);

      return {
        ok: true,
        mutated: true,
        action_summary,
        notificationJson,
        draft,
        persistedPath: `stored_notifications/notifications/${draft.notificationId}.json`,
      };
    }

    return { ok: false, mutated: false, action_summary: `Unknown notification tool: ${name}` };
  } catch (err) {
    return { ok: false, mutated: false, action_summary: `Notification error: ${err?.message ?? String(err)}` };
  }
}

/* -------------------------------------------------------------------------- */
/*                         OpenAI Realtime Connection                         */
/* -------------------------------------------------------------------------- */

let aiSocket = null;
let lastAudioBytes = 0;
let responsePending = false;

function notificationDraftSnapshotForLLM() {
  if (!notificationDraft) return "";
  const d = notificationDraft;
  const snap = {
    mode: d.mode,
    missingRequired: computeMissingRequired(d),
    notificationType: d.notificationType,
    shortText: d.shortText,
    priority: d.priority,
    equipmentID: d.equipmentID,
    functionalLocation: d.functionalLocation,
    plant: d.plant,
    reportedBy: d.reportedBy,
    photosCount: Array.isArray(d.photos) ? d.photos.length : 0,
  };
  return `\nCURRENT_NOTIFICATION_DRAFT_SNAPSHOT:\n${JSON.stringify(snap)}\n`;
}

async function connectRealtime() {
  console.log("Connecting to OpenAI Realtime...");

  try {
    const sessionRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
      },
      body: JSON.stringify({ model: "gpt-4o-realtime-preview", voice: "verse" }),
    });

    const session = await sessionRes.json();
    if (!session?.client_secret?.value) {
      console.error("Could not obtain session client secret");
      return setTimeout(connectRealtime, 3000);
    }

    aiSocket = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
      headers: { Authorization: `Bearer ${session.client_secret.value}`, "OpenAI-Beta": "realtime=v1" },
    });

    aiSocket.on("open", () => {
      console.log("Connected to OpenAI Realtime");

      aiSocket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            voice: "verse",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: null,

            tools: [...workOrderTools, ...notificationTools],
            tool_choice: "auto",

            instructions: `
You are an English-speaking SAP PM assistant running inside an iOS application that CAN perform device actions via tools.

WORK ORDERS
- Use work order tools. Do not break work order flows.

NOTIFICATIONS
- Required fields: notificationType, shortText, priority, and either equipmentID or functionalLocation.
- If required fields are missing, ask for ONE missing field (the first).
- If equipment/location is missing but a photo exists, you MAY call notification_analyze_last_photo once.

DEVICE ACTIONS
- If user asks to scan QR: call notification_request_qr_scan.
- If user asks to take a photo now: call notification_request_photo_capture.
- Do not say you cannot access the camera/QR scanner.

FINALIZATION
- You MUST NOT claim a notification is finalized unless notification_finalize returned ok=true.
            `,
          },
        })
      );
    });

    aiSocket.on("error", (err) => console.error("WebSocket error:", err.message));

    aiSocket.on("close", () => {
      console.log("AI socket closed, reconnecting...");
      aiSocket = null;
      responsePending = false;
      lastAudioBytes = 0;
      setTimeout(connectRealtime, 3000);
    });

    aiSocket.on("message", async (msg) => {
      const text = msg.toString();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        for (const res of clients) res.write(`data: ${text}\n\n`);
        return;
      }

      if (parsed.type === "response.done") responsePending = false;

      if (parsed.type === "response.function_call_arguments.done") {
        let args = {};
        try {
          args = JSON.parse(parsed.arguments);
        } catch {
          args = {};
        }

        const fn = parsed.name;

        // Work orders
        if (workOrderToolNames.has(fn)) {
          if (args.order_id) args.order_id = normalizeOrderId(args.order_id);

          if (args.order_id) {
            const wo = getWorkOrder(args.order_id);
            if (!wo) {
              aiSocket.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: ["text", "audio"],
                    output_audio_format: "pcm16",
                    instructions: `Work order ${args.order_id} does not exist. Ask the user to repeat it digit by digit.`,
                  },
                })
              );
              return;
            }
          }

          const result = await executeWorkOrderFunction(fn, args);

          if (result?.control_event?.mode) {
            broadcastToClients({
              type: "session.control",
              mode: result.control_event.mode,
              reason: result.control_event.reason || "",
              last_order_id: result.control_event.last_order_id ?? null,
            });
          }

          aiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
                output_audio_format: "pcm16",
                instructions: `Tool result JSON:\n${JSON.stringify(result)}\n\nFollow tool results. Do not invent success.`,
              },
            })
          );
          return;
        }

        // Notifications
        const nres = await executeNotificationFunction(fn, args);

        aiSocket.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              output_audio_format: "pcm16",
              instructions: `Tool result JSON:\n${JSON.stringify(nres)}\n\nRules:\n- If ok=false: explain and ask for next required field.\n- If ok=true: start with action_summary.\n- If missingRequired non-empty: ask for ONE missing field.\n- If tool requested camera/QR: tell the user the UI is opening.`,
            },
          })
        );
        return;
      }

      // Forward everything else to SSE clients
      for (const res of clients) res.write(`data: ${text}\n\n`);
    });
  } catch (err) {
    console.error("Failed to connect:", err.message);
    setTimeout(connectRealtime, 5000);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  API Routes                                */
/* -------------------------------------------------------------------------- */

app.post("/audio", (req, res) => {
  const { base64 } = req.body;
  if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN) return res.status(503).send("AI not connected");
  if (!base64) return res.status(400).json({ ok: false, error: "empty_audio" });

  lastAudioBytes += Buffer.from(base64, "base64").length;
  aiSocket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
  res.json({ ok: true });
});

app.post("/respond", (req, res) => {
  if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN) return res.status(503).send("AI not connected");
  if (responsePending) return res.status(429).json({ ok: false, error: "response_in_progress" });
  if (lastAudioBytes < 4800) return res.status(400).json({ ok: false, error: "audio_too_short" });

  aiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

  const notifSnap = notificationDraftSnapshotForLLM();

  aiSocket.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        output_audio_format: "pcm16",
        instructions: `Keep responses concise and in English.${notifSnap}`,
      },
    })
  );

  responsePending = true;
  lastAudioBytes = 0;
  res.json({ ok: true });
});

/* ---------------------------- Notification REST ---------------------------- */

app.post("/notification/start", (req, res) => {
  const mode = req.body?.mode === "full" ? NotificationModes.full : NotificationModes.minimal;
  notificationDraft = null;
  ensureDraft(mode);
  broadcastNotificationState(`Started notification draft (${mode}).`);
  res.json({ ok: true, draft: notificationDraft, missingRequired: computeMissingRequired(notificationDraft) });
});

app.post("/notification/set_field", (req, res) => {
  const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
  const applied = applyFieldUpdateFromBody(draft, req.body);

  if (Object.keys(applied).length === 0) return res.status(400).json({ ok: false, error: "no_supported_fields", draft });

  broadcastNotificationState(`Updated: ${Object.keys(applied).join(", ")}`);
  res.json({ ok: true, draft, applied, missingRequired: computeMissingRequired(draft) });
});

app.post("/notification/set_fields", (req, res) => {
  const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
  const applied = applyFieldUpdateFromBody(draft, req.body);

  if (Object.keys(applied).length === 0) return res.status(400).json({ ok: false, error: "no_supported_fields", draft });

  broadcastNotificationState(`Updated: ${Object.keys(applied).join(", ")}`);
  res.json({ ok: true, draft, applied, missingRequired: computeMissingRequired(draft) });
});

// Aliases for client safety
app.post("/notification/setField", (req, res) => app._router.handle(req, res, () => {}, "/notification/set_field"));

app.post("/notification/clear_field", (req, res) => {
  const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
  const field = normalizeFieldName(req.body?.field);
  if (!NOTIF_ALLOWED_FIELDS.has(field)) return res.status(400).json({ ok: false, error: "unsupported_field", field });

  draft[field] = "";
  broadcastNotificationState(`Cleared ${field}.`);
  res.json({ ok: true, draft, missingRequired: computeMissingRequired(draft) });
});

app.post("/notification/apply_qr", (req, res) => {
  const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
  const raw = String(req.body?.raw ?? "");

  const resolved = resolveQrToFields(raw);
  if (!resolved.ok) {
    broadcastNotificationState("QR not recognized.");
    return res.status(400).json({ ok: false, error: "qr_unrecognized", resolved, draft });
  }

  const applied = setDraftFields(draft, resolved.fields);
  broadcastNotificationState(`Applied QR: ${Object.keys(applied).join(", ")}`);
  res.json({ ok: true, draft, applied, resolved, missingRequired: computeMissingRequired(draft) });
});

// Photo upload
function attachPhotoHandler(req, res) {
  try {
    const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);

    const base64 = String(req.body?.base64 ?? "");
    const mimeType = String(req.body?.mimeType ?? "image/jpeg");
    const filename = String(req.body?.filename ?? `photo_${Date.now()}.jpg`);
    const note = String(req.body?.note ?? "");
    const source = String(req.body?.source ?? "manual");
    const requestId = String(req.body?.requestId ?? "");
    const clientLocalId = String(req.body?.clientLocalId ?? "");

    if (!base64) return res.status(400).json({ ok: false, error: "missing_base64" });

    const buffer = Buffer.from(base64, "base64");
    const absPath = path.join(STORE_PHOTOS, filename);
    fs.writeFileSync(absPath, buffer);

    const serverPath = `stored_notifications/photos/${filename}`;

    const entry = {
      filename,
      serverPath,
      mimeType,
      sizeBytes: buffer.length,
      note,
      source,
      requestId,
      clientLocalId,
      addedAt: nowISO(),
    };

    draft.photos.push(entry);

    broadcastNotificationState(`Attached photo ${filename}.`);

    // NEW: auto vision analysis (non-blocking for HTTP response)
    if (VISION_AUTO_ANALYZE) {
      setTimeout(() => {
        runVisionForPhotoAndBroadcast({ draft, photoEntry: entry, source: "auto" });
      }, 50);
    }

    res.json({ ok: true, draft, photo: entry, missingRequired: computeMissingRequired(draft) });
  } catch (err) {
    res.status(500).json({ ok: false, error: "attach_failed", detail: err?.message ?? String(err) });
  }
}

app.post("/notification/attach_photo", attachPhotoHandler);
app.post("/notification/upload_photo", attachPhotoHandler);
app.post("/notification/uploadPhoto", attachPhotoHandler);
app.post("/notification/attachPhoto", attachPhotoHandler);

// Optional REST endpoint to manually trigger vision on last photo (UI button could call this later)
app.post("/notification/analyze_last_photo", async (req, res) => {
  const draft = ensureDraft(notificationDraft?.mode ?? NotificationModes.minimal);
  const last = Array.isArray(draft.photos) ? draft.photos[draft.photos.length - 1] : null;
  if (!last) return res.status(400).json({ ok: false, error: "no_photos" });

  await runVisionForPhotoAndBroadcast({ draft, photoEntry: last, source: "rest" });
  res.json({ ok: true, filename: last.filename });
});

app.post("/notification/finalize", async (req, res) => {
  const out = await executeNotificationFunction("notification_finalize", {});
  res.status(out.ok ? 200 : 400).json(out);
});

/* ------------------------------ Work order REST ---------------------------- */

app.get("/workorder/:id", (req, res) => {
  const wo = getWorkOrder(req.params.id);
  if (!wo) return res.status(404).json({ error: "Work order not found" });
  res.json(wo);
});

app.get("/debug/reset", (req, res) => {
  resetWorkOrders();
  res.json({ status: "reset" });
});

/* ---------------------------------- SSE ---------------------------------- */

app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.push(res);
  console.log(`Client connected (${clients.length})`);

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);

  if (notificationDraft) {
    res.write(`data: ${JSON.stringify({
      type: "notification.state",
      mode: notificationDraft.mode,
      missingRequired: computeMissingRequired(notificationDraft),
      actionSummary: "Draft synced.",
      draft: notificationDraft,
    })}\n\n`);
  }

  req.on("close", () => {
    clearInterval(keepAlive);
    clients = clients.filter((c) => c !== res);
    console.log(`Client disconnected (${clients.length})`);
  });
});

/* --------------------------------- Start --------------------------------- */

const PORT = 3000;
app.listen(PORT, () => console.log(`Voice server running on port ${PORT}`));
connectRealtime();
