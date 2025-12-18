import SwiftUI

struct CommandsScreen: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {

                Text("Command Guide")
                    .font(.largeTitle)
                    .bold()
                    .padding(.bottom, 6)

                section("Work Order") {
                    command("Start work order 000012345678")
                    command("Pause work order 000012345678")
                    command("Update description for 000012345678 to Repair motor urgently")
                }

                section("Operations") {
                    command("Start operation 0010 in work order 000012345678")
                    command("What is the status of work order 000012345678?")
                    command("Show details for work order 000012345678")
                }

                section("Time (requires confirmation)") {
                    command("Add 60 minutes to the current work order")
                    command("Report 30 minutes for operation 0010 in work order 000012345678")
                }

                section("Completion (requires confirmation)") {
                    command("Complete work order 000012345678")
                    command("Force complete work order 000012345678")
                }

                section("Task Navigation") {
                    command("What is my next task?")
                }

                section("Session") {
                    command("End task session")
                    command("End assistant session")
                }

                Spacer().frame(height: 30)
            }
            .padding()
        }
        .navigationTitle("Available Commands")
    }

    private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.title3).bold()
            content()
        }
        .padding(.top, 6)
    }

    private func command(_ text: String) -> some View {
        Text("• \(text)")
            .font(.body)
            .padding(.leading, 8)
    }
}
