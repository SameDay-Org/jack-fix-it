# 0004. MVP stack

- **Status:** accepted
- **Date:** 2026-10-16

The stack in the context document (§8) is the one to use; changing a layer needs a new ADR.

| Layer              | Choice                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| Mobile app         | React Native with Expo, Expo Router, TypeScript                           |
| App UI             | NativeWind (Tailwind) + own components + Reanimated                       |
| App data           | TanStack Query + Zustand                                                  |
| Backend            | Python, FastAPI, SQLAlchemy 2 (async), Alembic, Pydantic v2               |
| Database           | PostgreSQL 16 (PostGIS optional)                                          |
| Queue and schedule | Redis + ARQ; Redis also carries chat pub/sub                              |
| Payments           | Stripe Connect (Express) + Payment Sheet                                  |
| Files              | Cloudflare R2 or Railway Buckets (S3 API), always through presigned URLs  |
| Auth               | Own JWT (access + refresh with rotation), Argon2, SMS OTP (Twilio Verify) |
| Notifications      | Expo Push, Resend (email), Twilio (SMS)                                   |
| Addresses          | Google Places Autocomplete + Geocoding                                    |
| Admin/BDC + site   | Next.js + shadcn/ui + TanStack Table (SSR for the landing)                |
| Quick internal UI  | SQLAdmin on FastAPI (pro approval from D7)                                |
| Languages          | i18next (app and web)                                                     |
| Observability      | Sentry, UptimeRobot, JSON logs                                            |
| Analytics          | PostHog                                                                   |
| CI/CD              | GitHub Actions; staging from `develop`, production from `main`            |
| Hosting            | Railway Pro (ADR 0001)                                                    |

The reason for each layer is in `docs/mvp-plan.md` (Stack e arquitetura).
