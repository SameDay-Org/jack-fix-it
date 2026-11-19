"""The steps of the product, each through the endpoint the apps and the panel call.

A step here is one request to the API (plus the upload it needs), so the rows it leaves are
the ones the real flow leaves: the state machines move every status, the money is computed by
the backend, staff actions write their audit rows. The few places with no endpoint say so:

- staff accounts come from scripts/create_staff_user.py (public registration never makes one);
- a card "charged in the app" is the PaymentIntent succeeding, then what the
  payment_intent.succeeded webhook handler does (PaymentReconciler.apply), minus the pushes;
- a pro's payouts are enabled by `store_payouts_enabled`, as the payouts status call and the
  account.updated event do, reading the account through the port given.
"""

import asyncio
import io
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final, Protocol

from app.integrations.stripe_connect import AccountReader
from app.integrations.stripe_payments import PaymentIntentFacts
from app.modules.payments.models import PaymentStatus
from app.modules.payments.reconciliation import IntentEvent, JobBooked, PaymentReconciler
from app.modules.payouts.service import store_payouts_enabled
from app.modules.pros.service import ProService
from app.modules.users.types import UserRole
from demo_seed import pictures
from demo_seed.cast import Person, Place
from demo_seed.world import Actor, SeedError, World
from scripts import create_staff_user

# Every Idempotency-Key the seed sends is a UUID derived from a name under this namespace.
_NAMESPACE: Final = uuid.UUID("6f1d5c0e-3b7a-4c57-9d53-0c1f3a2b9e11")
# The name of the environment variable the staff script reads, not a password.
_PASSWORD_ENV: Final = "DEMO_SEED_PASSWORD"  # noqa: S105
_APP_VERSION: Final = "1.0.0"
OPPORTUNITY_PAGE: Final = 50


def idempotency_key(*parts: str) -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid5(_NAMESPACE, ":".join(parts)))}


class Checkout(Protocol):
    """What the Payment Sheet does in the app: the customer's card is charged."""

    async def charge(self, payment_intent_id: str) -> PaymentIntentFacts: ...


@dataclass(frozen=True)
class Catalog:
    """The seeded categories and served ZIPs, by slug and by ZIP."""

    categories: dict[str, uuid.UUID]
    zips: dict[str, uuid.UUID]
    zips_by_city: dict[str, list[str]]

    def category(self, slug: str) -> str:
        return str(self.categories[slug])


@dataclass(frozen=True)
class RequestRef:
    id: uuid.UUID
    public_code: str


@dataclass(frozen=True)
class DisputeRef:
    id: str
    public_code: str
    pro_payout_cents: int


@dataclass(frozen=True)
class QuoteTerms:
    amount_cents: int
    scope: str
    approach: str
    duration_minutes: int
    start_at: datetime


async def read_catalog(world: World) -> Catalog:
    categories = await world.call(None, "GET", "/v1/categories", what="categories")
    regions = await world.call(None, "GET", "/v1/service-areas", what="service areas")
    zips: dict[str, uuid.UUID] = {}
    by_city: dict[str, list[str]] = {}
    for region in regions:
        for city in region["cities"]:
            for area in city["zips"]:
                zips[area["zip_code"]] = uuid.UUID(area["id"])
                by_city.setdefault(city["city"], []).append(area["zip_code"])
    return Catalog(
        categories={item["slug"]: uuid.UUID(item["id"]) for item in categories},
        zips=zips,
        zips_by_city=by_city,
    )


# ---- Accounts ----


async def register(world: World, person: Person, password: str) -> Actor:
    body = {
        "email": person.email,
        "password": password,
        "role": person.role,
        "locale": "en",
        "first_name": person.first,
        "last_name": person.last,
    }
    answer = await world.call(
        None, "POST", "/v1/auth/register", json=body, what=f"register {person.email}"
    )
    return world.actor(uuid.UUID(answer["user"]["id"]), UserRole(person.role), person.email)


async def create_staff(
    world: World, email: str, role: UserRole, name: tuple[str, str], password: str
) -> Actor:
    """An admin or an agent, through the staff script (locale en, as it always sets), then a
    real sign-in: the panel's own login must work with the demo password."""
    terminal = create_staff_user.Io(environ={_PASSWORD_ENV: password}, out=io.StringIO())
    arguments = ["--email", email, "--role", role.value, "--password-env", _PASSWORD_ENV]
    arguments += ["--first-name", name[0], "--last-name", name[1]]
    if await create_staff_user.run(arguments, world.sessions, world.settings, terminal) != 0:
        raise SeedError(f"staff account {email} was refused")
    answer = await world.call(
        None,
        "POST",
        "/v1/auth/login",
        json={"email": email, "password": password},
        what=f"sign in {email}",
    )
    return world.actor(uuid.UUID(answer["user"]["id"]), role, email)


async def upload(world: World, actor: Actor, purpose: str, data: bytes) -> str:
    """An upload as the apps make it: the API issues the key, the bytes go to the storage
    under it. Returns the key."""
    body = {"purpose": purpose, "content_type": pictures.JPEG, "size_bytes": len(data)}
    issued = await world.call(actor, "POST", "/v1/uploads", json=body, what=f"upload {purpose}")
    key: str = issued["key"]
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "upload.jpg"
        path.write_bytes(data)
        await asyncio.to_thread(world.storage.upload_from, path, key, pictures.JPEG)
    return key


async def set_account_photo(world: World, actor: Actor, person: Person, place: Place) -> None:
    """The customer's ID card: a photo and a home city."""
    key = await upload(world, actor, "profile_photo", pictures.avatar(person.initials, person.tone))
    body = {"photo_key": key, "home_city": place.city, "home_state": place.state}
    await world.call(actor, "PATCH", "/v1/auth/me", json=body, what="account photo")


async def save_address(world: World, actor: Actor, place: Place, label: str) -> None:
    body = {**place.body(), "label": label, "is_default": True}
    await world.call(actor, "POST", "/v1/addresses", json=body, what="saved address")


# ---- Pros ----


async def set_pro_profile(
    world: World,
    pro: Actor,
    person: Person,
    *,
    bio: str,
    years: int,
    category_ids: list[str],
    area_ids: list[str],
) -> None:
    key = await upload(world, pro, "profile_photo", pictures.avatar(person.initials, person.tone))
    body = {
        "bio": bio,
        "years_of_experience": years,
        "photo_key": key,
        "category_ids": category_ids,
        "service_area_ids": area_ids,
    }
    await world.call(pro, "PATCH", "/v1/pros/me", json=body, what=f"profile {pro.email}")


async def submit_documents(world: World, pro: Actor, person: Person, valid_until: str) -> None:
    """The pro's photo ID and insurance, as images."""
    documents = (("id", "Photo ID", "D-4410"), ("insurance", "Liability insurance", "P-88213"))
    for doc_type, title, number in documents:
        image = pictures.document(title, f"{person.first} {person.last[0]}.", number, valid_until)
        key = await upload(world, pro, "pro_document", image)
        body = {"doc_type": doc_type, "file_key": key, "expires_on": valid_until}
        await world.call(pro, "POST", "/v1/pros/me/documents", json=body, what="document")


async def profile_id_of(world: World, pro: Actor) -> uuid.UUID:
    async with world.session() as session:
        profile_id = await ProService(session).get_profile_id_for_user(pro.user_id)
    if profile_id is None:
        raise SeedError(f"{pro.email} has no pro profile")
    return profile_id


async def approve_pro(world: World, admin: Actor, pro: Actor) -> uuid.UUID:
    """The admin reviews each document, then approves the pro: the panel's own calls."""
    profile_id = await profile_id_of(world, pro)
    base = f"/v1/admin/pros/{profile_id}"
    detail = await world.call(admin, "GET", base, what="pro for review")
    approved = {"decision": "approved"}
    for document in detail["documents"]:
        path = f"{base}/documents/{document['id']}/review"
        await world.call(admin, "POST", path, json=approved, what="document review")
    await world.call(admin, "POST", f"{base}/decision", json=approved, what="pro approval")
    return profile_id


async def enable_payouts(
    world: World, pro: Actor, account_id: str, accounts: AccountReader
) -> None:
    """Stores the pro's connected account and its payouts_enabled as `accounts` reads it, the
    profile row locked over the read (payouts.service.store_payouts_enabled)."""
    async with world.session() as session:
        pros = ProService(session)
        _, account = await pros.lock_payout_account(pro.user_id)
        if account.stripe_account_id is None:
            await pros.set_stripe_account(account.profile_id, account_id)
        state, _ = await store_payouts_enabled(pros, accounts, account, account_id)
        await session.commit()
    if not state.payouts_enabled:
        raise SeedError(f"{pro.email}: the connected account has payouts disabled")


# ---- Requests and quotes ----


async def create_request(
    world: World,
    customer: Actor,
    *,
    name: str,
    category_id: str | None,
    place: Place,
    description: str,
    answers: dict[str, object],
    preferred_date: str | None,
    media: list[bytes] | None = None,
) -> RequestRef:
    """POST /v1/requests, then the dispatch it queued. `name` makes the Idempotency-Key."""
    keys = [await upload(world, customer, "request_media", data) for data in media or []]
    body: dict[str, Any] = {
        "description": description,
        "category_id": category_id,
        "address": place.body(),
        "preferred_date": preferred_date,
        "preferred_period": "flexible" if preferred_date else None,
        "intake_answers": answers,
        "media_keys": keys,
    }
    made = await world.call(
        customer,
        "POST",
        "/v1/requests",
        json=body,
        headers=idempotency_key("request", name),
        what=f"request {name}",
    )
    await world.drain()
    return RequestRef(uuid.UUID(made["id"]), made["public_code"])


async def dispatch_of(world: World, pro: Actor, request: RequestRef) -> str | None:
    """The pro's dispatch for the request, from their opportunities list; None when the
    request did not reach them."""
    cursor: str | None = None
    while True:
        params = {"limit": str(OPPORTUNITY_PAGE)} | ({"cursor": cursor} if cursor else {})
        page = await world.call(
            pro, "GET", "/v1/pros/me/opportunities", params=params, what="opportunities"
        )
        for item in page["items"]:
            if item["public_code"] == request.public_code:
                found: str = item["dispatch_id"]
                return found
        cursor = page["next_cursor"]
        if cursor is None:
            return None


async def send_quote(world: World, pro: Actor, dispatch_id: str, terms: QuoteTerms) -> str:
    body = {
        "amount_cents": terms.amount_cents,
        "scope": terms.scope,
        "approach": terms.approach,
        "duration_minutes": terms.duration_minutes,
        "proposed_start_at": terms.start_at.isoformat(),
    }
    path = f"/v1/pros/me/opportunities/{dispatch_id}/quote"
    quote = await world.call(pro, "POST", path, json=body, what="quote")
    await world.drain()
    quote_id: str = quote["id"]
    return quote_id


async def accept_quote(world: World, customer: Actor, request: RequestRef, quote_id: str) -> None:
    path = f"/v1/requests/{request.id}/quotes/{quote_id}/accept"
    await world.call(customer, "POST", path, what="accept quote")
    await world.drain()


async def pay(
    world: World, customer: Actor, request: RequestRef, quote_id: str, checkout: Checkout
) -> uuid.UUID:
    """The customer pays the accepted quote; the job's id. The payment sheet call creates the
    PaymentIntent, `checkout` charges the card, and the succeeded intent books the job."""
    path = f"/v1/requests/{request.id}/quotes/{quote_id}/payment"
    sheet = await world.call(customer, "POST", path, what="payment sheet")
    secret: str = sheet["payment_intent_client_secret"]
    facts = await checkout.charge(secret.split("_secret_")[0])
    event = IntentEvent(
        stripe_event_id=f"evt_demo{uuid.uuid4().hex}",
        event_type="payment_intent.succeeded",
        intent_id=facts.payment_intent_id,
        amount=facts.amount_cents,
        currency=facts.currency,
        customer=facts.customer_id,
        failure_code=None,
        metadata_payment_id=facts.payment_id,
    )
    async with world.session() as session:
        outcome = await PaymentReconciler(session).apply(event, PaymentStatus.SUCCEEDED)
        await session.commit()
    if not isinstance(outcome, JobBooked):
        raise SeedError(f"{request.public_code}: the payment booked no job")
    return outcome.job_id


# ---- The job ----


async def on_the_way(world: World, pro: Actor, job_id: uuid.UUID, eta_minutes: int = 20) -> None:
    body = {"eta_minutes": eta_minutes}
    await world.call(pro, "POST", f"/v1/pros/me/jobs/{job_id}/on-the-way", json=body, what="omw")
    await world.drain()


async def check_in(
    world: World, customer: Actor, pro: Actor, request: RequestRef, job_id: uuid.UUID
) -> None:
    """The customer reads the arrival code from their job; the pro types it at the door."""
    job = await world.call(customer, "GET", f"/v1/requests/{request.id}/job", what="job")
    body = {"arrival_code": job["arrival_code"], "lat": 26.1003, "lng": -80.1056}
    await world.call(pro, "POST", f"/v1/pros/me/jobs/{job_id}/check-in", json=body, what="check-in")
    await world.drain()


async def start_work(world: World, pro: Actor, job_id: uuid.UUID) -> None:
    await world.call(pro, "POST", f"/v1/pros/me/jobs/{job_id}/start", what="start")
    await world.drain()


async def add_photo(world: World, pro: Actor, job_id: uuid.UUID, kind: str, image: bytes) -> None:
    """A before or after photo; the drain makes its privacy-safe copy, as the worker does."""
    body = {"kind": kind, "upload_keys": [await upload(world, pro, "job_photo", image)]}
    await world.call(pro, "POST", f"/v1/pros/me/jobs/{job_id}/photos", json=body, what="photo")
    await world.drain()


async def complete(world: World, pro: Actor, job_id: uuid.UUID) -> None:
    await world.call(pro, "POST", f"/v1/pros/me/jobs/{job_id}/complete", what="job's done")
    await world.drain()


async def confirm(world: World, customer: Actor, request: RequestRef) -> None:
    """The customer confirms; the drain releases the transfer to the pro."""
    await world.call(customer, "POST", f"/v1/requests/{request.id}/job/confirm", what="confirm")
    await world.drain()


async def review(
    world: World, author: Actor, job_id: uuid.UUID, overall: int, comment: str
) -> None:
    body: dict[str, object] = {"overall": overall, "comment": comment}
    if author.role is UserRole.CUSTOMER:
        body |= {"communication": overall, "quality": overall, "punctuality": overall}
    await world.call(author, "POST", f"/v1/jobs/{job_id}/reviews", json=body, what="review")


# ---- Problems and support ----


async def report_problem(
    world: World,
    customer: Actor,
    job_id: uuid.UUID,
    *,
    reason: str,
    description: str,
    photos: list[bytes],
) -> None:
    keys = [await upload(world, customer, "dispute_photo", data) for data in photos]
    body = {"reason_code": reason, "description": description, "photo_keys": keys}
    await world.call(
        customer,
        "POST",
        f"/v1/jobs/{job_id}/dispute",
        json=body,
        headers=idempotency_key("dispute", str(job_id)),
        what="report a problem",
    )
    await world.drain()


async def reply_to_problem(world: World, pro: Actor, job_id: uuid.UUID, message: str) -> None:
    path = f"/v1/pros/me/jobs/{job_id}/dispute/reply"
    await world.call(pro, "POST", path, json={"message": message}, what="problem reply")
    await world.drain()


async def dispute_of(world: World, admin: Actor, job_id: uuid.UUID) -> DisputeRef:
    """The job's dispute as the panel reads it: the list, then the detail (an audited read)."""
    listing = await world.call(admin, "GET", "/v1/admin/disputes", what="disputes")
    for dispute in listing["disputes"]:
        if dispute["job_id"] == str(job_id):
            path = f"/v1/admin/disputes/{dispute['id']}"
            detail = await world.call(admin, "GET", path, what="dispute")
            return DisputeRef(detail["id"], detail["public_code"], detail["pro_payout_cents"])
    raise SeedError(f"no dispute for job {job_id}")


async def resolve_dispute(
    world: World,
    admin: Actor,
    dispute_id: str,
    *,
    decision: str,
    note: str,
    pro_release_cents: int | None = None,
) -> None:
    body = {"decision": decision, "note": note, "pro_release_cents": pro_release_cents}
    path = f"/v1/admin/disputes/{dispute_id}/resolve"
    await world.call(admin, "POST", path, json=body, what=f"resolve ({decision})")
    await world.drain()


async def open_ticket(
    world: World, user: Actor, *, name: str, topic: str, message: str, job_id: uuid.UUID | None
) -> None:
    body = {
        "topic": topic,
        "message": message,
        "job_id": None if job_id is None else str(job_id),
        "app_version": _APP_VERSION,
        "platform": "android",
    }
    await world.call(
        user,
        "POST",
        "/v1/support/tickets",
        json=body,
        headers=idempotency_key("ticket", name),
        what="support ticket",
    )


async def claim(world: World, agent: Actor, request: RequestRef) -> None:
    await world.call(agent, "POST", f"/v1/admin/requests/{request.id}/claim", what="claim")
