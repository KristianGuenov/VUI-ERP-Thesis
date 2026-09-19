#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) options[key] = true;
    else { options[key] = value; i += 1; }
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
}

function effectiveExperimentId(config, runId = null) {
  const requested = runId || process.env.EXPERIMENT_RUN_ID || null;
  if (!requested) return config.experimentId;
  return `${config.experimentId}_${String(requested).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function expandPlan(config, runId = null) {
  const trials = [];
  const experimentId = effectiveExperimentId(config, runId);
  const prototypeEntries = Object.entries(config.prototypes || {});
  for (const [prototype, definition] of prototypeEntries) {
    for (const condition of definition.conditions || []) {
      for (const voice of config.voices || []) {
        for (const repetition of config.repetitions || []) {
          for (const scenarioId of config.scenarioOrder || []) {
            const scenario = config.scenarios?.[scenarioId] || {};
            const environment = condition.environment;
            trials.push({
              trialId: `${experimentId}_${condition.condition}_${voice.id}_${scenarioId}_R${repetition}`,
              experimentId,
              condition: condition.condition,
              prototype,
              environment,
              scenarioId,
              repetition,
              stimulusVoice: voice.id,
              stimulusFile: voice.files[scenarioId],
              confirmationStimulusFile: scenario.requiresConfirmation ? voice.files.confirmation : null,
              noiseSource: environment === "industrial_noise" ? config.noise.sourceUrl : null,
              noiseLevelDb: environment === "industrial_noise" ? config.noise.levelDb : null,
              runSequence: trials.length + 1
            });
          }
        }
      }
    }
  }
  return trials;
}

function terminalTrialIds(experimentRoot) {
  const eventsPath = path.join(path.resolve(experimentRoot), "logs", "events.jsonl");
  if (!fs.existsSync(eventsPath)) return new Set();
  const terminal = new Set(["trial_completed", "trial_failed"]);
  const ids = new Set();
  for (const line of fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (terminal.has(event.eventType)) ids.add(event.trialId);
    } catch {
      // Leave malformed historical lines for the validator; do not block a run.
    }
  }
  return ids;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const configPath = path.resolve(required(options, "config"));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const prototype = required(options, "prototype");
  const runId = options["run-id"] || null;
  const completedIds = terminalTrialIds(required(options, "experiment-root"));
  const selected = expandPlan(config, runId).filter((trial) =>
    trial.prototype === prototype &&
    (!options.condition || trial.condition === options.condition) &&
    !completedIds.has(trial.trialId) &&
    !(options["skip-trial-id"] || "").split(",").filter(Boolean).includes(trial.trialId)
  );
  const startIndex = Number(options["start-index"] || 0);
  const trials = selected.slice(startIndex);
  if (!trials.length) throw new Error("No trials match the requested prototype/condition");

  const shared = [
    "shared/scripts/runTrial.mjs", "run",
    "--config", required(options, "config"),
    "--server", required(options, "server"),
    "--stimulus-root", required(options, "stimulus-root"),
    "--experiment-root", required(options, "experiment-root"),
    "--prototype", prototype,
    "--timeout-ms", String(options["timeout-ms"] || 90000)
  ];
  if (options.device) shared.push("--device", options.device);
  if (options["restart-app"]) shared.push("--restart-app");
  if (options["app-ready-delay-ms"] !== undefined) {
    shared.push("--app-ready-delay-ms", String(options["app-ready-delay-ms"]));
  }
  if (options.bundle) shared.push("--bundle", options.bundle);
  if (options.scheme) shared.push("--scheme", options.scheme);
  if (runId) shared.push("--run-id", runId);
  if (options["confirmation-delay-ms"] !== undefined) {
    shared.push("--confirmation-delay-ms", String(options["confirmation-delay-ms"]));
  }
  if (options["system-output-volume-percent"] !== undefined) {
    shared.push("--system-output-volume-percent", String(options["system-output-volume-percent"]));
  }

  console.log(JSON.stringify({
    prototype,
    condition: options.condition || null,
    count: trials.length,
    startIndex,
    trialIds: trials.map((trial) => trial.trialId)
  }, null, 2));

  const failures = [];
  for (const trial of trials) {
    console.log(`Starting ${trial.trialId}`);
    const args = [...shared, "--trial-id", trial.trialId];
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (result.status !== 0) {
      failures.push(trial.trialId);
      console.error(`Recorded failed trial and continuing once: ${trial.trialId}`);
      continue;
    }
    console.log(`Completed ${trial.trialId}`);
  }

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, completed: trials.length, failures: [] }, null, 2));
  }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
