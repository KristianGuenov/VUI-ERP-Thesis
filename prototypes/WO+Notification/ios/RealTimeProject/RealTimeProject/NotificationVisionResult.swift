import Foundation

struct NotificationVisionResult: Codable, Identifiable, Equatable {

    // Stable id for SwiftUI lists
    let id: String

    let ok: Bool
    let filename: String

    let serverPath: String?
    let source: String?

    let summary: String?
    let confidence: Double?
    let labels: [String]?

    let suggestedFields: [String: String]?
    let evidence: [String: String]?
    let appliedFields: [String: String]?

    let createdAt: String?

    // In case server emits failures
    let error: String?
    let detail: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case filename
        case serverPath
        case source
        case summary
        case confidence
        case labels
        case suggestedFields
        case evidence
        case appliedFields
        case createdAt
        case error
        case detail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        self.ok = (try c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        self.filename = (try c.decodeIfPresent(String.self, forKey: .filename)) ?? ""

        self.serverPath = try c.decodeIfPresent(String.self, forKey: .serverPath)
        self.source = try c.decodeIfPresent(String.self, forKey: .source)

        self.summary = try c.decodeIfPresent(String.self, forKey: .summary)
        self.confidence = try c.decodeIfPresent(Double.self, forKey: .confidence)
        self.labels = try c.decodeIfPresent([String].self, forKey: .labels)

        self.suggestedFields = try c.decodeIfPresent([String: String].self, forKey: .suggestedFields)
        self.evidence = try c.decodeIfPresent([String: String].self, forKey: .evidence)
        self.appliedFields = try c.decodeIfPresent([String: String].self, forKey: .appliedFields)

        self.createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)

        self.error = try c.decodeIfPresent(String.self, forKey: .error)
        self.detail = try c.decodeIfPresent(String.self, forKey: .detail)

        // Build an id that won't change during rendering
        if let createdAt = self.createdAt, !createdAt.isEmpty, !self.filename.isEmpty {
            self.id = "\(self.filename)-\(createdAt)"
        } else {
            self.id = UUID().uuidString
        }
    }
}
