# Voice-stimuli experiment protocol

`voice-stimuli-2026.json` is the single source of truth for the planned thesis experiment.
It expands to 144 unique trials: 72 per prototype, split into 36 quiet and 36
industrial-noise trials. Each environment contains four scenarios, three voices, and
three repetitions.

Use `RUNBOOK.md` for the exact operator sequence once the readiness gates below have
been completed and reviewed.

The condition identifiers deliberately remain compatible with the previous experiment:

- C1: ASR-TTS, quiet
- C2: ASR-TTS, industrial noise
- C3: Realtime, quiet
- C4: Realtime, industrial noise

The existing condition-level KPI aggregate files keep their original grouping and KPI
definitions. The analyzers additionally create `voice-aggregate-results.json` and CSV,
which provide the new V1/V2/V3 breakdown without changing the historical comparison.

## Timing comparability

Do not move or replace these events:

- Start: `audio_first_packet_received`
- End: the final `final_acknowledgement_completed`

The new metadata and harness do not change either timing boundary. Consequently, the
new latency metric has the same server-side definition as the previous 120 trials.

## Required readiness gates

Before any counted trial:

1. Archive the previous live experiment output.
2. Run the harness preflight against the stimulus directory and require `ready: true`.
3. Start the fixed continuous-noise player for C2/C4 and use the documented device
   placement.
4. Verify before the first counted noisy trial that continuous noise alone does not
   trigger Realtime VAD.
5. Keep the same command playback path and physical device placement for quiet and
   noisy conditions.

The industrial-noise asset is pinned by SHA-256 in the committed plan. Playback is
fixed at 0.25 file gain (-12.041 dB), 50% macOS output volume, through MacBook Air
Speakers. Command stimuli play at 1.0 file gain. The iPhone microphone must remain 50
cm from and facing the centre of the MacBook speaker edge. The noise player enforces
the output device and system volume and loops without interruption.

The YouTube source is the same recording used previously. The old experiment did not
log its output device, system volume, file gain, or microphone distance, and no local
record of those settings was found. Therefore the source recording is historically
matched, but an identical old-versus-new acoustic noise level cannot be claimed. The
fixed settings above make all 72 new noisy trials internally reproducible.

## Harness examples

Run from the repository root:

```sh
node shared/scripts/experimentHarness.mjs plan \
  --config shared/experiments/voice-stimuli-2026.json \
  --out /tmp/voice-stimuli-expanded.json

node shared/scripts/experimentHarness.mjs preflight \
  --config shared/experiments/voice-stimuli-2026.json \
  --stimulus-root "$HOME/Downloads/voice_stimuli" \
  --report shared/experiments/preflight-report.json

swift shared/scripts/noisePlayback.swift \
  shared/experiments/voice-stimuli-2026.json
```

The optional preflight report records byte sizes and SHA-256 hashes for every stimulus
and the noise file, so the exact audio inputs can be audited later. The hashes are also
pinned in the plan, so a changed asset makes preflight fail rather than silently
creating a new manifest.

`start`, `end`, `fail`, and `status` wrap the existing experiment HTTP endpoints.
`start` refuses a quiet trial while the noise player is running and refuses a noisy
trial unless the verified player state is active. `play-command` and
`play-confirmation` verify the active trial and audio hash before playback.
`validate` checks event cardinality, confirmation order, terminal events, timing events,
and final-state files for all 72 trials belonging to one prototype. A deliberately
failed trial still requires a start, terminal event, and final state; missing timing or
confirmation events are reported as warnings because the failure may have happened
before those events could occur.
