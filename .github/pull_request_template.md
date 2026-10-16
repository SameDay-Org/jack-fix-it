Closes #

**Plan task:** <!-- e.g. D8.2 from docs/mvp-plan.md, or "none" -->

## Summary

<!-- What changed and why, in a few lines. -->

## Acceptance criteria

<!-- One line per criterion from the issue, each pointing to the code and the test that proves it. -->

- [ ] Criterion → `path/to/code` · `path/to/test::test_name`

## How it was tested

<!-- Commands run and their result; manual checks. -->

## Screenshots

<!-- UI changes only. Mobile: Android and iOS, including empty and error states. Web: mobile and desktop width. -->

## Risks / follow-ups

<!-- Anything reviewers should watch, new native dependency ("Needs new dev build"), migration notes, follow-up issues. -->

## Review

- [ ] needs-vault: touches payments, Stripe, webhooks, auth, permissions, audit_log, file uploads or chat redaction
- [ ] has-migration: contains an Alembic migration (`uv run alembic heads` shows one head)
- [ ] API schema changed and `pnpm gen:api-types` output is committed
