import Foundation

public struct AgentResponse: Codable {
    public let reply: String
    public let json: [WorkOrder]?
}

public final class AgentClient {
    private let url: URL

    public init(baseURL: URL) {
        self.url = baseURL.appendingPathComponent("agent")
    }

    public func send(_ text: String) async throws -> AgentResponse {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["text": text])

        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(AgentResponse.self, from: data)
    }
}
