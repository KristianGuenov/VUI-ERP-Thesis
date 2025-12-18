import Foundation

struct AgentClient {
    let baseServerURL: URL

    func send(text: String) async throws -> String {
        var request = URLRequest(url: baseServerURL.appendingPathComponent("agent"))
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["text": text])

        let (data, _) = try await URLSession.shared.data(for: request)
        let reply = try JSONDecoder().decode(SimpleReply.self, from: data)
        return reply.reply
    }

    private struct SimpleReply: Codable { let reply: String }
}
