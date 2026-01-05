import SwiftUI

struct ContentView: View {
    @EnvironmentObject var viewModel: VoiceChatViewModel
    @State private var selectedTab: RootTab = .workOrders

    enum RootTab: Hashable {
        case workOrders
        case notifications
    }

    var body: some View {
        TabView(selection: $selectedTab) {

            WorkOrdersView()
                .environmentObject(viewModel)
                .tabItem {
                    Label("Work Orders", systemImage: "wrench.and.screwdriver")
                }
                .tag(RootTab.workOrders)

            NotificationsView()
                .environmentObject(viewModel)
                .tabItem {
                    Label("Notifications", systemImage: "bell.badge")
                }
                .tag(RootTab.notifications)
        }
    }
}

// MARK: - Work Orders view (unchanged behavior)

private struct WorkOrdersView: View {
    @EnvironmentObject var viewModel: VoiceChatViewModel

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(.systemGray6), Color(.systemGray5)],
                           startPoint: .top,
                           endPoint: .bottom)
            .ignoresSafeArea()

            VStack(spacing: 24) {

                HStack {
                    Image(systemName: viewModel.isRunning ? "waveform.circle.fill" : "dot.circle")
                        .foregroundColor(viewModel.isRunning ? .green : .gray)
                        .font(.system(size: 22, weight: .bold))

                    Text(viewModel.status)
                        .font(.title3.bold())

                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 16)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Assistant")
                        .font(.headline)
                        .padding(.bottom, 2)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            if viewModel.isAIPlaying && !viewModel.currentTranscript.isEmpty {
                                Text(viewModel.currentTranscript)
                                    .italic()
                                    .foregroundColor(.secondary)
                            }

                            Text(viewModel.fullResponseText.isEmpty ? "—" : viewModel.fullResponseText)
                                .font(.body)
                        }
                        .padding(.vertical, 4)
                    }
                    .frame(height: 180)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
                .padding(.horizontal)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Logs")
                        .font(.caption.bold())
                        .foregroundColor(.secondary)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(viewModel.logs.indices, id: \.self) { idx in
                                Text(viewModel.logs[idx])
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.07), radius: 6, x: 0, y: 3)
                .frame(height: 200)
                .padding(.horizontal)

                Spacer()

                Button(action: {
                    if viewModel.isRunning {
                        viewModel.stopConversation()
                    } else {
                        viewModel.startConversation()
                    }
                }) {
                    ZStack {
                        Circle()
                            .fill(viewModel.isRunning ? Color.red.gradient : Color.blue.gradient)
                            .frame(width: 100, height: 100)
                            .shadow(
                                color: (viewModel.isRunning ? Color.red : Color.blue).opacity(0.4),
                                radius: 10, x: 0, y: 6
                            )

                        Image(systemName: viewModel.isRunning ? "stop.fill" : "mic.fill")
                            .foregroundColor(.white)
                            .font(.system(size: 38, weight: .bold))
                    }
                }
                .padding(.bottom, 30)
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(VoiceChatViewModel())
}
