"""Erasing an account's personal data (#97): what the deletion does in its transaction, and what
the worker's second pass does again once nothing the account sent before can still be running.

A request the account sent before the deletion committed (a profile edit, a phone check, a new
request, a device, a saved address) may land after it: the deletion's row lock delays it, but
its write still lands once the lock is released. The second pass (accounts.cleanup) runs the
same erasure after ACCOUNT_DELETION_SETTLE_SECONDS, so such a write does not stay. Every step is
idempotent; each module erases its own part (its erasure.py).
"""

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.erasure import AddressErasure
from app.modules.auth.service import revoke_all_sessions
from app.modules.chat.erasure import forget_originals
from app.modules.devices.erasure import forget_devices
from app.modules.jobs.erasure import JobErasure
from app.modules.ops.erasure import erase_notes
from app.modules.payments.erasure import request_ids_with_an_open_payment
from app.modules.pros.erasure import ProErasure
from app.modules.requests.erasure import HeldRequest, RequestErasure
from app.modules.support.erasure import erase_messages
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole
from app.modules.waitlist.erasure import forget_entries


@dataclass
class Erased:
    # Storage keys of the files whose rows went: the worker deletes them.
    keys: list[str] = field(default_factory=list)
    # A media copy was still being made: it may upload after the commit.
    copy_in_flight: bool = False
    # What each step changed, for the audit row and the logs.
    counts: dict[str, int] = field(default_factory=dict)
    # The account has a Stripe Customer: its cards are to be detached.
    has_stripe_customer: bool = False


class AccountEraser:
    def __init__(self, session: AsyncSession, users: UserService) -> None:
        self._session = session
        self._users = users
        self._jobs = JobErasure(session)
        self._requests = RequestErasure(session)

    async def hold(self, account: UserAccount) -> list[HeldRequest]:
        """For a customer, locks the requests the erasure may cancel (requests.erasure), before
        the caller locks the user's row. Nothing for a pro."""
        if account.role is not UserRole.CUSTOMER:
            return []
        return await self._requests.hold_cancellable(
            account.id, self._jobs.request_ids_with_a_job()
        )

    async def erase(self, account: UserAccount, held: list[HeldRequest]) -> Erased:
        """Erases everything of the account but what is kept by rule (accounts.service), and
        anonymises it; the caller holds the user's row and commits."""
        erased = Erased()
        counts = erased.counts
        if account.role is UserRole.CUSTOMER:
            # The transitions first: each drains the unit of work before it writes.
            keep = set(
                await self._session.scalars(
                    self._jobs.request_ids_with_a_job().union(
                        request_ids_with_an_open_payment(account.id)
                    )
                )
            )
            counts["requests_cancelled"] = await self._requests.cancel(account, held, keep=keep)
            media = await self._requests.erase(account.id)
            erased.keys.extend(media.keys)
            erased.copy_in_flight = media.copy_in_flight
            addresses = await AddressErasure(self._session).erase(account.id)
            counts["saved_addresses"] = addresses.saved_deleted
            counts["request_addresses"] = addresses.request_addresses_erased
            counts["check_in_points"] = await self._jobs.forget_check_in_points(account.id)
            notes = await erase_notes(
                self._session, self._requests.customer_request_ids(account.id)
            )
            counts["staff_notes"] = notes.notes
            counts["staff_followups"] = notes.followups
        else:
            erased.keys.extend(await ProErasure(self._session).erase(account.id))
        if account.photo_key is not None:
            erased.keys.append(account.photo_key)
        counts["devices"] = await forget_devices(self._session, account.id)
        counts["waitlist_entries"] = await forget_entries(
            self._session, account.id, account.email, account.phone
        )
        counts["support_messages"] = await erase_messages(self._session, account.id)
        counts["chat_originals"] = await forget_originals(self._session, account.id)
        erased.has_stripe_customer = await self._users.stripe_customer_id(account.id) is not None
        await revoke_all_sessions(self._session, account.id)
        await self._users.anonymise(account.id)
        return erased
