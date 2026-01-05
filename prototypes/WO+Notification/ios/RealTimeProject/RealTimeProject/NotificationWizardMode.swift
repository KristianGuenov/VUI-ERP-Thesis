import Foundation
import Combine

@MainActor
final class NotificationWizardViewModel: ObservableObject {

    @Published var mode: NotificationWizardMode = NotificationWizardMode.minimal
    @Published var draft: NotificationDraft = NotificationDraft.empty

    init() {}

    func applyServerDraft(_ server: NotificationDraft) {
        // Map server draft.mode ("full"/"minimal") -> enum
        if (server.mode ?? "").lowercased() == "full" {
            self.mode = NotificationWizardMode.full
        } else {
            self.mode = NotificationWizardMode.minimal
        }

        // Replace draft with server truth
        self.draft = server
    }

    func setLocalField(_ field: String, value: String?) {
        switch field {
        case "notificationType":
            draft.notificationType = value

        case "shortText":
            draft.shortText = value

        case "priority":
            draft.priority = value

        case "equipmentID":
            draft.equipmentID = value

        case "functionalLocation":
            draft.functionalLocation = value

        case "plant":
            draft.plant = value

        case "reportedBy":
            draft.reportedBy = value

        default:
            break
        }
    }

    func removeLocalPhoto(filename: String) {
        draft.photos.removeAll { $0.filename == filename }
    }
}
