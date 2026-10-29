# One image for two Railway services (root directory /apps/api):
#   api    -> railway.api.json    (python -m app.serve, migrations as pre-deploy)
#   worker -> railway.worker.json (arq app.worker.WorkerSettings)
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# ffmpeg remuxes request videos into privacy-safe copies (#173). Only the worker runs it, but
# both services use this one image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first so code-only changes reuse this layer.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
# Operator commands run from a shell on the api service (docs/railway.md, steps 7 and 8).
COPY scripts ./scripts

RUN useradd --system --uid 10001 --no-create-home app
USER app

CMD ["python", "-m", "app.serve"]
