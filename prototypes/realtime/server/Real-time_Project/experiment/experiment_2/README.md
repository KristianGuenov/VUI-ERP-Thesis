# Experiment 2 real-time supplementary logs

This directory contains the original real-time records and results for Experiment 2, the voice-variation robustness evaluation. It contains 72 trials: C3 (quiet) and C4 (industrial noise), with 36 trials in each condition across three simulated voice profiles and four scenarios.

The included aggregate results agree with Table 5.3 of the thesis:

| Condition | Task success | Entity accuracy | Median latency | Failure or timeout | Confirmation compliance | Critical error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C3 | 86.1% | 88.9% | 27.37 s | 0.0% | 88.9% | 13.9% |
| C4 | 77.8% | 91.7% | 32.16 s | 0.0% | 85.2% | 22.2% |

`logs/` contains the original event records, `final-states/` contains the 72 terminal snapshots, `scenarios/` defines the tasks, `manual-review/` contains the critical-error review, and `results/` contains trial-level and aggregate tables. The event log references final-state files using portable relative paths.

The included analyzer can reproduce the result tables from the event records. Run `node analyzeKpis.js` from this directory if needed.
