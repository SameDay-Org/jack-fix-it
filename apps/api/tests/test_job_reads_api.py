"""Reading a paid job (D12.2, #63): the customer's GET /v1/requests/{id}/job and the pro's
GET /v1/pros/me/jobs[/{id}]."""

import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.schemas import AddressIn
from app.modules.addresses.service import AddressService
from app.modules.jobs.models import Job, JobStatus
from app.modules.requests.schemas import RequestCreate
from app.modules.users.names import safe_first_name
from app.redaction import MASK, KnownValues
from tests.job_world import (
    CUSTOMER_EMAIL,
    CUSTOMER_FIRST,
    CUSTOMER_PHONE,
    FEE,
    LEAKS,
    LINE1,
    LINE2,
    PAYOUT,
    PRICE,
    START,
    TAX,
    JobWorld,
    build_world,
    make_accepted_request,
    make_job,
)

NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
CODE = "0427"
CUSTOMER_KEYS = {
    "id",
    "status",
    "customer_status",
    "scheduled_start_at",
    "pro",
    "eta_at",
    "arrival_code",
    "timeline",
    "amount_cents",
    "tax_cents",
    "customer_total_cents",
}
PRO_KEYS = {
    "id",
    "status",
    "scheduled_start_at",
    "category",
    "description",
    "address",
    "customer_first_name",
    "eta_at",
    "checked_in_at",
    "arrival_code_locked",
    "started_at",
    "pro_payout_cents",
}
BASE = "/v1/pros/me/jobs"


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def customer_path(job: Job) -> str:
    return f"/v1/requests/{job.request_id}/job"


def no_leaks(text: str) -> None:
    for leak in LEAKS:
        assert leak not in text


# The customer


async def test_customer_sees_own_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.get(customer_path(job), headers=world.customer.headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == CUSTOMER_KEYS
    assert body["id"] == str(job.id)
    assert body["status"] == "scheduled"
    assert body["customer_status"] == "customerStatus.scheduled"
    assert datetime.fromisoformat(body["scheduled_start_at"]) == START
    assert body["pro"] == {
        "id": str(world.pro.profile_id),
        "name": "María P.",
        "rating_avg": None,
        "jobs_count": 0,
        "years_of_experience": 7,
        "verified": True,
    }
    assert body["eta_at"] is None
    assert body["arrival_code"] is None
    assert [(e["type"], e["status"]) for e in body["timeline"]] == [("created", "scheduled")]
    assert set(body["timeline"][0]) == {"type", "status", "at"}
    assert (body["amount_cents"], body["tax_cents"], body["customer_total_cents"]) == (
        PRICE,
        TAX,
        PRICE + TAX,
    )
    assert str(PAYOUT) not in response.text
    assert str(FEE) not in response.text
    no_leaks(response.text)


@pytest.mark.parametrize(
    ("status", "checked_in", "shown"),
    [
        (JobStatus.SCHEDULED, False, False),
        (JobStatus.ON_THE_WAY, False, True),
        (JobStatus.ON_THE_WAY, True, False),
        (JobStatus.IN_PROGRESS, True, False),
        (JobStatus.COMPLETED, True, False),
        (JobStatus.CANCELLED, False, False),
    ],
)
async def test_customer_sees_the_code_only_while_on_the_way(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
    checked_in: bool,
    shown: bool,
) -> None:
    # The code is cleared at check-in; a stray stored one is still never shown after it.
    job = await make_job(
        db_session,
        world,
        status,
        arrival_code=CODE,
        eta_at=datetime.now(UTC) + timedelta(minutes=30),
        checked_in_at=datetime.now(UTC) if checked_in else None,
    )

    response = await db_client.get(customer_path(job), headers=world.customer.headers)

    assert response.status_code == 200, response.text
    assert response.json()["arrival_code"] == (CODE if shown else None)
    assert response.json()["eta_at"] is not None


async def test_customer_cannot_read_another_customers_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY, arrival_code=CODE)

    other = await db_client.get(customer_path(job), headers=world.other_customer.headers)
    unknown = await db_client.get(
        f"/v1/requests/{uuid.uuid4()}/job", headers=world.customer.headers
    )

    assert (other.status_code, other.json()) == (404, NOT_FOUND)
    assert (unknown.status_code, unknown.json()) == (404, NOT_FOUND)
    assert CODE not in other.text


async def test_customer_request_without_a_job_is_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # Accepted, the payment still pending: no job yet.
    request, _ = await make_accepted_request(db_session, world, world.pro)

    response = await db_client.get(f"/v1/requests/{request.id}/job", headers=world.customer.headers)

    assert (response.status_code, response.json()) == (404, NOT_FOUND)


@pytest.mark.parametrize("role", ["pro", "agent", "admin"])
async def test_only_customers_read_the_request_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, role: str
) -> None:
    job = await make_job(db_session, world)
    headers = getattr(world, role).headers

    response = await db_client.get(customer_path(job), headers=headers)

    assert (response.status_code, response.json()) == (403, FORBIDDEN)


# The pro


async def test_pro_sees_own_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    eta = datetime.now(UTC) + timedelta(minutes=20)
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY, arrival_code=CODE, eta_at=eta)

    response = await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == PRO_KEYS
    assert body["status"] == "on_the_way"
    assert datetime.fromisoformat(body["scheduled_start_at"]) == START
    assert body["category"]["id"] == str(world.category_id)
    assert body["category"]["names"] == {"en": "Plumbing", "es": "Plomería"}
    # The customer's description, contacts masked as in the opportunity.
    assert body["description"].startswith("Kitchen faucet drips, call ")
    assert body["address"] == {
        "line1": LINE1,
        "line2": LINE2,
        "city": "Orlando",
        "state": "FL",
        "zip_code": "32801",
    }
    assert body["customer_first_name"] == CUSTOMER_FIRST
    assert datetime.fromisoformat(body["eta_at"]) == eta
    assert body["checked_in_at"] is None
    assert body["arrival_code_locked"] is False
    assert body["started_at"] is None
    assert body["pro_payout_cents"] == PAYOUT
    # Never the arrival code, the customer's last name or any contact.
    assert CODE not in response.text
    no_leaks(response.text)


async def test_pro_cannot_read_another_pros_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, pro=world.other_pro)

    detail = await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers)
    unknown = await db_client.get(f"{BASE}/{uuid.uuid4()}", headers=world.pro.headers)
    bare = await db_client.get(f"{BASE}/{job.id}", headers=world.pro_without_profile.headers)
    listed = await db_client.get(BASE, headers=world.pro.headers)

    for response in (detail, unknown, bare):
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
    assert listed.json() == {"items": [], "next_cursor": None}
    no_leaks(detail.text)


@pytest.mark.parametrize("role", ["customer", "agent", "admin"])
async def test_only_pros_read_pro_jobs(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, role: str
) -> None:
    job = await make_job(db_session, world)
    headers = getattr(world, role).headers

    for path in (BASE, f"{BASE}/{job.id}"):
        response = await db_client.get(path, headers=headers)
        assert (response.status_code, response.json()) == (403, FORBIDDEN)


async def test_unauthenticated_is_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)

    for path in (BASE, f"{BASE}/{job.id}", customer_path(job)):
        assert (await db_client.get(path)).status_code == 401


async def test_pro_address_is_withheld_once_cancelled(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    cancelled = await make_job(db_session, world, JobStatus.CANCELLED)
    refunded = await make_job(db_session, world, JobStatus.REFUNDED)

    for job in (cancelled, refunded):
        response = await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers)
        assert response.status_code == 200, response.text
        assert response.json()["address"] is None
        assert LINE1 not in response.text


# Contacts typed into the address (Gatekeeper round 1, B1): masked for the pro, the address kept.

ADDRESS = {
    "line1": LINE1,
    "line2": LINE2,
    "city": "Orlando",
    "state": "FL",
    "zip_code": "32801",
}
FAKE_EMAIL = "private63@example.com"
FAKE_PHONE = "+13055550963"


async def _job_at(
    db_session: AsyncSession, world: JobWorld, address: dict[str, str]
) -> tuple[JobWorld, Job]:
    """A scheduled job at `address`, stored as the public request schema accepts it."""
    data = RequestCreate(description="Fix the faucet", address=AddressIn.model_validate(address))
    address_id = await AddressService(db_session).create(world.customer.id, data.address)
    world = replace(world, address_id=address_id)
    return world, await make_job(db_session, world)


async def _pro_responses(
    db_client: httpx.AsyncClient, world: JobWorld, job: Job
) -> dict[str, httpx.Response]:
    """The three responses that carry the pro's view of the address."""
    responses = {
        "list": await db_client.get(BASE, headers=world.pro.headers),
        "detail": await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers),
        "on-the-way": await db_client.post(
            f"{BASE}/{job.id}/on-the-way", json={"eta_minutes": 15}, headers=world.pro.headers
        ),
    }
    for name, response in responses.items():
        assert response.status_code == 200, (name, response.text)
    return responses


def _address_of(name: str, response: httpx.Response) -> dict[str, str | None]:
    body = response.json()
    address: dict[str, str | None] = (body["items"][0] if name == "list" else body)["address"]
    return address


@pytest.mark.parametrize("field", ["line1", "line2", "city"])
@pytest.mark.parametrize("contact", [FAKE_EMAIL, FAKE_PHONE])
async def test_pro_address_masks_a_contact_typed_into_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    field: str,
    contact: str,
) -> None:
    typed = {**ADDRESS, field: f"{ADDRESS[field]}; contact {contact}"}
    world, job = await _job_at(db_session, world, typed)

    responses = await _pro_responses(db_client, world, job)

    for name, response in responses.items():
        assert contact not in response.text, name
        # The contact is masked; the street, the unit and the city stay usable.
        assert _address_of(name, response) == {
            **ADDRESS,
            field: f"{ADDRESS[field]}; contact {MASK}",
        }, name
    # Masked on the way out only: the stored address, which the customer's own views read
    # (AddressService.get), keeps what they typed.
    stored = await AddressService(db_session).get(world.address_id)
    assert stored is not None
    assert getattr(stored, field) == typed[field]


async def test_pro_address_masks_the_customers_own_contacts_in_any_form(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """The known values run first: the customer's account email spelled out and their phone
    with other punctuation are masked too."""
    local, domain = CUSTOMER_EMAIL.split("@")
    spelled = f"{local} at {domain.replace('.', ' dot ')}"
    digits = CUSTOMER_PHONE.removeprefix("+1")
    spaced = f"{digits[:3]}  {digits[3:6]} / {digits[6:]}"
    world, job = await _job_at(
        db_session, world, {**ADDRESS, "line2": f"{LINE2} {spelled}", "city": f"Orlando {spaced}"}
    )

    responses = await _pro_responses(db_client, world, job)

    for name, response in responses.items():
        address = _address_of(name, response)
        assert address["line2"] == f"{LINE2} {MASK}", name
        assert address["city"] == f"Orlando {MASK}", name
        no_leaks(response.text)
        assert spelled not in response.text


@pytest.mark.parametrize(
    "address",
    [
        ADDRESS,
        {**ADDRESS, "line1": "1200 NW 7th St", "line2": "Unit 4B, gate code 1234"},
        {**ADDRESS, "line1": "PO Box 1234", "line2": None},
        {**ADDRESS, "line1": "15500 SW 117th Ave", "line2": "Building 12, Suite 300"},
        {**ADDRESS, "line1": "Calle 8 #1500", "line2": "Apto 2"},
    ],
)
async def test_pro_address_without_contacts_is_unchanged(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    address: dict[str, str | None],
) -> None:
    world, job = await _job_at(db_session, world, {k: v for k, v in address.items() if v})

    responses = await _pro_responses(db_client, world, job)

    for name, response in responses.items():
        assert _address_of(name, response) == {**ADDRESS, "line2": None, **address}, name


async def test_pro_list_newest_scheduled_first_active_filter_and_cursor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """Ordered by the accepted quote's proposed start, not by the booking: each job here was
    booked an hour after the one before it, and scheduled in another order."""
    t0 = datetime(2026, 11, 1, tzinfo=UTC)
    day = START.replace(hour=9, minute=0)
    plan = [  # (status, scheduled start)
        (JobStatus.SCHEDULED, day + timedelta(days=3)),
        (JobStatus.COMPLETED, day + timedelta(days=5)),
        (JobStatus.ON_THE_WAY, day),
        (JobStatus.CANCELLED, day + timedelta(days=1)),
        (JobStatus.IN_PROGRESS, day + timedelta(days=4)),
    ]
    jobs = [
        await make_job(db_session, world, status, created_at=t0 + timedelta(hours=i), start=start)
        for i, (status, start) in enumerate(plan)
    ]
    await make_job(
        db_session,
        world,
        pro=world.other_pro,
        created_at=t0 + timedelta(days=1),
        start=day + timedelta(days=2),
    )
    newest_scheduled = [str(jobs[i].id) for i in (1, 4, 0, 3, 2)]

    everything = await db_client.get(BASE, headers=world.pro.headers, params={"limit": 50})
    active = await db_client.get(BASE, headers=world.pro.headers, params={"active": "true"})
    pages: list[list[str]] = []
    cursor: str | None = None
    while True:
        params: dict[str, str | int] = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = await db_client.get(BASE, headers=world.pro.headers, params=params)
        assert page.status_code == 200, page.text
        pages.append([item["id"] for item in page.json()["items"]])
        cursor = page.json()["next_cursor"]
        if cursor is None:
            break
    active_first = await db_client.get(
        BASE, headers=world.pro.headers, params={"active": "true", "limit": 1}
    )
    active_rest = await db_client.get(
        BASE,
        headers=world.pro.headers,
        params={"active": "true", "limit": 5, "cursor": active_first.json()["next_cursor"]},
    )
    bad = await db_client.get(BASE, headers=world.pro.headers, params={"cursor": "not-a-cursor"})

    items = everything.json()["items"]
    assert [item["id"] for item in items] == newest_scheduled
    assert [datetime.fromisoformat(item["scheduled_start_at"]) for item in items] == [
        plan[i][1] for i in (1, 4, 0, 3, 2)
    ]
    assert everything.json()["next_cursor"] is None
    assert pages == [newest_scheduled[:2], newest_scheduled[2:4], newest_scheduled[4:]]
    active_order = [str(jobs[4].id), str(jobs[0].id), str(jobs[2].id)]
    assert [item["id"] for item in active.json()["items"]] == active_order
    assert [item["id"] for item in active_first.json()["items"]] == active_order[:1]
    assert [item["id"] for item in active_rest.json()["items"]] == active_order[1:]
    assert active_rest.json()["next_cursor"] is None
    assert bad.status_code == 422
    for item in items:
        assert set(item) == PRO_KEYS
    no_leaks(everything.text)


async def test_pro_list_breaks_a_tied_start_by_job_id_across_pages(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """Jobs at the same start page by the job id (descending): none repeats, none is lost."""
    later = START + timedelta(days=1)
    tied = [await make_job(db_session, world, start=START) for _ in range(4)]
    first = await make_job(db_session, world, start=later)
    expected = [str(first.id), *sorted((str(job.id) for job in tied), reverse=True)]

    seen: list[str] = []
    cursor: str | None = None
    for _ in range(len(expected)):
        params: dict[str, str | int] = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = (await db_client.get(BASE, headers=world.pro.headers, params=params)).json()
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == expected


async def test_a_pro_without_a_profile_lists_nothing(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    response = await db_client.get(BASE, headers=world.pro_without_profile.headers)

    assert response.json() == {"items": [], "next_cursor": None}


@pytest.mark.parametrize(
    ("first_name", "expected"),
    [
        ("Ana", "Ana"),
        (None, None),
        ("", None),
        ("probe-customer-63", None),  # the local part of the account's own email
        ("repair.example.com", None),
    ],
)
def test_first_name_is_withheld_when_it_shows_a_contact(
    first_name: str | None, expected: str | None
) -> None:
    known = KnownValues(emails=("probe-customer-63@example.com",), phones=())

    assert safe_first_name(first_name, known) == expected
