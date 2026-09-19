# Previous ASR-TTS experiment (60 trials)

This directory preserves the ASR-TTS half of the previous 120-trial thesis experiment.
It contains 60 trial result rows across C1 (quiet) and C2 (industrial noise). There are
58 final-state snapshots because two historical trials ended without a terminal state;
the existing KPI results classify those trials as failures/timeouts.

The source experiment results were introduced at
`df25572441dbd67ec4d06b56d5f9a52a9e58d27e`. The analyzer and scenario files stored
here are snapshots for reproducibility. The KPI timing boundary is
`audio_first_packet_received` to `final_acknowledgement_completed`.

Do not append new experiment events to this archive.
