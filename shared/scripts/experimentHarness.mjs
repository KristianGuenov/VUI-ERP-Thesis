#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }

  return { command, options };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveConfig(options) {
  if (!options.config) throw new Error("Missing --config <path>");
  return path.resolve(options.config);
}

function expandPlan(config) {
  const trials = [];
  let runSequence = 0;

  for (const prototype of config.prototypeOrder) {
    const prototypeConfig = config.prototypes[prototype];
    if (!prototypeConfig) throw new Error(`Unknown prototype in prototypeOrder: ${prototype}`);

    for (const condition of prototypeConfig.conditions) {
      for (const voice of config.voices) {
        for (const scenarioId of config.scenarioOrder) {
          const scenario = config.scenarios[scenarioId];
          if (!scenario) throw new Error(`Missing scenario configuration: ${scenarioId}`);

          for (const repetition of config.repetitions) {
            runSequence += 1;
            const noisy = condition.environment === "industrial_noise";

            trials.push({
              trialId: `${config.experimentId}_${condition.condition}_${voice.id}_${scenarioId}_R${repetition}`,
              experimentId: config.experimentId,
              condition: condition.condition,
              prototype,
              environment: condition.environment,
              scenarioId,
              repetition,
              stimulusVoice: voice.id,
              stimulusFile: voice.files[scenarioId],
              confirmationStimulusFile: scenario.requiresConfirmation
                ? voice.files.confirmation
                : null,
              noiseSource: noisy ? config.noise.sourceUrl : null,
              noiseLevelDb: noisy ? config.noise.levelDb : null,
              runSequence
            });
          }
        }
      }
    }
  }

  const ids = new Set(trials.map((trial) => trial.trialId));
  if (ids.size !== trials.length) throw new Error("Experiment plan contains duplicate trial IDs");

  return trials;
}

function assertPlanShape(config, trials) {
  const expected = config.prototypeOrder.reduce(
    (total, prototype) =>
      total +
      config.prototypes[prototype].conditions.length *
        config.voices.length *
        config.scenarioOrder.length *
        config.repetitions.length,
    0
  );

  if (trials.length !== expected) {
    throw new Error(`Expected ${expected} trials but expanded ${trials.length}`);
  }

  const perPrototype = new Map();
  for (const trial of trials) {
    perPrototype.set(trial.prototype, (perPrototype.get(trial.prototype) ?? 0) + 1);
  }

  for (const prototype of config.prototypeOrder) {
    if (perPrototype.get(prototype) !== 72) {
      throw new Error(`Expected 72 ${prototype} trials but found ${perPrototype.get(prototype) ?? 0}`);
    }
  }
}

function describeAsset(filePath, kind, relativeFile = null) {
  const contents = fs.readFileSync(filePath);
  return {
    kind,
    relativeFile,
    absoluteFile: filePath,
    bytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

function commandAvailable(command) {
  return spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" }).status === 0;
}

function preflight(config, trials, options) {
  const errors = [];
  const assets = [];
  const stimulusRoot = options["stimulus-root"]
    ? path.resolve(options["stimulus-root"])
    : null;

  if (!stimulusRoot) {
    errors.push("Missing --stimulus-root <directory>");
  } else {
    const files = new Set();
    for (const trial of trials) {
      files.add(trial.stimulusFile);
      if (trial.confirmationStimulusFile) files.add(trial.confirmationStimulusFile);
    }

    for (const relativeFile of files) {
      const absoluteFile = path.join(stimulusRoot, relativeFile);
      if (!fs.existsSync(absoluteFile)) {
        errors.push(`Missing stimulus: ${absoluteFile}`);
      } else {
        assets.push(describeAsset(absoluteFile, "stimulus", relativeFile));
      }
    }
  }

  const noiseFile = options["noise-file"] || config.noise.localFile;
  if (!noiseFile) {
    errors.push("Industrial-noise local file is not configured; pass --noise-file or set noise.localFile");
  } else if (!fs.existsSync(path.resolve(noiseFile))) {
    errors.push(`Missing industrial-noise file: ${path.resolve(noiseFile)}`);
  } else {
    const noiseAsset = describeAsset(path.resolve(noiseFile), "industrial_noise");
    assets.push(noiseAsset);
    if (config.noise.sha256 && noiseAsset.sha256 !== config.noise.sha256) {
      errors.push(
        `Industrial-noise SHA-256 mismatch: expected ${config.noise.sha256}, found ${noiseAsset.sha256}`
      );
    }
  }

  if (typeof config.noise.levelDb !== "number" || !Number.isFinite(config.noise.levelDb)) {
    errors.push("noise.levelDb must be a finite number fixed before the pilot");
  }

  if (typeof config.noise.playbackVolume !== "number" ||
      config.noise.playbackVolume <= 0 || config.noise.playbackVolume > 1) {
    errors.push("noise.playbackVolume must be greater than 0 and no more than 1");
  } else {
    const calculatedDb = 20 * Math.log10(config.noise.playbackVolume);
    if (Math.abs(calculatedDb - config.noise.levelDb) > 0.01) {
      errors.push(
        `noise.levelDb (${config.noise.levelDb}) does not match playbackVolume (${calculatedDb.toFixed(3)} dB)`
      );
    }
  }

  if (!Number.isInteger(config.noise.systemOutputVolumePercent) ||
      config.noise.systemOutputVolumePercent < 0 ||
      config.noise.systemOutputVolumePercent > 100) {
    errors.push("noise.systemOutputVolumePercent must be an integer from 0 to 100");
  }

  if (!config.noise.outputDevice) errors.push("noise.outputDevice must be configured");
  if (!Number.isFinite(config.noise.deviceDistanceCm) || config.noise.deviceDistanceCm <= 0) {
    errors.push("noise.deviceDistanceCm must be a positive number");
  }

  for (const command of ["swift", "SwitchAudioSource", "osascript"]) {
    if (!commandAvailable(command)) errors.push(`Required noise-playback command is unavailable: ${command}`);
  }

  if (commandAvailable("SwitchAudioSource") && config.noise.outputDevice) {
    const outputDevices = spawnSync("SwitchAudioSource", ["-a", "-t", "output"], {
      encoding: "utf8"
    });
    const available = outputDevices.status === 0
      ? outputDevices.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];
    if (!available.includes(config.noise.outputDevice)) {
      errors.push(`Configured output device is unavailable: ${config.noise.outputDevice}`);
    }
  }

  return { errors, assets };
}

async function postJson(server, route, body = {}) {
  const response = await fetch(`${server.replace(/\/$/, "")}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${text}`);
  return payload;
}

async function getJson(server, route) {
  const response = await fetch(`${server.replace(/\/$/, "")}${route}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

function trialById(trials, trialId) {
  const trial = trials.find((item) => item.trialId === trialId);
  if (!trial) throw new Error(`Trial not found in plan: ${trialId}`);
  return trial;
}

function validateRun(config, trials, options) {
  if (!options.prototype) throw new Error("Missing --prototype realtime|asr_tts");
  if (!options["experiment-root"]) throw new Error("Missing --experiment-root <directory>");

  const expected = trials.filter((trial) => trial.prototype === options.prototype);
  const root = path.resolve(options["experiment-root"]);
  const eventsPath = path.join(root, "logs", "events.jsonl");
  const finalStatesDir = path.join(root, "final-states");
  const events = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const byTrial = new Map();

  for (const event of events) {
    if (!event.trialId) continue;
    if (!byTrial.has(event.trialId)) byTrial.set(event.trialId, []);
    byTrial.get(event.trialId).push(event);
  }

  const issues = [];
  const warnings = [];
  let complete = 0;
  let failed = 0;

  for (const trial of expected) {
    const trialEvents = byTrial.get(trial.trialId) ?? [];
    const count = (type) => trialEvents.filter((event) => event.eventType === type).length;
    const starts = count("trial_started");
    const completed = count("trial_completed");
    const failures = count("trial_failed");
    const terminal = completed + failures;

    if (starts !== 1) issues.push(`${trial.trialId}: expected one trial_started, found ${starts}`);
    if (terminal !== 1) issues.push(`${trial.trialId}: expected one terminal event, found ${terminal}`);
    const audioStarts = count("audio_first_packet_received");
    const finalAcknowledgements = count("final_acknowledgement_completed");
    const timingTarget = failures === 1 ? warnings : issues;
    if (audioStarts !== 1) {
      timingTarget.push(`${trial.trialId}: expected one audio_first_packet_received, found ${audioStarts}`);
    }
    if (finalAcknowledgements < 1) {
      timingTarget.push(`${trial.trialId}: missing final_acknowledgement_completed`);
    }

    const scenario = config.scenarios[trial.scenarioId];
    if (scenario.requiresConfirmation) {
      const prompted = trialEvents.find((event) => event.eventType === "confirmation_prompted");
      const received = trialEvents.find((event) => event.eventType === "confirmation_received");
      const executed = trialEvents.find((event) => event.eventType === "operation_executed");
      if (!prompted || !received || !executed) {
        const confirmationTarget = failures === 1 ? warnings : issues;
        confirmationTarget.push(`${trial.trialId}: incomplete confirmation/execution sequence`);
      } else if (!(prompted.timestamp <= received.timestamp && received.timestamp <= executed.timestamp)) {
        issues.push(`${trial.trialId}: confirmation events are out of order`);
      }
    }

    const finalState = path.join(finalStatesDir, `${trial.trialId}_final.json`);
    if (terminal === 1 && !fs.existsSync(finalState)) {
      issues.push(`${trial.trialId}: terminal event exists but final state is missing`);
    }

    if (completed === 1) complete += 1;
    if (failures === 1) failed += 1;
  }

  const expectedIds = new Set(expected.map((trial) => trial.trialId));
  const unexpected = [...byTrial.keys()].filter((trialId) =>
    trialId.startsWith(`${config.experimentId}_`) && !expectedIds.has(trialId)
  );
  for (const trialId of unexpected) issues.push(`Unexpected trial ID: ${trialId}`);

  return {
    experimentId: config.experimentId,
    prototype: options.prototype,
    expectedTrials: expected.length,
    completedTrials: complete,
    failedTrials: failed,
    issueCount: issues.length,
    warningCount: warnings.length,
    issues,
    warnings
  };
}

function usage() {
  return `Usage:
  node experimentHarness.mjs plan --config <file> [--out <file>]
  node experimentHarness.mjs preflight --config <file> --stimulus-root <dir> [--noise-file <file>] [--report <file>]
  node experimentHarness.mjs start --config <file> --trial-id <id> --server <url>
  node experimentHarness.mjs end --server <url>
  node experimentHarness.mjs fail --server <url> [--failure-type <type>] [--reason <text>]
  node experimentHarness.mjs status --server <url>
  node experimentHarness.mjs validate --config <file> --prototype <name> --experiment-root <dir>`;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
    return;
  }

  if (["end", "fail", "status"].includes(command)) {
    if (!options.server) throw new Error("Missing --server <url>");
    if (command === "status") {
      console.log(JSON.stringify(await getJson(options.server, "/experiment/current-trial"), null, 2));
      return;
    }
    if (command === "end") {
      console.log(JSON.stringify(await postJson(options.server, "/experiment/end-trial"), null, 2));
      return;
    }
    console.log(JSON.stringify(await postJson(options.server, "/experiment/fail-trial", {
      failureType: options["failure-type"] || "manual_failure",
      reason: options.reason || "Trial marked as failed by experiment harness"
    }), null, 2));
    return;
  }

  const configPath = resolveConfig(options);
  const config = readJson(configPath);
  const trials = expandPlan(config);
  assertPlanShape(config, trials);

  if (command === "plan") {
    const payload = JSON.stringify({ experimentId: config.experimentId, trials }, null, 2) + "\n";
    if (options.out) {
      fs.writeFileSync(path.resolve(options.out), payload, "utf8");
      console.log(`Wrote ${trials.length} trials to ${path.resolve(options.out)}`);
    } else {
      process.stdout.write(payload);
    }
    return;
  }

  if (command === "preflight") {
    const { errors, assets } = preflight(config, trials, options);
    const report = {
      experimentId: config.experimentId,
      expectedTrials: trials.length,
      ready: errors.length === 0,
      generatedAt: new Date().toISOString(),
      noiseLevelDb: config.noise.levelDb,
      noise: config.noise,
      assets,
      errors
    };
    if (options.report) {
      fs.writeFileSync(path.resolve(options.report), JSON.stringify(report, null, 2) + "\n", "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    if (errors.length) process.exitCode = 1;
    return;
  }

  if (command === "start") {
    if (!options.server) throw new Error("Missing --server <url>");
    if (!options["trial-id"]) throw new Error("Missing --trial-id <id>");
    const trial = trialById(trials, options["trial-id"]);
    if (trial.environment === "industrial_noise" &&
        (typeof trial.noiseLevelDb !== "number" || !Number.isFinite(trial.noiseLevelDb))) {
      throw new Error("Refusing to start noisy trial before noise.levelDb is fixed in the plan");
    }
    console.log(JSON.stringify(await postJson(options.server, "/experiment/start-trial", trial), null, 2));
    return;
  }

  if (command === "validate") {
    const result = validateRun(config, trials, options);
    console.log(JSON.stringify(result, null, 2));
    if (result.issueCount) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
