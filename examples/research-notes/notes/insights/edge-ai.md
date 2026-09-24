# Insights - Edge AI

Theme: running models on small, local, often battery-powered hardware instead of the cloud.

---

## 2026-09-21 - Offline voice assistants are becoming a hobby build
**Status:** new

Several maker projects now do wake-word detection and speech recognition on a single-board computer with no network at all.
The hard parts are noisy rooms and latency, not model availability.
A working build is cheap enough to bring on stage and let an audience try.

## 2026-09-02 - Neural coprocessors reach budget microcontrollers
**Status:** new

Small neural coprocessors are showing up in low-cost microcontroller lines with mics and accelerometers on the dev kit.
That puts always-on audio and sensor models within reach of classrooms and weekend projects.
Watch whether toolchains keep up with the silicon.

## 2026-08-14 - Quantization quietly breaks confidence scores
**Status:** new

Shrinking a model to 4 bits keeps its fluency but shifts its probability estimates, usually toward overconfidence.
Any on-device pipeline that thresholds on model scores needs to be recalibrated after compression, not before.
This is easy to miss because headline accuracy barely moves.

## 2026-05-19 - Misclassifications are the best part of a live vision demo
**Status:** new

A sub-$150 detector rig on a single-board computer drew crowds mainly when it got things wrong.
Seeing a wrong label with a confidence number makes model limits concrete in a way slides do not.
Running fully offline also removed the usual venue Wi-Fi risk.

## 2026-03-12 - Wake-word models live or die on the audio front end
**Status:** new

A keyword spotter fits in a few hundred KB of RAM on a $4 chip, and the network is the easy part.
Mic gain, feature extraction, and power budget decide whether it works in a real room.
Dataset coverage of accents and acoustics is the likely failure mode.
