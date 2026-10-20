# Experiment 1 real time supplementary logs

This directory is the canonical supplementary-data location for the real-time half of Experiment 1. It contains 60 trials: C3 (quiet) and C4 (industrial noise), with 30 trials in each condition.

The generated aggregate results reproduce Table 5.1 of the thesis:

| Condition | Task success | Entity accuracy | Median latency | Failure or timeout | Confirmation compliance | Critical error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C3 | 80.0% | 83.3% | 24.415 s | 0.0% | 83.3% | 20.0% |
| C4 | 90.0% | 96.7% | 24.830 s | 0.0% | 94.4% | 10.0% |

`logs/` contains event records, `final-states/` contains the 60 retained terminal snapshots, `scenarios/` defines the tasks, `manual-review/` contains the critical-error review, and `results/` contains derived trial and aggregate results.

The author confirmed on 17 October 2026 that the archived `DRY_C3_S01_TEST` record was the first counted C3/S01 trial. Its test label and repetition value `0` were capture-metadata errors. This numbered submission copy records it as `SELF_C3_S01_R1` with repetition `1`; its event sequence and outcome are unchanged. The original archive remains unchanged.

The raw event log has 62 `trial_started` events for 60 unique trial identifiers. `SELF_C4_S01_R1` and `SELF_C3_S05_R3` each have an additional start event under the same identifier; the results table counts each identifier once. These original event records have not been removed.

Run `node analyzeKpis.js` from this directory to regenerate `results/`.
