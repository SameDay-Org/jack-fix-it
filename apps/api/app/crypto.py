"""Encryption of the originals the chat keeps for staff (#72): AES-256-GCM, rotation-ready.

The keyring is the setting CHAT_ORIGINAL_KEYS, a JSON object mapping a key id to a base64
32-byte key ({"2026-11": "<base64>"}), plus CHAT_ORIGINAL_ACTIVE_KEY_ID, the id new originals
are sealed with. Every sealed value records its key id, so an older key opens what it sealed
until its originals are purged: rotating adds a key and moves the active id; an old key is
removed only once nothing it sealed is left.

A sealed value is a random 96-bit nonce followed by the ciphertext and its 128-bit tag. The
caller's associated data (the message id) is authenticated, not stored: a ciphertext copied to
another row does not open there. Neither the keys nor a plaintext are ever logged or put into
an exception: parse errors name the key id at most, decryption failures carry no detail.
"""

import base64
import binascii
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_BYTES: Final = 32  # AES-256
NONCE_BYTES: Final = 12  # 96 bits, the GCM standard
TAG_BYTES: Final = 16
# A key id is stored next to each ciphertext: short, and safe to log.
KEY_ID_MAX_LENGTH: Final = 32
_KEY_ID: Final = re.compile(rf"[A-Za-z0-9_.-]{{1,{KEY_ID_MAX_LENGTH}}}")


class KeyringError(ValueError):
    """CHAT_ORIGINAL_KEYS or CHAT_ORIGINAL_ACTIVE_KEY_ID is malformed. The message never holds
    a key."""


class DecryptionError(Exception):
    """A sealed value did not open: unknown key id, wrong key, tampered bytes or associated
    data. Deliberately without detail."""


@dataclass(frozen=True)
class Sealed:
    key_id: str
    ciphertext: bytes  # nonce + ciphertext + tag


def parse_keyring(raw: str) -> dict[str, bytes]:
    """The keys of a CHAT_ORIGINAL_KEYS value: KeyringError unless it is a non-empty JSON
    object of key ids to base64 32-byte keys."""
    try:
        loaded = json.loads(raw)
    except ValueError:
        raise KeyringError("CHAT_ORIGINAL_KEYS must be a JSON object") from None
    if not isinstance(loaded, dict) or not loaded:
        raise KeyringError("CHAT_ORIGINAL_KEYS must be a non-empty JSON object")
    keys: dict[str, bytes] = {}
    for key_id, encoded in loaded.items():
        if not _KEY_ID.fullmatch(key_id):
            raise KeyringError(
                f"CHAT_ORIGINAL_KEYS key ids are 1 to {KEY_ID_MAX_LENGTH} of A-Z a-z 0-9 _ . -"
            )
        if not isinstance(encoded, str):
            raise KeyringError(f"CHAT_ORIGINAL_KEYS[{key_id}] must be a base64 string")
        try:
            key = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise KeyringError(f"CHAT_ORIGINAL_KEYS[{key_id}] is not valid base64") from None
        if len(key) != KEY_BYTES:
            raise KeyringError(f"CHAT_ORIGINAL_KEYS[{key_id}] must decode to {KEY_BYTES} bytes")
        keys[key_id] = key
    return keys


class OriginalCipher:
    """Seals with the active key; opens with whichever key a value names."""

    def __init__(self, keys: Mapping[str, bytes], active_key_id: str) -> None:
        if active_key_id not in keys:
            raise KeyringError("CHAT_ORIGINAL_ACTIVE_KEY_ID must name a key of CHAT_ORIGINAL_KEYS")
        self._ciphers = {key_id: AESGCM(key) for key_id, key in keys.items()}
        self._active_key_id = active_key_id

    @property
    def active_key_id(self) -> str:
        return self._active_key_id

    def encrypt(self, plaintext: str, associated_data: bytes) -> Sealed:
        """A fresh random nonce per call: never reused under one key in practice (2^-32
        collision risk only after 2^32 messages per key; rotate well before that)."""
        nonce = os.urandom(NONCE_BYTES)
        sealed = self._ciphers[self._active_key_id].encrypt(
            nonce, plaintext.encode("utf-8"), associated_data
        )
        return Sealed(key_id=self._active_key_id, ciphertext=nonce + sealed)

    def decrypt(self, sealed: Sealed, associated_data: bytes) -> str:
        """The plaintext; DecryptionError when the key id is unknown or anything was altered."""
        cipher = self._ciphers.get(sealed.key_id)
        if cipher is None or len(sealed.ciphertext) < NONCE_BYTES + TAG_BYTES:
            raise DecryptionError
        nonce, body = sealed.ciphertext[:NONCE_BYTES], sealed.ciphertext[NONCE_BYTES:]
        try:
            return cipher.decrypt(nonce, body, associated_data).decode("utf-8")
        except (InvalidTag, UnicodeDecodeError):
            raise DecryptionError from None
