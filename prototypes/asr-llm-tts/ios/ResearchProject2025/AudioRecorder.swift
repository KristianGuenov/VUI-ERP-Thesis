import Foundation
import AVFoundation
import Combine

@MainActor
final class AudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {

    @Published private(set) var outputURL: URL?

    private var recorder: AVAudioRecorder?

    func start() throws {
        reset()

        let dir = FileManager.default.temporaryDirectory
        let url = dir.appendingPathComponent("recording-\(UUID().uuidString).m4a")

        // AAC in M4A container (reliably supported by OpenAI transcription)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 128_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        let rec = try AVAudioRecorder(url: url, settings: settings)
        rec.delegate = self
        rec.isMeteringEnabled = false
        rec.prepareToRecord()
        rec.record()

        recorder = rec
        outputURL = url
    }

    func stop() {
        recorder?.stop()
        recorder = nil
        // outputURL remains so the client can upload it
    }

    func reset() {
        // Stop any ongoing recording
        recorder?.stop()
        recorder = nil

        // Delete the last file if it exists
        if let url = outputURL {
            try? FileManager.default.removeItem(at: url)
        }

        outputURL = nil
    }
}
