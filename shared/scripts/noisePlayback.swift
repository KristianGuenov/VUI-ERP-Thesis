#!/usr/bin/env swift

import AVFoundation
import Darwin
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2 else {
    fail("Usage: noisePlayback.swift <experiment-config.json>")
}

let configURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let configData: Data

do {
    configData = try Data(contentsOf: configURL)
} catch {
    fail("Unable to read experiment config: \(error.localizedDescription)")
}

guard
    let root = try? JSONSerialization.jsonObject(with: configData) as? [String: Any],
    let playback = root["playback"] as? [String: Any],
    let noise = root["noise"] as? [String: Any],
    let localFile = noise["localFile"] as? String,
    let playbackVolume = noise["playbackVolume"] as? Double,
    let noiseSha256 = noise["sha256"] as? String,
    let statusFile = noise["statusFile"] as? String,
    let outputVolume = playback["systemOutputVolumePercent"] as? Int,
    let outputDevice = playback["outputDevice"] as? String
else {
    fail("Noise playback settings are missing or invalid in \(configURL.path)")
}

guard FileManager.default.fileExists(atPath: localFile) else {
    fail("Industrial-noise file is missing: \(localFile)")
}

let statusURL = URL(fileURLWithPath: statusFile)
if let existingData = try? Data(contentsOf: statusURL),
   let existing = try? JSONSerialization.jsonObject(with: existingData) as? [String: Any],
   let existingPidNumber = existing["pid"] as? NSNumber,
   kill(existingPidNumber.int32Value, 0) == 0 {
    fail("Industrial-noise playback is already running with PID \(existingPidNumber.int32Value)")
}
try? FileManager.default.removeItem(at: statusURL)

func capture(_ executable: String, _ arguments: [String]) -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [executable] + arguments
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        fail("Unable to run \(executable): \(error.localizedDescription)")
    }
    guard process.terminationStatus == 0 else {
        fail("\(executable) exited with status \(process.terminationStatus)")
    }
    return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

let actualNoiseHash = capture("shasum", ["-a", "256", localFile])
    .split(separator: " ")
    .first
    .map(String.init) ?? ""
guard actualNoiseHash == noiseSha256 else {
    fail("Industrial-noise SHA-256 mismatch: expected \(noiseSha256), found \(actualNoiseHash)")
}

func run(_ executable: String, _ arguments: [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [executable] + arguments
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        fail("Unable to run \(executable): \(error.localizedDescription)")
    }
    guard process.terminationStatus == 0 else {
        fail("\(executable) exited with status \(process.terminationStatus)")
    }
}

run("SwitchAudioSource", ["-s", outputDevice, "-t", "output"])
run("osascript", ["-e", "set volume output volume \(outputVolume) without output muted"])

let player: AVAudioPlayer
do {
    player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: localFile))
} catch {
    fail("Unable to load industrial-noise audio: \(error.localizedDescription)")
}

player.volume = Float(playbackVolume)
player.numberOfLoops = -1
player.prepareToPlay()

guard player.play() else {
    fail("AVAudioPlayer refused to start industrial-noise playback")
}

let status: [String: Any] = [
    "pid": ProcessInfo.processInfo.processIdentifier,
    "startedAt": ISO8601DateFormatter().string(from: Date()),
    "localFile": localFile,
    "sha256": actualNoiseHash,
    "playbackVolume": playbackVolume,
    "outputDevice": outputDevice,
    "systemOutputVolumePercent": outputVolume
]

do {
    let statusData = try JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys])
    try statusData.write(to: statusURL, options: .atomic)
} catch {
    player.stop()
    fail("Unable to write noise-player status: \(error.localizedDescription)")
}

let levelDb = 20 * log10(playbackVolume)
let formattedLevelDb = String(format: "%.3f", levelDb)
print("Industrial noise running continuously. Press Control-C to stop.")
print("File: \(localFile)")
print("Output: \(outputDevice), system volume \(outputVolume)%, file gain \(playbackVolume) (\(formattedLevelDb) dB)")
fflush(stdout)

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let stopSignals = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler {
        player.stop()
        try? FileManager.default.removeItem(at: statusURL)
        exit(0)
    }
    source.resume()
    return source
}

withExtendedLifetime(stopSignals) {
    RunLoop.main.run()
}
