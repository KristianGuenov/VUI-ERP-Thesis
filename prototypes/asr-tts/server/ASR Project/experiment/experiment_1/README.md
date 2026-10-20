# Experiment 1 ASR TTS supplementary logs

This directory is the canonical supplementary-data location for the ASR-TTS half of Experiment 1. It contains 60 trials: C1 (quiet) and C2 (industrial noise), with 30 trials in each condition.

The generated aggregate results reproduce Table 5.1 of the thesis:

| Condition | Task success | Entity accuracy | Median latency | Failure or timeout | Confirmation compliance | Critical error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C1 | 93.3% | 93.3% | 8.334 s | 3.3% | 94.4% | 13.3% |
| C2 | 86.7% | 80.0% | 13.895 s | 3.3% | 77.8% | 6.7% |

`logs/` contains event records, `final-states/` contains retained terminal snapshots, `scenarios/` defines the tasks, and `results/` contains derived trial and aggregate results. The event log uses portable paths to final-state files.

There are 58 retained terminal snapshots. Two trials ended without a terminal snapshot: `SELF_C1_S01_R2` and `SELF_C2_S10_R2`. Their result classification is determined from their retained event history. `published-result-overrides.json` records the one task-success correction required to align the damaged historical archive with the final experiment outcome reported in the thesis.

Run `npx tsx analyzeKpis.ts` from this directory to regenerate `results/`.
