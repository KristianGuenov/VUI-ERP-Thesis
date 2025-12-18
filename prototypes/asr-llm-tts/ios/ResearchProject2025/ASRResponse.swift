//
//  ASRResponse.swift
//  ResearchProject2025
//
//  Created by Kristian on 10.11.25.
//


import Foundation

public struct ASRResponse: Decodable {
    public let text: String
}

public final class ASRClient {
    public let serverURL: URL

    public init(serverURL: URL) {
        self.serverURL = serverURL
    }

    public func transcribe(fileURL: URL) async throws -> ASRResponse {
        var request = URLRequest(url: serverURL)
        request.httpMethod = "POST"

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }

        let filename = fileURL.lastPathComponent
        let mime = "audio/m4a"

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"audio\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(mime)\r\n\r\n")
        body.append(try Data(contentsOf: fileURL))
        append("\r\n--\(boundary)--\r\n")

        request.httpBody = body

        let (data, resp) = try await URLSession.shared.data(for: request)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? "Server error"
            throw NSError(domain: "ASRClient", code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: msg])
        }

        return try JSONDecoder().decode(ASRResponse.self, from: data)
    }
}

