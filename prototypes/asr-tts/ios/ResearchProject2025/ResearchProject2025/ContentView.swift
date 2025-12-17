import SwiftUI
import AVFoundation

struct AgentReply: Codable {
    let reply: String
    let json: [[String: AnyCodable]]? // not used directly, but kept for future
}

// Simple wrapper so we can decode unknown JSON if needed later
struct AnyCodable: Codable {}

struct ChatMessage: Identifiable, Codable {
    enum Role: String, Codable {
        case user
        case assistant
    }

    let id: UUID
    let role: Role
    let text: String

    init(role: Role, text: String) {
        self.id = UUID()
        self.role = role
        self.text = text
    }
}

struct ContentView: View {
    @State private var isRecording = false
    @State private var transcript: String = ""
    @State private var errorMessage: String = ""
    @State private var isTranscribing = false
    @State private var isSpeaking = false

    @State private var debugLog: String = ""
    @State private var fullJSONString: String = ""

    @State private var player: AVPlayer?
    @State private var lastTTSURL: URL? = nil

    @State private var chatHistory: [ChatMessage] = []

    private let recorder = AudioRecorder()
    @State private var serverURLString: String = "http://10.57.0.101:3000"

    private let historyKey = "VoiceWOChatHistory"

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 14) {

                    // 🔥 NEW TITLE
                    Text("ASR → Agent → TTS")
                        .font(.title)
                        .bold()
                        .padding(.top, 12)

                    Text("Voice Work Orders")
                        .font(.headline)
                        .foregroundColor(.secondary)

                    // Chat history
                    if !chatHistory.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Chat History")
                                .font(.headline)

                            ScrollView {
                                VStack(alignment: .leading, spacing: 8) {
                                    ForEach(chatHistory) { msg in
                                        HStack {
                                            if msg.role == .assistant { Spacer() }
                                            Text(msg.text)
                                                .padding(8)
                                                .background(msg.role == .user ? Color.blue.opacity(0.1) : Color.green.opacity(0.1))
                                                .cornerRadius(8)
                                            if msg.role == .user { Spacer() }
                                        }
                                    }
                                }
                                .padding(8)
                            }
                            .frame(height: 200)
                            .background(Color(.systemGray6))
                            .cornerRadius(8)
                        }
                    }

                    HStack {
                        Button(isRecording ? "Stop" : "Record") {
                            toggleRecording()
                        }
                        .buttonStyle(.borderedProminent)

                    }

                    if let last = lastTTSURL {
                        Button("Replay Last TTS") {
                            replayTTS(from: last)
                        }
                        .buttonStyle(.bordered)
                    }

                    if !fullJSONString.isEmpty {
                        VStack(alignment: .leading) {
                            Text("Full Raw Agent Response JSON")
                                .font(.headline)
                            ScrollView {
                                Text(fullJSONString)
                                    .font(.system(size: 11, design: .monospaced))
                                    .padding(6)
                            }
                            .frame(height: 140)
                            .background(Color(.systemGray6))
                            .cornerRadius(8)
                        }
                    }

                    if !debugLog.isEmpty {
                        VStack(alignment: .leading) {
                            Text("Debug Log")
                                .font(.headline)
                            ScrollView {
                                Text(debugLog)
                                    .font(.system(size: 11, design: .monospaced))
                                    .padding(6)
                            }
                            .frame(height: 120)
                            .background(Color(.systemGray6))
                            .cornerRadius(8)
                        }
                    }

                }
                .padding()
            }
            .navigationBarHidden(true)   // cleaner header
            .onAppear {
                configureAudioSession()   // Ensures mic works while screen recording
                loadHistory()
                startRecordingOnLaunch()
            }
        }
    }

    // MARK: - Recording

    private func configureAudioSession() {
        let audioSession = AVAudioSession.sharedInstance()

        do {
            // Use .playAndRecord category with options to allow Bluetooth and AirPlay
            try audioSession.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth, .allowAirPlay])

            // Activate the session
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            // This ensures that other apps, like screen recording, can also use the mic
            print("Audio session configured successfully.")
        } catch {
            print("Failed to configure audio session: \(error.localizedDescription)")
        }
    }

    private func startRecordingOnLaunch() {
        do {
            try recorder.start()
            isRecording = true
            transcript = ""
            debugLog += "🎙️ Auto recording started on launch.\n"
        } catch {
            debugLog += "Failed to start recording on launch: \(error.localizedDescription)\n"
        }
    }

    private func toggleRecording() {
        if isRecording {
            // STOP RECORDING
            recorder.stop()
            isRecording = false
            debugLog += "🛑 Recording stopped.\n"

            // ✅ Immediately transcribe after stopping
            Task {
                transcribeAndHandle()
            }

        } else {
            // START RECORDING
            do {
                try recorder.start()
                isRecording = true
                transcript = ""
                debugLog += "🎙️ Recording started.\n"
            } catch {
                debugLog += "Recording error: \(error.localizedDescription)\n"
            }
        }
    }

    // MARK: - ASR + Agent combo

    private func transcribeAndHandle() {
        guard let fileURL = recorder.outputURL else {
            debugLog += "No recording available.\n"
            return
        }
        guard let url = URL(string: serverURLString)?
            .appendingPathComponent("asr") else {
            debugLog += "Invalid ASR URL.\n"
            return
        }

        isTranscribing = true

        Task {
            do {
                let client = ASRClient(serverURL: url)
                let response = try await client.transcribe(fileURL: fileURL)
                transcript = response.text
                debugLog += "ASR → \(response.text)\n"
                isTranscribing = false

                appendMessage(role: .user, text: response.text)
                await handleAgent(for: response.text)

            } catch {
                debugLog += "ASR error: \(error.localizedDescription)\n"
                isTranscribing = false
            }
        }
    }

    // MARK: - Agent

    @MainActor
    private func handleAgent(for text: String) async {
        guard let url = URL(string: serverURLString)?
            .appendingPathComponent("agent") else {
            debugLog += "Invalid agent URL.\n"
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["text": text])

        do {
            let (data, _) = try await URLSession.shared.data(for: request)

            fullJSONString = String(data: data, encoding: .utf8) ?? ""

            struct SimpleAgentReply: Codable { let reply: String }
            let simple = try JSONDecoder().decode(SimpleAgentReply.self, from: data)

            let replyText = simple.reply
            debugLog += "Agent → \(replyText)\n"

            appendMessage(role: .assistant, text: replyText)
            await playTTS(replyText)

        } catch {
            debugLog += "Agent error: \(error.localizedDescription)\n"
        }
    }

    // MARK: - TTS

    @MainActor
    private func playTTS(_ text: String) async {
        guard let base = URL(string: serverURLString) else {
            debugLog += "Invalid TTS server URL.\n"
            return
        }

        let ttsClient = TTSClient(baseServerURL: base)
        do {
            let (url, _) = try await ttsClient.speak(text: text)
            player = AVPlayer(url: url)
            player?.play()
            lastTTSURL = url
            debugLog += "🔊 Playing TTS.\n"
        } catch {
            debugLog += "TTS error: \(error.localizedDescription)\n"
        }
    }

    private func replayTTS(from url: URL) {
        player = AVPlayer(url: url)
        player?.play()
        debugLog += "🔁 Replaying last TTS.\n"
    }

    // MARK: - Chat history

    private func appendMessage(role: ChatMessage.Role, text: String) {
        let msg = ChatMessage(role: role, text: text)
        chatHistory.append(msg)
        saveHistory()
    }

    private func saveHistory() {
        do {
            let data = try JSONEncoder().encode(chatHistory)
            UserDefaults.standard.set(data, forKey: historyKey)
        } catch {
            debugLog += "Failed to save history: \(error.localizedDescription)\n"
        }
    }

    private func loadHistory() {
        if let data = UserDefaults.standard.data(forKey: historyKey) {
            do {
                let decoded = try JSONDecoder().decode([ChatMessage].self, from: data)
                chatHistory = decoded
            } catch {
                debugLog += "Failed to load history: \(error.localizedDescription)\n"
            }
        }
    }
}
