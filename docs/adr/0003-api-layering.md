# 0003. API code is layered per domain module, with integrations behind adapters

- **Status:** accepted
- **Date:** 2026-10-16

Each domain lives in `apps/api/app/modules/<domain>/` with up to five files:

- `router.py`: HTTP only. Parses input, declares auth dependencies, calls the service, returns
  schemas.
- `service.py`: business rules and transaction boundaries. Calls repositories, other modules'
  services and integrations.
- `repository.py`: SQLAlchemy queries for the module's tables.
- `models.py`: SQLAlchemy models (subclasses of `app.db.Base`).
- `schemas.py`: Pydantic request and response models.

External services (Stripe, Twilio, Resend, Expo Push, S3 storage, Google) are reached only
through adapters in `app/integrations/`. Modules use each other through services, never
through another module's repository or models.

Why: the rules that must never break (money, the job state machine, ownership checks) need one
obvious place to live and to be tested. Thin routers and adapters at the edges let tests cover
the services without HTTP or real vendors, and keep a vendor swap contained to one file.

## Consequences

- A module only needs the files it uses (the `health` module has no repository or models).
- `alembic/env.py` imports every `app/modules/*/models.py`, so a new module's tables are seen
  by autogenerate without extra wiring.
