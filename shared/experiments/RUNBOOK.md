# Experiment runbook

This runbook is for the counted `VOICE_STIMULI_2026` experiment. Require a successful
preflight before using it. Never reuse a trial ID; the servers reject duplicates.

## Common sequence

1. Start only the server and iOS client for the prototype under test.
2. For an industrial-noise block, place the iPhone microphone 50 cm from and facing
   the centre of the MacBook Air speaker edge. Start the continuous player below
   before the client begins listening and leave its terminal open through all 36
   trials. It selects MacBook Air Speakers, sets macOS output to 50%, and loops the
   pinned file at 0.25 gain (-12.041 dB). Do not move either device.
3. Start the planned trial through the harness. Confirm the returned metadata and
   active trial ID before playing audio.
4. Play the command stimulus once. For S01, S04, and S07, wait until the prototype
   finishes its confirmation prompt, then play the trial's confirmation stimulus once.
   S09 has no confirmation stimulus.
5. Wait for the final spoken acknowledgement to finish. End the trial through the
   harness only after the server accepts that no response, acknowledgement, or
   sensitive action is pending.
6. If the interaction cannot finish, use `fail`, record a specific failure type and
   reason, and continue with the next planned ID. Do not silently repeat or overwrite
   the failed trial.

The plan order is Realtime C3 quiet, Realtime C4 industrial noise, ASR-TTS C1 quiet,
then ASR-TTS C2 industrial noise. Within each condition it runs all V1 trials, then V2,
then V3; each voice contains S01, S04, S07, and S09 with repetitions R1–R3.

Start continuous noise from the repository root. Stop it with Control-C only after the
entire 36-trial noisy block:

```sh
swift shared/scripts/noisePlayback.swift \
  shared/experiments/voice-stimuli-2026.json
```

Play every command and confirmation WAV with `afplay` at its default 1.0 file gain.
The noise and stimuli therefore use the same physical output path.

## Trial-control commands

Run these from the repository root and substitute the server URL and exact planned ID:

```sh
node shared/scripts/experimentHarness.mjs start \
  --config shared/experiments/voice-stimuli-2026.json \
  --trial-id VOICE_STIMULI_2026_C3_V1_S01_R1 \
  --server http://10.4.4.112:3000

node shared/scripts/experimentHarness.mjs status \
  --server http://10.4.4.112:3000

node shared/scripts/experimentHarness.mjs end \
  --server http://10.4.4.112:3000

node shared/scripts/experimentHarness.mjs fail \
  --server http://10.4.4.112:3000 \
  --failure-type operator_abort \
  --reason "Describe the observed failure"
```

The `start` command resets the selected scenario state. The first server-received
audio remains the latency start, and the final acknowledgement remains the latency
end; trial-control time is not included.

## Realtime client

Start the conversation, allow the two-second ambient-noise calibration to finish, and
then play the command with `afplay` or the agreed equivalent playback path. In noisy
blocks, the continuous noise must already be present during calibration. Do not play a
command while the app is speaking.

## ASR-TTS client

The client records immediately when the screen opens. Play the command, then tap
**Stop**; this submits that recording to ASR. For a confirmation scenario, wait for the
confirmation prompt to finish, tap **Record**, play the confirmation stimulus, and tap
**Stop** again. Do not use **Replay Last TTS** during a counted trial.

## End-of-block checks

After each 36-trial condition, run the validator before changing environment or
prototype. Replace the experiment root with the relevant server path:

```sh
node shared/scripts/experimentHarness.mjs validate \
  --config shared/experiments/voice-stimuli-2026.json \
  --prototype realtime \
  --experiment-root prototypes/realtime/server/Real-time_Project/experiment
```

The validator reports incomplete planned trials during an in-progress block. At the
end of all 72 trials for a prototype it must report 72 terminal trials, no structural
issues, and only explainable warnings belonging to explicitly failed trials. Run the
prototype's `analyze:kpis` command only after this check.
