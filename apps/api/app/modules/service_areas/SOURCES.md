# Sources of `seed_data.json`

The launch service areas: South Florida, decided by Cesar on 2026-10-22 (#9). Broward is active
at launch; Miami-Dade and Palm Beach are seeded inactive and switched on later (context doc §1).

Last built on 2026-10-22 by `scripts/build_service_area_seed.py`.

## Sources

- **GeoNames US postal codes**: <https://download.geonames.org/export/zip/US.zip>, downloaded
  on 2026-10-22. Contains data from GeoNames, CC BY 4.0
  (<https://creativecommons.org/licenses/by/4.0/>). The city names are GeoNames' place names,
  unchanged.
- **US Census Bureau, 2020 ZCTA to county relationship file**:
  <https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt>,
  downloaded on 2026-10-22. A US Government work, public domain.

## Rule

1. Take the GeoNames postal codes with state `FL` and county (admin name 2) Broward, Miami-Dade
   or Palm Beach.
2. Keep a code only when it is a 2020 Census ZCTA. PO-box-only and unique ZIPs have no ZCTA and
   are dropped.
3. Use the Census county: the county holding most of the ZCTA's land area (Broward 12011,
   Miami-Dade 12086, Palm Beach 12099). A ZIP whose Census county is none of the three is left
   out. The build lists every ZIP where the two sources disagree.
4. Each entry is `{region: "South Florida", city, state: "FL", zip_code, county, active}`, sorted
   by ZIP. `active` is true for Broward only. `county` is not a column: tests use it to check
   the file.

## Rebuild

From `apps/api`, run `uv run python -m scripts.build_service_area_seed`. The command downloads
both files. To use copies you already have, add `--geonames US.zip --census tab20.txt`.

Review the diff and the printed counts and disagreements before committing. Seeding the database
is a separate step; see `docs/railway.md`.
