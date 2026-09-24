# Mara Lindqvist: "The whole model fits in less RAM than the bootloader"

**Date:** 2026-03-12
**Source:** embedded systems conference talk (fictional sample)

## TL;DR

- Keyword spotting runs on a $4 microcontroller with 256 KB of RAM and no network.
- The demo board wakes on a spoken word, lights an LED, and sleeps again at under 1 mW average.
- Most of the engineering is in the audio front end, not the neural net.
- Int8 quantization cost about 1 point of accuracy on her test set (speaker-reported).

## Their Argument

Lindqvist argues that "edge AI" talks spend too much time on accelerators and too little on the boring parts: microphone gain, feature extraction, and power budgets.
Her live demo used a dev board, a MEMS mic, and a coin cell, and she let the audience shout the wake word to show false-accept behavior in a noisy room.

She claims the real constraint is not compute but data.
Wake-word models fail on accents and room acoustics the training set never saw, and no amount of on-device cleverness fixes a narrow dataset.

## Implications

- A cheap, battery-powered wake-word board is a strong live demo: visible, interactive, cheap to bring on stage.
- Dataset coverage, not model size, is the likely failure mode to probe.
- Power measurement belongs in the demo, not the appendix.
