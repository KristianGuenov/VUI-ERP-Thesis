// ------------------------------------------------------------
// workOrderTools.js
// Tools (functions) for OpenAI Realtime "tools" API
// ------------------------------------------------------------

export const workOrderTools = [
  // ------------------------------------------------------------
  // SESSION TERMINATION
  // ------------------------------------------------------------
  {
    type: "function",
    name: "end_task_session",
    description:
      "Soft termination: end the current task/conversation and put the assistant into idle mode (wake word to resume).",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for ending the task session."
        }
      },
      required: []
    }
  },
  {
    type: "function",
    name: "end_assistant_session",
    description:
      "Hard termination: end the assistant session completely (stop listening / end the session).",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for ending the assistant session."
        }
      },
      required: []
    }
  },

  // ------------------------------------------------------------
  // WORK ORDER ACTIONS
  // ------------------------------------------------------------
  {
    type: "function",
    name: "start_work_order",
    description: "Mark a work order as in process (and set it as the current context).",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" }
      },
      required: ["order_id"]
    }
  },
  {
    type: "function",
    name: "pause_work_order",
    description: "Pause work on a work order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" }
      },
      required: ["order_id"]
    }
  },
  {
    type: "function",
    name: "update_description",
    description: "Update the header description of the work order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        description: { type: "string" }
      },
      required: ["order_id", "description"]
    }
  },

  // ------------------------------------------------------------
  // TIME REPORTING
  // ------------------------------------------------------------
  {
    type: "function",
    name: "report_time",
    description:
      "Report minutes worked for a specific operation in the work order. Sensitive action: requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        operation_id: { type: "string" },
        minutes: { type: "number" }
      },
      required: ["order_id", "operation_id", "minutes"]
    }
  },
  {
    type: "function",
    name: "add_time_to_work_order",
    description:
      "Add minutes at work-order level, not a specific operation. If order_id is omitted, uses the current work order. Sensitive action: requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number" },
        order_id: {
          type: "string",
          description: "Optional. If omitted, applies to the current work order."
        }
      },
      required: ["minutes"]
    }
  },

  // ------------------------------------------------------------
  // OPERATIONS
  // ------------------------------------------------------------
  {
    type: "function",
    name: "start_operation",
    description: "Start a specific operation within a work order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        operation_id: { type: "string" }
      },
      required: ["order_id", "operation_id"]
    }
  },
  {
    type: "function",
    name: "close_operation",
    description:
      "Close a specific operation within a work order. Sensitive action: requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        operation_id: { type: "string" }
      },
      required: ["order_id", "operation_id"]
    }
  },

  // ------------------------------------------------------------
  // COMPLETION / CLOSING
  // ------------------------------------------------------------
  {
    type: "function",
    name: "validate_complete_work_order",
    description: "Check if all operations are completed before completing the work order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" }
      },
      required: ["order_id"]
    }
  },
  {
    type: "function",
    name: "complete_work_order",
    description:
      "Complete/close a work order. If force=true, open operations are auto-completed. Sensitive action: requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        force: { type: "boolean" }
      },
      required: ["order_id", "force"]
    }
  },

  // ------------------------------------------------------------
  // ATTRIBUTES / ASSIGNMENT
  // ------------------------------------------------------------
  {
    type: "function",
    name: "set_due_date",
    description: "Set or update the due date of a work order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        due_date: {
          type: "string",
          description: "ISO 8601 date-time string, e.g. 2025-11-30T12:00:00Z"
        }
      },
      required: ["order_id", "due_date"]
    }
  },
  {
    type: "function",
    name: "assign_work_order",
    description: "Assign a work order to a technician.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        technician_id: { type: "string" }
      },
      required: ["order_id", "technician_id"]
    }
  },

  // ------------------------------------------------------------
  // TASK NAVIGATION
  // ------------------------------------------------------------
  {
    type: "function",
    name: "get_next_task",
    description:
      "Get the next work order for a technician. If technician_id is omitted, uses current technician.",
    parameters: {
      type: "object",
      properties: {
        technician_id: { type: "string" }
      },
      required: []
    }
  },

  // ------------------------------------------------------------
  // READS
  // ------------------------------------------------------------
  {
    type: "function",
    name: "get_work_order_status",
    description: "Return a summary of the work order status.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" }
      },
      required: ["order_id"]
    }
  },
  {
    type: "function",
    name: "get_work_order_details",
    description: "Return the full work order JSON.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" }
      },
      required: ["order_id"]
    }
  }
];