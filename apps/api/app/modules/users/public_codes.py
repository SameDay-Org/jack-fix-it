"""The short public code on the back of a user's ID card (#250).

Eight characters of Crockford base32 (0-9 and A-Z without I, L, O and U, so none is misread),
drawn at random with the CSPRNG when the account is created, unique, never reused and never
derived from the UUID or from a sequence: the code says nothing about the account. The app
shows it grouped `K7Q2-9MXA`; the API carries the eight characters only. It is not a secret,
but it is never logged either.
"""

import secrets
from typing import Final

ALPHABET: Final = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
LENGTH: Final = 8
# One pattern for the request type and the database CHECK (ck_users_public_code_crockford):
# the alphabet as a character class.
PATTERN: Final = r"^[0-9A-HJKMNP-TV-Z]{8}$"
# Creating a user tries this many codes before giving up (a 500): with 32**8 codes a second
# collision in a row is practically impossible.
MAX_TRIES: Final = 5


def generate_public_code() -> str:
    """A fresh random code; the caller handles the (rare) collision with a stored one."""
    return "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))
