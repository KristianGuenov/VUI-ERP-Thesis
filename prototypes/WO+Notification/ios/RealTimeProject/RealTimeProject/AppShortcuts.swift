import AppIntents

struct SAPAssistantShortcuts: AppShortcutsProvider {

    @AppShortcutsBuilder
    static var appShortcuts: [AppShortcut] {

        // ───────────────────────────────
        // Shortcut 1 — Start Assistant
        // ───────────────────────────────
        AppShortcut(
            intent: StartConversationIntent(),
            phrases: [
                "Start \(.applicationName)",
                "Open \(.applicationName)",
                "Begin \(.applicationName)"
            ],
            shortTitle: "Start Assistant",
            systemImageName: "mic.fill"
        )

        // ───────────────────────────────
        // Shortcut 2 — Work Order Status
        // ───────────────────────────────
        AppShortcut(
            intent: WorkOrderStatusIntent(),
            phrases: [
                "Check work order status in \(.applicationName)",
                "Get work order status from \(.applicationName)",
                "Ask \(.applicationName) for work order status"
            ],
            shortTitle: "Work Order Status",
            systemImageName: "doc.text.magnifyingglass"
        )
    }
}
