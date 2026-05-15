import express from "express";
import { NotificationConfirmationGate } from "./notificationConfirmations.js";

/**
 * createNotificationConfirmationRouter
 *
 * Args:
 * - notificationStore:
 *    - getDraft()
 *    - normalizeField(field): string
 *    - isAllowedField(field): boolean
 *    - applyField(field,value): void
 *    - clearField(field): void
 *    - finalizeAndPersist(): object (final tool-like result)
 *    - emitState(actionSummary?: string): void (broadcast notification.state)
 * - emit(type,payload): broadcast SSE event
 * - gate (optional): shared NotificationConfirmationGate instance
 */
export function createNotificationConfirmationRouter({ notificationStore, emit, gate = null }) {
  const router = express.Router();

  const sharedGate =
    gate ??
    new NotificationConfirmationGate({
      emit,
      getDraft: () => notificationStore.getDraft(),
      applyField: (field, value) => notificationStore.applyField(field, value),
      clearField: (field) => notificationStore.clearField(field),
      finalize: () => notificationStore.finalizeAndPersist(),
    });

  router.post("/set_field", (req, res) => {
    const { field, value, source = "manual" } = req.body || {};
    const f = notificationStore.normalizeField(field);

    if (!notificationStore.isAllowedField(f)) {
      return res.status(400).json({ ok: false, mutated: false, error: "unsupported_field", field: f });
    }

    const out = sharedGate.proposeField({ field: f, value, source });
    notificationStore.emitState(out.needsConfirmation ? `Confirmation requested for ${f}.` : `Updated: ${f}`);
    res.json(out);
  });

  router.post("/clear_field", (req, res) => {
    const { field, source = "manual" } = req.body || {};
    const f = notificationStore.normalizeField(field);

    if (!notificationStore.isAllowedField(f)) {
      return res.status(400).json({ ok: false, mutated: false, error: "unsupported_field", field: f });
    }

    const out = sharedGate.proposeField({ field: f, value: "", source });
    notificationStore.emitState(`Cleared: ${f}`);
    res.json(out);
  });

  router.post("/set_fields", (req, res) => {
    const { fields = {}, source = "qr" } = req.body || {};
    if (!fields || typeof fields !== "object") {
      return res.status(400).json({ ok: false, mutated: false, error: "bad_fields_object" });
    }

    let needsConfirmation = false;
    const results = [];

    for (const [k, v] of Object.entries(fields)) {
      const f = notificationStore.normalizeField(k);
      if (!notificationStore.isAllowedField(f)) continue;

      const r = sharedGate.proposeField({ field: f, value: v, source });
      results.push({ field: f, ...r });
      if (r.needsConfirmation) needsConfirmation = true;
    }

    notificationStore.emitState(
      needsConfirmation ? "Some fields require confirmation." : `Updated: ${results.map((r) => r.field).join(", ")}`
    );
    res.json({ ok: true, mutated: !needsConfirmation, results });
  });

  router.post("/confirm_field", (req, res) => {
    const { requestId, accept, correctedValue } = req.body || {};
    const out = sharedGate.confirmField({ requestId, accept: !!accept, correctedValue });

    notificationStore.emitState(
      out.ok
        ? out.action === "confirmed_applied"
          ? `Confirmed: ${out.field}`
          : "Field confirmation handled."
        : "Field confirmation failed."
    );

    res.status(out.ok ? 200 : 400).json(out);
  });

  router.post("/finalize_gate", (req, res) => {
    const { source = "ui" } = req.body || {};
    const out = sharedGate.requestFinalize({ source });
    notificationStore.emitState("Finalize confirmation requested.");
    res.json(out);
  });

  router.post("/confirm_finalize", (req, res) => {
    const { requestId, accept } = req.body || {};
    const out = sharedGate.confirmFinalize({ requestId, accept: !!accept });

    // confirmFinalize->finalizeAndPersist() will broadcast notification.created; still update state
    notificationStore.emitState(out.ok ? "Finalization completed." : "Finalization not completed.");
    res.status(out.ok ? 200 : 400).json(out);
  });

  return router;
}
