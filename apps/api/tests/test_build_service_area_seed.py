"""The build rule of the launch seed file (#9), on small fixture files: no network."""

from scripts.build_service_area_seed import (
    CensusCounty,
    Disagreement,
    PostalCode,
    build,
    dominant_counties,
    parse_geonames,
)

# GeoNames columns: country, postal code, place name, admin name 1, admin code 1, admin name 2,
# admin code 2, admin name 3, admin code 3, latitude, longitude, accuracy. Fixture rows only.
GEONAMES = "\n".join(
    "\t".join(row)
    for row in [
        ["US", "00101", "Alpha", "Florida", "FL", "Broward", "011", "", "", "0", "0", "4"],
        ["US", "00102", "Beta ", "Florida", "FL", "Miami-Dade", "086", "", "", "0", "0", "4"],
        ["US", "00103", "Gamma", "Florida", "FL", "Palm Beach", "099", "", "", "0", "0", "4"],
        ["US", "00104", "PO Box", "Florida", "FL", "Broward", "011", "", "", "0", "0", "4"],
        ["US", "00105", "Delta", "Florida", "FL", "Palm Beach", "099", "", "", "0", "0", "4"],
        ["US", "00106", "Epsilon", "Florida", "FL", "Hendry", "051", "", "", "0", "0", "4"],
        ["US", "00107", "Zeta", "Georgia", "GA", "Broward", "011", "", "", "0", "0", "4"],
    ]
)

HEADER = (
    "OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|"
    "MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|"
    "NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|"
    "CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART"
)


def census_row(zcta: str, fips: str, name: str, land: int) -> str:
    return f"1|{zcta}|ZCTA5 {zcta}|0|0|G6350|B5|S|2|{fips}|{name}|0|0|G4020|H1|A|{land}|0"


CENSUS = "\n".join(
    [
        HEADER,
        census_row("00101", "12011", "Broward County", 900),
        census_row("00101", "12086", "Miami-Dade County", 100),  # mostly Broward
        census_row("00102", "12086", "Miami-Dade County", 500),
        census_row("00103", "12099", "Palm Beach County", 10),
        census_row("00103", "12011", "Broward County", 20),  # GeoNames says Palm Beach
        census_row("00105", "12085", "Martin County", 50),  # outside the three counties
        census_row("00106", "12099", "Palm Beach County", 50),  # GeoNames says Hendry
        census_row("00108", "12011", "Broward County", 50),  # GeoNames has no such code
        census_row("", "12011", "Broward County", 999),  # a county part outside every ZCTA
    ]
)


def test_parse_geonames_keeps_florida_only() -> None:
    codes = parse_geonames(GEONAMES)

    assert [code.zip_code for code in codes] == [f"0010{n}" for n in range(1, 7)]
    assert codes[1] == PostalCode(zip_code="00102", city="Beta", county="Miami-Dade")


def test_dominant_county_is_the_one_with_most_land() -> None:
    counties = dominant_counties(CENSUS)

    assert counties["00101"] == CensusCounty(fips="12011", name="Broward County")
    assert counties["00103"].fips == "12011"
    assert "" not in counties


def test_build_keeps_zctas_of_the_three_counties_and_lists_disagreements() -> None:
    entries, disagreements = build(parse_geonames(GEONAMES), dominant_counties(CENSUS))

    assert entries == [
        {
            "region": "South Florida",
            "city": "Alpha",
            "state": "FL",
            "zip_code": "00101",
            "county": "Broward",
            "active": True,
        },
        {
            "region": "South Florida",
            "city": "Beta",
            "state": "FL",
            "zip_code": "00102",
            "county": "Miami-Dade",
            "active": False,
        },
        # The Census county wins: Broward, so active.
        {
            "region": "South Florida",
            "city": "Gamma",
            "state": "FL",
            "zip_code": "00103",
            "county": "Broward",
            "active": True,
        },
    ]
    # 00104 has no ZCTA (a PO-box-only code): dropped without a disagreement.
    assert disagreements == [
        Disagreement("00103", "Palm Beach", "Broward"),
        Disagreement("00105", "Palm Beach", "Martin County"),
        Disagreement("00106", "Hendry", "Palm Beach"),
        Disagreement("00108", "absent", "Broward"),
    ]
