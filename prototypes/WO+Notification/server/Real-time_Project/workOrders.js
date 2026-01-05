// ------------------------------------------------------------
// workOrders.js
// Load JSON files using fs (compatible with all Node versions)
// ------------------------------------------------------------
import fs from "fs";
import path from "path";

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(path.resolve("data", file), "utf8"));
}

const workOrder1 = loadJSON("workOrder1.json");
const workOrder2 = loadJSON("workOrder2.json");
const workOrder3 = loadJSON("workOrder3.json");

export const WORK_ORDERS = new Map([
  [workOrder1.OrderHeader.order_id, structuredClone(workOrder1)],
  [workOrder2.OrderHeader.order_id, structuredClone(workOrder2)],
  [workOrder3.OrderHeader.order_id, structuredClone(workOrder3)]
]);

export function getWorkOrder(id) {
  const wo = WORK_ORDERS.get(id);

  if (!wo) {
    console.log("\n=== [DEBUG] getWorkOrder: NOT FOUND ===");
    console.log("Requested ID:", id);
    console.log("Available IDs:", Array.from(WORK_ORDERS.keys()).join(", "));
    return null;
  }

  console.log("\n=== [DEBUG] getWorkOrder: FOUND ===");
  console.log("ID:", id);

  return wo;
}

export function updateWorkOrder(orderId, updatedOrder) {
  updatedOrder.OrderHeader.last_changed = new Date().toISOString();
  WORK_ORDERS.set(orderId, updatedOrder);
  return updatedOrder;
}

export function resetWorkOrders() {
  WORK_ORDERS.clear();
  WORK_ORDERS.set(workOrder1.OrderHeader.order_id, structuredClone(workOrder1));
  WORK_ORDERS.set(workOrder2.OrderHeader.order_id, structuredClone(workOrder2));
  WORK_ORDERS.set(workOrder3.OrderHeader.order_id, structuredClone(workOrder3));
}

export function listWorkOrders() {
  return Array.from(WORK_ORDERS.values());
}

export function listWorkOrdersForTechnician(technicianId) {
  return listWorkOrders().filter(
    (wo) => wo.OrderHeader.assigned_to === technicianId
  );
}
