"""Adapters for external services (Stripe, Twilio, Resend, Expo Push, S3 storage, Google).

Services call these adapters, never the vendor SDKs directly, so tests can replace them at
this boundary. See docs/adr/0003-api-layering.md.
"""
