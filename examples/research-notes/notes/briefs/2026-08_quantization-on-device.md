# Lena Okafor: "Four bits is fine until it isn't"

**Date:** 2026-08-14
**Source:** on-device ML podcast interview (fictional sample)

## TL;DR

- 4-bit quantized language models run usably on recent laptops and some phones.
- Quality loss is uneven: fluent text survives, arithmetic and rare facts degrade first.
- Quantized models tend to be more overconfident, so confidence scores need re-checking.
- Memory bandwidth, not compute, sets the token rate on most consumer hardware.

## Their Argument

Okafor argues that aggressive quantization is what made local models practical, but that average benchmark scores hide where the damage lands.
Tasks needing precise recall or multi-step math fall off faster than chat quality suggests.

She also flags a subtle effect: after quantization, the model's probability estimates drift.
Any system that thresholds on model confidence should be recalibrated on the quantized model, not the original.

## Implications

- Local inference on consumer hardware is practical for many tasks today.
- Recalibration after quantization is an easy-to-miss step.
- Task-specific evals matter more than headline scores for on-device models.
