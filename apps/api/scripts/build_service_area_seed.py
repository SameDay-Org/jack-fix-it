"""Build app/modules/service_areas/seed_data.json for South Florida (#9).

`uv run python -m scripts.build_service_area_seed` from apps/api. A data tool, not run by the
app: it downloads two public files, writes the seed file and prints what Cesar should eyeball.
Pass `--geonames US.zip --census tab20.txt` to rebuild from files already downloaded.

Rule (SOURCES.md next to the seed file):
1. GeoNames US postal codes, state FL, county (admin name 2) one of COUNTIES;
2. kept only when the ZIP is a 2020 Census ZCTA: PO-box-only and unique ZIPs have none;
3. the county is the Census one, the county holding most of the ZCTA's land area. A ZIP whose
   Census county is not one of COUNTIES is left out and listed as a disagreement.
"""

import argparse
import csv
import io
import json
import urllib.request
import zipfile
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from app.modules.service_areas.service import SEED_DATA_PATH

GEONAMES_URL: Final = "https://download.geonames.org/export/zip/US.zip"
CENSUS_URL: Final = (
    "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/"
    "tab20_zcta520_county20_natl.txt"
)
REGION: Final = "South Florida"
STATE: Final = "FL"


@dataclass(frozen=True)
class County:
    name: str  # as GeoNames spells it (admin name 2)
    fips: str  # state + county, as the Census file spells it
    active: bool


# Decided by Cesar on 2026-10-22 (#9): Broward at launch, Miami-Dade and Palm Beach later.
COUNTIES: Final = (
    County(name="Broward", fips="12011", active=True),
    County(name="Miami-Dade", fips="12086", active=False),
    County(name="Palm Beach", fips="12099", active=False),
)


@dataclass(frozen=True)
class PostalCode:
    zip_code: str
    city: str
    county: str


@dataclass(frozen=True)
class CensusCounty:
    fips: str
    name: str  # NAMELSAD, e.g. "Martin County"


@dataclass(frozen=True)
class Disagreement:
    zip_code: str
    geonames_county: str
    census_county: str


def parse_geonames(text: str) -> list[PostalCode]:
    """Every FL postal code. GeoNames columns: country, postal code, place name, admin name 1,
    admin code 1, admin name 2, ... (readme.txt in US.zip)."""
    codes = []
    for row in csv.reader(io.StringIO(text), delimiter="\t"):
        zip_code, city, state, county = row[1], row[2], row[4], row[5]
        if state == STATE:
            codes.append(PostalCode(zip_code=zip_code, city=city.strip(), county=county))
    return codes


def dominant_counties(text: str) -> dict[str, CensusCounty]:
    """ZCTA -> the county holding most of its land area, for every ZCTA in the file."""
    best: dict[str, tuple[int, CensusCounty]] = {}
    for row in csv.DictReader(io.StringIO(text), delimiter="|"):
        zcta = row["GEOID_ZCTA5_20"]
        if not zcta:  # a county part outside every ZCTA
            continue
        land = int(row["AREALAND_PART"])
        if zcta not in best or land > best[zcta][0]:
            county = CensusCounty(fips=row["GEOID_COUNTY_20"], name=row["NAMELSAD_COUNTY_20"])
            best[zcta] = (land, county)
    return {zcta: county for zcta, (_, county) in best.items()}


def build(
    codes: list[PostalCode], census: dict[str, CensusCounty]
) -> tuple[list[dict[str, object]], list[Disagreement]]:
    """The seed entries sorted by ZIP, and every ZIP whose two sources name different counties.

    `codes` are GeoNames' FL postal codes; `census` maps each ZCTA to its county.
    """
    by_fips = {county.fips: county for county in COUNTIES}
    names = {county.name for county in COUNTIES}
    entries: list[dict[str, object]] = []
    disagreements = []
    for code in sorted(codes, key=lambda code: code.zip_code):
        if code.county not in names:
            continue
        census_county = census.get(code.zip_code)
        if census_county is None:
            continue  # no ZCTA: a PO-box-only or unique ZIP
        county = by_fips.get(census_county.fips)
        if county is None or county.name != code.county:
            census_name = county.name if county else census_county.name
            disagreements.append(Disagreement(code.zip_code, code.county, census_name))
        if county is None:
            continue
        entries.append(
            {
                "region": REGION,
                "city": code.city,
                "state": STATE,
                "zip_code": code.zip_code,
                "county": county.name,
                "active": county.active,
            }
        )
    # ZCTAs the Census puts inside COUNTIES while GeoNames puts them elsewhere, or has no such
    # postal code: listed, not kept (rule 1).
    geonames_county = {code.zip_code: code.county for code in codes}
    for zcta, census_county in sorted(census.items()):
        county_name = geonames_county.get(zcta, "absent")
        county = by_fips.get(census_county.fips)
        if county is not None and county_name not in names:
            disagreements.append(Disagreement(zcta, county_name, county.name))
    return entries, disagreements


def _download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 (fixed https URLs)
        body: bytes = response.read()
    return body


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--geonames", type=Path, help="US.zip already downloaded")
    parser.add_argument("--census", type=Path, help="the relationship file already downloaded")
    parser.add_argument("--output", type=Path, default=SEED_DATA_PATH)
    args = parser.parse_args()

    geonames_zip = args.geonames.read_bytes() if args.geonames else _download(GEONAMES_URL)
    census_text = args.census.read_bytes() if args.census else _download(CENSUS_URL)
    us_txt = zipfile.ZipFile(io.BytesIO(geonames_zip)).read("US.txt").decode("utf-8")
    # The Census file starts with a byte order mark.
    entries, disagreements = build(
        parse_geonames(us_txt), dominant_counties(census_text.decode("utf-8-sig"))
    )

    built_on = datetime.now(UTC).date().isoformat()
    seed = {
        "note": (
            f"{REGION} launch areas (#9), built on {built_on} by "
            "scripts/build_service_area_seed.py from GeoNames US.zip and the Census 2020 "
            "ZCTA-to-county relationship file; sources and rule in SOURCES.md. Contains data "
            "from GeoNames, CC BY 4.0. The seed inserts missing ZIPs and never changes an "
            "existing row: switch a county on in the admin or with SQL (docs/railway.md)."
        ),
        "service_areas": entries,
    }
    args.output.write_bytes((json.dumps(seed, indent=2, ensure_ascii=False) + "\n").encode())

    counts = Counter(str(entry["county"]) for entry in entries)
    print(f"Wrote {len(entries)} ZIPs to {args.output}")
    for county in COUNTIES:
        state = "active" if county.active else "inactive"
        print(f"  {county.name}: {counts[county.name]} ({state})")
    print(f"County disagreements ({len(disagreements)}):")
    for item in disagreements:
        print(f"  {item.zip_code}: GeoNames {item.geonames_county}, Census {item.census_county}")


if __name__ == "__main__":
    main()
