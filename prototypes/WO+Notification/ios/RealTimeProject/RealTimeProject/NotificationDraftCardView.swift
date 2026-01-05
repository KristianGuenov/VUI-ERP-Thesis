import SwiftUI

struct NotificationDraftCardView: View {

    let draft: NotificationDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {

            HStack {
                Text("Notification Draft")
                    .font(.headline)

                Spacer()

                Text(draft.status.rawValue)
                    .font(.caption.bold())
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.thinMaterial)
                    .cornerRadius(999)
            }

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                row(label: "Type", value: display(draft.notificationType))
                row(label: "Short Text", value: display(draft.shortText))
                row(label: "Priority", value: display(draft.priority))
                row(label: "Equipment", value: display(draft.equipmentID))
                row(label: "Functional Location", value: display(draft.functionalLocation))
                row(label: "Plant", value: display(draft.plant))
                row(label: "Reported By", value: display(draft.reportedBy))
                row(label: "Attachments", value: "\(draft.attachments.count)")
            }

            if !draft.attachments.isEmpty {
                Divider()
                Text("Attachments")
                    .font(.caption.bold())
                    .foregroundColor(.secondary)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(draft.attachments.prefix(5)) { a in
                        HStack(spacing: 8) {
                            Image(systemName: "photo")
                                .foregroundColor(.secondary)
                            Text(a.note ?? "Photo")
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                            Spacer()
                        }
                    }
                }
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private func row(label: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.caption.bold())
                .foregroundColor(.secondary)
                .frame(width: 120, alignment: .leading)

            Text(value)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func display(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "—" : trimmed
    }
}

#Preview {
    NotificationDraftCardView(draft: .stub())
        .padding()
}
