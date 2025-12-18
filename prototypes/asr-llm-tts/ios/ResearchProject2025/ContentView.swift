import SwiftUI
import AVFoundation

struct ContentView: View {
    @StateObject private var recorder = AudioRecorder()
    @State private var isRecording = false
    @State private var transcript = ""
    @State private var assistantReply = ""
    @State private var isTranscribing = false
    @State private var isProcessing = false
    @State private var logs: [String] = []
    @State private var lastTTSURL: URL? = nil
    @State private var workOrders: [WorkOrder] = []
    @State private var player: AVPlayer?

    private let serverURLString = "http://10.4.4.148:3000"

    // MARK: - Body
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(.systemGray6), Color(.systemGray5)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                // Status
                HStack {
                    Image(systemName: isRecording ? "waveform.circle.fill" : "dot.circle")
                        .foregroundColor(isRecording ? .green : .gray)
                        .font(.system(size: 22, weight: .bold))
                    Text(currentStatus())
                        .font(.title3.bold())
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 16)

                // You / Transcript
                VStack(alignment: .leading, spacing: 8) {
                    Text("You (ASR)").font(.headline)
                    Text(transcript.isEmpty ? "—" : transcript)
                        .font(.body)
                        .foregroundColor(.secondary)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 6, x: 0, y: 3)
                .padding(.horizontal)

                // Assistant
                VStack(alignment: .leading, spacing: 10) {
                    Text("Assistant").font(.headline)
                    Text(assistantReply.isEmpty ? "—" : assistantReply)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 4)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
                .padding(.horizontal)

                // Logs
                VStack(alignment: .leading, spacing: 8) {
                    Text("Logs").font(.caption.bold()).foregroundColor(.secondary)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(logs.indices, id: \.self) { i in
                                Text(logs[i])
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.07), radius: 6, x: 0, y: 3)
                .frame(height: 150)
                .padding(.horizontal)

                Spacer()

                // Buttons
                HStack(spacing: 20) {
                    Button(action: toggleRecording) {
                        ZStack {
                            Circle()
                                .fill(isRecording ? Color.red.gradient : Color.blue.gradient)
                                .frame(width: 90, height: 90)
                                .shadow(color: .black.opacity(0.2), radius: 10, x: 0, y: 6)
                            Image(systemName: isRecording ? "stop.fill" : "mic.fill")
                                .foregroundColor(.white)
                                .font(.system(size: 34, weight: .bold))
                        }
                    }
                    .disabled(isProcessing)

                    Button("Reset") { resetRecording() }
                        .buttonStyle(.bordered)
                        .disabled(isProcessing)

                    Button("Replay TTS") {
                        if let url = lastTTSURL { replayTTS(url) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(lastTTSURL == nil || isProcessing)
                }
                .padding(.bottom, 25)
            }
        }
        .onAppear { configureAudioSession() }
    }

    // MARK: - Helpers
    private func currentStatus() -> String {
        if isProcessing { return "Processing…" }
        if isTranscribing { return "Transcribing…" }
        if isRecording { return "Recording…" }
        return "Ready"
    }

    private func log(_ message: String) {
        logs.append("[\(timestamp())] \(message)")
    }

    private func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date())
    }

    // MARK: - Audio Session
    private func configureAudioSession() {
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playAndRecord,
                                         mode: .measurement,
                                         options: [.defaultToSpeaker, .allowAirPlay])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            log("Audio session configured")
        } catch {
            log("Audio session error: \(error.localizedDescription)")
        }
    }

    // MARK: - Recording Controls
    private func toggleRecording() {
        if isRecording {
            recorder.stop()
            isRecording = false
            log("🛑 Recording stopped")
            Task { await transcribeAndHandle() }
        } else {
            do {
                try recorder.start()
                isRecording = true
                transcript = ""
                log("🎙️ Recording started")
            } catch {
                log("Recording error: \(error.localizedDescription)")
            }
        }
    }

    private func resetRecording() {
        recorder.reset()
        isRecording = false
        isTranscribing = false
        isProcessing = false
        transcript = ""
        assistantReply = ""
        log("Recording reset")
    }

    // MARK: - ASR + Agent + TTS Pipeline
    private func transcribeAndHandle() async {
        guard let fileURL = recorder.outputURL else {
            log("No audio file")
            return
        }

        guard let asrURL = URL(string: serverURLString)?.appendingPathComponent("asr") else {
            log("Bad ASR URL")
            return
        }

        isTranscribing = true
        isProcessing = true
        do {
            let asrClient = ASRClient(serverURL: asrURL)
            let response = try await asrClient.transcribe(fileURL: fileURL)
            transcript = response.text
            log("ASR → \(response.text)")
            isTranscribing = false
            await handleAgent(text: response.text)
        } catch {
            log("ASR error: \(error.localizedDescription)")
            isProcessing = false
            isTranscribing = false
        }
    }

    private func handleAgent(text: String) async {
        guard let url = URL(string: serverURLString)?.appendingPathComponent("agent") else {
            log("Invalid Agent URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["text": text])

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let agentReply = try JSONDecoder().decode(SimpleAgentReply.self, from: data)
            assistantReply = agentReply.reply
            log("Agent → \(assistantReply)")
            if let parsed = try? JSONDecoder().decode([WorkOrder].self, from: data) {
                workOrders = parsed
            }
            await playTTS(assistantReply)
        } catch {
            log("Agent error: \(error.localizedDescription)")
            isProcessing = false
        }
    }

    private func playTTS(_ text: String) async {
        guard let base = URL(string: serverURLString) else { return }
        let ttsClient = TTSClient(baseServerURL: base)
        do {
            let (url, _) = try await ttsClient.speak(text: text)
            player = AVPlayer(url: url)
            player?.play()
            lastTTSURL = url
            log("🔊 Playing TTS")
        } catch {
            log("TTS error: \(error.localizedDescription)")
        }
        isProcessing = false
    }

    private func replayTTS(_ url: URL) {
        player = AVPlayer(url: url)
        player?.play()
        log("🔁 Replaying last TTS")
    }
}

private struct SimpleAgentReply: Codable {
    let reply: String
}
