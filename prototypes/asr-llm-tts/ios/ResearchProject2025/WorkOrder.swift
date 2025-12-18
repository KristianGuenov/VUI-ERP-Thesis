import Foundation

// Canonical structure — matches Realtime prototype schema
struct WorkOrder: Codable, Identifiable {
    var id: String { OrderHeader.order_id }

    struct Header: Codable {
        var order_id: String
        var order_type: String
        var description: String
        var priority: String?
        var functional_location: String?
        var equipment_id: String?
        var planner_group: String?
        var created_by: String?
        var created_on: String?
        var last_changed: String?
        var due_date: String?
        var assigned_to: String?
        var status: Status

        struct Status: Codable {
            var system_status: [String]
            var user_status: [String]
        }
    }

    struct Operation: Codable, Identifiable {
        var id: String { operation_id }
        var operation_id: String
        var description: String
        var status: String
        var planned_duration_minutes: Int
        var actual_duration_minutes: Int
    }

    struct Totals: Codable {
        var total_planned_time_minutes: Int
        var total_actual_time_minutes: Int
    }

    var OrderHeader: Header
    var Operations: [Operation]
    var Totals: Totals?
}
