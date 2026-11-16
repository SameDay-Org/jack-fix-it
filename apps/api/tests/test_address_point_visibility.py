"""The point geocode on save keeps (#384) is for the server's own use: no response carries
it. The visibility rules of the address are as they were: a pro sees the ZIP and its city
before a job, the street once hired, and never a coordinate; the customer's own views of the
request and the job have none either."""

import uuid
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.jobs.models import JobStatus
from tests import job_world
from tests.helpers import json_fields
from tests.test_opportunities_api import BASE as OPPORTUNITIES
from tests.test_opportunities_api import build_world as build_opportunity_world
from tests.test_opportunities_api import dispatch, listed, make_request, storage
from tests.test_requests_api import FakeStorage

# Fixtures, used by name.
__all__ = ["storage"]

# Digits no id, time or other number of a response spells.
LAT, LNG = Decimal("28.53836"), Decimal("-81.37924")
NEEDLES = ("28.5383", "81.3792")
COORDINATE_KEYS = {"lat", "lng", "latitude", "longitude", "coordinates", "point"}
ADDRESS_KEYS = {"line1", "line2", "city", "state", "zip_code"}


async def keep_point(session: AsyncSession, address_id: uuid.UUID) -> None:
    address = await session.get(Address, address_id)
    assert address is not None
    address.lat, address.lng = LAT, LNG
    await session.flush()


def keys_of(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in keys_of(item)}
    if isinstance(value, list):
        return {key for item in value for key in keys_of(item)}
    return set()


def assert_no_point(response: httpx.Response) -> Any:
    assert response.status_code == 200, response.text
    body = response.json()
    assert keys_of(body) & COORDINATE_KEYS == set()
    for needle in NEEDLES:
        assert [field for field in json_fields(body) if needle in field] == [], needle
        assert needle not in response.text, needle
    return body


async def test_a_pro_sees_no_point_before_a_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    world = await build_opportunity_world(db_session)
    await keep_point(db_session, world.address_id)
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    listing = assert_no_point(await listed(db_client, world.me))
    detail = assert_no_point(
        await db_client.get(f"{OPPORTUNITIES}/{dispatch_id}", headers=world.me.caller.headers)
    )

    # Where the job is, coarsely, as before: the ZIP and the city of its service area.
    assert listing["items"][0]["location"] == {"zip_code": "32801", "city": "Orlando"}
    assert detail["location"] == {"zip_code": "32801", "city": "Orlando"}


async def test_the_hired_pro_and_the_customer_see_the_address_without_its_point(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    job_world.record_pushes(app)
    world = await job_world.build_world(db_session)
    await keep_point(db_session, world.address_id)
    job = await job_world.make_job(db_session, world, JobStatus.SCHEDULED)

    pro_job = assert_no_point(
        await db_client.get(f"/v1/pros/me/jobs/{job.id}", headers=world.pro.headers)
    )
    pro_jobs = assert_no_point(await db_client.get("/v1/pros/me/jobs", headers=world.pro.headers))
    request = assert_no_point(
        await db_client.get(f"/v1/requests/{job.request_id}", headers=world.customer.headers)
    )
    requests = assert_no_point(await db_client.get("/v1/requests", headers=world.customer.headers))
    customer_job = assert_no_point(
        await db_client.get(f"/v1/requests/{job.request_id}/job", headers=world.customer.headers)
    )

    # The hired pro has to get there: the street, as before, and nothing more.
    assert set(pro_job["address"]) == ADDRESS_KEYS
    assert pro_job["address"]["line1"] == job_world.LINE1
    assert set(request["address"]) == ADDRESS_KEYS
    assert pro_jobs["items"]
    assert requests["items"]
    assert customer_job["id"] == str(job.id)


# Which schemas of the API name a coordinate at all: the pro's own position (#350), the
# device's (#215, check-in) and the address book's, which the app itself sends (#214).
SCHEMAS_WITH_A_POINT = {
    "CheckInIn",
    "ProLocationIn",
    "ProPosition",
    "ReversePositionIn",
    "SavedAddressIn",
    "SavedAddressOut",
    "SavedAddressPatch",
}


def test_no_schema_gained_a_coordinate(app: FastAPI) -> None:
    schemas = app.openapi()["components"]["schemas"]
    with_a_point = {
        name
        for name, schema in schemas.items()
        if {"lat", "lng"} & set(schema.get("properties", {}))
    }

    assert with_a_point == SCHEMAS_WITH_A_POINT


@pytest.mark.parametrize("name", ["AddressIn", "AddressOut", "JobAddress", "OpportunityLocation"])
def test_a_request_address_has_no_coordinate_in_the_contract(app: FastAPI, name: str) -> None:
    properties = set(app.openapi()["components"]["schemas"][name]["properties"])

    assert properties & COORDINATE_KEYS == set()
    assert properties <= ADDRESS_KEYS
