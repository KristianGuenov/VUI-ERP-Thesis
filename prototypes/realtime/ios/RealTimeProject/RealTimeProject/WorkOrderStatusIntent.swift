import AppIntents

struct WorkOrderStatusIntent: AppIntent {

    static var title: LocalizedStringResource = "Check Work Order Status"
    static var description = IntentDescription(
        "Opens the app and requests the status of a work order from the assistant."
    )

    static var openAppWhenRun = true

    @Parameter(title: "Work Order ID")
    var orderID: String?

    @MainActor
    func perform() async throws -> some IntentResult {

        NotificationCenter.default.post(
            name: .startVoiceAssistant,
            object: ["requestedOrderID": orderID ?? ""]
        )

        return .result()
    }
}
