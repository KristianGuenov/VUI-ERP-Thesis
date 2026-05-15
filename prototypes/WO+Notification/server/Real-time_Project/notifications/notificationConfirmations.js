import crypto from "crypto";

export const CRITICAL_NUMERIC_FIELDS = new Set([
  "equipmentID",
  "functionalLocation",
  "plant",
  "priority",
]);

export function isCriticalField(field) {
  return CRITICAL_NUMERIC_FIELDS.has(field);
}

// Noise-resilient readback (digits spaced)
export function readback(field, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";

  const isDigitHeavy = /^[0-9\-]+$/.test(v);
  if (!isDigitHeavy) return `I heard ${field}: ${v}`;

  const spaced = v.split("").join(" ");
  return `I heard ${field}: ${spaced}. Please confirm.`;
}

export function newRequestId(prefix = "C") {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto
    .randomBytes(2)
    .toString("hex")
    .toUpperCase()}`;
}

export class NotificationConfirmationGate {
  constructor({ emit, getDraft, applyField, clearField, finalize }) {
    this.emit = emit; // (type, payload) => void  (SSE broadcast)
    this.getDraft = getDraft; // () => draft object
    this.applyField = applyField; // (field, value) => void
    this.clearField = clearField; // (field) => void
    this.finalize = finalize; // () => finalize result (persist + emit notification.created)
    this.pending = new Map(); // requestId -> {kind, field, value, source}
  }

  reset() {
    this.pending.clear();
  }

  proposeField({ field, value, source }) {
    const v = String(value ?? "").trim();

    // Manual typing: apply immediately (no gate)
    if (source === "manual") {
      if (!v) this.clearField(field);
      else this.applyField(field, v);
      return { ok: true, mutated: true };
    }

    // QR/Vision: gate only if overwriting a non-empty different value for critical fields
    if ((source === "qr" || source === "vision") && isCriticalField(field)) {
      const cur = String(this.getDraft()?.[field] ?? "").trim();
      if (cur && cur !== v) {
        const requestId = newRequestId("F");
        this.pending.set(requestId, { kind: "field", field, value: v, source });
        this.emit("notification.confirm_field", {
          requestId,
          field,
          proposedValue: v,
          readback: readback(field, v),
          reason: "overwrite",
        });
        return { ok: true, mutated: false, needsConfirmation: true, requestId };
      }
      if (!v) this.clearField(field);
      else this.applyField(field, v);
      return { ok: true, mutated: true };
    }

    // Voice: always gate critical numeric fields
    if (source === "voice" && isCriticalField(field)) {
      const requestId = newRequestId("F");
      this.pending.set(requestId, { kind: "field", field, value: v, source });
      this.emit("notification.confirm_field", {
        requestId,
        field,
        proposedValue: v,
        readback: readback(field, v),
        reason: "critical_numeric",
      });
      return { ok: true, mutated: false, needsConfirmation: true, requestId };
    }

    // Non-critical: apply directly
    if (!v) this.clearField(field);
    else this.applyField(field, v);
    return { ok: true, mutated: true };
  }

  confirmField({ requestId, accept, correctedValue }) {
    const req = this.pending.get(requestId);
    if (!req || req.kind !== "field") return { ok: false, error: "unknown requestId" };

    this.pending.delete(requestId);

    if (!accept) {
      // Reject: clear to force re-entry
      this.clearField(req.field);
      return { ok: true, mutated: true, action: "rejected_cleared" };
    }

    const finalValue = String((correctedValue ?? req.value) ?? "").trim();
    if (!finalValue) {
      this.clearField(req.field);
      return { ok: true, mutated: true, action: "confirmed_cleared" };
    }

    this.applyField(req.field, finalValue);
    return { ok: true, mutated: true, action: "confirmed_applied", field: req.field, value: finalValue };
  }

  // Finalize: always require confirmation (voice OR UI)
  requestFinalize({ source }) {
    const requestId = newRequestId("Z");
    const draft = this.getDraft();
    this.pending.set(requestId, { kind: "finalize", source });

    this.emit("notification.confirm_finalize", {
      requestId,
      reason: "Please review and confirm finalization.",
      missingRequired: draft?.missingRequired ?? [],
      draft,
    });

    return { ok: true, mutated: false, needsConfirmation: true, requestId };
  }

  confirmFinalize({ requestId, accept }) {
    const req = this.pending.get(requestId);
    if (!req || req.kind !== "finalize") return { ok: false, error: "unknown requestId" };

    this.pending.delete(requestId);

    if (!accept) return { ok: true, mutated: false, action: "finalize_cancelled" };

    return this.finalize();
  }
}
