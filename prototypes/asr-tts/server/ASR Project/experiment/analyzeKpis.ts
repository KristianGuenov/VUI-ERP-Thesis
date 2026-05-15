// ------------------------------------------------------------
// experiment/analyzeKpis.ts
// Calculates the six agreed KPI values from server-side logs.
// ------------------------------------------------------------

import fs from "fs";
import path from "path";

const EXPERIMENT_DIR = path.resolve("experiment");
const EVENTS_FILE = path.join(EXPERIMENT_DIR, "logs", "events.jsonl");
const SCENARIOS_FILE = path.join(EXPERIMENT_DIR, "scenarios", "common_scenarios.json");
const FINAL_STATES_DIR = path.join(EXPERIMENT_DIR, "final-states");
const RESULTS_DIR = path.join(EXPERIMENT_DIR, "results");
const MANUAL_REVIEW_FILE = path.join(EXPERIMENT_DIR, "manual-review", "critical-error-review.csv");

const SENSITIVE_TOOLS = new Set([
  "add_time_to_work_order",
  "report_time",
  "close_operation",
  "complete_work_order",
  "end_task_session",
  "end_assistant_session",
]);

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function csvEscape(value: any) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.includes(",") || text.includes("\n") || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath: string, rows: any[], columns: string[]) {
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function groupBy(items: any[], keyFn: (item: any) => string) {
  const map = new Map<string, any[]>();

  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }

  return map;
}

function toMs(timestamp: string) {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function normalizeValue(value: any) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number") return Number(value);
  if (typeof value === "boolean") return Boolean(value);
  return value;
}

function valuesEqual(actual: any, expected: any) {
  if (typeof expected === "number") {
    return Number(actual) === Number(expected);
  }

  return normalizeValue(actual) === normalizeValue(expected);
}

function getPathValue(workOrder: any, fieldPath: string) {
  if (!workOrder || !fieldPath) return undefined;

  if (fieldPath.startsWith("operationsById.")) {
    const parts = fieldPath.split(".");
    const operationId = parts[1];
    const rest = parts.slice(2);
    const operation = (workOrder.operations || []).find((op: any) => op.id === operationId);
    return rest.reduce((current, key) => current?.[key], operation);
  }

  if (fieldPath === "notesContains") {
    return (workOrder.notes || []).map((note: any) => note.text).join(" ");
  }

  return fieldPath.split(".").reduce((current, key) => current?.[key], workOrder);
}

function getFinalState(trialId: string) {
  const filePath = path.join(FINAL_STATES_DIR, `${trialId}_final.json`);
  return readJson(filePath, null);
}

function getCapturedEntitiesFromEvents(events: any[]) {
  const captured: Record<string, any> = {};

  for (const event of events) {
    if (event.eventType !== "operation_executed") continue;

    const args = event.args || {};
    for (const [key, value] of Object.entries(args)) {
      captured[key] = value;
    }
  }

  return captured;
}

function operationMatchesExpected(event: any, expectedOperation: any) {
  if (event.eventType !== "operation_executed") return false;
  if (event.toolName !== expectedOperation.toolName) return false;

  const args = event.args || {};

  for (const [key, expectedValue] of Object.entries(expectedOperation)) {
    if (key === "toolName") continue;
    if (!valuesEqual(args[key], expectedValue)) return false;
  }

  return true;
}

function operationAllowed(event: any, allowedOperations: any[]) {
  return allowedOperations.some((expectedOperation) => operationMatchesExpected(event, expectedOperation));
}

function computeTaskSuccess(scenario: any, finalState: any, failed: boolean) {
  if (failed) return false;
  if (!finalState?.workOrder) return false;

  const checks = scenario.expectedFinalChecks || [];

  return checks.every((check: any) => {
    const actual =
      check.path === "notesContains"
        ? getPathValue(finalState.workOrder, "notesContains")
        : getPathValue(finalState.workOrder, check.path);

    if (check.path === "notesContains") {
      return String(actual).toLowerCase().includes(String(check.equals).toLowerCase());
    }

    return valuesEqual(actual, check.equals);
  });
}

function computeEntityAccuracy(scenario: any, events: any[]) {
  if (!scenario.numericHeavy) return "N/A";

  const expected = scenario.expectedEntities || {};
  const expectedEntries = Object.entries(expected);
  if (expectedEntries.length === 0) return "N/A";

  const captured = getCapturedEntitiesFromEvents(events);
  let correct = 0;

  for (const [key, expectedValue] of expectedEntries) {
    if (valuesEqual(captured[key], expectedValue)) correct += 1;
  }

  return correct / expectedEntries.length;
}

function computeLatencyMs(events: any[]) {
  const start = events.find((event) => event.eventType === "audio_first_packet_received");
  const end = [...events].reverse().find((event) => event.eventType === "final_acknowledgement_completed");

  if (!start || !end) return "N/A";

  const startMs = toMs(start.timestamp);
  const endMs = toMs(end.timestamp);

  if (startMs === null || endMs === null || endMs < startMs) return "N/A";

  return endMs - startMs;
}

function computeConfirmationCompliance(scenario: any, events: any[]) {
  if (!scenario.includedInConfirmationCompliance) return "N/A";

  const sensitiveOperations = events.filter(
    (event) => event.eventType === "operation_executed" && SENSITIVE_TOOLS.has(event.toolName)
  );

  const prompted = events.find((event) => event.eventType === "confirmation_prompted");
  const received = events.find((event) => event.eventType === "confirmation_received");

  if (sensitiveOperations.length === 0 || !prompted || !received) return false;

  const promptedMs = toMs(prompted.timestamp);
  const receivedMs = toMs(received.timestamp);

  if (promptedMs === null || receivedMs === null || receivedMs < promptedMs) return false;

  for (const operation of sensitiveOperations) {
    const operationMs = toMs(operation.timestamp);
    if (operationMs === null) return false;
    if (operationMs < promptedMs || operationMs < receivedMs) return false;
  }

  return true;
}

function computeCriticalExecutionError(scenario: any, events: any[]) {
  const allowedOperations = scenario.allowedOperations || [];
  const executedOperations = events.filter((event) => event.eventType === "operation_executed");

  if (allowedOperations.length === 0 && executedOperations.length > 0) {
    return true;
  }

  for (const operation of executedOperations) {
    if (!operationAllowed(operation, allowedOperations)) return true;
  }

  if (scenario.includedInConfirmationCompliance) {
    const prompted = events.find((event) => event.eventType === "confirmation_prompted");
    const received = events.find((event) => event.eventType === "confirmation_received");
    const sensitiveOperations = executedOperations.filter((operation) => SENSITIVE_TOOLS.has(operation.toolName));

    for (const operation of sensitiveOperations) {
      if (!prompted || !received) return true;

      const operationMs = toMs(operation.timestamp);
      const promptedMs = toMs(prompted.timestamp);
      const receivedMs = toMs(received.timestamp);

      if (operationMs === null || promptedMs === null || receivedMs === null) return true;
      if (operationMs < promptedMs) return true;
      if (operationMs < receivedMs) return true;
    }
  }

  return false;
}

function readManualCriticalReview() {
  if (!fs.existsSync(MANUAL_REVIEW_FILE)) return new Map<string, boolean>();

  const rows = fs
    .readFileSync(MANUAL_REVIEW_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const decisions = new Map<string, boolean>();
  const [, ...dataRows] = rows;

  for (const row of dataRows) {
    const [trialId, , manualDecision] = row.split(",").map((value) => value?.trim());
    if (!trialId || manualDecision == null || manualDecision === "") continue;

    if (["true", "yes", "1"].includes(manualDecision.toLowerCase())) {
      decisions.set(trialId, true);
    } else if (["false", "no", "0"].includes(manualDecision.toLowerCase())) {
      decisions.set(trialId, false);
    }
  }

  return decisions;
}

function median(values: any[]) {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (nums.length === 0) return "N/A";

  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function mean(values: any[]) {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return "N/A";
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function rate(rows: any[], column: string, predicate = (value: any) => value === true) {
  if (rows.length === 0) return "N/A";
  return rows.filter((row) => predicate(row[column])).length / rows.length;
}

function relevantRate(rows: any[], column: string) {
  const relevant = rows.filter((row) => row[column] !== "N/A");
  if (relevant.length === 0) return "N/A";
  return relevant.filter((row) => row[column] === true).length / relevant.length;
}

function main() {
  ensureDir(RESULTS_DIR);

  const scenarios = readJson(SCENARIOS_FILE, []);
  const scenarioById = new Map(scenarios.map((scenario: any) => [scenario.scenarioId, scenario]));
  const events = readJsonl(EVENTS_FILE);
  const manualCriticalReview = readManualCriticalReview();

  const trials = [...groupBy(events, (event) => event.trialId).entries()]
    .filter(([trialId]) => trialId && trialId !== "undefined")
    .map(([trialId, trialEvents]) => {
      const first = trialEvents.find((event) => event.eventType === "trial_started") || trialEvents[0];
      const scenario = scenarioById.get(first.scenarioId);

      if (!scenario) return null;

      const finalState = getFinalState(trialId);
      const failed = trialEvents.some((event) => event.eventType === "trial_failed");
      const automaticCriticalExecutionError = computeCriticalExecutionError(scenario, trialEvents);
      const criticalExecutionError = manualCriticalReview.has(trialId)
        ? manualCriticalReview.get(trialId)
        : automaticCriticalExecutionError;

      return {
        trialId,
        condition: first.condition,
        prototype: first.prototype,
        environment: first.environment,
        scenarioId: first.scenarioId,
        repetition: first.repetition,
        taskSuccess: computeTaskSuccess(scenario, finalState, failed),
        criticalExecutionError,
        entityAccuracy: computeEntityAccuracy(scenario, trialEvents),
        endToEndLatencyMs: computeLatencyMs(trialEvents),
        failureOrTimeout: failed || !trialEvents.some((event) => event.eventType === "trial_completed"),
        confirmationCompliant: computeConfirmationCompliance(scenario, trialEvents),
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.trialId.localeCompare(b.trialId));

  const trialColumns = [
    "trialId",
    "condition",
    "prototype",
    "environment",
    "scenarioId",
    "repetition",
    "taskSuccess",
    "criticalExecutionError",
    "entityAccuracy",
    "endToEndLatencyMs",
    "failureOrTimeout",
    "confirmationCompliant",
  ];

  fs.writeFileSync(path.join(RESULTS_DIR, "trial-results.json"), JSON.stringify(trials, null, 2), "utf8");
  writeCsv(path.join(RESULTS_DIR, "trial-results.csv"), trials, trialColumns);

  const byCondition = groupBy(trials, (trial) => trial.condition);
  const aggregateRows: any[] = [];

  for (const [condition, rows] of byCondition.entries()) {
    const first = rows[0];
    const latencies = rows.map((row: any) => row.endToEndLatencyMs).filter((value: any) => typeof value === "number");

    aggregateRows.push({
      condition,
      prototype: first.prototype,
      environment: first.environment,
      totalTrials: rows.length,
      taskSuccessRate: rate(rows, "taskSuccess"),
      criticalExecutionErrorRate: rate(rows, "criticalExecutionError"),
      meanEntityAccuracy: mean(rows.map((row: any) => row.entityAccuracy)),
      medianLatencyMs: median(latencies),
      minLatencyMs: latencies.length ? Math.min(...latencies) : "N/A",
      maxLatencyMs: latencies.length ? Math.max(...latencies) : "N/A",
      failureTimeoutRate: rate(rows, "failureOrTimeout"),
      confirmationComplianceRate: relevantRate(rows, "confirmationCompliant"),
    });
  }

  const aggregateColumns = [
    "condition",
    "prototype",
    "environment",
    "totalTrials",
    "taskSuccessRate",
    "criticalExecutionErrorRate",
    "meanEntityAccuracy",
    "medianLatencyMs",
    "minLatencyMs",
    "maxLatencyMs",
    "failureTimeoutRate",
    "confirmationComplianceRate",
  ];

  fs.writeFileSync(path.join(RESULTS_DIR, "aggregate-results.json"), JSON.stringify(aggregateRows, null, 2), "utf8");
  writeCsv(path.join(RESULTS_DIR, "aggregate-results.csv"), aggregateRows, aggregateColumns);

  console.log(`Wrote ${trials.length} trial result(s).`);
  console.log(`Results directory: ${RESULTS_DIR}`);
}

main();
