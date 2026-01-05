import Foundation

enum NotificationWizardMode: String, CaseIterable, Codable {
    case minimal
    case full
}

enum NotificationDraftStatus: String, Codable {
    case empty
    case inProgress
    case ready
}

struct NotificationPhoto: Codable, Equatable, Identifiable {
    var id: String { (clientLocalId?.isEmpty == false ? (clientLocalId ?? "") : filename) }

    var filename: String
    var serverPath: String?
    var mimeType: String?
    var sizeBytes: Int?
    var note: String?
    var source: String?
    var requestId: String?
    var clientLocalId: String?
    var addedAt: String?

    init(
        filename: String,
        serverPath: String? = nil,
        mimeType: String? = nil,
        sizeBytes: Int? = nil,
        note: String? = nil,
        source: String? = nil,
        requestId: String? = nil,
        clientLocalId: String? = nil,
        addedAt: String? = nil
    ) {
        self.filename = filename
        self.serverPath = serverPath
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.note = note
        self.source = source
        self.requestId = requestId
        self.clientLocalId = clientLocalId
        self.addedAt = addedAt
    }
}

struct NotificationDraft: Codable, Equatable {

    var notificationId: String?
    var createdAt: String?
    var mode: String?

    var notificationType: String?
    var shortText: String?
    var priority: String?

    var equipmentID: String?
    var functionalLocation: String?
    var plant: String?
    var reportedBy: String?

    // Canonical storage (server also uses "photos")
    var photos: [NotificationPhoto]

    // MARK: - Compatibility alias (older UI code expects attachments)
    var attachments: [NotificationPhoto] { photos }

    // MARK: - Derived UI helpers (NOT encoded/decoded)
    var status: NotificationDraftStatus {
        let hasAnyID = !(notificationId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !hasAnyID { return .empty }

        func hasText(_ s: String?) -> Bool {
            guard let s else { return false }
            return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }

        let hasType = hasText(notificationType)
        let hasShort = hasText(shortText)
        let hasPrio = hasText(priority)
        let hasEquip = hasText(equipmentID)
        let hasFloc = hasText(functionalLocation)

        let ready = hasType && hasShort && hasPrio && (hasEquip || hasFloc)
        return ready ? .ready : .inProgress
    }

    // MARK: - Factories
    static let empty = NotificationDraft(
        notificationId: nil,
        createdAt: nil,
        mode: "minimal",
        notificationType: nil,
        shortText: nil,
        priority: nil,
        equipmentID: nil,
        functionalLocation: nil,
        plant: nil,
        reportedBy: nil,
        photos: []
    )

    static func stub() -> NotificationDraft {
        NotificationDraft(
            notificationId: "N-TEST-0001",
            createdAt: ISO8601DateFormatter().string(from: Date()),
            mode: "minimal",
            notificationType: "problem",
            shortText: "Pump malfunction",
            priority: "2",
            equipmentID: "",
            functionalLocation: "FL-100",
            plant: "1000",
            reportedBy: "Operator01",
            photos: []
        )
    }

    init(
        notificationId: String?,
        createdAt: String?,
        mode: String?,
        notificationType: String?,
        shortText: String?,
        priority: String?,
        equipmentID: String?,
        functionalLocation: String?,
        plant: String?,
        reportedBy: String?,
        photos: [NotificationPhoto]
    ) {
        self.notificationId = notificationId
        self.createdAt = createdAt
        self.mode = mode
        self.notificationType = notificationType
        self.shortText = shortText
        self.priority = priority
        self.equipmentID = equipmentID
        self.functionalLocation = functionalLocation
        self.plant = plant
        self.reportedBy = reportedBy
        self.photos = photos
    }
}
