# Theo Nakamura: "Put the camera on the table and let people break it"

**Date:** 2026-05-19
**Source:** maker faire booth talk (fictional sample)

## TL;DR

- An object detector on a single-board computer with a small USB accelerator ran at about 25 fps.
- Visitors held up household objects; the screen showed boxes, labels, and confidence live.
- The most engaging moment was misclassifications, not correct ones.
- Total hardware cost was under $150 (speaker-reported).

## Their Argument

Nakamura argues that live, hands-on hardware demos teach more about model limits than any slide.
When a banana gets labeled as a phone at 0.71 confidence, the audience instantly understands both what the model learned and why confidence numbers matter.

He also makes a practical case: the demo ran fully offline, so booth Wi-Fi never mattered.
The thermal throttling curve after an hour was itself a talking point about running inference at the edge.

## Implications

- A cheap vision rig is a reliable, crowd-friendly live demo.
- Showing confidence scores on screen doubles as a lesson in model uncertainty.
- Offline operation is a feature worth stating out loud on stage.
