//
//  AudioRecorder.swift
//  ResearchProject2025
//
//  Created by Kristian on 10.11.25.
//


//
//  Untitled.swift
//  ASRProject_V1.01
//
//  Created by user286676 on 10/29/25.
//

import AVFoundation

final class AudioRecorder: NSObject {
    // MARK: - Properties
    private var recorder: AVAudioRecorder?
    private(set) var outputURL: URL?

    // MARK: - Recording control
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord,
                                mode: .spokenAudio,
                                options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)

        // temporary file location
        let tmp = FileManager.default.temporaryDirectory
        let url = tmp.appendingPathComponent(UUID().uuidString).appendingPathExtension("m4a")
        outputURL = url

        // audio settings
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        // create & start the recorder
        recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder?.record()
    }

    func stop() {
        recorder?.stop()
        recorder = nil
    }
}

