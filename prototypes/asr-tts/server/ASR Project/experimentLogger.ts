// ------------------------------------------------------------
// experimentLogger.ts
// Server-side experiment logging utilities for KPI automation
// ------------------------------------------------------------

import fs from "fs";
import path from "path";

const EXPERIMENT_DIR = path.resolve("experiment");
const LOG_DIR = path.join(EXPERIMENT_DIR, "logs");
const FINAL_STATES_DIR = path.join(EXPERIMENT_DIR, "final-states");

export const EVENTS_FILE = path.join(LOG_DIR, "events.jsonl");

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureExperimentStructure() {
  ensureDir(path.join(EXPERIMENT_DIR, "scenarios"));
  ensureDir(LOG_DIR);
  ensureDir(FINAL_STATES_DIR);
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

export function saveFinalState(trialId: string, payload: any) {
  ensureExperimentStructure();

  const safeTrialId = String(trialId || "unknown_trial").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(FINAL_STATES_DIR, `${safeTrialId}_final.json`);

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}