# Experiment 2 ASR/TTS supplementary logs

This directory contains the original ASR/TTS records and results for Experiment 2, the voice-variation robustness evaluation. It contains 72 trials: C1 (quiet) and C2 (industrial noise), with 36 trials in each condition across three simulated voice profiles and four scenarios.

The included aggregate results agree with Table 5.3 of the thesis:

| Condition | Task success | Entity accuracy | Median latency | Failure or timeout | Confirmation compliance | Critical error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C1 | 88.9% | 88.9% | 12.00 s | 2.8% | 88.9% | 11.1% |
| C2 | 83.3% | 83.3% | 14.41 s | 2.8% | 81.5% | 16.7% |

`logs/` contains the original event records, `final-states/` contains the 72 terminal snapshots, `scenarios/` defines the tasks, and `results/` contains trial-level and aggregate tables. The event log references final-state files using portable relative paths.

The included analyzer can reproduce the result tables from the event records. Run `npx tsx analyzeKpis.ts` from this directory if needed.
