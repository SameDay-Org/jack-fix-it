"""status writer triggers

Revision ID: 4eb1fd67455e
Revises: cc5f5e3a9bbf
Create Date: 2026-10-22 21:33:51.539802

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4eb1fd67455e"
down_revision: str | Sequence[str] | None = "cc5f5e3a9bbf"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Each guarded table, with the status a row may be inserted with when no state machine is
# writing: its server default (models: RequestStatus.RECEIVED, JobStatus.SCHEDULED).
GUARDED = {"service_requests": "received", "jobs": "scheduled"}


def upgrade() -> None:
    # The database guard (#163): request and job statuses change only through the state
    # machines (AGENTS.md), whatever Python path issues the write. The machines set the
    # transaction-local flag app.status_writer = 'state_machine' around their own write; any
    # other status change, or an insert with a status other than the default, is refused with
    # SQLSTATE 42501 and a message naming the table only.
    op.execute(
        """
        CREATE FUNCTION enforce_status_writer() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF coalesce(current_setting('app.status_writer', true), '') = 'state_machine' THEN
                RETURN NEW;
            END IF;
            -- An insert trigger passes the table's default status as its argument.
            IF TG_OP = 'INSERT' AND TG_NARGS = 1 AND NEW.status = TG_ARGV[0] THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'the status of % changes only through its state machine', TG_TABLE_NAME
                USING ERRCODE = '42501';
        END
        $$
        """
    )
    for table, default_status in GUARDED.items():
        op.execute(
            f"""
            CREATE TRIGGER {table}_status_update_guard
            BEFORE UPDATE OF status ON {table}
            FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
            EXECUTE FUNCTION enforce_status_writer()
            """
        )
        op.execute(
            f"""
            CREATE TRIGGER {table}_status_insert_guard
            BEFORE INSERT ON {table}
            FOR EACH ROW EXECUTE FUNCTION enforce_status_writer('{default_status}')
            """
        )


def downgrade() -> None:
    for table in GUARDED:
        op.execute(f"DROP TRIGGER {table}_status_insert_guard ON {table}")
        op.execute(f"DROP TRIGGER {table}_status_update_guard ON {table}")
    op.execute("DROP FUNCTION enforce_status_writer()")
