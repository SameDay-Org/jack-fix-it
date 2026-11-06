"""Where a user lives, as the ID card shows it (#250): the city and the US state, nothing more
precise. A customer's full addresses are their saved addresses (#214). PII: never logged.
"""

from typing import Annotated, Final

from pydantic import AfterValidator, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL

HOME_CITY_MAX_LENGTH: Final = 80

# The 50 states and the District of Columbia, as USPS writes them. Also the database CHECK
# (ck_users_home_state_us): the migration that created it lists the same codes.
US_STATE_CODES: Final[frozenset[str]] = frozenset(
    {
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
        "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
        "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
        "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    }
)  # fmt: skip


def home_state_check_sql() -> str:
    """The CHECK's condition: NULL, or one of the codes."""
    codes = ", ".join(f"'{code}'" for code in sorted(US_STATE_CODES))
    return f"home_state IS NULL OR home_state IN ({codes})"


def _us_state(value: str) -> str:
    if value not in US_STATE_CODES:
        raise ValueError("not a US state or DC code")
    return value


HomeCity = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=HOME_CITY_MAX_LENGTH, pattern=NO_NUL
    ),
]
# [A-Z], not \w: Pydantic's regex also matches non-ASCII letters. Upper case only, no folding:
# the app sends what the card shows.
HomeState = Annotated[
    str,
    Field(pattern=r"^[A-Z]{2}$", description="A US state or DC code, upper case, e.g. FL."),
    AfterValidator(_us_state),
]
