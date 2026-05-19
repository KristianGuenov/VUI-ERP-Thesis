import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const LOG_PATH = path.join(ROOT, "experiment", "logs", "events.jsonl");
const SCENARIO_PATH = path.join(ROOT, "experiment", "scenarios", "common_scenarios.json");
const FINAL_STATES_DIR = path.join(ROOT, "experiment", "final-states");
const RESULTS_DIR = path.join(ROOT, "experiment", "results");
const MANUAL_REVIEW_DIR = path.join(ROOT, "experiment", "manual-review");

const SENSITIVE_TOOLS = new Set([
  "report_time",
  "add_time_to_work_order",
  "close_operation",
  "complete_work_order",
  "end_task_session",
  "end_assistant_session"
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readEvents() {
  if (!fs.existsSync(LOG_PATH)) {
    throw new Error(`Missing log file: ${LOG_PATH}`);
  }

  return fs
    .readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function groupByTrial(events) {
  const map = new Map();

  for (const event of events) {
    if (!event.trialId) continue;
    if (!map.has(event.trialId)) map.set(event.trialId, []);
    map.get(event.trialId).push(event);
  }

  for (const list of map.values()) {
    list.sort((a, b) => parseTime(a.timestamp) - parseTime(b.timestamp));
  }

  return map;
}

function makeScenarioMap(scenarios) {
  return new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
}

function loadFinalState(trialId) {
  const filePath = path.join(FINAL_STATES_DIR, `${trialId}_final.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return readJson(filePath);
}

function normalizeExpectedOperation(operation) {
  if (!operation) return null;

  const toolName = operation.toolName || operation.name;

  const args = operation.args
    ? { ...operation.args }
    : Object.fromEntries(
        Object.entries(operation).filter(([key]) => key !== "toolName" && key !== "name")
      );

  return { toolName, args };
}

function valuesEqual(actual, expected) {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.trim().toLowerCase() === expected.trim().toLowerCase();
  }

  return actual === expected;
}

function argsMatch(actualArgs = {}, expectedArgs = {}) {
  for (const [key, expectedValue] of Object.entries(expectedArgs)) {
    if (!valuesEqual(actualArgs[key], expectedValue)) {
      return false;
    }
  }

  return true;
}

function operationMatches(event, expectedOperation) {
  if (!event || !expectedOperation) return false;
  if (event.toolName !== expectedOperation.toolName) return false;
  return argsMatch(event.args || {}, expectedOperation.args || {});
}

function getWorkOrderFromFinalState(finalState) {
  if (!finalState) return null;
  if (finalState.workOrder) return finalState.workOrder;
  if (finalState.OrderHeader) return finalState;
  return null;
}

function createVirtualWorkOrder(workOrder) {
  if (!workOrder) return null;

  const virtual = structuredClone(workOrder);

  const operations = Array.isArray(workOrder.Operations)
    ? workOrder.Operations
    : Array.isArray(workOrder.operations)
      ? workOrder.operations
      : [];

  virtual.OperationsById = {};

  for (const operation of operations) {
    const id = operation.operation_id || operation.id;
    if (id) virtual.OperationsById[id] = operation;
  }

  return virtual;
}

function getByPath(object, pathText) {
  if (!object || !pathText) return undefined;

  const parts = pathText.split(".");
  let current = object;

  for (const part of parts) {
    if (current == null) return undefined;

    if (/^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      current = current[part];
    }
  }

  return current;
}

function evaluateFinalChecks(scenario, finalState) {
  const checks = scenario.expectedFinalChecks || [];
  const workOrder = getWorkOrderFromFinalState(finalState);
  const virtualWorkOrder = createVirtualWorkOrder(workOrder);

  if (!checks.length) {
    return { passed: true, failedChecks: [] };
  }

  const failedChecks = [];

  for (const check of checks) {
    const actual = getByPath(virtualWorkOrder, check.path);

    if (!valuesEqual(actual, check.equals)) {
      failedChecks.push({
        path: check.path,
        expected: check.equals,
        actual
      });
    }
  }

  return {
    passed: failedChecks.length === 0,
    failedChecks
  };
}

function getExpectedEntityFields(scenario) {
  const fields = [];

  const expectedEntities = scenario.expectedEntities || {};

  if (Array.isArray(expectedEntities)) {
    for (const item of expectedEntities) {
      if (item?.key) fields.push({ key: item.key, value: item.value });
    }
  } else {
    for (const [key, value] of Object.entries(expectedEntities)) {
      fields.push({ key, value });
    }
  }

  const allowedOperations = (scenario.allowedOperations || [])
    .map(normalizeExpectedOperation)
    .filter(Boolean);

  for (const operation of allowedOperations) {
    for (const [key, value] of Object.entries(operation.args || {})) {
      if (!fields.some((field) => field.key === key && field.value === value)) {
        fields.push({ key, value });
      }
    }
  }

  return fields;
}

function evaluateEntityAccuracy(scenario, events) {
  if (!scenario.numericHeavy) return null;

  const expectedFields = getExpectedEntityFields(scenario);

  if (!expectedFields.length) return null;

  const toolEvents = events.filter((event) =>
    ["tool_call_requested", "tool_call_result", "operation_executed", "operation_rejected"].includes(event.eventType)
  );

  let correct = 0;

  for (const field of expectedFields) {
    const found = toolEvents.some((event) =>
      valuesEqual(event.args?.[field.key], field.value)
    );

    if (found) correct += 1;
  }

  return correct / expectedFields.length;
}

function evaluateCriticalExecutionError(scenario, events, finalCheckResult) {
  const allowedOperations = (scenario.allowedOperations || [])
    .map(normalizeExpectedOperation)
    .filter(Boolean);

  const executedEvents = events.filter((event) => event.eventType === "operation_executed");

  for (const event of executedEvents) {
    const matched = allowedOperations.some((operation) =>
      operationMatches(event, operation)
    );

    if (!matched) {
      return {
        criticalExecutionError: true,
        reason: "Executed operation did not match allowed operation",
        event
      };
    }
  }

  if (!finalCheckResult.passed) {
    return {
      criticalExecutionError: true,
      reason: "Final state did not match expected checks",
      failedChecks: finalCheckResult.failedChecks
    };
  }

  return {
    criticalExecutionError: false,
    reason: ""
  };
}

function evaluateConfirmationCompliance(scenario, events) {
  if (!scenario.includedInConfirmationCompliance) return null;

  const sensitiveExecution = events.find(
    (event) =>
      event.eventType === "operation_executed" &&
      SENSITIVE_TOOLS.has(event.toolName)
  );

  const confirmationPrompted = events.find((event) => event.eventType === "confirmation_prompted");
  const confirmationReceived = events.find((event) => event.eventType === "confirmation_received");

  if (!sensitiveExecution) return false;
  if (!confirmationPrompted || !confirmationReceived) return false;

  const execTime = parseTime(sensitiveExecution.timestamp);
  const promptedTime = parseTime(confirmationPrompted.timestamp);
  const receivedTime = parseTime(confirmationReceived.timestamp);

  return promptedTime <= execTime && receivedTime <= execTime;
}

function evaluateLatency(events) {
  const audioStart = events.find((event) => event.eventType === "audio_first_packet_received");
  const finalAcks = events.filter((event) => event.eventType === "final_acknowledgement_completed");

  if (!audioStart || !finalAcks.length) return null;

  const startMs = parseTime(audioStart.timestamp);
  const endMs = parseTime(finalAcks[finalAcks.length - 1].timestamp);

  if (startMs == null || endMs == null) return null;

  const latency = endMs - startMs;

  return latency >= 0 ? latency : null;
}

function evaluateFailure(events) {
  const completed = events.some((event) => event.eventType === "trial_completed");
  const failed = events.some((event) => event.eventType === "trial_failed");

  const fatalObserved = events.some(
    (event) => event.eventType === "trial_failure_observed" && event.fatal === true
  );

  return failed || fatalObserved || !completed;
}

function evaluateTrial(trialId, events, scenarioMap) {
  const start = events.find((event) => event.eventType === "trial_started") || events[0];
  const scenario = scenarioMap.get(start.scenarioId);

  if (!scenario) {
    throw new Error(`No scenario found for trial ${trialId}, scenarioId=${start.scenarioId}`);
  }

  const finalState = loadFinalState(trialId);
  const finalCheckResult = evaluateFinalChecks(scenario, finalState);
  const critical = evaluateCriticalExecutionError(scenario, events, finalCheckResult);
  const entityAccuracy = evaluateEntityAccuracy(scenario, events);
  const confirmationCompliance = evaluateConfirmationCompliance(scenario, events);
  const latencyMs = evaluateLatency(events);
  const failureObserved = evaluateFailure(events);

  const hasExpectedOperation =
    !scenario.allowedOperations ||
    scenario.allowedOperations.length === 0 ||
    (scenario.allowedOperations || [])
      .map(normalizeExpectedOperation)
      .filter(Boolean)
      .some((operation) =>
        events.some((event) =>
          ["tool_call_requested", "tool_call_result", "operation_executed"].includes(event.eventType) &&
          operationMatches(event, operation)
        )
      );

  const taskSuccess =
    !failureObserved &&
    finalCheckResult.passed &&
    hasExpectedOperation &&
    !critical.criticalExecutionError;

  return {
    trialId,
    condition: start.condition,
    prototype: start.prototype,
    environment: start.environment,
    scenarioId: start.scenarioId,
    repetition: start.repetition,
    taskSuccess,
    criticalExecutionError: critical.criticalExecutionError,
    criticalExecutionErrorReason: critical.reason || "",
    entityAccuracy,
    latencyMs,
    failureTimeout: failureObserved,
    confirmationCompliance,
    failedChecks: finalCheckResult.failedChecks
  };
}

function median(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!valid.length) return null;

  valid.sort((a, b) => a - b);

  const mid = Math.floor(valid.length / 2);

  if (valid.length % 2 === 1) return valid[mid];

  return (valid[mid - 1] + valid[mid]) / 2;
}

function mean(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!valid.length) return null;

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function rate(values) {
  if (!values.length) return null;
  return values.filter(Boolean).length / values.length;
}

function aggregateResults(trialResults) {
  const groups = new Map();

  for (const result of trialResults) {
    const key = `${result.condition}|${result.prototype}|${result.environment}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  const aggregates = [];

  for (const [key, rows] of groups.entries()) {
    const [condition, prototype, environment] = key.split("|");

    const entityValues = rows
      .map((row) => row.entityAccuracy)
      .filter((value) => value !== null);

    const confirmationValues = rows
      .map((row) => row.confirmationCompliance)
      .filter((value) => value !== null);

    const latencyValues = rows
      .map((row) => row.latencyMs)
      .filter((value) => value !== null);

    aggregates.push({
      condition,
      prototype,
      environment,
      totalTrials: rows.length,
      taskSuccessRate: rate(rows.map((row) => row.taskSuccess)),
      criticalExecutionErrorRate: rate(rows.map((row) => row.criticalExecutionError)),
      meanEntityAccuracy: mean(entityValues),
      medianLatencyMs: median(latencyValues),
      minLatencyMs: latencyValues.length ? Math.min(...latencyValues) : null,
      maxLatencyMs: latencyValues.length ? Math.max(...latencyValues) : null,
      failureTimeoutRate: rate(rows.map((row) => row.failureTimeout)),
      confirmationComplianceRate: confirmationValues.length ? rate(confirmationValues) : null
    });
  }

  return aggregates.sort((a, b) => a.condition.localeCompare(b.condition));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);

  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function writeCsv(filePath, rows) {
  if (!rows.length) {
    fs.writeFileSync(filePath, "", "utf8");
    return;
  }

  const headers = Object.keys(rows[0]);

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ];

  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function main() {
  ensureDir(RESULTS_DIR);
  ensureDir(MANUAL_REVIEW_DIR);

  const events = readEvents();
  const scenarios = readJson(SCENARIO_PATH);
  const scenarioMap = makeScenarioMap(scenarios);
  const grouped = groupByTrial(events);

  const trialResults = [];

  for (const [trialId, trialEvents] of grouped.entries()) {
    if (!trialEvents.some((event) => event.eventType === "trial_started")) {
      continue;
    }

    trialResults.push(evaluateTrial(trialId, trialEvents, scenarioMap));
  }

  trialResults.sort((a, b) => a.trialId.localeCompare(b.trialId));

  const aggregates = aggregateResults(trialResults);

  fs.writeFileSync(
    path.join(RESULTS_DIR, "trial-results.json"),
    JSON.stringify(trialResults, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(RESULTS_DIR, "aggregate-results.json"),
    JSON.stringify(aggregates, null, 2),
    "utf8"
  );

  writeCsv(path.join(RESULTS_DIR, "trial-results.csv"), trialResults);
  writeCsv(path.join(RESULTS_DIR, "aggregate-results.csv"), aggregates);

  const manualReviewRows = trialResults
    .filter((row) => row.criticalExecutionError)
    .map((row) => ({
      trialId: row.trialId,
      condition: row.condition,
      scenarioId: row.scenarioId,
      repetition: row.repetition,
      criticalExecutionError: row.criticalExecutionError,
      reason: row.criticalExecutionErrorReason,
      reviewerDecision: "",
      reviewerNotes: ""
    }));

  writeCsv(path.join(MANUAL_REVIEW_DIR, "critical-error-review.csv"), manualReviewRows);

  console.log(JSON.stringify(aggregates, null, 2));
}

main();