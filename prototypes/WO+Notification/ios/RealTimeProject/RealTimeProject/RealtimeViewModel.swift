import SwiftUI
import Accelerate
import Combine
@preconcurrency import Speech
@preconcurrency import AVFoundation
@preconcurrency import AVFAudio

enum SessionState {
    case active
    case idleGated
    case off
}

struct NotificationPhotoRequest: Identifiable, Equatable {
    var id: String { requestId }
    let requestId: String
    let reason: String
}

struct NotificationQRRequest: Identifiable, Equatable {
    var id: String { requestId }
    let requestId: String
    let reason: String
}

@MainActor
final class VoiceChatViewModel: ObservableObject {

    private let audioEngine = AVAudioEngine()
    private let playbackEngine = AVAudioEngine()
    private var playbackPlayer = AVAudioPlayerNode()

    // IMPORTANT: keep your server IP here
    private let server = "http://10.4.4.148:3000"
    var serverBaseURL: String { server }

    // MARK: - Published state for UI
    @Published var isAIPlaying: Bool = false
    @Published var fullResponseText: String = ""
    @Published var currentTranscript: String = ""
    @Published var userTranscript: String = ""

    @Published var isRunning = false
    @Published var status = "Idle"
    @Published var logs: [String] = []

    @Published var sessionState: SessionState = .active

    // MARK: - Notifications (server-driven)
    @Published var notificationServerMode: String = "minimal"
    @Published var notificationMissingRequired: [String] = []
    @Published var notificationLastActionSummary: String = ""
    @Published var notificationLatestDraft: NotificationDraft? = nil
    @Published var notificationLatestJSONPretty: String = ""

    @Published var notificationPhotoRequest: NotificationPhotoRequest? = nil
    @Published var notificationQRRequest: NotificationQRRequest? = nil

    // upload/remove status for UI
    @Published var notificationUploadInFlight: Bool = false
    @Published var notificationUploadError: String? = nil

    // NEW (Step 6): Vision fallback results from SSE "notification.vision_result"
    @Published var notificationVisionResults: [NotificationVisionResult] = []

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

    private let silenceGrace: TimeInterval = 1.4

    private var awaitingUserReply = false
    private var finalizeUtteranceWorkItem: DispatchWorkItem?

    // Inactivity defaults
    private let idleAfterSeconds: TimeInterval = 60
    private let hardStopAfterSeconds: TimeInterval = 600

    private var idleWorkItem: DispatchWorkItem?
    private var hardStopWorkItem: DispatchWorkItem?

    // Wake word
    private let wakeWord = "assistant"

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var speechAuthGranted = false
    private var wakeRequest: SFSpeechAudioBufferRecognitionRequest?
    private var wakeTask: SFSpeechRecognitionTask?
    private var isWakeListening = false
    private var lastWakeFireAt: Date = .distantPast
    private let wakeDebounceSeconds: TimeInterval = 2.0

    // Status strings
    private let statusListening = "🎙️ Listening..."
    private let statusThinking = "🧠 Thinking..."
    private let statusStopped = "Stopped"
    private let statusIdleAuto = "Idle (say “Assistant” to continue)"

    // MARK: - Lifecycle

    func startConversation() {
        sessionState = .active

        if !isStreaming {
            listenToServer()
            isStreaming = true
        }

        ensureSpeechAuthorization()

        Task { @MainActor in
            let granted = await ensureMicrophonePermission()
            guard granted else {
                self.status = "Microphone permission denied"
                self.logEssential("Microphone permission denied; cannot start.")
                return
            }

            self.startMic()

            self.isRunning = true
            self.status = self.statusListening
            self.logEssential("Listening started")

            self.scheduleInactivityTimers()
            self.stopWakeWordListeningIfNeeded()
        }
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

    private func logEssential(_ message: String) {
        logs.append("[\(Self.timestamp())] \(message)")
    }

    private static func timestamp() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: Date())
    }

    // MARK: - Microphone permission (iOS 17+)

    private func ensureMicrophonePermission() async -> Bool {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return true
            case .denied: return false
            case .undetermined:
                return await withCheckedContinuation { cont in
                    AVAudioApplication.requestRecordPermission { granted in
                        cont.resume(returning: granted)
                    }
                }
            @unknown default: return false
            }
        } else {
            let session = AVAudioSession.sharedInstance()
            switch session.recordPermission {
            case .granted: return true
            case .denied: return false
            case .undetermined:
                return await withCheckedContinuation { cont in
                    session.requestRecordPermission { granted in
                        cont.resume(returning: granted)
                    }
                }
            @unknown default: return false
            }
        }
    }

    // MARK: - Notification REST calls

    func syncNotificationField(field: String, value: String?) async {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            await postJSON(path: "/notification/clear_field", body: ["field": field])
        } else {
            await postJSON(path: "/notification/set_field", body: ["field": field, "value": trimmed])
        }
    }

    /// Bulk-set multiple fields in one round-trip (faster, used by QR scan)
    func setNotificationFields(fields: [String: String]) async {
        await postJSON(path: "/notification/set_fields", body: ["fields": fields])
    }

    /// Ask server to resolve QR and apply to draft
    func applyQRCode(raw: String) async {
        await postJSON(path: "/notification/apply_qr", body: ["raw": raw])
    }

    func clearNotificationPhotoRequest() {
        notificationPhotoRequest = nil
    }

    func clearNotificationQRRequest() {
        notificationQRRequest = nil
    }

    func attachNotificationPhoto(image: UIImage,
                                 source: String,
                                 note: String? = nil,
                                 requestId: String? = nil,
                                 clientLocalId: String) async {

        notificationUploadError = nil
        notificationUploadInFlight = true
        defer { notificationUploadInFlight = false }

        let resized = image.resized(maxDimension: 1600) ?? image

        guard let jpeg = resized.jpegData(compressionQuality: 0.72) else {
            self.notificationUploadError = "Photo encode failed."
            self.logEssential("Photo encode failed (jpegData)")
            return
        }

        let base64 = jpeg.base64EncodedString()
        let filename = "photo_\(Int(Date().timeIntervalSince1970)).jpg"

        guard let url = URL(string: "\(server)/notification/attach_photo") else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "base64": base64,
            "mimeType": "image/jpeg",
            "filename": filename,
            "note": note ?? "",
            "clientLocalId": clientLocalId,
            "requestId": requestId ?? "",
            "source": source
        ]

        req.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [])

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1

            if !(200...299).contains(code) {
                let serverText = String(data: data, encoding: .utf8) ?? ""
                self.notificationUploadError = "Upload failed (HTTP \(code))."
                self.logEssential("POST /notification/attach_photo failed: HTTP \(code) \(serverText.prefix(240))")
            }
        } catch {
            self.notificationUploadError = "Upload failed: \(error.localizedDescription)"
            self.logEssential("POST /notification/attach_photo error: \(error.localizedDescription)")
        }
    }

    func removeNotificationPhoto(filename: String) async {
        notificationUploadError = nil
        notificationUploadInFlight = true
        defer { notificationUploadInFlight = false }

        guard let url = URL(string: "\(server)/notification/remove_photo") else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["filename": filename], options: [])

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if !(200...299).contains(code) {
                let serverText = String(data: data, encoding: .utf8) ?? ""
                self.notificationUploadError = "Remove failed (HTTP \(code))."
                self.logEssential("POST /notification/remove_photo failed: HTTP \(code) \(serverText.prefix(240))")
            }
        } catch {
            self.notificationUploadError = "Remove failed: \(error.localizedDescription)"
            self.logEssential("POST /notification/remove_photo error: \(error.localizedDescription)")
        }
    }

    // IMPORTANT: keep this callable by views (not private)
    func postJSON(path: String, body: [String: Any]) async {
        guard let url = URL(string: "\(server)\(path)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [])

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if !(200...299).contains(code) {
                let serverText = String(data: data, encoding: .utf8) ?? ""
                self.logEssential("POST \(path) failed: HTTP \(code) \(serverText.prefix(240))")
            }
        } catch {
            self.logEssential("POST \(path) error: \(error.localizedDescription)")
        }
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
        let session = AVAudioSession.sharedInstance()

        let input = audioEngine.inputNode
        input.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.reset()

        var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .mixWithOthers]
        if #available(iOS 17.0, *) {
            options.insert(.allowBluetoothA2DP)
        } else {
            options.insert(.allowBluetooth)
            options.insert(.allowBluetoothA2DP)
        }

        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        } catch {
            do {
                try session.setCategory(.playAndRecord, mode: .measurement, options: options)
            } catch {
                logEssential("Audio session setCategory failed: \(error.localizedDescription)")
                return
            }
        }

        do {
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            logEssential("Audio session setActive failed: \(error.localizedDescription)")
            return
        }

        guard session.isInputAvailable else {
            logEssential("No audio input available.")
            status = "No microphone input available"
            return
        }
        if session.inputNumberOfChannels == 0 {
            logEssential("Microphone input has 0 channels.")
            status = "Microphone unavailable (0 channels)"
            return
        }

        var recordedData = Data()

        // IMPORTANT: install tap with format:nil to avoid format assertions
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            guard let self else { return }
            if self.isAIPlaying { return }

            if self.sessionState == .idleGated {
                Task { @MainActor in self.startWakeWordListeningIfNeeded() }
                self.wakeRequest?.append(buffer)
                return
            }

            let now = Date()

            let rms: Float
            if let ch0 = buffer.floatChannelData?[0] {
                let frameCount = Int(buffer.frameLength)
                rms = vDSP.rootMeanSquare(UnsafeBufferPointer(start: ch0, count: frameCount))
            } else if let i16 = buffer.int16ChannelData?[0] {
                let frameCount = Int(buffer.frameLength)
                var floats = [Float](repeating: 0, count: frameCount)
                vDSP_vflt16(i16, 1, &floats, 1, vDSP_Length(frameCount))
                var scale: Float = 1.0 / Float(Int16.max)
                vDSP_vsmul(floats, 1, &scale, &floats, 1, vDSP_Length(frameCount))
                rms = vDSP.rootMeanSquare(floats)
            } else {
                return
            }

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
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5, execute: workItem)
                }
            } else {
                self.speechEndTime = nil
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            logEssential("Audio engine start error: \(error.localizedDescription)")
            status = "Mic start failed"
        }
    }

    // MARK: - Conversion (source → PCM16 mono 24kHz)

    private func convertBufferToPCM16(_ buffer: AVAudioPCMBuffer) -> Data? {
        let sourceFormat = buffer.format
        guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0 else { return nil }

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

        await MainActor.run { self.scheduleInactivityTimers() }

        let base64 = data.base64EncodedString()
        do {
            var req = URLRequest(url: URL(string: "\(server)/audio")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["base64": base64])

            _ = try await URLSession.shared.data(for: req)

            var respond = URLRequest(url: URL(string: "\(server)/respond")!)
            respond.httpMethod = "POST"
            let (_, resp2) = try await URLSession.shared.data(for: respond)
            if let r = resp2 as? HTTPURLResponse, r.statusCode == 200 {
                await MainActor.run {
                    self.awaitingUserReply = true
                    self.userTranscript = ""
                }
            } else if let r = resp2 as? HTTPURLResponse {
                await MainActor.run { self.logEssential("Respond failed: HTTP \(r.statusCode)") }
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

    // MARK: - Notification decoding

    private func decodeNotificationDraft(from any: Any) -> NotificationDraft? {
        guard JSONSerialization.isValidJSONObject(any),
              let data = try? JSONSerialization.data(withJSONObject: any, options: []) else {
            return nil
        }
        return try? JSONDecoder().decode(NotificationDraft.self, from: data)
    }

    private func prettyJSONString(from any: Any) -> String {
        guard JSONSerialization.isValidJSONObject(any),
              let data = try? JSONSerialization.data(withJSONObject: any, options: [.prettyPrinted]),
              let s = String(data: data, encoding: .utf8) else {
            return ""
        }
        return s
    }

    // MARK: - Handle SSE events

    private func handleServerMessage(_ json: String) async {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = dict["type"] as? String else { return }

        if type == "notification.photo_request" {
            let requestId = (dict["requestId"] as? String) ?? ""
            let reason = (dict["reason"] as? String) ?? "Take a photo now"
            await MainActor.run {
                if !requestId.isEmpty {
                    self.notificationPhotoRequest = NotificationPhotoRequest(requestId: requestId, reason: reason)
                }
            }
            return
        }

        if type == "notification.qr_request" {
            let requestId = (dict["requestId"] as? String) ?? ""
            let reason = (dict["reason"] as? String) ?? "Scan QR code"
            await MainActor.run {
                if !requestId.isEmpty {
                    self.notificationQRRequest = NotificationQRRequest(requestId: requestId, reason: reason)
                }
            }
            return
        }

        if type == "notification.state" {
            await MainActor.run {
                self.notificationServerMode = (dict["mode"] as? String) ?? "minimal"
                self.notificationMissingRequired = (dict["missingRequired"] as? [String]) ?? []
                self.notificationLastActionSummary = (dict["actionSummary"] as? String) ?? ""

                if let draftObj = dict["draft"],
                   let decoded = self.decodeNotificationDraft(from: draftObj) {
                    self.notificationLatestDraft = decoded
                }
            }
            return
        }

        if type == "notification.created" {
            await MainActor.run {
                self.notificationServerMode = (dict["mode"] as? String) ?? "minimal"
                self.notificationMissingRequired = (dict["missingRequired"] as? [String]) ?? []
                self.notificationLastActionSummary = (dict["actionSummary"] as? String) ?? "Notification finalized."

                if let draftObj = dict["draft"],
                   let decoded = self.decodeNotificationDraft(from: draftObj) {
                    self.notificationLatestDraft = decoded
                }

                if let njson = dict["notificationJson"] {
                    self.notificationLatestJSONPretty = self.prettyJSONString(from: njson)
                }
            }
            return
        }

        // NEW (Step 6): Vision fallback event (decode from JSON, no dict initializer)
        if type == "notification.vision_result" {
            if let vr = try? JSONDecoder().decode(NotificationVisionResult.self, from: data) {
                await MainActor.run {
                    self.notificationVisionResults.insert(vr, at: 0)
                    if self.notificationVisionResults.count > 25 {
                        self.notificationVisionResults = Array(self.notificationVisionResults.prefix(25))
                    }
                }
            } else {
                await MainActor.run {
                    self.logEssential("notification.vision_result received but failed to decode")
                }
            }
            return
        }

        // Model audio events (unchanged behavior)
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

        if type == "response.audio_transcript.delta",
           let text = dict["delta"] as? String {
            if awaitingUserReply && !isAIPlaying {
                await MainActor.run { self.userTranscript = text }
                return
            }
            await MainActor.run { self.currentTranscript = text }
            return
        }

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
}

// MARK: - Image resize helper
private extension UIImage {
    func resized(maxDimension: CGFloat) -> UIImage? {
        let w = size.width
        let h = size.height
        guard w > 0, h > 0 else { return nil }

        let scale = min(maxDimension / w, maxDimension / h, 1.0)
        let newSize = CGSize(width: w * scale, height: h * scale)

        UIGraphicsBeginImageContextWithOptions(newSize, false, 1.0)
        defer { UIGraphicsEndImageContext() }
        draw(in: CGRect(origin: .zero, size: newSize))
        return UIGraphicsGetImageFromCurrentImageContext()
    }
}
