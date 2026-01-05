import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import QRCode from "qrcode";

export class NotificationQRCodeGenerator {
  /**
   * Your file format:
   * { "Notification": { ... } }
   */
  static buildPayloadFromNotificationWrapper(input) {
    if (!input || typeof input !== "object") {
      throw new Error("Invalid input JSON: not an object");
    }

    const n = input.Notification;
    if (!n || typeof n !== "object") {
      throw new Error('Invalid input JSON: missing top-level key "Notification"');
    }

    // Compact, scan-friendly payload (do NOT include attachments)
    return {
      schema: "sap.pm.qr.v1",
      asset: {
        equipment_id: String(n.equipment_id ?? "").trim(),
        functional_location: String(n.functional_location ?? "").trim(),
        plant: String(n.plant ?? "").trim(),
      },
      defaults: {
        notification_type: String(n.notification_type ?? "").trim(),
        priority: String(n.priority ?? "").trim(),
      },
      ref: {
        notification_id: String(n.notification_id ?? "").trim(),
        created_at: String(n.created_at ?? "").trim(),
      },
    };
  }

  static encodePayload(payload) {
    // Stable ordering + minified JSON to keep QR small
    const ordered = {
      schema: payload.schema,
      asset: payload.asset,
      defaults: payload.defaults,
      ref: payload.ref,
    };
    return JSON.stringify(ordered);
  }

  static async generatePNG({ payload, outFile, errorCorrectionLevel = "M", margin = 2, scale = 8 }) {
    const text = this.encodePayload(payload);

    await fs.mkdir(path.dirname(outFile), { recursive: true });

    await QRCode.toFile(outFile, text, {
      type: "png",
      errorCorrectionLevel, // L/M/Q/H
      margin,
      scale,
    });

    return { outFile, text };
  }
}

// -----------------------
// CLI
// -----------------------
async function resolveInputPath(p) {
  if (fsSync.existsSync(p)) return p;
  if (!p.toLowerCase().endsWith(".json")) {
    const withJson = `${p}.json`;
    if (fsSync.existsSync(withJson)) return withJson;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inPathArg, outPngPath] = process.argv;

  if (!inPathArg || !outPngPath) {
    console.log("Usage: node NotificationQRCodeGenerator.js <finalizeNotification.json> <out.png>");
    console.log("Example: node NotificationQRCodeGenerator.js ./notifications/finalizeNotification.json ./out/asset_qr.png");
    process.exit(1);
  }

  console.log(`CWD: ${process.cwd()}`);

  const resolved = await resolveInputPath(inPathArg);
  if (!resolved) {
    console.error(`Input file not found: ${inPathArg}`);
    process.exit(1);
  }

  const raw = await fs.readFile(resolved, "utf8");
  const input = JSON.parse(raw);

  const payload = NotificationQRCodeGenerator.buildPayloadFromNotificationWrapper(input);

  const { outFile, text } = await NotificationQRCodeGenerator.generatePNG({
    payload,
    outFile: outPngPath,
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8,
  });

  console.log(`Wrote: ${outFile}`);
  console.log(`QR payload (minified JSON): ${text}`);
}
