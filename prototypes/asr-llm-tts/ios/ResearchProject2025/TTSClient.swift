import Foundation

struct TTSClient {
    let baseServerURL: URL

    func speak(text: String) async throws -> (URL, Int) {
        var request = URLRequest(url: baseServerURL.appendingPathComponent("tts"))
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["text": text])

        let (data, response) = try await URLSession.shared.data(for: request)
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tts-\(UUID().uuidString).mp3")
        try data.write(to: tmp)
        return (tmp, (response as? HTTPURLResponse)?.statusCode ?? 200)
    }
}
