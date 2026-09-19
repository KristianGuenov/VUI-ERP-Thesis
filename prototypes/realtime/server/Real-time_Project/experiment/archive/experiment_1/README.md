# Previous Realtime experiment (60 trials)

This directory preserves the Realtime half of the previous 120-trial thesis experiment.
It contains 60 trial result rows and 60 final-state snapshots across C3 (quiet) and C4
(industrial noise).

The historical C3 set contains `DRY_C3_S01_TEST` in place of
`SELF_C3_S01_R1`; this is preserved exactly as recorded rather than corrected after
the fact.

The source experiment was committed at `62271dbae7316641d66349c3b2024552b078edca`.
The analyzer and scenario files stored here are snapshots for reproducibility. The KPI
timing boundary is `audio_first_packet_received` to the final
`final_acknowledgement_completed` event.

Do not append new experiment events to this archive.
