# Real-time experiment records

- `experiment_1/` is the thesis supplementary set for C3 and C4 (60 trials). Its README explains the normalized legacy trial identifier.
- `experiment_2/` is the thesis supplementary set for C3 and C4 (72 trials). Its README and manifest identify the included records and Table 5.3 values.
- `archive/experiment_1/` retains the older source archive, including the original test-labelled record. It is not a second set of counted trials.
- Files directly under `experiment/logs/`, `experiment/final-states/`, and `experiment/results/` are the server's historical working output for Experiment 2. The portable `experiment_2/` copy is the submission reference. A new server run writes to those working directories unless `EXPERIMENT_EVENTS_FILE` and `EXPERIMENT_FINAL_STATES_DIR` are set.

Do not combine the archived and submission copies when calculating trial totals. The included analyzers operate within each numbered experiment directory.
