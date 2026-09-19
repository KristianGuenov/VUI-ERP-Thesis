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
2. Configure a local industrial-noise file and a fixed `noise.levelDb`.
3. Run the harness preflight against the stimulus directory.
4. Complete non-counted pilot trials for all four scenarios on both prototypes.
5. Verify that continuous noise does not trigger Realtime VAD by itself.
6. Keep the same audio-input path for quiet and noisy conditions.

The industrial-noise file and level intentionally remain unset in the committed plan.
The preflight command fails until both are explicitly configured.

## Harness examples

Run from the repository root:

```sh
node shared/scripts/experimentHarness.mjs plan \
  --config shared/experiments/voice-stimuli-2026.json \
  --out /tmp/voice-stimuli-expanded.json

node shared/scripts/experimentHarness.mjs preflight \
  --config shared/experiments/voice-stimuli-2026.json \
  --stimulus-root "$HOME/Downloads/voice_stimuli" \
  --noise-file /absolute/path/to/factory-noise.wav \
  --report /absolute/path/to/preflight-report.json
```

The optional preflight report records byte sizes and SHA-256 hashes for every stimulus
and the noise file, so the exact audio inputs can be audited later.

`start`, `end`, `fail`, and `status` wrap the existing experiment HTTP endpoints.
`validate` checks event cardinality, confirmation order, terminal events, timing events,
and final-state files for all 72 trials belonging to one prototype. A deliberately
failed trial still requires a start, terminal event, and final state; missing timing or
confirmation events are reported as warnings because the failure may have happened
before those events could occur.
