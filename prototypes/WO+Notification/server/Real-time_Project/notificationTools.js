export const notificationTools = [
  {
    type: "function",
    name: "notification_start",
    description: "Start a new maintenance notification draft (server-side).",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["minimal", "full"], description: "Wizard mode." }
      }
    }
  },
  {
    type: "function",
    name: "notification_set_mode",
    description: "Set the notification wizard mode.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["minimal", "full"] }
      },
      required: ["mode"]
    }
  },
  {
    type: "function",
    name: "notification_set_field",
    description: "Set a notification draft field by name.",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: [
            "notificationType",
            "shortText",
            "priority",
            "equipmentID",
            "functionalLocation",
            "plant",
            "reportedBy"
          ]
        },
        value: { type: "string" }
      },
      required: ["field", "value"]
    }
  },
  {
    type: "function",
    name: "notification_clear_field",
    description: "Clear a notification draft field by name.",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: [
            "notificationType",
            "shortText",
            "priority",
            "equipmentID",
            "functionalLocation",
            "plant",
            "reportedBy"
          ]
        }
      },
      required: ["field"]
    }
  },
  {
    type: "function",
    name: "notification_summary",
    description: "Return a concise summary of the current notification draft and missing required fields.",
    parameters: { type: "object", properties: {} }
  },
  {
    type: "function",
    name: "notification_finalize",
    description: "Finalize the notification (create JSON) if required fields are complete.",
    parameters: { type: "object", properties: {} }
  },
  {
    type: "function",
    name: "notification_request_photo_capture",
    description: "Request the mobile app to open the camera now and upload the photo to the current notification draft.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional reason to show in UI." }
      }
    }
  }
];
