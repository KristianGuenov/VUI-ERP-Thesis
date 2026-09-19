#!/usr/bin/env swift

import AVFoundation
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
    let noise = root["noise"] as? [String: Any],
    let localFile = noise["localFile"] as? String,
    let playbackVolume = noise["playbackVolume"] as? Double,
    let outputVolume = noise["systemOutputVolumePercent"] as? Int,
    let outputDevice = noise["outputDevice"] as? String
else {
    fail("Noise playback settings are missing or invalid in \(configURL.path)")
}

guard FileManager.default.fileExists(atPath: localFile) else {
    fail("Industrial-noise file is missing: \(localFile)")
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
        exit(0)
    }
    source.resume()
    return source
}

withExtendedLifetime(stopSignals) {
    RunLoop.main.run()
}
