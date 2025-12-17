import SwiftUI
import Accelerate
import Combine
@preconcurrency import Speech
@preconcurrency import AVFoundation

enum SessionState {
    case active
    case idleGated
    case off
}

@MainActor
final class VoiceChatViewModel: ObservableObject {
    private let audioEngine = AVAudioEngine()
    private let playbackEngine = AVAudioEngine()
    private var playbackPlayer = AVAudioPlayerNode()

    private let server = "http://10.4.4.149:3000"

    // MARK: - Published state for UI
    @Published var isAIPlaying: Bool = false
    @Published var fullResponseText: String = ""
    @Published var currentTranscript: String = ""
    @Published var userTranscript: String = ""

    @Published var isRunning = false
    @Published var status = "Idle"
    @Published var logs: [String] = []

    @Published var sessionState: SessionState = .active

    // MARK: - Internal state
    private var isStreaming = false
    private var isProcessing = false
    private var pendingAudioData = Data()

    // VAD
    private var isRecordingSpeech = false
    private var speechEndTime: Date?
    private let baseSpeechThreshold: Float = 0.05

    private var noiseFloorRMS: Float = 0.0
    private let noiseAlpha: Float = 0.05
    private let minDynamicThreshold: Float = 0.01
    private let maxDynamicThreshold: Float = 0.15

    private let silenceGrace: TimeInterval = 2.5
    private var awaitingUserReply = false
    private var finalizeUtteranceWorkItem: DispatchWorkItem?

    // MARK: - Inactivity defaults
    private let idleAfterSeconds: TimeInterval = 60
    private let hardStopAfterSeconds: TimeInterval = 600

    private var idleWorkItem: DispatchWorkItem?
    private var hardStopWorkItem: DispatchWorkItem?

    // MARK: - Wake word
    private let wakeWord = "assistant"

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var speechAuthGranted = false
    private var wakeRequest: SFSpeechAudioBufferRecognitionRequest?
    private var wakeTask: SFSpeechRecognitionTask?
    private var isWakeListening = false
    private var lastWakeFireAt: Date = .distantPast
    private let wakeDebounceSeconds: TimeInterval = 2.0

    // MARK: - Status strings
    private let statusListening = "🎙️ Listening..."
    private let statusThinking = "🧠 Thinking..."
    private let statusStopped = "Stopped"
    private let statusIdleAuto = "Idle (say “Assistant” to continue)"
    private let statusIdleTaskFinished = "Idle (task finished – say “Assistant” to continue)"

    // MARK: - Lifecycle

    func startConversation() {
        sessionState = .active

        if !isStreaming {
            listenToServer()
            isStreaming = true
        }

        ensureSpeechAuthorization()
        startMic()

        isRunning = true
        status = statusListening
        logEssential("Listening started")

        scheduleInactivityTimers()
        stopWakeWordListeningIfNeeded()
    }

    func stopConversation() {
        sessionState = .off
        cancelInactivityTimers()
        stopWakeWordListeningIfNeeded()

        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }

        isRecordingSpeech = false
        speechEndTime = nil
        finalizeUtteranceWorkItem?.cancel()
        finalizeUtteranceWorkItem = nil
        pendingAudioData.removeAll()

        isRunning = false
        status = statusStopped
        logEssential("Stopped (hard termination)")
    }

    // MARK: - Essential logging only

    private func logEssential(_ message: String) {
        logs.append("[\(Self.timestamp())] \(message)")
    }

    private static func timestamp() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: Date())
    }

    // MARK: - Speech authorization

    private func ensureSpeechAuthorization() {
        guard !speechAuthGranted else { return }

        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            Task { @MainActor in
                guard let self else { return }
                if authStatus == .authorized {
                    self.speechAuthGranted = true
                    self.logEssential("Speech recognition enabled (wake word ready)")
                } else {
                    self.speechAuthGranted = false
                    self.logEssential("Speech recognition denied; wake word will not work")
                }
            }
        }
    }

    // MARK: - Wake listening

    private func startWakeWordListeningIfNeeded() {
        guard sessionState == .idleGated else { return }
        guard speechAuthGranted else { return }
        guard !isWakeListening else { return }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation

        wakeRequest = req
        isWakeListening = true

        wakeTask = speechRecognizer?.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }

            if let error {
                Task { @MainActor in
                    self.logEssential("Wake-word recognizer error: \(error.localizedDescription)")
                    self.stopWakeWordListeningIfNeeded()
                    if self.sessionState == .idleGated {
                        self.startWakeWordListeningIfNeeded()
                    }
                }
                return
            }

            guard let result else { return }
            let text = result.bestTranscription.formattedString.lowercased()

            if text.contains(self.wakeWord) {
                let now = Date()
                if now.timeIntervalSince(self.lastWakeFireAt) < self.wakeDebounceSeconds { return }
                self.lastWakeFireAt = now

                Task { @MainActor in
                    self.logEssential("Wake word detected: “Assistant”")
                    self.exitIdleToActive()
                }
            }
        }

        logEssential("Idle gated (wake word listening)")
    }

    private func stopWakeWordListeningIfNeeded() {
        guard isWakeListening else { return }
        wakeTask?.cancel()
        wakeTask = nil
        wakeRequest?.endAudio()
        wakeRequest = nil
        isWakeListening = false
    }

    private func exitIdleToActive() {
        stopWakeWordListeningIfNeeded()

        sessionState = .active
        status = statusListening

        isRecordingSpeech = false
        speechEndTime = nil
        finalizeUtteranceWorkItem?.cancel()
        finalizeUtteranceWorkItem = nil

        scheduleInactivityTimers()
    }

    // MARK: - Inactivity timers

    private func scheduleInactivityTimers() {
        guard sessionState != .off else { return }

        idleWorkItem?.cancel()
        hardStopWorkItem?.cancel()

        let idleItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                guard self.sessionState != .off else { return }
                if self.sessionState == .active {
                    self.sessionState = .idleGated
                    self.status = self.statusIdleAuto
                    self.logEssential("Auto-idle after \(Int(self.idleAfterSeconds))s inactivity")
                    self.startWakeWordListeningIfNeeded()
                }
            }
        }

        let hardItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                guard self.sessionState != .off else { return }
                self.logEssential("Auto hard-stop after \(Int(self.hardStopAfterSeconds))s inactivity")
                self.stopConversation()
            }
        }

        idleWorkItem = idleItem
        hardStopWorkItem = hardItem

        DispatchQueue.global().asyncAfter(deadline: .now() + idleAfterSeconds, execute: idleItem)
        DispatchQueue.global().asyncAfter(deadline: .now() + hardStopAfterSeconds, execute: hardItem)
    }

    private func cancelInactivityTimers() {
        idleWorkItem?.cancel()
        hardStopWorkItem?.cancel()
        idleWorkItem = nil
        hardStopWorkItem = nil
    }

    // MARK: - VAD threshold

    private func currentVADThreshold() -> Float {
        let base = max(noiseFloorRMS * 3.0, baseSpeechThreshold)
        return min(max(base, minDynamicThreshold), maxDynamicThreshold)
    }

    // MARK: - Microphone tap

    private func startMic() {
        let input = audioEngine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)

        var recordedData = Data()

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            if self.isAIPlaying { return }
            guard let channel = buffer.floatChannelData?[0] else { return }

            // Idle gated: feed wake recognizer only; do not send to server.
            if self.sessionState == .idleGated {
                Task { @MainActor in self.startWakeWordListeningIfNeeded() }
                self.wakeRequest?.append(buffer)
                return
            }

            let frameCount = Int(buffer.frameLength)
            let rms = vDSP.rootMeanSquare(UnsafeBufferPointer(start: channel, count: frameCount))
            let now = Date()

            if !self.isRecordingSpeech {
                let alpha = self.noiseAlpha
                self.noiseFloorRMS = (1 - alpha) * self.noiseFloorRMS + alpha * rms
            }

            let threshold = self.currentVADThreshold()

            if rms > threshold && !self.isRecordingSpeech {
                self.isRecordingSpeech = true
                self.finalizeUtteranceWorkItem?.cancel()
                self.finalizeUtteranceWorkItem = nil
            }

            if self.isRecordingSpeech, let pcmChunk = self.convertBufferToPCM16(buffer) {
                recordedData.append(pcmChunk)
            }

            if self.isRecordingSpeech && rms < threshold {
                if self.speechEndTime == nil { self.speechEndTime = now }

                if let end = self.speechEndTime,
                   now.timeIntervalSince(end) > self.silenceGrace {

                    self.isRecordingSpeech = false
                    self.speechEndTime = nil

                    let payload = recordedData
                    recordedData.removeAll()

                    guard payload.count > 8000 else { return }

                    let workItem = DispatchWorkItem { [weak self] in
                        guard let self else { return }
                        if !self.isRecordingSpeech {
                            Task { @MainActor in
                                self.status = self.statusThinking
                                self.scheduleInactivityTimers()
                            }
                            Task { await self.flushAudio(payload) }
                        }
                    }

                    self.finalizeUtteranceWorkItem?.cancel()
                    self.finalizeUtteranceWorkItem = workItem
                    DispatchQueue.global().asyncAfter(deadline: .now() + 1.2, execute: workItem)
                }
            } else {
                self.speechEndTime = nil
            }
        }

        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, options: [.defaultToSpeaker])
            try AVAudioSession.sharedInstance().setActive(true)
            try audioEngine.start()
        } catch {
            Task { @MainActor in self.logEssential("Audio engine error: \(error.localizedDescription)") }
        }
    }

    // MARK: - Conversion (Float32 → PCM16 mono 24kHz)

    private func convertBufferToPCM16(_ buffer: AVAudioPCMBuffer) -> Data? {
        let sourceFormat = buffer.format
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: 24000,
                                               channels: 1,
                                               interleaved: true) else { return nil }

        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat),
              let dstBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat,
                                               frameCapacity: buffer.frameCapacity) else { return nil }

        var error: NSError?
        converter.convert(to: dstBuffer, error: &error) { _, outStatus in
            outStatus.pointee = .haveData
            return buffer
        }

        if let e = error {
            Task { @MainActor in self.logEssential("Audio conversion error: \(e.localizedDescription)") }
            return nil
        }

        guard let int16ptr = dstBuffer.int16ChannelData?[0] else { return nil }
        return Data(bytes: int16ptr,
                    count: Int(dstBuffer.frameLength) * MemoryLayout<Int16>.size)
    }

    // MARK: - Send audio to server

    private func flushAudio(_ data: Data) async {
        guard !data.isEmpty, data.count > 8000 else { return }

        // Reset inactivity timers on meaningful interaction
        await MainActor.run { self.scheduleInactivityTimers() }

        let base64 = data.base64EncodedString()
        do {
            // /audio
            var req = URLRequest(url: URL(string: "\(server)/audio")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["base64": base64])

            let (audioData, resp) = try await URLSession.shared.data(for: req)
            if let r = resp as? HTTPURLResponse, r.statusCode != 200 {
                await MainActor.run {
                    self.logEssential("Server /audio error: \(String(data: audioData, encoding: .utf8) ?? "unknown")")
                }
            }

            // /respond
            var respond = URLRequest(url: URL(string: "\(server)/respond")!)
            respond.httpMethod = "POST"
            let (data2, resp2) = try await URLSession.shared.data(for: respond)
            if let r = resp2 as? HTTPURLResponse, r.statusCode == 200 {
                await MainActor.run {
                    self.awaitingUserReply = true
                    self.userTranscript = ""
                }
            } else {
                await MainActor.run {
                    self.logEssential("Failed to trigger model response: \(String(data: data2, encoding: .utf8) ?? "unknown")")
                }
            }
        } catch {
            await MainActor.run { self.logEssential("Network error: \(error.localizedDescription)") }
        }
    }

    // MARK: - SSE stream

    private func listenToServer() {
        guard let url = URL(string: "\(server)/stream") else { return }

        Task.detached { [weak self] in
            while let self = self {
                do {
                    let (bytes, _) = try await URLSession.shared.bytes(from: url)
                    var buffer = Data()
                    for try await chunk in bytes {
                        buffer.append(chunk)
                        while let range = buffer.range(of: Data("\n\n".utf8)) {
                            let messageData = buffer.subdata(in: 0..<range.lowerBound)
                            buffer.removeSubrange(0..<range.upperBound)
                            if let text = String(data: messageData, encoding: .utf8),
                               text.hasPrefix("data:") {
                                let payload = String(text.dropFirst(5))
                                await self.handleServerMessage(payload)
                            }
                        }
                    }
                } catch {
                    await MainActor.run {
                        self.logEssential("Stream disconnected; reconnecting…")
                    }
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
        }
    }

    // MARK: - Handle SSE events (essential behavior only)

    private func handleServerMessage(_ json: String) async {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = dict["type"] as? String else { return }

        // Server control: soft/hard termination
        if type == "session.control" {
            let mode = dict["mode"] as? String ?? ""
            await MainActor.run {
                switch mode {
                case "soft_end":
                    self.handleSoftEnd(reason: dict["reason"] as? String)
                case "hard_end":
                    self.handleHardEnd(reason: dict["reason"] as? String)
                default:
                    self.logEssential("Unknown control event: \(mode)")
                }
                self.scheduleInactivityTimers()
            }
            return
        }

        // Audio
        if type == "response.audio.delta" {
            if audioEngine.isRunning {
                audioEngine.pause()
                await MainActor.run { self.isAIPlaying = true }
            }
            if let base64 = dict["delta"] as? String,
               let audioData = Data(base64Encoded: base64) {
                pendingAudioData.append(audioData)
            }
            return
        }

        // Transcript deltas
        if type == "response.audio_transcript.delta",
           let text = dict["delta"] as? String {
            if awaitingUserReply && !isAIPlaying {
                await MainActor.run { self.userTranscript = text }
                return
            }
            await MainActor.run { self.currentTranscript = text }
            return
        }

        // Transcript done
        if type == "response.audio_transcript.done",
           let transcript = dict["transcript"] as? String {
            if awaitingUserReply && !isAIPlaying {
                await MainActor.run {
                    self.userTranscript = transcript
                    self.awaitingUserReply = false
                    self.scheduleInactivityTimers()
                }
                return
            }
            await MainActor.run {
                self.fullResponseText = transcript
                self.currentTranscript = transcript
            }
            return
        }

        // Done
        if type == "response.done" {
            await MainActor.run {
                guard !self.isProcessing else { return }
                self.isProcessing = true
                self.scheduleInactivityTimers()

                if !self.pendingAudioData.isEmpty {
                    self.playAudioChunk(self.pendingAudioData)
                    self.pendingAudioData.removeAll()
                } else {
                    self.isAIPlaying = false
                    if !self.audioEngine.isRunning && self.sessionState != .off {
                        do { try self.audioEngine.start() }
                        catch { self.logEssential("Mic resume error: \(error.localizedDescription)") }
                    }
                    self.isProcessing = false
                    self.status = self.sessionState == .active
                        ? self.statusListening
                        : (self.sessionState == .idleGated ? self.statusIdleAuto : self.statusStopped)
                }
            }
            return
        }
    }

    // MARK: - Playback

    private func playAudioChunk(_ data: Data) {
        Task { @MainActor in self.isAIPlaying = true }

        if playbackPlayer.engine == nil {
            playbackEngine.attach(playbackPlayer)
            let mixerFormat = playbackEngine.mainMixerNode.outputFormat(forBus: 0)
            playbackEngine.connect(playbackPlayer, to: playbackEngine.mainMixerNode, format: mixerFormat)
            do { try playbackEngine.start() }
            catch {
                Task { @MainActor in self.logEssential("Playback engine error: \(error.localizedDescription)") }
                return
            }
        }

        let player = playbackPlayer
        let srcRate: Double = 24000
        let srcChannels: AVAudioChannelCount = 1
        let srcFrameCount = UInt32(data.count) / 2

        guard let srcFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: srcRate,
                                            channels: srcChannels,
                                            interleaved: true),
              let srcBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat,
                                               frameCapacity: srcFrameCount) else { return }

        srcBuffer.frameLength = srcFrameCount
        data.withUnsafeBytes { rawPtr in
            guard let base = rawPtr.baseAddress else { return }
            memcpy(srcBuffer.int16ChannelData![0], base, Int(srcFrameCount) * MemoryLayout<Int16>.size)
        }

        let dstFormat = playbackEngine.mainMixerNode.outputFormat(forBus: 0)

        if srcFormat.sampleRate == dstFormat.sampleRate &&
            srcFormat.channelCount == dstFormat.channelCount {

            player.scheduleBuffer(srcBuffer, at: nil, options: []) {
                Task { @MainActor [weak self] in self?.handlePlaybackFinished() }
            }
        } else {
            let sampleRateRatio = dstFormat.sampleRate / srcFormat.sampleRate
            let dstCapacityFrames = AVAudioFrameCount(Double(srcBuffer.frameLength) * sampleRateRatio + 1024)

            guard let dstBuffer = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: dstCapacityFrames),
                  let converter = AVAudioConverter(from: srcFormat, to: dstFormat) else {
                Task { @MainActor in self.logEssential("Playback conversion setup failed") }
                return
            }

            var error: NSError?
            converter.convert(to: dstBuffer, error: &error) { _, outStatus in
                outStatus.pointee = .haveData
                return srcBuffer
            }

            if let e = error {
                Task { @MainActor in self.logEssential("Playback conversion error: \(e.localizedDescription)") }
                return
            }

            player.scheduleBuffer(dstBuffer, at: nil, options: []) {
                Task { @MainActor [weak self] in self?.handlePlaybackFinished() }
            }
        }

        if !player.isPlaying { player.play() }
    }

    private func handlePlaybackFinished() {
        self.isAIPlaying = false
        self.scheduleInactivityTimers()

        if !self.audioEngine.isRunning && self.sessionState != .off {
            do { try self.audioEngine.start() }
            catch { self.logEssential("Mic resume error: \(error.localizedDescription)") }
        }

        self.isProcessing = false
        self.status = self.sessionState == .active
            ? self.statusListening
            : (self.sessionState == .idleGated ? self.statusIdleAuto : self.statusStopped)
    }

    // MARK: - Server control

    private func handleSoftEnd(reason: String?) {
        sessionState = .idleGated
        status = statusIdleTaskFinished
        logEssential("Soft termination received" + (reason != nil ? ": \(reason!)" : ""))

        startWakeWordListeningIfNeeded()
    }

    private func handleHardEnd(reason: String?) {
        logEssential("Hard termination received" + (reason != nil ? ": \(reason!)" : ""))
        stopConversation()
    }
}
