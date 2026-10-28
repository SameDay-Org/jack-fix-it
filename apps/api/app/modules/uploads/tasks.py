"""Worker side of the uploads module: the sweep of uploads no row references (#191)."""

import logging
from typing import Any

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.uploads.orphans import OrphanSweepConfig, OrphanUploadSweeper

logger = logging.getLogger(__name__)


async def sweep_orphan_uploads(ctx: dict[str, Any]) -> None:
    """ARQ cron: deletes uploads older than ORPHAN_UPLOAD_MIN_AGE_HOURS that no row references,
    or only counts them in dry_run (see orphans.py). Never raises; the next run starts over."""
    settings: Settings = ctx["settings"]
    config = OrphanSweepConfig.from_settings(settings)
    if config.mode == "off":
        return
    storage: Storage | None = ctx.get("storage")
    if storage is None:
        # S3_* settings are missing (development without storage): there is nothing to sweep.
        logger.warning("orphan_upload_sweep_unconfigured", extra={"mode": config.mode})
        return
    await OrphanUploadSweeper(ctx["session_factory"], storage, config).sweep()
