"""Write the API's OpenAPI schema to packages/shared/openapi.json.

Run from the repo root with `pnpm gen:api-types`, which also regenerates the TypeScript types.
CI fails if the committed files differ from a fresh export.
"""

import json
from pathlib import Path

from app.config import Settings
from app.main import create_app

OUTPUT = Path(__file__).resolve().parents[3] / "packages" / "shared" / "openapi.json"


def main() -> None:
    # The schema does not depend on real connections; placeholders only satisfy validation,
    # and _env_file=None keeps a local .env from changing the output.
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url="postgresql://openapi:openapi@localhost:5432/openapi",
        redis_url="redis://localhost:6379/0",
    )
    schema = create_app(settings).openapi()
    OUTPUT.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
