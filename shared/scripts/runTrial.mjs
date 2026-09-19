#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) options[key] = true;
    else { options[key] = value; i += 1; }
  }
  return { command, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
}

function runHarness(command, options, extra = {}) {
  const args = ["shared/scripts/experimentHarness.mjs", command,
    "--config", required(options, "config"),
    "--server", required(options, "server")];
  if (options["trial-id"]) args.push("--trial-id", options["trial-id"]);
  if (options["rerun-of"]) args.push("--rerun-of", options["rerun-of"]);
  if (options["run-id"]) args.push("--run-id", options["run-id"]);
  if (command === "play-command" || command === "play-confirmation") {
    args.push("--stimulus-root", required(options, "stimulus-root"));
    if (options["system-output-volume-percent"] !== undefined) {
      args.push("--system-output-volume-percent", String(options["system-output-volume-percent"]));
    }
  }
  if (command === "fail") {
    args.push("--failure-type", extra.failureType || "runner_failure");
    args.push("--reason", extra.reason || "Trial runner aborted the trial");
  }
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Harness ${command} failed with status ${result.status}`);
}

function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getClientStatus(server) {
  try {
    const response = await fetch(`${server.replace(/\/$/, "")}/experiment/client-status`);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.status ?? null;
  } catch {
    return null;
  }
}

async function waitForPromptPlaybackToFinish(server, timeoutMs, fallbackDelayMs) {
  const startedAt = Date.now();
  let sawActive = false;
  while (Date.now() - startedAt < Math.min(timeoutMs, 20000)) {
    const status = await getClientStatus(server);
    if (status?.audioPlaybackActive === true) sawActive = true;
    if (sawActive && status?.audioPlaybackActive === false) return;
    if (!sawActive && Date.now() - startedAt >= fallbackDelayMs) return;
    await sleep(250);
  }
}

async function waitForEvent(eventsPath, trialId, eventType, timeoutMs, afterTimestamp = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = readEvents(eventsPath).find(
      (event) => event.trialId === trialId &&
        event.eventType === eventType &&
        (!afterTimestamp || event.timestamp > afterTimestamp)
    );
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${eventType} for ${trialId}`);
}

function deviceCommand(options, action) {
  const device = required(options, "device");
  const bundle = options.bundle || "-bm.ResearchProject2025";
  const scheme = options.scheme || "vui-asr";
  const result = spawnSync("xcrun", [
    "devicectl", "device", "process", "launch", "--device", device,
    bundle, "--payload-url", `${scheme}://${action}`, "--no-activate"
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Device ${action} command failed with status ${result.status}`);
}

function launchRealtimeApp(options) {
  const device = required(options, "device");
  const bundle = options["realtime-bundle"] || "UTwente.RealTimeProject";
  const result = spawnSync("xcrun", [
    "devicectl", "device", "process", "launch", "--device", device,
    "--terminate-existing", "--activate", bundle
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Realtime app launch failed with status ${result.status}`);
}

function usage() {
  return `Usage:\n  node shared/scripts/runTrial.mjs run --config <file> [--run-id <id>] --trial-id <id> [--rerun-of <id>] --server <url> --stimulus-root <dir> --experiment-root <dir> [--prototype realtime|asr_tts] [--device <udid>] [--restart-app] [--app-ready-delay-ms <ms>] [--confirmation-delay-ms <ms>] [--system-output-volume-percent <0-100>]`;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command !== "run") { console.log(usage()); return; }

  const trialId = required(options, "trial-id");
  const experimentRoot = path.resolve(required(options, "experiment-root"));
  const eventsPath = path.join(experimentRoot, "logs", "events.jsonl");
  const timeoutMs = Number(options["timeout-ms"] || 90000);
  const prototype = options.prototype || "realtime";
  const isAsr = prototype === "asr_tts";

  try {
    if (!isAsr && options["restart-app"]) {
      launchRealtimeApp(options);
      await sleep(Number(options["app-ready-delay-ms"] || 3500));
    }
    if (isAsr) deviceCommand(options, "start");
    runHarness("start", options);
    runHarness("play-command", options);

    if (isAsr) deviceCommand(options, "stop");
    await waitForEvent(eventsPath, trialId, "audio_first_packet_received", timeoutMs);

    const config = JSON.parse(fs.readFileSync(path.resolve(options.config), "utf8"));
    const scenarioId = trialId.match(/_(S\d+)_R\d+(?:_RERUN\d+)?$/)?.[1];
    const requiresConfirmation = Boolean(config.scenarios?.[scenarioId]?.requiresConfirmation);

    if (requiresConfirmation) {
      const promptEvent = await waitForEvent(eventsPath, trialId, "confirmation_prompted", timeoutMs);
      // The server records confirmation_prompted when the response is complete,
      // while the client may still be playing that response over the phone
      // speaker.  Leave a guard interval so the confirmation recording cannot
      // acoustically overlap the prompt.  ASR/TTS has a shorter local prompt;
      // the realtime client uses a conservative default for network/audio
      // buffering.  The value is overridable for a documented calibration.
      // ASR/TTS reports playback asynchronously from AVPlayer.  Give the
      // client time to publish audioPlaybackActive=true before accepting the
      // confirmation recording; otherwise the recording can start while the
      // spoken prompt is still playing.
      const defaultConfirmationDelayMs = isAsr ? 5000 : 5000;
      const confirmationDelayMs = Number(options["confirmation-delay-ms"] || defaultConfirmationDelayMs);
      if (!Number.isFinite(confirmationDelayMs) || confirmationDelayMs < 0) {
        throw new Error(`Invalid --confirmation-delay-ms: ${options["confirmation-delay-ms"]}`);
      }
      await waitForPromptPlaybackToFinish(options.server, timeoutMs, confirmationDelayMs);
      if (isAsr) deviceCommand(options, "start");
      runHarness("play-confirmation", options);
      if (isAsr) deviceCommand(options, "stop");

      // A model may emit an informational response (and even a final ack)
      // before it has produced the confirmation prompt.  Only a confirmation
      // received after this prompt can advance a counted trial.
      const confirmationEvent = await waitForEvent(
        eventsPath,
        trialId,
        "confirmation_received",
        timeoutMs,
        promptEvent.timestamp
      );
      await waitForEvent(
        eventsPath,
        trialId,
        "final_acknowledgement_completed",
        timeoutMs,
        confirmationEvent.timestamp
      );
    } else {
      await waitForEvent(eventsPath, trialId, "final_acknowledgement_completed", timeoutMs);
    }
    runHarness("end", options);
    console.log(JSON.stringify({ ok: true, trialId, requiresConfirmation }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    try {
      runHarness("fail", options, {
        failureType: "runner_timeout",
        reason: error instanceof Error ? error.message : String(error)
      });
    } catch (failError) {
      console.error(`Could not mark trial failed: ${failError instanceof Error ? failError.message : String(failError)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
