// ------------------------------------------------------------
// executeWorkOrderFunction.js
// ------------------------------------------------------------

import {
  getWorkOrder,
  listWorkOrdersForTechnician
} from "./workOrders.js";

// Simple in-memory conversation context (single-tech prototype)
let currentTechnicianId = "TECH001"; // TODO: later pass real user id from client
let currentWorkOrderId = null;

// Utility to update last_changed timestamp
function updateTimestamp(header) {
  header.last_changed = new Date().toISOString();
}

function debug(...args) {
  console.log("=== [DEBUG]", ...args);
}

function setCurrentWorkOrder(orderId) {
  currentWorkOrderId = orderId;
}

/**
 * Standardized responses so the assistant can reliably:
 * - Detect whether a mutation occurred
 * - Start every mutation reply with "I confirm I have ..."
 */
function mutationResponse({ action_summary, payload }) {
  return {
    ok: true,
    mutated: true,
    action_summary, // must start with "I confirm I have ..."
    ...payload
  };
}

function readResponse(payload) {
  return {
    ok: true,
    mutated: false,
    ...payload
  };
}

/**
 * Control events are interpreted by index.js and sent to the client as:
 * { type: "session.control", mode: "soft_end" | "hard_end", reason: "..." }
 */
function controlResponse({ mode, reason, last_order_id }) {
  return {
    ok: true,
    mutated: false,
    control_event: { mode, reason, last_order_id }
  };
}

// Keep totals consistent by recomputing from operations + order-level confirmations if needed.
// In your prototype: Totals.total_actual_time_minutes is used as order-level accumulator.
// For operation-level reporting, recompute from operations to avoid drift.
function recomputeActualTotals(wo) {
  const opsTotal = (wo.Operations || []).reduce(
    (sum, o) => sum + (Number(o.actual_duration_minutes) || 0),
    0
  );

  // Keep order-level total as opsTotal PLUS any ORDER-level confirmations (if you want both).
  // Your current design adds "add_time_to_work_order" to Totals directly and creates confirmations.
  // To preserve that, we compute ORDER-level minutes separately and add.
  const orderLevelMinutes = (wo.TimeConfirmations || [])
    .filter((c) => c?.level === "ORDER")
    .reduce((sum, c) => sum + (Number(c.duration_minutes) || 0), 0);

  if (!wo.Totals) {
    wo.Totals = { total_planned_time_minutes: 0, total_actual_time_minutes: 0 };
  }

  wo.Totals.total_actual_time_minutes = opsTotal + orderLevelMinutes;
}

export async function executeWorkOrderFunction(name, args) {
  debug(`Function called → ${name}`);
  debug("Args:", args);

  switch (name) {
    /* -------------------------------------------------------- */
    /* START WORK ORDER                                          */
    /* -------------------------------------------------------- */
    case "start_work_order": {
      const { order_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      wo.OrderHeader.status.user_status = ["IN_PROCESS"];

      // Default assignee if missing
      if (!wo.OrderHeader.assigned_to) {
        wo.OrderHeader.assigned_to = currentTechnicianId;
      }

      // Set as current context
      setCurrentWorkOrder(order_id);
      updateTimestamp(wo.OrderHeader);

      return mutationResponse({
        action_summary: `I confirm I have started work order ${order_id}.`,
        payload: {
          type: "WORK_ORDER_STARTED",
          order_id,
          user_status: wo.OrderHeader.status.user_status,
          assigned_to: wo.OrderHeader.assigned_to
        }
      });
    }

    /* -------------------------------------------------------- */
    /* PAUSE WORK ORDER                                          */
    /* -------------------------------------------------------- */
    case "pause_work_order": {
      const { order_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      wo.OrderHeader.status.user_status = ["PAUSED"];
      updateTimestamp(wo.OrderHeader);

      // Keep context
      setCurrentWorkOrder(order_id);

      return mutationResponse({
        action_summary: `I confirm I have paused work order ${order_id}.`,
        payload: {
          type: "WORK_ORDER_PAUSED",
          order_id,
          user_status: wo.OrderHeader.status.user_status
        }
      });
    }

    /* -------------------------------------------------------- */
    /* UPDATE DESCRIPTION                                        */
    /* -------------------------------------------------------- */
    case "update_description": {
      const { order_id, description } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      wo.OrderHeader.description = description;
      updateTimestamp(wo.OrderHeader);
      setCurrentWorkOrder(order_id);

      return mutationResponse({
        action_summary: `I confirm I have updated the description for work order ${order_id}.`,
        payload: {
          type: "DESCRIPTION_UPDATED",
          order_id,
          description
        }
      });
    }

    /* -------------------------------------------------------- */
    /* REPORT TIME (OPERATION LEVEL)                             */
    /* -------------------------------------------------------- */
    case "report_time": {
      const { order_id, operation_id, minutes } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      const op = wo.Operations.find((o) => o.operation_id === operation_id);
      if (!op) {
        return { ok: false, error: "OPERATION_NOT_FOUND", order_id, operation_id };
      }

      op.actual_duration_minutes = (Number(op.actual_duration_minutes) || 0) + Number(minutes || 0);

      // Recompute totals to avoid drift
      recomputeActualTotals(wo);

      updateTimestamp(wo.OrderHeader);
      setCurrentWorkOrder(order_id);

      return mutationResponse({
        action_summary: `I confirm I have reported ${minutes} minutes on operation ${operation_id} for work order ${order_id}.`,
        payload: {
          type: "TIME_REPORTED_OPERATION",
          order_id,
          operation_id,
          minutes_added: minutes,
          new_operation_actual_minutes: op.actual_duration_minutes,
          new_order_total_minutes: wo.Totals?.total_actual_time_minutes ?? null
        }
      });
    }

    /* -------------------------------------------------------- */
    /* START OPERATION                                           */
    /* -------------------------------------------------------- */
    case "start_operation": {
      const { order_id, operation_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      const op = wo.Operations.find((o) => o.operation_id === operation_id);
      if (!op) return { ok: false, error: "OPERATION_NOT_FOUND", operation_id };

      op.status = "in_progress";
      op.started_at = new Date().toISOString();

      updateTimestamp(wo.OrderHeader);
      setCurrentWorkOrder(order_id);

      return mutationResponse({
        action_summary: `I confirm I have started operation ${operation_id} for work order ${order_id}.`,
        payload: {
          type: "OPERATION_STARTED",
          order_id,
          operation_id,
          status: op.status,
          started_at: op.started_at
        }
      });
    }

    /* -------------------------------------------------------- */
    /* VALIDATE WORK ORDER COMPLETION                            */
    /* -------------------------------------------------------- */
    case "validate_complete_work_order": {
      const { order_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      const openOps = wo.Operations.filter((op) => op.status !== "completed");

      return readResponse({
        type: "WORK_ORDER_VALIDATION",
        order_id,
        open_operations: openOps.map((op) => ({
          operation_id: op.operation_id,
          description: op.description,
          status: op.status
        })),
        can_complete: openOps.length === 0
      });
    }

    /* -------------------------------------------------------- */
    /* COMPLETE WORK ORDER                                       */
    /* -------------------------------------------------------- */
    case "complete_work_order": {
      const { order_id, force } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      const openOps = wo.Operations.filter((op) => op.status !== "completed");

      if (openOps.length > 0 && !force) {
        return {
          ok: false,
          error: "OPEN_OPERATIONS",
          order_id,
          open_operations: openOps.map((op) => ({
            operation_id: op.operation_id,
            description: op.description,
            status: op.status
          }))
        };
      }

      // Auto-complete operations
      if (force) {
        for (const op of openOps) {
          op.status = "completed";
          op.completed_at = new Date().toISOString();
        }
      }

      wo.OrderHeader.status.user_status = ["COMPLETED"];
      updateTimestamp(wo.OrderHeader);

      // Clear current WO context if it was this one
      if (currentWorkOrderId === order_id) {
        setCurrentWorkOrder(null);
      }

      const summary = force
        ? `I confirm I have force-closed work order ${order_id} and completed ${openOps.length} open operation(s).`
        : `I confirm I have closed work order ${order_id}.`;

      return mutationResponse({
        action_summary: summary,
        payload: {
          type: "WORK_ORDER_COMPLETED",
          order_id,
          user_status: wo.OrderHeader.status.user_status,
          forced: Boolean(force),
          auto_completed_operations: force ? openOps.length : 0
        }
      });
    }

    /* -------------------------------------------------------- */
    /* GET WORK ORDER STATUS                                     */
    /* -------------------------------------------------------- */
    case "get_work_order_status": {
      const { order_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      const openOps = wo.Operations.filter((op) => op.status !== "completed");

      return readResponse({
        type: "WORK_ORDER_STATUS",
        order_id,
        description: wo.OrderHeader.description,
        user_status: wo.OrderHeader.status.user_status,
        system_status: wo.OrderHeader.status.system_status,
        operations_open: openOps.length,
        operations_total: wo.Operations.length,
        due_date: wo.OrderHeader.due_date ?? null,
        assigned_to: wo.OrderHeader.assigned_to ?? null
      });
    }

    /* -------------------------------------------------------- */
    /* GET FULL WORK ORDER DETAILS                               */
    /* -------------------------------------------------------- */
    case "get_work_order_details": {
      const { order_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      return readResponse({
        type: "WORK_ORDER_DETAILS",
        order_id,
        description: wo.OrderHeader.description,
        operations: wo.Operations.map((op) => ({
          operation_id: op.operation_id,
          description: op.description,
          status: op.status,
          planned_duration: op.planned_duration_minutes,
          actual_duration: op.actual_duration_minutes
        })),
        raw: wo
      });
    }

    /* -------------------------------------------------------- */
    /* GET NEXT TASK FOR TECHNICIAN                              */
    /* -------------------------------------------------------- */
    case "get_next_task": {
      const technicianId = args.technician_id || currentTechnicianId;

      const candidates = listWorkOrdersForTechnician(technicianId).filter((wo) => {
        const us = wo.OrderHeader.status.user_status?.[0] || "";
        return ["PLANNED", "IN_PROCESS", "PAUSED"].includes(us);
      });

      if (candidates.length === 0) {
        return readResponse({
          type: "NO_NEXT_TASK",
          technician_id: technicianId,
          has_next: false
        });
      }

      // sort by due_date, fallback to created_on
      candidates.sort((a, b) => {
        const da = Date.parse(a.OrderHeader.due_date || a.OrderHeader.created_on || 0);
        const db = Date.parse(b.OrderHeader.due_date || b.OrderHeader.created_on || 0);
        return da - db;
      });

      const next = candidates[0];
      setCurrentWorkOrder(next.OrderHeader.order_id);

      return readResponse({
        type: "NEXT_TASK_FOUND",
        technician_id: technicianId,
        has_next: true,
        order: {
          order_id: next.OrderHeader.order_id,
          description: next.OrderHeader.description,
          user_status: next.OrderHeader.status.user_status,
          system_status: next.OrderHeader.status.system_status,
          due_date: next.OrderHeader.due_date,
          assigned_to: next.OrderHeader.assigned_to,
          total_planned_minutes: next.Totals?.total_planned_time_minutes ?? null,
          total_actual_minutes: next.Totals?.total_actual_time_minutes ?? null
        }
      });
    }

    /* -------------------------------------------------------- */
    /* ADD TIME TO WORK ORDER (ORDER LEVEL)                      */
    /* -------------------------------------------------------- */
    case "add_time_to_work_order": {
      const minutes = Number(args.minutes || 0);
      const orderId = args.order_id || currentWorkOrderId;

      if (orderId == null) {
        return {
          ok: false,
          error: "NO_CURRENT_WORK_ORDER",
          message:
            "No current work order is selected. Provide order_id or start a work order first."
        };
      }

      const wo = getWorkOrder(orderId);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id: orderId };

      if (!wo.Totals) {
        wo.Totals = { total_planned_time_minutes: 0, total_actual_time_minutes: 0 };
      }

      if (!wo.TimeConfirmations) {
        wo.TimeConfirmations = [];
      }

      wo.TimeConfirmations.push({
        confirmation_id: `WO-${Date.now()}`,
        operation_id: null,
        technician_id: currentTechnicianId,
        start_time: null,
        end_time: null,
        duration_minutes: minutes,
        final_confirmation: false,
        level: "ORDER"
      });

      // Recompute totals to include new order-level time
      recomputeActualTotals(wo);

      updateTimestamp(wo.OrderHeader);
      setCurrentWorkOrder(orderId);

      return mutationResponse({
        action_summary: `I confirm I have added ${minutes} minutes to work order ${orderId}.`,
        payload: {
          type: "TIME_REPORTED_ORDER",
          order_id: orderId,
          minutes_added: minutes,
          new_order_total_minutes: wo.Totals.total_actual_time_minutes
        }
      });
    }

    /* -------------------------------------------------------- */
    /* SET DUE DATE                                              */
    /* -------------------------------------------------------- */
    case "set_due_date": {
      const { order_id, due_date } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      wo.OrderHeader.due_date = due_date;
      updateTimestamp(wo.OrderHeader);
      setCurrentWorkOrder(order_id);

      return mutationResponse({
        action_summary: `I confirm I have set the due date for work order ${order_id}.`,
        payload: {
          type: "DUE_DATE_UPDATED",
          order_id,
          due_date
        }
      });
    }

    /* -------------------------------------------------------- */
    /* ASSIGN WORK ORDER                                         */
    /* -------------------------------------------------------- */
    case "assign_work_order": {
      const { order_id, technician_id } = args;
      const wo = getWorkOrder(order_id);
      if (!wo) return { ok: false, error: "WORK_ORDER_NOT_FOUND", order_id };

      wo.OrderHeader.assigned_to = technician_id;
      updateTimestamp(wo.OrderHeader);

      // Update current context as well
      currentTechnicianId = technician_id;
      setCurrentWorkOrder(order_id);

      return mutationResponse({
        action_summary: `I confirm I have assigned work order ${order_id} to technician ${technician_id}.`,
        payload: {
          type: "WORK_ORDER_ASSIGNED",
          order_id,
          assigned_to: technician_id
        }
      });
    }

    /* -------------------------------------------------------- */
    /* SOFT TERMINATION: END TASK SESSION                        */
    /* -------------------------------------------------------- */
    case "end_task_session": {
      const reason = args?.reason || "Task completed";
      const last = currentWorkOrderId;

      setCurrentWorkOrder(null);

      return controlResponse({
        mode: "soft_end",
        reason,
        last_order_id: last
      });
    }

    /* -------------------------------------------------------- */
    /* HARD TERMINATION: END ASSISTANT SESSION                   */
    /* -------------------------------------------------------- */
    case "end_assistant_session": {
      const reason = args?.reason || "Session ended";
      const last = currentWorkOrderId;

      setCurrentWorkOrder(null);

      return controlResponse({
        mode: "hard_end",
        reason,
        last_order_id: last
      });
    }

    /* -------------------------------------------------------- */
    /* UNKNOWN FUNCTION                                          */
    /* -------------------------------------------------------- */
    default:
      return { ok: false, error: "UNKNOWN_FUNCTION", name };
  }
}
