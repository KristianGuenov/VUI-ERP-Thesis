//
//  CommandsScreen.swift
//  ResearchProject2025
//
//  Created by Kristian on 27.11.25.
//


import SwiftUI

struct CommandsScreen: View {

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {

                Text("Voice Command Guide")
                    .font(.largeTitle)
                    .bold()
                    .padding(.bottom, 10)

                Group {
                    Text("🔧 Work Order Status")
                        .font(.title3).bold()

                    command("Start work order WO-1001")
                    command("Start WO-2003")
                    command("Open work order WO-3003")
                    command("Close work order WO-2005")
                }

                Group {
                    Text("❓ Status Questions")
                        .font(.title3).bold()

                    command("What’s the status of WO-1001?")
                    command("Status of 3003")
                    command("What’s the status?")
                    command("Is it open?")
                }

                Group {
                    Text("⏱ Report Time")
                        .font(.title3).bold()

                    command("Add 20 minutes to WO-1001")
                    command("Add 10 minutes to this work order")
                }

                Group {
                    Text("🛠 Operations")
                        .font(.title3).bold()

                    command("Close operation OP-3 in WO-1001")
                    command("Close OP-1")
                }

                Group {
                    Text("➡️ Operation Navigation")
                        .font(.title3).bold()

                    command("Next operation")
                    command("Next step")
                    command("Go to next operation")
                }

                Group {
                    Text("📋 Summaries")
                        .font(.title3).bold()

                    command("Show summary for WO-1001")
                    command("Give me a summary")
                }

                Group {
                    Text("📝 Description Updates")
                        .font(.title3).bold()

                    command("Set description of WO-3003 to Replace filter")
                    command("Update description to Fix the motor")
                }

                Group {
                    Text("🗒 Add Note")
                        .font(.title3).bold()

                    command("Add note to WO-1001: Technician arrived")
                    command("Note as Machine offline")
                }

                Spacer().frame(height: 40)
            }
            .padding()
        }
        .navigationTitle("Available Commands")
    }

    // MARK: - Helper
    private func command(_ text: String) -> some View {
        Text("• \(text)")
            .font(.body)
            .padding(.leading, 8)
    }
}
