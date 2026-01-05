import SwiftUI

@main
struct RealTimeProjectApp: App {
    @StateObject var vm = VoiceChatViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vm)
                .onReceive(NotificationCenter.default.publisher(for: .startVoiceAssistant)) { notification in
                    if let info = notification.object as? [String: String],
                       let orderID = info["requestedOrderID"] {
                        vm.startConversation()
                        vm.userTranscript = "Check status for work order \(orderID)"
                        vm.logs.append("[\(Self.timestamp())] Shortcut: status for \(orderID)")
                    } else {
                        vm.startConversation()
                        vm.logs.append("[\(Self.timestamp())] Shortcut: start assistant")
                    }
                }
                .onAppear {
                    if !vm.isRunning && vm.sessionState != .off {
                        vm.startConversation()
                    }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .active && !vm.isRunning && vm.sessionState != .off {
                        vm.startConversation()
                    }
                }
        }
    }

    private static func timestamp() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: Date())
    }
}
