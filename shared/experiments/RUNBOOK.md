# Runbook: VOICE_STIMULI_2026 thesis experiment

**Owner:** Kristian Guenov | **Frequency:** One controlled 144-trial experiment

**Last updated:** 2026-09-19 | **Last run:** Not started

## Purpose

Run 72 trials on Realtime and 72 on ASR-TTS while preserving the six historical KPI
definitions and the original server-side latency boundary. Never reuse a trial ID; the
servers reject duplicates.

## Prerequisites

- [ ] Repository `main` contains the approved experiment-preparation commits.
- [ ] `shared/experiments/preflight-report.json` says `ready: true` and has no errors.
- [ ] The iPhone and Mac are on the same network; both clients use `10.4.4.112:3000`.
- [ ] Only the server and iOS client for the prototype under test are running.
- [ ] MacBook Air Speakers are available. Disconnect headphones if they could obscure
      whether playback is audible from the Mac.
- [ ] Position the iPhone microphone 50 cm from and facing the centre of the MacBook
      Air speaker edge. Mark both positions and do not move them until all trials end.
- [ ] No counted experiment has been started merely to test the setup.

## Fixed protocol

The order is Realtime C3 quiet, Realtime C4 industrial noise, ASR-TTS C1 quiet, then
ASR-TTS C2 industrial noise. Within each condition, run V1, V2, and V3. Each voice has
S01, S04, S07, and S09 with R1–R3.

Command and confirmation files use 1.0 file gain. The background noise uses the pinned
factory-noise WAV at 0.25 gain (-12.041 dB). Both use MacBook Air Speakers at 50%
macOS output volume and the same physical path. Noise runs without interruption for
the full 36-trial C4 block and again for the full 36-trial C2 block.

Latency remains measured from `audio_first_packet_received` through the final
`final_acknowledgement_completed`. Trial-control time is not part of latency.

## Procedure

### Step 1: Verify all inputs and playback dependencies

From the repository root:

```sh
node shared/scripts/experimentHarness.mjs preflight \
  --config shared/experiments/voice-stimuli-2026.json \
  --stimulus-root "$HOME/Downloads/voice_stimuli" \
  --report shared/experiments/preflight-report.json
```

**Expected result:** `ready` is `true`, `expectedTrials` is 144, `assets` contains 16
entries, and `errors` is empty. Every file is checked against its pinned SHA-256.

**If it fails:** Do not start a trial. Restore the missing or changed file, reconnect
the configured output device, or reinstall the named missing playback command. Never
edit a pinned hash merely to make an unexplained file change pass.

### Step 2: Start the selected prototype

Start only the relevant server and build/run its iOS client. Confirm that the server
has no active trial:

```sh
node shared/scripts/experimentHarness.mjs status \
  --server http://10.4.4.112:3000
```

**Expected result:** The server responds successfully and `activeTrial` is `null`.

**If it fails:** Fix connectivity or close/fail the known active trial. Do not use the
reset endpoint to discard an unexplained counted trial.

### Step 3: Start continuous noise for C4 or C2

Skip this step for C3 and C1. For C4 and C2, run the following in a dedicated terminal
before the client begins listening, and keep it open for all 36 trials:

```sh
swift shared/scripts/noisePlayback.swift \
  shared/experiments/voice-stimuli-2026.json
```

**Expected result:** It reports MacBook Air Speakers, 50% system volume, 0.25 file gain,
and -12.041 dB. The factory noise is audible and continues across file boundaries.

**If it fails:** Stop the block. Restore the pinned noise file or configured speaker.
Restart the player before restarting the client so Realtime's two-second VAD
calibration observes the background noise.

### Step 4: Start one planned trial

Substitute the exact next ID from the generated plan:

```sh
node shared/scripts/experimentHarness.mjs start \
  --config shared/experiments/voice-stimuli-2026.json \
  --trial-id VOICE_STIMULI_2026_C3_V1_S01_R1 \
  --server http://10.4.4.112:3000
```

**Expected result:** The returned active trial exactly matches the requested ID,
prototype, condition, environment, scenario, voice, and repetition.

**If it fails:** Do not play audio. Resolve the reported duplicate, wrong-prototype,
active-trial, or metadata error.

### Step 5: Play the exact command

For Realtime, start the conversation and wait through its two-second ambient-noise
calibration. For ASR-TTS, confirm that the client is recording. Then run:

```sh
node shared/scripts/experimentHarness.mjs play-command \
  --config shared/experiments/voice-stimuli-2026.json \
  --trial-id VOICE_STIMULI_2026_C3_V1_S01_R1 \
  --stimulus-root "$HOME/Downloads/voice_stimuli" \
  --server http://10.4.4.112:3000
```

**Expected result:** The harness verifies that this ID is active, verifies the file
hash, enforces MacBook Air Speakers at 50%, plays the planned file at 1.0 gain, and
reports completion. On ASR-TTS, tap **Stop** after playback to submit the recording.

**If it fails:** Do not substitute another file or play it manually. Correct the
active ID, asset, output device, or server connection first.

### Step 6: Handle confirmation when required

S01, S04, and S07 require confirmation. Wait until the full confirmation prompt has
finished. On ASR-TTS tap **Record**, then run:

```sh
node shared/scripts/experimentHarness.mjs play-confirmation \
  --config shared/experiments/voice-stimuli-2026.json \
  --trial-id VOICE_STIMULI_2026_C3_V1_S01_R1 \
  --stimulus-root "$HOME/Downloads/voice_stimuli" \
  --server http://10.4.4.112:3000
```

On ASR-TTS, tap **Stop** after playback. S09 has no confirmation; the harness refuses
a confirmation playback for S09. Do not use **Replay Last TTS** during a counted trial.

**Expected result:** The prototype executes the sensitive operation only after the
confirmation and produces its final spoken acknowledgement.

**If it fails:** Mark the trial failed with a specific reason. Do not replay an input
inside the same counted trial unless the study protocol is formally changed first.

### Step 7: End or fail the trial

After the final acknowledgement has fully finished:

```sh
node shared/scripts/experimentHarness.mjs end \
  --server http://10.4.4.112:3000
```

If the interaction cannot finish:

```sh
node shared/scripts/experimentHarness.mjs fail \
  --server http://10.4.4.112:3000 \
  --failure-type operator_abort \
  --reason "Describe exactly what was observed"
```

**Expected result:** One terminal event and one final-state file are written. `end`
refuses while a response, acknowledgement, or sensitive action is pending.

**If it fails:** Inspect `status`. Preserve the evidence and use `fail` with an honest
reason rather than resetting, overwriting, or silently repeating the ID.

### Step 8: Validate each block

After each 36-trial condition, and again after all 72 trials for a prototype:

```sh
node shared/scripts/experimentHarness.mjs validate \
  --config shared/experiments/voice-stimuli-2026.json \
  --prototype realtime \
  --experiment-root prototypes/realtime/server/Real-time_Project/experiment
```

Use `asr_tts` and its experiment root for ASR-TTS.

**Expected result:** At prototype completion, 72 terminal trials, zero structural
issues, and only explainable warnings belonging to explicitly failed trials.

**If it fails:** Stop before changing prototype. Resolve missing or duplicate events
and final states without editing historical observations.

### Step 9: Stop noise and analyze KPIs

After the entire 36-trial noisy block, stop the noise player with Control-C. After a
prototype passes validation, run its `npm run analyze:kpis` command.

**Expected result:** Historical condition aggregates plus the new voice-level
aggregate files are generated.

**If it fails:** Keep the event log and final states unchanged; fix only the analyzer
or execution environment and rerun analysis.

## Verification checklist

- [ ] Preflight says 144 trials, 16 matching assets, zero errors.
- [ ] Every trial ID has exactly one start and one terminal event.
- [ ] S01, S04, and S07 contain prompt → confirmation → execution in order.
- [ ] S09 contains no confirmation input.
- [ ] C4 and C2 each used uninterrupted noise with identical settings and placement.
- [ ] Each prototype has 72 terminal trials and zero validator issues.
- [ ] The final KPI analyzer outputs are retained with the raw events and states.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Preflight hash mismatch | Audio file changed | Restore the pinned file; do not bless an unexplained change |
| Playback refuses | Requested ID is not active | Check `status`, then use the exact active ID |
| Noise triggers Realtime by itself | Calibration began before noise or physical level is too high | Restart client with noise already running; stop the block if it persists |
| `end` returns 409 | Response or sensitive action still pending | Wait for final acknowledgement or explicitly fail the trial |
| Duplicate trial ID | Trial was already started | Preserve it; use the next planned ID rather than overwriting |
| ASR-TTS sends silence or truncated audio | Record/Stop timing was wrong | Mark the counted trial failed; correct procedure on the next planned ID |
| Noise process stops | Terminal closed or playback error | Stop the block, restart continuous noise, document the affected trial |
| Noise player says it is already running | A verified loop is already active | Keep the existing player; do not start a second overlapping loop |

## Rollback

Before the first counted trial, revert the experiment-preparation commits if the
protocol is rejected. After any counted trial starts, do not alter protocol, audio,
timing events, or recorded evidence. Stop the study, preserve the partial dataset, and
begin a newly identified experiment only after documenting the protocol change.

## Escalation

If the old experiment's physical noise level or device placement can be recovered,
update the protocol before counted trials. If it cannot, explicitly document that the
same source recording—but not a proven identical acoustic level—was used.

## History

| Date | Run by | Notes |
|---|---|---|
| 2026-09-19 | Codex | Software preflight completed; no counted trial started |
