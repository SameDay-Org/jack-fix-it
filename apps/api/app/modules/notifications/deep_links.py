"""The app screens a push may open (D10.3, #54): the only place they are defined.

A push carries an app path in `data.url`, never an arbitrary URL, so a notification can only
lead to one of these screens.
"""

import re
from typing import Final

_UUID: Final = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ALLOWED_DEEP_LINKS: Final = (
    re.compile(rf"/requests/{_UUID}"),
    re.compile(rf"/requests/{_UUID}/job"),  # the customer's ongoing job (#64), job pushes (#65)
    re.compile(rf"/jobs/{_UUID}"),
    re.compile(rf"/quotes/{_UUID}"),
    re.compile(rf"/opportunities/{_UUID}"),  # a pro's dispatch (#49), from the new request push
    re.compile(r"/"),  # home: a pro's jobs and opportunities, from the quote accepted push (#338)
)


def is_allowed(path: str) -> bool:
    return any(pattern.fullmatch(path) for pattern in ALLOWED_DEEP_LINKS)
