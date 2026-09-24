# Engineering manager essay: "Every breaking change is a tax on trust"

**Date:** 2026-09-02
**Source:** engineering blog essay (fictional sample)

## TL;DR

- The author's team deprecated an SDK major version and tracked migration over 12 months.
- Automated codemods migrated roughly 70% of call sites; the rest needed humans (author-reported).
- Deprecation warnings in the terminal were ignored; failing CI with a link got action.
- Long support windows cost engineering time but kept churn low.

## Their Argument

The essay argues that breaking changes are a developer experience decision, not just a versioning one.
Each forced migration spends goodwill, and developers remember which platforms made them rewrite code for no visible benefit.

The author recommends shipping migration tooling with the breaking release, giving dates instead of vague "future" removals, and publishing a changelog written for the reader who skipped the last three versions.

## Implications

- Migration tooling is part of the product, not an afterthought.
- Deprecation timelines with concrete dates reduce surprise and support load.
- Codemods written for both humans and coding agents could raise migration rates.
