"""Who and what the demo shows: made-up people, public street names, plain home-repair text.

Nothing here is a real person or a real customer's words. Emails are on example.com (reserved
for documentation), phones are never set, and every account shares the demo password the seed
writes to its password file (never to the repository).
"""

from dataclasses import dataclass
from typing import Final, Literal

Role = Literal["customer", "pro"]
Tone = tuple[int, int, int]


@dataclass(frozen=True)
class Person:
    first: str
    last: str
    role: Role
    email: str
    tone: Tone = (43, 108, 176)

    @property
    def initials(self) -> str:
        return f"{self.first[0]}{self.last[0]}"


@dataclass(frozen=True)
class Place:
    line1: str
    city: str
    zip_code: str
    state: str = "FL"

    def body(self) -> dict[str, str]:
        return {
            "line1": self.line1,
            "city": self.city,
            "state": self.state,
            "zip_code": self.zip_code,
        }


@dataclass(frozen=True)
class Work:
    """One kind of job in a category: what the customer writes and what the pro quotes."""

    description: str
    answers: dict[str, object]
    scope: str
    approach: str
    amount_cents: tuple[int, int]
    duration_minutes: int


@dataclass(frozen=True)
class ProSetup:
    person: Person
    bio: str
    years: int
    categories: tuple[str, ...]
    # Months before the seed runs that the pro joined.
    joined_months_ago: int


def _customer(first: str, last: str, tone: Tone = (43, 108, 176)) -> Person:
    return Person(first, last, "customer", f"{first.lower()}.{last.lower()}@example.com", tone)


# ---- The people the video follows. Short emails: they are typed on the emulator. ----
ADMIN_EMAIL: Final = "admin@example.com"
AGENT_EMAIL: Final = "agent@example.com"
ADMIN_NAME: Final = ("Avery", "Stone")
AGENT_NAME: Final = ("Riley", "Brooks")

JAMIE: Final = Person("Jamie", "Carter", "customer", "jamie@example.com", (32, 96, 160))
DAN: Final = Person("Dan", "Rivera", "pro", "dan@example.com", (22, 101, 52))
MARIA: Final = Person("Maria", "Santos", "pro", "maria@example.com", (147, 51, 234))

JAMIE_HOME: Final = Place("1200 Seabreeze Blvd", "Fort Lauderdale", "33316")

# The category the video's own request should use: only Maria offers it, so the request waits
# in the queue until she is approved on camera, then reaches her.
MARIA_CATEGORIES: Final = ("moving-assembly",)

PROS: Final = (
    ProSetup(
        DAN,
        "Handyman and painter for twelve years across Broward. Doors, cabinets, drywall "
        "patches, fixtures and interior paint. On time, floors protected, room left clean.",
        12,
        ("handyman", "painting"),
        20,
    ),
    ProSetup(
        Person("Sam", "Lee", "pro", "sam.lee@example.com", (180, 83, 9)),
        "Small repairs and interior painting. Careful prep, clean lines, fair prices.",
        4,
        ("handyman", "painting"),
        9,
    ),
    ProSetup(
        Person("Priya", "Nair", "pro", "priya.nair@example.com", (190, 24, 93)),
        "Home cleaning for eight years: move-outs, deep cleans and weekly visits. My own "
        "supplies, pet-safe products on request.",
        8,
        ("house-cleaning",),
        14,
    ),
    ProSetup(
        Person("Marcus", "Hill", "pro", "marcus.hill@example.com", (21, 94, 117)),
        "Lawn care and landscaping: mowing, hedges, cleanups and fresh mulch. Reliable "
        "weekly routes in Fort Lauderdale and Hollywood.",
        10,
        ("lawn-landscaping",),
        16,
    ),
)
MARIA_SETUP: Final = ProSetup(
    MARIA,
    "Furniture assembly and TV mounting. Six years putting homes together: beds, desks, "
    "shelves and wall mounts, with my own tools.",
    6,
    MARIA_CATEGORIES,
    0,
)

# The history's customers: enough for repeat customers without one person owning the charts.
CUSTOMERS: Final = (
    _customer("Casey", "Hart"),
    _customer("Morgan", "Reed"),
    _customer("Taylor", "Quinn"),
    _customer("Jordan", "Blake"),
    _customer("Alex", "Morgan"),
    _customer("Sasha", "Kim"),
    _customer("Devon", "Price"),
    _customer("Robin", "Ellis"),
    _customer("Quinn", "Foster"),
    _customer("Harper", "Lane"),
    _customer("Rowan", "Diaz"),
    _customer("Emery", "Cole"),
    _customer("Skyler", "Wong"),
    _customer("Reese", "Patel"),
    _customer("Avery", "Nolan"),
    _customer("Blake", "Turner"),
    _customer("Cameron", "Shaw"),
    _customer("Dakota", "Mills"),
    _customer("Elliot", "Vance"),
    _customer("Finley", "Ross"),
    _customer("Gray", "Sutton"),
    _customer("Hayden", "Brooks"),
    _customer("Indigo", "Marsh"),
    _customer("Jules", "Baker"),
    _customer("Kai", "Lambert"),
    _customer("Logan", "Pierce"),
    _customer("Micah", "Stone"),
    _customer("Noel", "Carver"),
    _customer("Oakley", "Grant"),
    _customer("Parker", "Hale"),
    _customer("Remy", "Dalton"),
    _customer("Sage", "Whitaker"),
    _customer("Tatum", "Rhodes"),
    _customer("Wren", "Holloway"),
)

# Public streets in the served cities (Broward); the house numbers are arbitrary.
PLACES: Final = (
    Place("915 E Las Olas Blvd", "Fort Lauderdale", "33301"),
    Place("2400 E Sunrise Blvd", "Fort Lauderdale", "33304"),
    Place("1700 SE 17th St", "Fort Lauderdale", "33316"),
    Place("1900 Harrison St", "Hollywood", "33020"),
    Place("3500 N Hills Dr", "Hollywood", "33021"),
    Place("50 NE 1st St", "Pompano Beach", "33060"),
    Place("1200 N Ocean Blvd", "Pompano Beach", "33062"),
)

# The cities every seeded pro serves (every active ZIP of them, up to the API's cap).
SERVED_CITIES: Final = ("Fort Lauderdale", "Hollywood", "Pompano Beach", "Dania")

WORK: Final[dict[str, tuple[Work, ...]]] = {
    "handyman": (
        Work(
            "The kitchen cabinet door next to the fridge hangs crooked and won't close. "
            "One hinge looks loose.",
            {"tasks": "Fix a cabinet door that won't close."},
            "Realign the door, replace the loose hinge and adjust both hinges.",
            "I bring two hinge sizes, so it's done in one visit.",
            (9500, 14500),
            60,
        ),
        Work(
            "Two interior doors stick at the top since the summer, and the bathroom door "
            "handle is loose.",
            {"tasks": "Plane two sticking doors. Tighten a door handle."},
            "Plane and reseal the two doors, tighten the handle set and check the latches.",
            "Doors come off the hinges, so I need about a metre of floor space.",
            (12000, 19000),
            90,
        ),
        Work(
            "A towel bar pulled out of the drywall and left two holes. I'd like it patched "
            "and the bar mounted again.",
            {"tasks": "Patch two small drywall holes. Remount a towel bar."},
            "Patch and sand both holes, prime, and remount the bar on proper anchors.",
            "The patch needs an hour to set before the bar goes back.",
            (11000, 16500),
            120,
        ),
    ),
    "painting": (
        Work(
            "The guest bedroom needs repainting, walls only. About 12 by 12 feet, light "
            "gray over beige.",
            {"jobs": ["interior"]},
            "Two coats on the four walls, prep and light patching included. Paint included.",
            "Furniture moved to the middle and covered; done in one day.",
            (38000, 52000),
            360,
        ),
        Work(
            "Baseboards and two door frames in the hallway are scuffed and need a fresh "
            "coat of white.",
            {"jobs": ["doors_trim"]},
            "Sand, caulk and paint the hallway baseboards and both frames, semi-gloss white.",
            "Low-odor paint; dry to the touch in two hours.",
            (18000, 26000),
            180,
        ),
    ),
    "house-cleaning": (
        Work(
            "Deep clean before family visits: kitchen, both bathrooms and floors throughout.",
            {"bedrooms": 3, "bathrooms": 2, "square_feet": 1600, "frequency": "one_time"},
            "Deep clean of the kitchen, two bathrooms and all floors; inside of the oven.",
            "Two of us, about four hours. We bring every supply.",
            (16000, 24000),
            240,
        ),
        Work(
            "Looking for a cleaning every two weeks for a two-bedroom condo.",
            {"bedrooms": 2, "bathrooms": 1, "square_feet": 950, "frequency": "recurring"},
            "Standard clean of the condo: dusting, kitchen, bathroom, floors.",
            "Same person every visit.",
            (9000, 13000),
            150,
        ),
    ),
    "lawn-landscaping": (
        Work(
            "Front and back yard need mowing and the hedges along the fence are overgrown.",
            {"jobs": ["mowing", "hedges"]},
            "Mow, edge and blow both yards; trim the hedge line and haul the clippings.",
            "I bring everything; gate access to the back yard is all I need.",
            (8500, 14000),
            120,
        ),
        Work(
            "Yard cleanup after the storm: fallen branches and leaves, and new mulch for "
            "the two front beds.",
            {"jobs": ["cleanup", "beds_mulch"]},
            "Clear and haul the debris, weed the two beds and lay fresh mulch.",
            "Mulch included, dark brown unless you prefer another.",
            (16000, 23000),
            180,
        ),
    ),
    "moving-assembly": (
        Work(
            "A 55 inch TV to mount on the living room wall, and a bookcase to assemble.",
            {"jobs": ["tv_mounting", "furniture_assembly"]},
            "Mount the TV on your bracket, tidy the cables, and assemble the bookcase.",
            "I bring a stud finder and anchors.",
            (12000, 18000),
            120,
        ),
        Work(
            "New bed frame and two nightstands arrived flat-packed and need assembly.",
            {"jobs": ["furniture_assembly"]},
            "Assemble the bed frame and both nightstands; packaging taken to the bins.",
            "About two hours with my own tools.",
            (9000, 14000),
            120,
        ),
    ),
}

# What a customer writes when no category fits: the request goes to the BDC to classify, and
# is never quoted as it stands.
UNSORTED: Final = (
    Work(
        "The sliding glass door to the patio is off its track and very hard to move.",
        {},
        "",
        "",
        (0, 0),
        0,
    ),
    Work(
        "There's a water stain on the ceiling under the upstairs bathroom. Not sure who to "
        "call for this.",
        {},
        "",
        "",
        (0, 0),
        0,
    ),
)

CUSTOMER_REVIEWS: Final = (
    (5, "On time, tidy and the work looks great."),
    (5, "Explained everything before starting. Would book again."),
    (4, "Good work. Arrived a little later than planned but kept me posted."),
    (5, "Quick and careful. Left the place cleaner than before."),
    (4, "Solid job overall."),
    (5, "Fair price and done in one visit."),
    (3, "The work is fine, but it took longer than quoted."),
)
PRO_REVIEWS: Final = (
    (5, "Clear about the job and easy to reach."),
    (5, "Everything was ready when I arrived."),
    (4, "Good customer. Parking was a bit tricky."),
    (5, "Friendly, and the description matched the job."),
)
DISPUTE_TEXT: Final = (
    (
        "work_incomplete",
        "One of the two doors still sticks at the top.",
        "I planed both doors. The second one swelled again with the humidity; I can come "
        "back and take a little more off.",
    ),
    (
        "poor_quality",
        "The paint on one wall shows roller marks in daylight.",
        "Two coats went on as quoted. I offered a touch-up on that wall the next morning.",
    ),
)
TICKETS: Final = (
    ("payment", "I was charged, but I can't find the receipt for my last job in the app."),
    ("app_problem", "Photos take a long time to upload when I'm on mobile data."),
    ("account", "How do I change the email on my account?"),
)
