# ASR/TTS thesis prototype

This folder contains the iOS client, the Node.js server, and the C1/C2 records for both experiments in *Voice User Interfaces in ERP Systems*. The prototype transcribes recorded speech, interprets work-order commands on the server, and returns spoken responses. Run it on a trusted local network; it is a research prototype, not a production ERP service.

## Run the prototype

Requirements: macOS with Xcode capable of building the iOS 26.1 target, an iPhone with iOS 26.1 or newer (or the iOS Simulator), Node.js 20 or newer, and an OpenAI API key.

1. From `server/ASR Project`, run `npm ci`.
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`. Set a unique `EXPERIMENT_ADMIN_TOKEN` if using the experiment control commands. The `.env` file is intentionally excluded from the submission.
3. Run `npm start`. The server listens on port 3000.
4. Open `ios/ResearchProject2025/ResearchProject2025.xcodeproj` in Xcode. Select your own development team for device signing.
5. In the app's **Server URL** field, enter the server's address. Use `http://localhost:3000` in the simulator or the Mac's current local-network address on an iPhone. Connect both devices to the same trusted network.

Only one of the two thesis servers can use port 3000 at a time. The app sends voice data to the server and the configured OpenAI service; do not use real customer records.

## Experiment records

`server/ASR Project/experiment/experiment_1/` contains the 60 C1/C2 trials for Experiment 1. `experiment_2/` contains the 72 C1/C2 trials for Experiment 2. Each directory includes its event log, available final states, scenarios, analyzer, trial results, aggregate results, README, and manifest. Run `npm run analyze:experiment1` or `npm run analyze:experiment2` from the server directory to reproduce the included result tables. The older source archive is retained under `experiment/archive/experiment_1/`; see `experiment/README.md` before comparing copies.

Experiment 1 has two missing terminal snapshots and one explicit outcome override; these are disclosed in its README. The source archive must be consulted for the historical record. The Experiment 2 aggregates agree with Table 5.3 of the thesis.

The companion `shared/` directory at the submission root contains the Experiment 2 protocol, harness, and command stimuli. The external industrial-noise recording is identified by source and SHA-256 in the protocol; it is not redistributed in this package. Set `EXPERIMENT_ADMIN_TOKEN` in the terminal running the harness as well as the server when starting, ending, failing, or resetting a trial. Historical logs should be analysed from the numbered directories, never appended to during a new run.
