// ------------------------------------------------------------
// experimentLogger.ts
// Server-side experiment logging utilities for KPI automation
// ------------------------------------------------------------

import fs from "fs";
import path from "path";

const EXPERIMENT_DIR = path.resolve("experiment");
const LOG_DIR = path.join(EXPERIMENT_DIR, "logs");
const FINAL_STATES_DIR = path.join(EXPERIMENT_DIR, "final-states");

// Keep historical logs intact when a fresh thesis run uses an isolated output
// directory.  With no override, the original paths are preserved.
export const EVENTS_FILE = process.env.EXPERIMENT_EVENTS_FILE
  ? path.resolve(process.env.EXPERIMENT_EVENTS_FILE)
  : path.join(LOG_DIR, "events.jsonl");

const ACTIVE_FINAL_STATES_DIR = process.env.EXPERIMENT_FINAL_STATES_DIR
  ? path.resolve(process.env.EXPERIMENT_FINAL_STATES_DIR)
  : FINAL_STATES_DIR;

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureExperimentStructure() {
  ensureDir(path.join(EXPERIMENT_DIR, "scenarios"));
  ensureDir(LOG_DIR);
  ensureDir(ACTIVE_FINAL_STATES_DIR);
  ensureDir(path.dirname(EVENTS_FILE));
  ensureDir(path.join(EXPERIMENT_DIR, "results"));
  ensureDir(path.join(EXPERIMENT_DIR, "manual-review"));
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeClone<T>(value: T): T | null {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

export function logEvent(event: Record<string, any>) {
  ensureExperimentStructure();

  const entry = {
    timestamp: nowIso(),
    ...event,
  };

  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function hasTrialStarted(trialId: string) {
  if (!trialId || !fs.existsSync(EVENTS_FILE)) return false;

  return fs
    .readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        const event = JSON.parse(line);
        return event.trialId === trialId && event.eventType === "trial_started";
      } catch {
        return false;
      }
    });
}

export function saveFinalState(trialId: string, payload: any) {
  ensureExperimentStructure();

  const safeTrialId = String(trialId || "unknown_trial").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(ACTIVE_FINAL_STATES_DIR, `${safeTrialId}_final.json`);

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}
