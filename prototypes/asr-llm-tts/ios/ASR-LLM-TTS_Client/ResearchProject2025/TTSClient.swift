//
//  TTSClient.swift
//  ResearchProject2025
//
//  Created by Kristian on 10.11.25.
//


//
import Foundation
import AVFoundation

public final class TTSClient {
    private let baseServerURL: URL
    private var player: AVAudioPlayer?

    public init(baseServerURL: URL) {
        self.baseServerURL = baseServerURL
    }

    /// Requests speech generation from the server and saves the result as an MP3 file.
    /// Returns both the local file URL and the server's HTTP response for debugging.
    public func speak(text: String) async throws -> (URL, HTTPURLResponse) {
        // Determine the correct /tts endpoint
        let ttsURL: URL
        if baseServerURL.absoluteString.hasSuffix("/asr") {
            ttsURL = baseServerURL.deletingLastPathComponent().appendingPathComponent("tts")
        } else {
            ttsURL = baseServerURL.appendingPathComponent("tts")
        }

        // Prepare JSON request
        var request = URLRequest(url: ttsURL)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["text": text])

        // Send request to server
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "TTSClient", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid server response"])
        }

        // Save data to temporary MP3 file
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("tts_output.mp3")
        try data.write(to: tempURL)

        // Return both the file and headers for debugging
        return (tempURL, httpResponse)
    }
}
