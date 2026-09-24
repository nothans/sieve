# Priya Ansel: "A confident wrong answer is the expensive one"

**Date:** 2026-04-22
**Source:** applied ML workshop keynote (fictional sample)

## TL;DR

- Classifier confidence scores are often badly calibrated out of the box, especially after fine-tuning.
- Temperature scaling on a held-out set fixed most of the gap in her examples.
- Reliability diagrams should ship with any model that gates a decision.
- Abstaining below a threshold beat forcing a label in every workflow she tested.

## Their Argument

Ansel argues that teams obsess over accuracy and ignore whether the probability attached to a prediction means anything.
If a model says 0.9 and is right 60% of the time, every downstream threshold is wrong, and nobody notices until an audit.

Her fix is unglamorous: hold out data, measure expected calibration error, apply temperature scaling, and give the system a real "I don't know" path.
She showed that routing low-confidence items to a human cut error cost more than a larger model did.

## Implications

- Calibration is a cheap, underused lever for any system that ranks or gates on model scores.
- "Abstain" should be a first-class output in classifier-driven tools.
- Good material for a talk on trusting typed model judgments.
