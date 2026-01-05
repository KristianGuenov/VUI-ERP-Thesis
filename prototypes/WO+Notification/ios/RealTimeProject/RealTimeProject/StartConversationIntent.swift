//
//  StartConversationIntent.swift
//  RealTimeProject
//
//  Created by Kristian on 24.11.25.
//
import AppIntents

struct StartConversationIntent: AppIntent {

    static var title: LocalizedStringResource = "Start Voice Assistant"
    static var description = IntentDescription(
        "Opens the app and starts the SAP voice assistant immediately."
    )
    static var openAppWhenRun = true
    @MainActor
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .startVoiceAssistant, object: nil)
        return .result()
    }
}

extension Notification.Name {
    static let startVoiceAssistant = Notification.Name("startVoiceAssistant")
}

