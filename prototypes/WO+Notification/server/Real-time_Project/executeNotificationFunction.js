// executeNotificationFunction.js
import crypto from "crypto";

let notificationCounter = 1000;

let state = {
  mode: "minimal", // "minimal" | "full"
  draft: null,
  lastActionSummary: "",
  pendingPhotoRequest: null // { requestId, reason, createdAt }
};

function nowIso() {
  return new Date().toISOString();
}

function hasText(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function computeMissingRequired(draft, mode) {
  if (!draft) return ["notificationType", "shortText", "technicalObject"];

  const missing = [];

  if (!hasText(draft.notificationType)) missing.push("notificationType");
  if (!hasText(draft.shortText)) missing.push("shortText");

  const hasTechObj = hasText(draft.equipmentID) || hasText(draft.functionalLocation);
  if (!hasTechObj) missing.push("technicalObject");

  if (mode === "full") {
    if (!hasText(draft.priority)) missing.push("priority");
    if (!hasText(draft.plant)) missing.push("plant");
    if (!hasText(draft.reportedBy)) missing.push("reportedBy");
  }

  return missing;
}

function ensureDraft(mode = "minimal") {
  state.mode = mode || state.mode || "minimal";

  if (!state.draft) {
    state.draft = {
      id: `DRAFT-${crypto.randomUUID()}`,
      createdAt: nowIso(),
      status: "draft",
      notificationId: null,

      notificationType: null,
      shortText: null,
      priority: null,
      equipmentID: null,
      functionalLocation: null,
      plant: null,
      reportedBy: null,

      attachments: []
    };
  }

  return state.draft;
}

function toStateEvent(actionSummary = "") {
  const missingRequired = computeMissingRequired(state.draft, state.mode);
  const isReady = missingRequired.length === 0;

  // keep draft.status aligned
  if (state.draft) {
    state.draft.status = isReady ? "ready" : "draft";
  }

  return {
    type: "notification.state",
    mode: state.mode,
    actionSummary: actionSummary || state.lastActionSummary || "",
    missingRequired,
    draft: state.draft
  };
}

function summaryText() {
  const d = state.draft;
  const missing = computeMissingRequired(d, state.mode);

  const lines = [];
  lines.push(`Mode: ${state.mode}`);
  lines.push(`Notification type: ${d?.notificationType || "(missing)"}`);
  lines.push(`Short text: ${d?.shortText || "(missing)"}`);
  lines.push(`Priority: ${d?.priority || "(optional/minimal or missing)"}`);
  lines.push(`Equipment ID: ${d?.equipmentID || "(not set)"}`);
  lines.push(`Functional location: ${d?.functionalLocation || "(not set)"}`);
  lines.push(`Plant: ${d?.plant || "(optional/minimal or missing)"}`);
  lines.push(`Reported by: ${d?.reportedBy || "(optional/minimal or missing)"}`);
  lines.push(`Attachments: ${Array.isArray(d?.attachments) ? d.attachments.length : 0}`);

  if (missing.length) {
    lines.push(`Missing required: ${missing.join(", ")}`);
  } else {
    lines.push("All required fields are complete.");
  }

  return lines.join("\n");
}

function buildNotificationJsonFromDraft(draft, mode) {
  const notificationId = draft.notificationId || `N-${notificationCounter++}`;

  const technicalObject = hasText(draft.equipmentID)
    ? { equipmentID: draft.equipmentID }
    : { functionalLocation: draft.functionalLocation };

  return {
    notificationId,
    createdAt: nowIso(),
    mode,
    header: {
      notificationType: draft.notificationType,
      shortText: draft.shortText,
      priority: draft.priority || null,
      plant: draft.plant || null,
      reportedBy: draft.reportedBy || null,
      technicalObject
    },
    attachments: (draft.attachments || []).map((a) => ({
      id: a.id,
      filename: a.filename || null,
      mimeType: a.mimeType || null,
      sizeBytes: a.sizeBytes || null,
      serverPath: a.serverPath || null,
      note: a.note || null,
      source: a.source || null,
      createdAt: a.createdAt || null
    }))
  };
}

export async function executeNotificationFunction(name, args = {}) {
  try {
    switch (name) {
      case "notification_start": {
        const mode = args.mode || "minimal";
        state.mode = mode;
        state.draft = null;
        state.pendingPhotoRequest = null;

        ensureDraft(mode);

        const action_summary = "I confirm I have started a new notification draft.";
        state.lastActionSummary = action_summary;

        return {
          ok: true,
          mutated: true,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired: computeMissingRequired(state.draft, state.mode),
          notification_event: toStateEvent(action_summary)
        };
      }

      case "notification_set_mode": {
        ensureDraft(state.mode);
        state.mode = args.mode || state.mode;

        const action_summary = `I confirm I have set the notification mode to ${state.mode}.`;
        state.lastActionSummary = action_summary;

        return {
          ok: true,
          mutated: true,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired: computeMissingRequired(state.draft, state.mode),
          notification_event: toStateEvent(action_summary)
        };
      }

      case "notification_set_field": {
        ensureDraft(state.mode);

        const { field, value } = args;
        const allowed = new Set([
          "notificationType",
          "shortText",
          "priority",
          "equipmentID",
          "functionalLocation",
          "plant",
          "reportedBy"
        ]);

        if (!allowed.has(field)) {
          return { ok: false, mutated: false, error: "invalid_field", message: `Unknown field: ${field}` };
        }

        state.draft[field] = String(value ?? "").trim() || null;

        const action_summary = `I confirm I have set ${field} in the notification draft.`;
        state.lastActionSummary = action_summary;

        return {
          ok: true,
          mutated: true,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired: computeMissingRequired(state.draft, state.mode),
          notification_event: toStateEvent(action_summary)
        };
      }

      case "notification_clear_field": {
        ensureDraft(state.mode);

        const { field } = args;
        const allowed = new Set([
          "notificationType",
          "shortText",
          "priority",
          "equipmentID",
          "functionalLocation",
          "plant",
          "reportedBy"
        ]);

        if (!allowed.has(field)) {
          return { ok: false, mutated: false, error: "invalid_field", message: `Unknown field: ${field}` };
        }

        state.draft[field] = null;

        const action_summary = `I confirm I have cleared ${field} in the notification draft.`;
        state.lastActionSummary = action_summary;

        return {
          ok: true,
          mutated: true,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired: computeMissingRequired(state.draft, state.mode),
          notification_event: toStateEvent(action_summary)
        };
      }

      case "notification_summary": {
        ensureDraft(state.mode);

        const action_summary = "Notification draft summary generated.";
        const missingRequired = computeMissingRequired(state.draft, state.mode);

        return {
          ok: true,
          mutated: false,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired,
          summary: summaryText(),
          notification_event: toStateEvent(state.lastActionSummary)
        };
      }

      case "notification_finalize": {
        ensureDraft(state.mode);

        const missingRequired = computeMissingRequired(state.draft, state.mode);
        if (missingRequired.length) {
          return {
            ok: false,
            mutated: false,
            error: "missing_required",
            message: `Cannot finalize. Missing required: ${missingRequired.join(", ")}.`,
            mode: state.mode,
            draft: state.draft,
            missingRequired,
            notification_event: toStateEvent(state.lastActionSummary)
          };
        }

        // Create notification JSON
        const notificationJson = buildNotificationJsonFromDraft(state.draft, state.mode);
        state.draft.notificationId = notificationJson.notificationId;
        state.draft.status = "finalized";

        const action_summary = "I confirm I have finalized the notification draft and created the notification JSON.";
        state.lastActionSummary = action_summary;

        return {
          ok: true,
          mutated: true,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired: [],
          notificationJson,
          notification_event: {
            type: "notification.created",
            mode: state.mode,
            actionSummary: action_summary,
            missingRequired: [],
            draft: state.draft,
            notificationJson
          }
        };
      }

      // Step 4: Voice-triggered camera capture
      case "notification_request_photo_capture": {
        ensureDraft(state.mode);

        const requestId = crypto.randomUUID();
        const reason = String(args.reason || "Take a photo now").slice(0, 120);

        state.pendingPhotoRequest = { requestId, reason, createdAt: nowIso() };

        return {
          ok: true,
          mutated: false,
          action_summary: "Photo capture requested.",
          mode: state.mode,
          draft: state.draft,
          missingRequired: computeMissingRequired(state.draft, state.mode),
          notification_event: {
            type: "notification.photo_request",
            requestId,
            reason,
            mode: state.mode,
            draft: state.draft
          }
        };
      }

      // Internal (REST) tool: attach photo metadata to draft
      case "notification_attach_photo": {
        ensureDraft(state.mode);

        const attachment = {
          id: `ATT-${crypto.randomUUID()}`,
          createdAt: nowIso(),
          filename: args.filename || null,
          mimeType: args.mimeType || null,
          sizeBytes: typeof args.sizeBytes === "number" ? args.sizeBytes : null,
          serverPath: args.serverPath || null,
          note: args.note || null,
          clientLocalId: args.clientLocalId || null,
          requestId: args.requestId || null,
          source: args.source || "manual"
        };

        state.draft.attachments = Array.isArray(state.draft.attachments) ? state.draft.attachments : [];
        state.draft.attachments.push(attachment);

        // if this attachment came from a pending voice request, clear it
        if (state.pendingPhotoRequest?.requestId && args.requestId === state.pendingPhotoRequest.requestId) {
          state.pendingPhotoRequest = null;
        }

        const action_summary = "I confirm I have attached the photo to the notification draft.";
        state.lastActionSummary = action_summary;

        return {
          ok: true,
          mutated: true,
          action_summary,
          mode: state.mode,
          draft: state.draft,
          missingRequired: computeMissingRequired(state.draft, state.mode),
          notification_event: toStateEvent(action_summary)
        };
      }

      default:
        return { ok: false, mutated: false, error: "unknown_tool", message: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, mutated: false, error: "exception", message: err?.message || String(err) };
  }
}
