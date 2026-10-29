"""Masking contact details in free text (#172, quote scopes #188, chat #72 later): one redactor.

Before payment, a pro sees the customer's request but never how to reach them (context doc:
contacts stay hidden to prevent disintermediation; ZIP + city only until paid). Customers
still type contacts into free text, so text shown to pros goes through `redact_contacts`
first. It masks, with the language-neutral MASK:
- emails: plain, spaced, spelled out in EN or ES ("name at gmail dot com", "luis arroba gmail
  punto com"), bracketed ("(at)", "[dot]"), letter by letter ("j a n e @ g m a i l"), and a
  known mail provider with no TLD ("jdoe@gmail", "jdoe at gmail", "jdoe en hotmail");
- phone numbers: 10 digits, or 11 with a leading 1, grouped as people write them (dots,
  dashes, slashes, spaces, parentheses, +1, an area code then any grouping, digits split by
  spaces), ten or more digits spelled out in EN or ES words, a number after "+", "00" or "011"
  (10 to 15 digits), and Venezuelan (04xx) and Cuban (53 5) mobile forms;
- URLs and domains: http(s)://, www., a known TLD, any TLD followed by a path ("linktr.ee/x"),
  a spaced ". com" and a spelled "dot com";
- social and payment handles: "@handle", "$cashtag", and a platform word (instagram, ig,
  snap, whatsapp, venmo, gmail, ...) followed by an id;
- addresses: US street addresses (a house number, a street name, a suffix such as St or Avenue,
  in either order, with directions and units), the Miami grid ("8800 SW 72nd"), US-1 style
  highways, PO boxes, apartment and suite numbers, and the Spanish forms (Calle, Avenida, Av.,
  Vía, "el 1500 de la Collins Ave", apto, depto, apartado postal).
Before matching, look-alike characters are folded (fullwidth and math letters, circled and
superscript digits, keycaps, Cyrillic look-alikes inside Latin words) and invisible ones
dropped. Measurements, quantities, prices, years, ZIP codes, times, dates, IP addresses and
trade shorthand ("6 inch rd duct", "20 amp cir", "1800 sq ft", "unit 2 is not cooling") are left
alone.

Known gaps, on purpose (each cheap evasion would cost more false positives than it stops):
letters for digits ("305 555 O199"), commas between phone groups, digits that mix words and
numerals, a phone grouping no one uses ("30 55 55 01 99"), a bare handle with no "@", cue or
digit ("insta jdoe"), a plain word after a weak platform ("my venmo is jdoe"), a display name
("find me on facebook as John Doe"), a street with no suffix ("1234 Flagler"), a reversed street
with lowercase or function-word names, a non-ASCII letter inside a TLD or a mail provider's
name ("gmail.cöm": those lists are literal; a mark glued inside one is handled, see
_UNMARKED_FIRST), and text inside images (#173 handles media). A 10-digit order or serial
number is masked like a phone: hiding a number is the safe side.

The patterns are data in this module; it does no I/O and keeps no state. Every pattern is
anchored so a 2,000-character input (the description limit) is handled in milliseconds.
"""

import bisect
import re
import unicodedata
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import Final, Protocol

MASK: Final = "•••"

_FLAGS: Final = re.IGNORECASE
_APOSTROPHES: Final = "'" + chr(0x2019)

# --- Cleaning --------------------------------------------------------------------------------
# Characters dropped before matching: format characters (zero-width spaces, joiners, soft
# hyphen, bidi controls; Unicode category Cf), enclosing marks such as the keycap (Me), and a
# few fillers: the combining grapheme joiner, the Hangul fillers, the blank braille cell, the
# variation selectors (also the Mongolian and the supplementary ones). Shared with the saved
# address label (addresses.schemas), which drops them before its own checks.
INVISIBLE_FILLERS: Final = frozenset(
    chr(code)
    for code in (
        0x034F,
        0x115F,
        0x1160,
        0x2800,
        0x3164,
        0xFFA0,
        *range(0x180B, 0x180E),
        *range(0xFE00, 0xFE10),
        *range(0xE0100, 0xE01F0),
    )
)
# Characters folded to their ASCII form (NFKC) when that form is one ASCII letter, digit or one
# of "@$#.-/()": fullwidth and small forms (U+FF20, U+FF04, U+FE69), mathematical letters
# and digits, circled digits. Superscript and subscript digits only in a run of three or more
# ("call ³⁰⁵..."), so "ft²" stays. The low lines and the dot leaders are not folded here: an
# ASCII "_" or "..." glued to a domain hides it ("see_gmail.com" and "jack...fixit.com" are
# known gaps) while the typed form keeps the boundary; the handle pattern accepts them as
# typed instead (_SEPARATOR_FORMS).
_FOLDABLE: Final = re.compile(r"[a-zA-Z0-9@$#.\-/()]")
# Spanish ordinal indicators stay as typed ("1º piso", "Nº").
_KEEP_AS_IS: Final = frozenset((chr(0x00AA), chr(0x00BA)))
_SCRIPT_DIGITS: Final = frozenset(
    chr(code) for code in (0x00B2, 0x00B3, 0x00B9, *range(0x2070, 0x207A), *range(0x2080, 0x208A))
)
# Cyrillic and Greek letters that look Latin, folded only inside a word that also holds an ASCII
# letter ("gmail" typed with a Cyrillic a), so real Russian or Greek text is unchanged.
_CONFUSABLES: Final = {
    chr(cyrillic): latin
    for cyrillic, latin in (
        (0x0430, "a"), (0x0435, "e"), (0x043E, "o"), (0x0440, "p"), (0x0441, "c"),
        (0x0445, "x"), (0x0443, "y"), (0x0456, "i"), (0x0458, "j"), (0x0455, "s"),
        (0x04BB, "h"), (0x043A, "k"), (0x043C, "m"), (0x0442, "t"), (0x0432, "b"),
        (0x043D, "h"), (0x0410, "A"), (0x0412, "B"), (0x0415, "E"), (0x041A, "K"),
        (0x041C, "M"), (0x041D, "H"), (0x041E, "O"), (0x0420, "P"), (0x0421, "C"),
        (0x0422, "T"), (0x0425, "X"), (0x0405, "S"), (0x03B1, "a"), (0x03BF, "o"),
        (0x03BD, "v"), (0x03C1, "p"), (0x03C4, "t"), (0x0391, "A"), (0x0392, "B"),
        (0x0395, "E"), (0x0397, "H"), (0x0399, "I"), (0x039A, "K"), (0x039C, "M"),
        (0x039D, "N"), (0x039F, "O"), (0x03A1, "P"), (0x03A4, "T"), (0x03A7, "X"),
    )
}  # fmt: skip
_MIXED_WORD: Final = re.compile(r"\w+")
# Between two digits, 1 to 3 emoji, symbols or the marks "_ * | ~ · •" read as a "-"
# ("305🔥555🔥0199", "305_555_0199", "305*555*0199"). ASCII punctuation people use in numbers
# ("@" in "2x4@8ft", ",", ":", "%", "/", "'") is left as typed.
_ODD_MARKS: Final = "_*|~" + chr(0x00B7) + chr(0x2022)
_ODD_SEPARATOR: Final = re.compile(
    rf"(?<=\d)(?:[{re.escape(_ODD_MARKS)}]|[^\x00-\x7f\w\s]){{1,3}}(?=\d)"
)
# Dashes of every width, the minus sign and its superscript and subscript forms read as "-".
_DASH_CODES: Final = (*range(0x2010, 0x2016), 0x207B, 0x208B, 0x2212, 0xFE58, 0xFE63, 0xFF0D)
_DASHES: Final = re.compile("[" + "".join(map(chr, _DASH_CODES)) + "]")

# --- Combining marks -------------------------------------------------------------------------
# Every nonspacing (Mn) and spacing (Mc) combining mark, of any script, so a Cyrillic, Hebrew
# or Arabic mark continues a token as a Latin one does ("@home" + U+0483 + "fixit", #229); the
# enclosing marks (Me) are dropped by _clean. _MARK_RANGES is generated from the unicodedata of
# Python 3.12 (Unicode 15.0): a scan of every code point at import costs a few hundred ms, so
# the tuple is committed and test_mark_set_matches_unicodedata rebuilds it, failing on any
# difference after a Python upgrade. The handle, email and URL patterns take the marks glued to
# their own characters (_MARKED after a counted character, or _MARKS inside a class), so
# "@bob" + U+05B0 + "smith" and "jo" + U+0483 + "se@gmail.com" are masked whole (#236).
_MARK_RANGES: Final = (
    (0x0300, 0x036F), (0x0483, 0x0487), (0x0591, 0x05BD), (0x05BF, 0x05BF), (0x05C1, 0x05C2),
    (0x05C4, 0x05C5), (0x05C7, 0x05C7), (0x0610, 0x061A), (0x064B, 0x065F), (0x0670, 0x0670),
    (0x06D6, 0x06DC), (0x06DF, 0x06E4), (0x06E7, 0x06E8), (0x06EA, 0x06ED), (0x0711, 0x0711),
    (0x0730, 0x074A), (0x07A6, 0x07B0), (0x07EB, 0x07F3), (0x07FD, 0x07FD), (0x0816, 0x0819),
    (0x081B, 0x0823), (0x0825, 0x0827), (0x0829, 0x082D), (0x0859, 0x085B), (0x0898, 0x089F),
    (0x08CA, 0x08E1), (0x08E3, 0x0903), (0x093A, 0x093C), (0x093E, 0x094F), (0x0951, 0x0957),
    (0x0962, 0x0963), (0x0981, 0x0983), (0x09BC, 0x09BC), (0x09BE, 0x09C4), (0x09C7, 0x09C8),
    (0x09CB, 0x09CD), (0x09D7, 0x09D7), (0x09E2, 0x09E3), (0x09FE, 0x09FE), (0x0A01, 0x0A03),
    (0x0A3C, 0x0A3C), (0x0A3E, 0x0A42), (0x0A47, 0x0A48), (0x0A4B, 0x0A4D), (0x0A51, 0x0A51),
    (0x0A70, 0x0A71), (0x0A75, 0x0A75), (0x0A81, 0x0A83), (0x0ABC, 0x0ABC), (0x0ABE, 0x0AC5),
    (0x0AC7, 0x0AC9), (0x0ACB, 0x0ACD), (0x0AE2, 0x0AE3), (0x0AFA, 0x0AFF), (0x0B01, 0x0B03),
    (0x0B3C, 0x0B3C), (0x0B3E, 0x0B44), (0x0B47, 0x0B48), (0x0B4B, 0x0B4D), (0x0B55, 0x0B57),
    (0x0B62, 0x0B63), (0x0B82, 0x0B82), (0x0BBE, 0x0BC2), (0x0BC6, 0x0BC8), (0x0BCA, 0x0BCD),
    (0x0BD7, 0x0BD7), (0x0C00, 0x0C04), (0x0C3C, 0x0C3C), (0x0C3E, 0x0C44), (0x0C46, 0x0C48),
    (0x0C4A, 0x0C4D), (0x0C55, 0x0C56), (0x0C62, 0x0C63), (0x0C81, 0x0C83), (0x0CBC, 0x0CBC),
    (0x0CBE, 0x0CC4), (0x0CC6, 0x0CC8), (0x0CCA, 0x0CCD), (0x0CD5, 0x0CD6), (0x0CE2, 0x0CE3),
    (0x0CF3, 0x0CF3), (0x0D00, 0x0D03), (0x0D3B, 0x0D3C), (0x0D3E, 0x0D44), (0x0D46, 0x0D48),
    (0x0D4A, 0x0D4D), (0x0D57, 0x0D57), (0x0D62, 0x0D63), (0x0D81, 0x0D83), (0x0DCA, 0x0DCA),
    (0x0DCF, 0x0DD4), (0x0DD6, 0x0DD6), (0x0DD8, 0x0DDF), (0x0DF2, 0x0DF3), (0x0E31, 0x0E31),
    (0x0E34, 0x0E3A), (0x0E47, 0x0E4E), (0x0EB1, 0x0EB1), (0x0EB4, 0x0EBC), (0x0EC8, 0x0ECE),
    (0x0F18, 0x0F19), (0x0F35, 0x0F35), (0x0F37, 0x0F37), (0x0F39, 0x0F39), (0x0F3E, 0x0F3F),
    (0x0F71, 0x0F84), (0x0F86, 0x0F87), (0x0F8D, 0x0F97), (0x0F99, 0x0FBC), (0x0FC6, 0x0FC6),
    (0x102B, 0x103E), (0x1056, 0x1059), (0x105E, 0x1060), (0x1062, 0x1064), (0x1067, 0x106D),
    (0x1071, 0x1074), (0x1082, 0x108D), (0x108F, 0x108F), (0x109A, 0x109D), (0x135D, 0x135F),
    (0x1712, 0x1715), (0x1732, 0x1734), (0x1752, 0x1753), (0x1772, 0x1773), (0x17B4, 0x17D3),
    (0x17DD, 0x17DD), (0x180B, 0x180D), (0x180F, 0x180F), (0x1885, 0x1886), (0x18A9, 0x18A9),
    (0x1920, 0x192B), (0x1930, 0x193B), (0x1A17, 0x1A1B), (0x1A55, 0x1A5E), (0x1A60, 0x1A7C),
    (0x1A7F, 0x1A7F), (0x1AB0, 0x1ABD), (0x1ABF, 0x1ACE), (0x1B00, 0x1B04), (0x1B34, 0x1B44),
    (0x1B6B, 0x1B73), (0x1B80, 0x1B82), (0x1BA1, 0x1BAD), (0x1BE6, 0x1BF3), (0x1C24, 0x1C37),
    (0x1CD0, 0x1CD2), (0x1CD4, 0x1CE8), (0x1CED, 0x1CED), (0x1CF4, 0x1CF4), (0x1CF7, 0x1CF9),
    (0x1DC0, 0x1DFF), (0x20D0, 0x20DC), (0x20E1, 0x20E1), (0x20E5, 0x20F0), (0x2CEF, 0x2CF1),
    (0x2D7F, 0x2D7F), (0x2DE0, 0x2DFF), (0x302A, 0x302F), (0x3099, 0x309A), (0xA66F, 0xA66F),
    (0xA674, 0xA67D), (0xA69E, 0xA69F), (0xA6F0, 0xA6F1), (0xA802, 0xA802), (0xA806, 0xA806),
    (0xA80B, 0xA80B), (0xA823, 0xA827), (0xA82C, 0xA82C), (0xA880, 0xA881), (0xA8B4, 0xA8C5),
    (0xA8E0, 0xA8F1), (0xA8FF, 0xA8FF), (0xA926, 0xA92D), (0xA947, 0xA953), (0xA980, 0xA983),
    (0xA9B3, 0xA9C0), (0xA9E5, 0xA9E5), (0xAA29, 0xAA36), (0xAA43, 0xAA43), (0xAA4C, 0xAA4D),
    (0xAA7B, 0xAA7D), (0xAAB0, 0xAAB0), (0xAAB2, 0xAAB4), (0xAAB7, 0xAAB8), (0xAABE, 0xAABF),
    (0xAAC1, 0xAAC1), (0xAAEB, 0xAAEF), (0xAAF5, 0xAAF6), (0xABE3, 0xABEA), (0xABEC, 0xABED),
    (0xFB1E, 0xFB1E), (0xFE00, 0xFE0F), (0xFE20, 0xFE2F), (0x101FD, 0x101FD), (0x102E0, 0x102E0),
    (0x10376, 0x1037A), (0x10A01, 0x10A03), (0x10A05, 0x10A06), (0x10A0C, 0x10A0F),
    (0x10A38, 0x10A3A), (0x10A3F, 0x10A3F), (0x10AE5, 0x10AE6), (0x10D24, 0x10D27),
    (0x10EAB, 0x10EAC), (0x10EFD, 0x10EFF), (0x10F46, 0x10F50), (0x10F82, 0x10F85),
    (0x11000, 0x11002), (0x11038, 0x11046), (0x11070, 0x11070), (0x11073, 0x11074),
    (0x1107F, 0x11082), (0x110B0, 0x110BA), (0x110C2, 0x110C2), (0x11100, 0x11102),
    (0x11127, 0x11134), (0x11145, 0x11146), (0x11173, 0x11173), (0x11180, 0x11182),
    (0x111B3, 0x111C0), (0x111C9, 0x111CC), (0x111CE, 0x111CF), (0x1122C, 0x11237),
    (0x1123E, 0x1123E), (0x11241, 0x11241), (0x112DF, 0x112EA), (0x11300, 0x11303),
    (0x1133B, 0x1133C), (0x1133E, 0x11344), (0x11347, 0x11348), (0x1134B, 0x1134D),
    (0x11357, 0x11357), (0x11362, 0x11363), (0x11366, 0x1136C), (0x11370, 0x11374),
    (0x11435, 0x11446), (0x1145E, 0x1145E), (0x114B0, 0x114C3), (0x115AF, 0x115B5),
    (0x115B8, 0x115C0), (0x115DC, 0x115DD), (0x11630, 0x11640), (0x116AB, 0x116B7),
    (0x1171D, 0x1172B), (0x1182C, 0x1183A), (0x11930, 0x11935), (0x11937, 0x11938),
    (0x1193B, 0x1193E), (0x11940, 0x11940), (0x11942, 0x11943), (0x119D1, 0x119D7),
    (0x119DA, 0x119E0), (0x119E4, 0x119E4), (0x11A01, 0x11A0A), (0x11A33, 0x11A39),
    (0x11A3B, 0x11A3E), (0x11A47, 0x11A47), (0x11A51, 0x11A5B), (0x11A8A, 0x11A99),
    (0x11C2F, 0x11C36), (0x11C38, 0x11C3F), (0x11C92, 0x11CA7), (0x11CA9, 0x11CB6),
    (0x11D31, 0x11D36), (0x11D3A, 0x11D3A), (0x11D3C, 0x11D3D), (0x11D3F, 0x11D45),
    (0x11D47, 0x11D47), (0x11D8A, 0x11D8E), (0x11D90, 0x11D91), (0x11D93, 0x11D97),
    (0x11EF3, 0x11EF6), (0x11F00, 0x11F01), (0x11F03, 0x11F03), (0x11F34, 0x11F3A),
    (0x11F3E, 0x11F42), (0x13440, 0x13440), (0x13447, 0x13455), (0x16AF0, 0x16AF4),
    (0x16B30, 0x16B36), (0x16F4F, 0x16F4F), (0x16F51, 0x16F87), (0x16F8F, 0x16F92),
    (0x16FE4, 0x16FE4), (0x16FF0, 0x16FF1), (0x1BC9D, 0x1BC9E), (0x1CF00, 0x1CF2D),
    (0x1CF30, 0x1CF46), (0x1D165, 0x1D169), (0x1D16D, 0x1D172), (0x1D17B, 0x1D182),
    (0x1D185, 0x1D18B), (0x1D1AA, 0x1D1AD), (0x1D242, 0x1D244), (0x1DA00, 0x1DA36),
    (0x1DA3B, 0x1DA6C), (0x1DA75, 0x1DA75), (0x1DA84, 0x1DA84), (0x1DA9B, 0x1DA9F),
    (0x1DAA1, 0x1DAAF), (0x1E000, 0x1E006), (0x1E008, 0x1E018), (0x1E01B, 0x1E021),
    (0x1E023, 0x1E024), (0x1E026, 0x1E02A), (0x1E08F, 0x1E08F), (0x1E130, 0x1E136),
    (0x1E2AE, 0x1E2AE), (0x1E2EC, 0x1E2EF), (0x1E4EC, 0x1E4EF), (0x1E8D0, 0x1E8D6),
    (0x1E944, 0x1E94A), (0xE0100, 0xE01EF),
)  # fmt: skip
_MARKS: Final = "".join(f"{chr(low)}-{chr(high)}" for low, high in _MARK_RANGES)
_MARKED: Final = rf"[{_MARKS}]*+"  # the marks glued to one character, taken as a run
_MARK_CHARS: Final = frozenset(
    chr(code) for low, high in _MARK_RANGES for code in range(low, high + 1)
)

# --- Emails ----------------------------------------------------------------------------------
# Top-level domains a bare "name.tld" must end with, unless a path follows: generic ones,
# country codes customers here use, and the gTLDs local businesses pick. Words such as "so",
# "do" or "to" are left out, since "it.So" is a missing space, not a domain.
_TLDS: Final = (
    "com|net|org|edu|gov|io|co|us|me|info|biz|app|dev|ly|gl|ee|be|cc|ws|page|link|site|"
    "online|store|shop|xyz|ai|tv|gg|mx|es|br|ar|cu|ve|pr|ca|uk|de|fr|miami|travel|studio|"
    "email|pro|club|services|solutions|tech|live|nyc|agency|llc|design|art|life|world|today|"
    "company|group|repair|contractors|construction|builders|homes|house|realty|properties|"
    "network|plumbing|expert|cleaning|pools|roofing"
)
_TLD_END: Final = rf"(?:{_TLDS})(?![a-z0-9])"
# TLDs that are also words, so "cooling.Me and my wife" is a missing space, not a domain.
_WORD_TLDS: Final = frozenset(
    {"me", "us", "be", "es", "co", "pro", "art", "life", "live", "today", "world", "club",
     "shop", "store", "site", "page", "link", "info", "design", "house", "homes", "group"}
)  # fmt: skip
# Mail providers whose name alone, with no TLD, is an address ("jdoe@gmail").
_PROVIDERS: Final = (
    r"(?:gmail|g\s?mail|hotmail|yahoo|outlook|icloud|aol|msn|proton(?:mail)?|comcast|"
    r"bellsouth|earthlink|verizon|att\.net)"
)
# Never start inside a word, a dotted chain or a marked token: a start after a mark would scan
# the token again from every mark ("a" + U+0483 repeated), so the lookbehind refuses it and the
# leftmost start takes the whole token, marks included. A token may begin with a spacing mark
# (_clean keeps an Mc anywhere: U+093F + "jose@gmail.com"), so every pattern takes _MARKED
# right after the lookbehind, where that mark is the one legal start.
_START: Final = rf"(?<![\w.%+@\-{_MARKS}])"
# Possessive, so a long dotted chain is never re-split; Unicode letters too ("josé.pérez"), and
# the marks glued to any of its characters ("jo" + U+0483 + "se", #236).
_LOCAL: Final = rf"[\w+][\w.%+\-{_MARKS}]*+"  # any valid start: "_jane", "__x", "+tag"
# A domain label character: any Unicode letter or digit ("gmäil", "ñandú"), a hyphen, or a mark
# glued to one of them. "_" stays out ("see_gmail.com" is a known gap, see _FOLDABLE). The TLD
# and the provider names stay literal (the mark class after every letter would make the
# patterns hundreds of kilobytes); a mark inside them ("gmail.c" + U+0483 + "om") is found by
# running these rules on the text without its marks first (_UNMARKED_FIRST, #240).
_LABEL: Final = rf"(?:[^\W_]|[\-{_MARKS}])"
_LABEL_CHAR: Final = re.compile(_LABEL)
_AT: Final = r"(?:\s*@\s*|\s*[(\[{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+(?:at|arroba|en)\s+)"
_STRONG_AT: Final = r"(?:\s*@\s*|\s*[(\[{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+arroba\s+)"
_WEAK_AT: Final = re.compile(r"\s+(?:at|en)\s+", _FLAGS)  # everyday words too
_SPANISH_EN: Final = re.compile(r"\s+en\s+", _FLAGS)
_SPELLED_DOT: Final = r"(?:\.|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+)"
_BRACKETED_DOT: Final = r"\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*"
_ONLY_SPELLED_DOT: Final = rf"(?:{_BRACKETED_DOT}|\s+(?:dot|punto)\s+)"
# An "@" that starts a token may stand before the local part too: "@jdoe@acme.com" is the
# handle written as the address, and "acme.com" after an "@" is no URL (_DOMAIN_START).
_AT_SIGN_START: Final = rf"(?<=@)(?<![\w.%+@\-{_MARKS}]@)"
PLAIN_EMAIL: Final = re.compile(
    rf"(?:{_START}|{_AT_SIGN_START}){_MARKED}{_LOCAL}@{_LABEL}++(?:[.,]{_LABEL}++)*?[.,][a-z]{{2,}}\b",
    _FLAGS,
)
SPACED_EMAIL: Final = re.compile(
    rf"{_START}{_MARKED}{_LOCAL}\s*@\s*{_LABEL}++(?:\s*\.\s*{_LABEL}++)*?\s*\.\s*{_TLD_END}",
    _FLAGS,
)
# "maria at gmail dot com", "juan dot perez at gmail dot com", "jane (at) outlook.com". With a
# bare " at " and a plain dot, the local part may not be a common word ("it at Amazon.com").
# The local part is a chain of pieces joined by spelled dots, of any length ("a dot b dot c dot
# d dot e dot f at gmail dot com" is masked whole, #240). A dot word or an at word may be a
# piece too ("jose dot dot at acme dot com", "bob punto at (at) gmail.com"). Tried from every
# word start, the chain would be scanned again from each of its pieces (quadratic on "a dot "
# repeated), so the rule runs through _RunSearch, which walks each run once (_LOCAL_HEAD, then
# _LOCAL_STEP) and tries only the starts that can end differently. The domain chain is lazy
# and runs only after the "at". A piece may begin with "-" or a mark ("jose dot -b at x.com").
_LOCAL_PIECE: Final = rf"[\w+\-{_MARKS}][\w.%+\-{_MARKS}]*+"
_LOCAL_CHAIN: Final = rf"{_LOCAL}(?:{_ONLY_SPELLED_DOT}{_LOCAL_PIECE})*+"
_LOCAL_HEAD: Final = re.compile(rf"{_START}{_MARKED}{_LOCAL}", _FLAGS)
_LOCAL_STEP: Final = re.compile(
    rf"(?:\s+(?P<word>dot|punto)\s+|{_BRACKETED_DOT})(?P<piece>{_LOCAL_PIECE})", _FLAGS
)
SPELLED_EMAIL: Final = re.compile(
    rf"{_START}{_MARKED}(?P<local>{_LOCAL_CHAIN})"
    rf"(?P<at>{_AT}){_LABEL}++(?:{_SPELLED_DOT}{_LABEL}++)*?(?P<dot>{_SPELLED_DOT})"
    rf"(?P<tld>{_TLD_END})",
    _FLAGS,
)
# A provider with no TLD, or with a TLD typed loosely ("gmail com", "gmailcom", "gmail,com").
PROVIDER_EMAIL: Final = re.compile(
    rf"{_START}{_MARKED}(?P<local>{_LOCAL})(?P<at>{_AT}){_PROVIDERS}"
    rf"(?:\s*[.,]?\s*(?:dot\s+|punto\s+)?(?:com|net|es|mx)\b)?",
    _FLAGS,
)
# "local@word" glued, whatever comes next: an address with its domain cut short. The word ends
# where a word character would continue it ("jose@acme_x" is the "_" gap), marks included.
GLUED_EMAIL: Final = re.compile(
    rf"{_START}{_MARKED}[^\W\d_]{_LOCAL}@[^\W\d_]{_LABEL}++(?!\w)", _FLAGS
)
# An email typed letter by letter: "j a n e @ g m a i l . c o m", in any script, each letter
# with its marks. Before the "@" the letters are taken once, possessively, and after each one
# the space is tried before the mark class (an atomic choice, never revisited when the "@" is
# missing): this part runs from every word start, and the mark class is a long one.
SPACED_LETTERS_EMAIL: Final = re.compile(
    rf"(?<!\S)(?:[^\W_](?>\s|[{_MARKS}]++\s)){{2,40}}+@\s(?:[^\W_]{_MARKED}\s?){{2,40}}"
    rf"(?:\.\s?(?:[^\W\d_]{_MARKED}\s?){{2,6}})?",
    _FLAGS,
)
# Words that are never the local part of a spelled-out email ("photos are at iCloud").
_COMMON_WORDS: Final = frozenset(
    {"it", "is", "are", "was", "were", "be", "been", "me", "us", "you", "him", "her", "them",
     "one", "this", "that", "these", "those", "here", "there", "work", "works", "worked", "look",
     "send", "sent", "bought", "buy", "parts", "part", "photos", "pics", "pictures", "stuff",
     "things", "home", "house", "online", "ad", "ads", "job", "price", "prices", "order",
     "ordered", "stay", "stays", "estoy", "esta", "está", "están", "fotos", "trabajo", "and",
     "or", "the", "a", "an", "at", "on", "in", "to", "of", "for", "my", "your", "our", "his",
     "their", "el", "la", "los", "las", "de", "en", "y", "o", "mi", "su", "i", "we", "they",
     "he", "she", "available", "located", "based", "listed", "found", "seen", "saw"}
)  # fmt: skip

# --- URLs ------------------------------------------------------------------------------------
# A domain never starts inside a word or a marked token (see _START), and may begin with a
# spacing mark; its labels are _LABEL, so "gmäil.com", "gm" + U+0483 + "ail.com" and
# "ñandú.com/x" are masked whole. An accented word glued to a word TLD by a missing space
# ("El baño.es muy pequeño") is left alone by _accented_word.
_DOMAIN_START: Final = rf"(?<![\w.@\-{_MARKS}])"
URL: Final = re.compile(
    rf"(?:https?://|\bwww\s*\.\s*)\S+"
    rf"|{_DOMAIN_START}{_MARKED}[^\W_]{_LABEL}*+(?:\.{_LABEL}++)*?\.[a-z]{{2,}}/\S*"
    rf"|{_DOMAIN_START}{_MARKED}[^\W_]{_LABEL}*+(?:\.{_LABEL}++)*?\.(?P<tld>{_TLD_END})"
    rf"|{_DOMAIN_START}{_MARKED}[^\W_]{_LABEL}{{2,}}+\s*\.\s+(?:com|net|org|co|us|io|miami)\b"
    rf"|{_DOMAIN_START}{_MARKED}[^\W_]{_LABEL}{{2,}}+\s+\.\s*(?:com|net|org|co|us|io|miami)\b",
    _FLAGS,
)
# "jackfixit dot com", "aa dot bb dot cc dot dd dot ee dot ff dot com": a chain of any length,
# walked once per run (_DOMAIN_HEAD, then _DOMAIN_STEP) as SPELLED_EMAIL is. A piece may be
# the dot word ("miweb dot dot dot com").
_DOMAIN_PIECE: Final = rf"{_LABEL}++"
_DOMAIN_HEAD: Final = re.compile(rf"{_DOMAIN_START}{_LABEL}{{2,}}+", _FLAGS)
_DOMAIN_STEP: Final = re.compile(rf"\s+(?P<word>dot|punto)\s+(?P<piece>{_DOMAIN_PIECE})", _FLAGS)
SPELLED_URL: Final = re.compile(
    rf"{_DOMAIN_START}{_LABEL}{{2,}}+(?:\s+(?:dot|punto)\s+{_DOMAIN_PIECE})*\s+(?:dot|punto)\s+"
    rf"{_TLD_END}",
    _FLAGS,
)

# --- Handles ---------------------------------------------------------------------------------
# Strong platforms: "my insta is jdoe" names a handle whatever the word. Weak platforms are
# everyday words too ("Zelle as payment", "facebook last week"): their id must look like a
# handle (a digit, "_", "." or a leading "@"/"$"), unless a cue word or ":"/"=" came first.
_STRONG_PLATFORMS: Final = r"(?:insta(?:gram)?|ig|snap(?:chat)?|tiktok|telegram|tg|twitter|sc)"
_WEAK_PLATFORMS: Final = (
    r"(?:whats\s?app|wasap|guasap|wsp|wpp|wa|facebook|face|fb|venmo|cash\s?app|zelle|paypal|"
    r"e-?mail|correo|g\s?mail|hotmail|yahoo|outlook|icloud)"
)
_PLATFORM_WORDS: Final = frozenset(
    {"insta", "instagram", "ig", "snap", "snapchat", "tiktok", "telegram", "tg", "twitter", "sc",
     "whatsapp", "wasap", "guasap", "wsp", "wpp", "wa", "facebook", "face", "fb", "venmo",
     "cashapp", "zelle", "paypal", "email", "e-mail", "correo", "gmail", "hotmail", "yahoo",
     "outlook", "icloud", "text", "call", "phone", "cash", "card", "check"}
)  # fmt: skip
_CUE: Final = r"(?:handle|account|cuenta|user(?:name)?|usuario|name|nombre|id)"
_LINK_WORD: Final = (
    r"(?:is|es|as|como|me\s+at|at|al|se\s+llama|is\s+called|aparezco\s+como|aparece\s+como)"
)
PLATFORM_HANDLE: Final = re.compile(
    rf"\b(?:(?P<strong>{_STRONG_PLATFORMS})|(?P<weak>{_WEAK_PLATFORMS}))"
    rf"(?:(?P<cue>\s+{_CUE}\b(?:\s+(?:is|es))?\s*[:=]?\s*)"
    rf"|(?P<colon>\s*(?:{_LINK_WORD}\s*)?[:=@>]\s*@?\s*)"
    rf"|(?P<dash>\s*[/-]\s*)"
    rf"|(?P<linked>\s+{_LINK_WORD}\s+)"
    rf"|(?P<spaced>\s+))"
    rf"(?P<id>[@$]?{_MARKED}[^\W_]{_MARKED}(?:[\w.-]{_MARKED}){{1,29}})(?![\w{_MARKS}])",
    _FLAGS,
)
# A handle written before its platform: "j.doe.fixit (insta)". The token is possessive and its
# shape is checked in _mask_reverse_handle, so a long dotted chain costs one pass. It never
# starts inside a marked token (see _START) and takes the marks glued to its characters. The
# spaces around the bracket are possessive: two runs that could split one stretch of spaces
# would try every split before failing ("a", 2,000 spaces, "b" took 0.6 s, #260).
REVERSE_HANDLE: Final = re.compile(
    rf"(?<![\w@.{_MARKS}])(?P<id>{_MARKED}[^\W_][\w.{_MARKS}]*+)"
    rf"\s*+(?:[(\[]\s*+)?(?:on\s+|en\s+)?{_STRONG_PLATFORMS}\b",
    _FLAGS,
)
# Words that follow "insta is" in ordinary sentences, so are not an id.
_NOT_AN_ID: Final = frozenset(
    {"fine", "ok", "okay", "good", "great", "better", "best", "easier", "faster", "down", "not",
     "free", "working", "broken", "the", "a", "my", "your", "private", "public", "new", "old",
     "bien", "mejor", "gratis", "privado", "privada", "nuevo", "nueva", "empty", "gone"}
)  # fmt: skip
# "@name" and "$cashtag", but not "@5pm", "@noon", "@home", "@tomorrow", a price or a currency.
# A handle token is word characters (\w: the letters of any script, digits and "_", so
# "@mañana.fixit", "@josé_silva" and "@мария.ivanova" are masked whole, #236) and runs of ".",
# "_" and "-" (_HANDLE_BODY, as the platforms accept it), the separators also in their
# compatibility forms as typed (_SEPARATOR_FORMS: the low lines whose NFKC form is "_", the
# dot leaders and the ellipsis whose NFKC form is a run of "."; the dashes are already "-" and
# U+2024 already "." after _clean). A time, a measure or a word after "@" is exempt only when
# it is the whole token: _BODY_END refuses whatever would continue the token, a word character,
# a combining mark glued to the word (\w skips marks: "@home" + U+0335 + "fixit") or a run of
# separators followed by a word character. So "@home", "@home.", "@home!", "@home " and
# "@mañana" stay, while "@home.fixit", "@home--fixit", "@home._fixit", "@home_fixit" and
# "@home" + U+FF3F + "fixit" are handles (#224 review, rounds 1 and 2). _clean composes the
# input (NFC), so "@home" + U+0301 + "fixit" is "@homéfixit": no exempt word, one token.
# _HANDLE_BODY takes the marks glued to its own characters (_MARKED, the mark set of
# _MARK_RANGES), so "@bob" + U+05B0 + "smith" is masked whole (#229). A spacing mark (Mc)
# survives _clean after a separator or the "@" too, so a run of separators followed by a mark
# continues the token ("@home." + U+093F + "fixit") and the "@" may carry marks before the
# body ("@" + U+093F + "bobsmith"), also in the spaced form ("@ bob" + U+0483 + ".smith").
# The platform handle, the reverse handle and the cashtag take the marks the same way (#236).
_SEPARATOR_FORMS: Final = "".join(
    map(chr, (0xFE33, 0xFE34, 0xFE4D, 0xFE4E, 0xFE4F, 0xFF3F, 0x2025, 0x2026, 0xFE19, 0xFE30))
)
_SEPARATORS: Final = rf"._\-{_SEPARATOR_FORMS}"
_HANDLE_BODY: Final = rf"\w{_MARKED}(?:(?:[\w{_SEPARATORS}]{_MARKED}){{0,28}}\w{_MARKED})?"
_BODY_END: Final = rf"(?![\w{_MARKS}]|[{_SEPARATORS}]+[\w{_MARKS}])"
AT_HANDLE: Final = re.compile(
    rf"(?<![\w.@])@{_MARKED}(?:\s(?=[\w.\-{_MARKS}]*[\d_.]))?(?!\d{{1,2}}(?:[:.]\d{{1,3}})?\s*(?:[ap]\.?m\.?)?{_BODY_END}|"
    rf"\d+(?:\.\d+)?\s*(?:ft|in|cm|mm|m|hrs?|h|mins?|hours?){_BODY_END}|"
    rf"(?:noon|night|home|work|casa|today|tomorrow|tonight|ma(?:ñ|n)ana){_BODY_END})"
    rf"{_HANDLE_BODY}",
    _FLAGS,
)
# A cashtag is 2 to 20 characters, a letter first, ending on a word character; the characters
# carry their marks, and the "$" may carry a spacing mark ("$" + U+093F + "bob"). Three capitals
# are a currency only as the whole token: a mark or a word character continues it ("$BOB" +
# U+0483 + "smith" is a cashtag, "$USD" and "$USD-denominated" are currencies, #240).
CASHTAG: Final = re.compile(
    rf"(?<![\w$])\$(?!(?-i:[A-Z]{{3}})(?![\w{_MARKS}]))"
    rf"{_MARKED}[^\W\d_]{_MARKED}(?:[\w-]{_MARKED}){{0,18}}\w{_MARKED}(?![\w{_MARKS}])",
    _FLAGS,
)
# A combining mark on a Latin letter after NFC is never an accent (every EN, ES and PT accent
# composes): "bob" + U+0483 + "smith" and "josé" + U+0483 + "smith" are shaped like an evasion,
# not like a word (#240). Scripts that write with marks (Devanagari, Arabic, Hebrew) are not
# Latin, so their words stay plain words. The Latin letters: ASCII, Latin-1, Extended-A and B,
# and Extended Additional (Vietnamese).
_LATIN_LETTERS: Final = "a-z" + "".join(
    f"{chr(low)}-{chr(high)}"
    for low, high in ((0x00C0, 0x00D6), (0x00D8, 0x00F6), (0x00F8, 0x024F), (0x1E00, 0x1EFF))
)
_MARKED_LATIN: Final = re.compile(rf"[{_LATIN_LETTERS}][{_MARKS}]", _FLAGS)
_CASHTAG_START: Final = re.compile(rf"\$[{_MARKS}]*[^\W\d_]")  # "$jdoe", "$" + U+093F + "jdoe"

# --- Phones ----------------------------------------------------------------------------------
# Phones spelled out: ten or more digit words (EN or ES) or digits in a row.
_DIGIT_WORD: Final = (
    r"(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|"
    r"cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|\d)"
)
SPELLED_PHONE: Final = re.compile(rf"\b{_DIGIT_WORD}(?:[\s,.-]+{_DIGIT_WORD}){{9,}}\b", _FLAGS)
# Digit runs joined by phone separators, with an optional "+". Each run is searched for
# phone-shaped windows of its digit groups (_phones), so a phone next to another number is
# still found, and a longer number around a phone-shaped piece is left whole.
DIGIT_RUN: Final = re.compile(r"(?<!\d)\+?[(\[]?\d(?:[\s()\[\]./-]*+\d++)*+(?![\d%])")
_GROUP: Final = re.compile(r"\d+")
_MAX_WINDOW_GROUPS: Final = 11  # ten digits split by spaces, plus a leading 1
_MAX_WINDOW_DIGITS: Final = 18
# How US phones are grouped, as digit counts per group (a leading 1 or +1 included).
PHONE_GROUPS: Final = frozenset(
    {
        (10,),
        (11,),
        (1, 10),
        (3, 7),
        (1, 3, 7),
        (4, 3, 4),
        (3, 3, 4),
        (1, 3, 3, 4),
        (3, 3, 2, 2),
        (1, 3, 3, 2, 2),
        (2, 4, 4),  # Mexico, 10 digits
    }
)
_CUE_PREFIXES: Final = frozenset(
    {"cell", "cel", "tel", "ph", "phone", "call", "txt", "text", "wa", "whatsapp", "movil",
     "móvil", "celular", "telefono", "teléfono"}
)  # fmt: skip
_DOTTED_QUAD: Final = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
# A price with cents: one dot in the number ("450.00"), not dotted groups ("0414-123.45.67").
_CENTS: Final = re.compile(r"(?<![\d.])\d+\.\d\d(?![\d.])")

# --- Addresses -------------------------------------------------------------------------------
# Words that are never part of a street name (lowercase only, so "3400 Day Ave" stays a street):
# measures, quantities, trade shorthand ("6 inch rd duct", "20 amp cir"), distance words.
_NOT_NAMES: Final = (
    r"(?-i:ft|feet|foot|in|inch|inches|sq|square|yd|yards?|gal|gallons?|lbs?|amps?|volts?|v|w|"
    r"watts?|x|pcs?|pieces?|hp|seer|btu|tons?|mm|cm|m|metros?|minutes?|min|mins|hrs?|hours?|"
    r"days?|weeks?|months?|years?|yrs?|am|pm|blocks?|miles?|cuadras?|off|past|behind|across|"
    r"beds?|baths?|bedrooms?|bathrooms?|story|stories|car|cars|cu|ct|count|packs?|boxes|"
    r"model|series|serial|unit|units|zones?|stage|speed|FT|SQ|HP|BTU|AMP)"
)
_FUNCTION_WORDS: Final = (
    r"(?:the|a|an|on|in|at|to|of|for|my|your|our|his|her|their|and|or|with|by|from|near|over|"
    r"el|la|los|las|de|del|en|y|o|con|por|mi|su)"
)
_WORD_END: Final = rf"(?![\w{_APOSTROPHES}-])"
# A name word: not a bare number, not a function word or a "not a name" word, and never ending
# in a period (a name does not cross a sentence end: "installed. Way too hot"). Ordinals
# ("42nd") and apostrophes ("O'Neil") are fine; so is an initial ("J.").
_NAME_WORD: Final = (
    rf"(?!(?:{_FUNCTION_WORDS}|{_NOT_NAMES}){_WORD_END})(?!\d+{_WORD_END})"
    rf"(?:[^\W\d_]\.(?=\s)|[^\W_](?:[\w{_APOSTROPHES}-]|\.(?=\w))*+)"
)
# A street name: name words, with up to two function words inside ("Ponce de Leon", "Isle of
# Palms") and a capitalized article first ("Las Olas", "El Dorado").
_FIRST_WORD: Final = rf"(?:{_NAME_WORD}|(?-i:(?:Las|Los|La|El|Del|De|The))(?=\s))"
_STREET_NAME: Final = rf"{_FIRST_WORD}(?:\s+(?:(?:{_FUNCTION_WORDS})\s+){{0,2}}{_NAME_WORD}){{0,5}}"
# "av" only before punctuation or the end: "1200 Brickell Av, apt 5", not "Denon AV receiver".
_ABBREVIATIONS: Final = (
    r"st|ave|rd|blvd|dr|ln|ct|pl|ter|terr|cir|hwy|pkwy|trl|xing|cswy|expy|cv|lp|pt|"
    r"av(?=\s*[.,;]|\s*$)"
)
_PLAIN_SUFFIXES: Final = (
    "street|avenue|road|boulevard|lane|highway|parkway|causeway|expressway|"
    "drive|way|place|court|circle|plaza|trail|terrace|isle|island|cove|run|loop|pass|path|"
    "row|point|pointe|bay|key|bend|crescent|square"
)
# Suffixes that are also everyday nouns ("10 basketball court lights", "3 LED lights over the
# kitchen island"): with a house number under 3 digits they need a capitalized suffix and a
# capitalized word right before it.
_COMMON_NOUNS: Final = frozenset(
    {"drive", "way", "place", "court", "circle", "plaza", "trail", "terrace", "isle", "island",
     "cove", "run", "loop", "pass", "path", "row", "point", "pointe", "bay", "key", "bend",
     "crescent", "square"}
)  # fmt: skip
_SUFFIX: Final = rf"(?:{_ABBREVIATIONS}|{_PLAIN_SUFFIXES})"
_DIRECTION: Final = r"(?:(?:n\.?\s?[ew]|s\.?\s?[ew])\.?|(?:n|s|e|w)\.?|north|south|east|west)"
_HOUSE_NUMBER: Final = r"\d{1,6}(?:-?[a-z]\b|\s+1/2)?"
# Longest first, so "apto 12B" is one unit, not "apt" + "o". "#" only on its own (not "Part#").
_UNIT_WORDS: Final = (
    r"(?:\b(?:apartamento|apartment|apto|apt|departamento|depto|unidad|unit|suite|ste|bldg|"
    r"penthouse|(?-i:PH))|(?<!\w)#)"
)
_UNIT: Final = rf"(?:,?\s*{_UNIT_WORDS}\.?\s*#?\s*[a-z0-9-]+\b)"
# Keeps an abbreviation's period only when the sentence goes on ("St. Apt 4", not "Way.").
_DOT: Final = r"(?:\.(?=\s*[\w,#]))?"
_NUMBER_MARK: Final = r"(?:#|n[oº°]\.?|nro\.?|n[uú]m(?:ero)?\.?|number)"
STREET: Final = re.compile(
    rf"\b(?P<number>{_HOUSE_NUMBER}),?\s+(?:(?P<direction>{_DIRECTION})\s+)?"
    rf"(?:(?P<grid>\d{{1,3}}(?:st|nd|rd|th)?)\s+)?(?P<name>{_STREET_NAME}\s+)?"
    rf"(?P<suffix>{_SUFFIX})\b{_DOT}(?:\s+{_DIRECTION}\b{_DOT})?{_UNIT}?",
    _FLAGS,
)
# The house number last, as many Spanish speakers write it: "Brickell Ave 1200", "SW 8th St
# 1250", "Coral Way 3500, apt 2". Capitalized names only, and not a quantity or a ZIP after it.
_CAPITALIZED: Final = rf"(?-i:[A-Z][\w{_APOSTROPHES}-]*)"
REVERSED_STREET: Final = re.compile(
    rf"\b(?:(?P<direction>{_DIRECTION})\s+)?"
    rf"(?P<name>\d{{1,3}}(?:st|nd|rd|th)|(?<=\s)\d{{1,3}}(?=\s)|"
    rf"{_CAPITALIZED}(?:\s+{_CAPITALIZED}){{0,2}})"
    rf"\s+(?P<suffix>{_SUFFIX})\b{_DOT},?\s*{_NUMBER_MARK}?\s*"
    rf"(?P<number>\d{{2,6}}[a-z]?)\b(?!\s*(?:{_NOT_NAMES}|%|floor|story)\b){_UNIT}?",
    _FLAGS,
)
# The Miami grid without a suffix ("8800 SW 72nd", "1500 SW 8") and US-1 style highways.
GRID_OR_HIGHWAY: Final = re.compile(
    r"\b\d{2,6}\s+(?:(?:n\.?\s?[ew]|s\.?\s?[ew])\.?\s+\d{1,3}(?:st|nd|rd|th)?|(?:n|s|e|w)\.?\s+"
    r"\d{1,3}(?:st|nd|rd|th))\b(?!\s+(?:floor|story|stories)\b)"
    r"|\b\d{2,6}\s+(?:(?:n|s|e|w)\.?\s+)?(?:us[\s-]?(?:hwy\s*)?\d{1,3}|(?:sr|fl)-\d{1,3}|"
    r"state\s+road\s+\d{1,3})\b",
    _FLAGS,
)
# Spanish forms: "Calle 8 #123", "calle 8 numero 1500", "Calle Flagler 742", "Avenida de las
# Americas 100", "Av. Brickell 1200", "Vía Mizner 100", "el 1500 de la Collins Ave". A street
# word and one number only ("Calle 8", "la avenida 27") is a street name, not an address.
_ES_STREET_WORD: Final = r"(?:calle|avenida|avda\.?|av\.|ave\.?|v(?-i:í)a|(?-i:V[ií]a))"
_ES_NAME: Final = r"(?:(?-i:[A-ZÁÉÍÓÚÑ][\wáéíóúñü'-]*)|\d{1,3}\b|de|la|las|los|del|el)"
_ES_NUMBER: Final = r"\d{1,6}[a-z]?\b(?!\.\d)"
SPANISH_STREET: Final = re.compile(
    rf"\b{_ES_STREET_WORD}\s+(?:(?P<name>(?:{_ES_NAME}\s+){{1,4}}?){_NUMBER_MARK}?\s*{_ES_NUMBER}"
    rf"|\d{{1,3}}\b\s*,?\s*{_NUMBER_MARK}?\s*{_ES_NUMBER})"
    rf"(?:\s*,?\s*{_NUMBER_MARK}?\s*{_ES_NUMBER})?{_UNIT}?"
    rf"|\b\d{{1,6}}\s+(?:de\s+la\s+|del\s+)?{_ES_STREET_WORD}\s+{_ES_NAME}(?:\s+{_ES_NAME}){{0,3}}"
    rf"|\b(?:el|al)\s+\d{{2,6}}\s+(?:de\s+la|del)\s+(?:{_STREET_NAME}\s+)?(?:{_SUFFIX}\b{_DOT}|"
    rf"{_ES_STREET_WORD}\s+{_ES_NAME}(?:\s+{_ES_NAME}){{0,2}}){_UNIT}?",
    _FLAGS,
)
# A unit or a PO box on its own ("apt 4B", "Suite 300", "apto 12", "PO Box #12"). A unit number
# followed by an ordinary word ("unit 2 is not cooling", "suite 2 sinks") is not an address.
UNIT_OR_BOX: Final = re.compile(
    rf"{_UNIT_WORDS}\.?\s*#?\s*\d+[a-z]?\b(?!\.\d)"
    rf"(?!\s+(?!(?:apt|apto|unit|suite|ste|bldg)\b)(?-i:[a-záéíóúñ]|[A-Z]{{2,}}\b|A/C))"
    r"|\bp\.?\s*o\.?\s*box\s*[:#]?\s*\d+\b|\bapartado(?:\s+postal)?\s*[:#]?\s*\d+\b",
    _FLAGS,
)

# A measure right after a digit run: the run is a quantity, not a phone. Only unambiguous
# measure words count; "in" only after a short number ("3.5 in", "10 in x 12 in"), since after
# a phone it is prose ("call 305-555-0199 in the afternoon").
_MEASURE_AFTER: Final = re.compile(
    r"\s*(?:(?P<inch>in)\b|(?:ft|feet|foot|sq|sqft|square|inch(?:es)?|yd|yards?|gal(?:lons?)?|"
    r"lbs?|pounds?|amps?|volts?|watts?|kw|hp|seer2?|btu|tons?|mm|cm|metros?|pies|"
    r"pulgadas?|galones)\b)",
    _FLAGS,
)
_SHORT_NUMBER: Final = re.compile(r"\d{1,4}(?:[./]\d{1,3})?")

_Replace = Callable[[re.Match[str]], str | None]  # None keeps the match as it is
# What a contact rule masks in a match: None when it holds no contact (the search tries again
# one character later), else the spans to mask; [] when it was analyzed whole and holds none.
_Rule = Callable[[re.Match[str]], list[tuple[int, int]] | None]


class _Search(Protocol):
    def search(self, string: str, pos: int = 0) -> re.Match[str] | None: ...


@dataclass(frozen=True)
class _RunSearch:
    """`pattern` tried on each run of spelled-dot pieces (`head`, then `step` while it
    matches) from only the starts that can end differently, so the search stays linear (#240).
    A piece another chain already read ends that chain's way and reaches its verdict, so only
    a chain's first piece is tried. A spaced dot word read as a piece swaps the roles: the
    pieces around it become its separators ("jose dot at acme dot com" is "dot" at "acme",
    "miweb dot dot dot com" ends in "dot dot com"), so it starts a chain of its own, unless one
    read it already ("dot dot dot"). That chain may run past its run's end; the pieces it read
    are remembered, so each one is read once. `accept` refuses a match here rather than in the
    replace step, which would try again one character later."""

    head: re.Pattern[str]  # the run's first piece
    step: re.Pattern[str]  # a spelled dot and the next piece: groups "word" (spaced) and "piece"
    pattern: re.Pattern[str]
    accept: Callable[[re.Match[str]], bool] | None = None
    tail: str | None = None  # the group after which an overlapping match may start

    def search(self, string: str, pos: int = 0) -> re.Match[str] | None:
        read: set[int] = set()  # where the pieces of the chains tried so far start
        while (head := self.head.search(string, pos)) is not None:
            pieces, words, pos = self._chain(string, head)
            for start in [head.start(), *words]:
                first = head if start == head.start() else self.head.match(string, start)
                if start in read or first is None:
                    continue
                read.update(pieces if first is head else self._chain(string, first)[0])
                match = self.pattern.match(string, start)
                if match is not None and (self.accept is None or self.accept(match)):
                    return match
        return None

    def _chain(self, string: str, first: re.Match[str]) -> tuple[list[int], list[int], int]:
        """The chain that `first` begins: where its pieces and its spaced dot words start, and
        where it ends."""
        pieces, words, end = [first.start()], [], first.end()
        while (step := self.step.match(string, end)) is not None:
            pieces.append(step.start("piece"))
            if step.group("word") is not None:
                words.append(step.start("word"))
            end = step.end()
        return pieces, words, end

    def mask_end(self, string: str, match: re.Match[str]) -> int:
        """Where the mask of `match` ends. An accepted match that starts after its `tail` group
        and before its end runs past it (the domain of "x (at) pérez.me@b.c (dot) es" is the
        local part of the next address); it joins the mask, so accepting a match never hides
        one that a search refusing it would have found (#240)."""
        end = match.end()
        while (
            self.tail is not None
            and (more := self.search(string, match.end(self.tail))) is not None
            and more.start() < end
        ):
            match, end = more, more.end()
        return end


@dataclass(frozen=True)
class RedactionResult:
    text: str
    redacted: bool  # True when at least one contact detail was masked


def redact_contacts(text: str) -> RedactionResult:
    """`text` with every contact detail it recognizes replaced by MASK (see the module doc).
    The rules run in order, each on the text the ones before it masked. A mask can cut a
    contact a later rule would have read whole: in "call 305 555 0199 at gmail" the email
    takes the last group and leaves six digits, no phone (#257); the URL in "jdoe1 insta dot
    com" takes the platform and leaves the handle, the email in "1250 Ocean Dr at gmail" takes
    the suffix and leaves the house (#240). So these rules also read the text without masks. A
    phone found there joins the masks it overlaps or touches. A reverse handle or an address
    (_CUT_STEPS) joins only an email or URL mask that took its cue, the platform, the suffix or
    the number (_cut). A mask that took another of its words was another contact's: "site.com/2
    new drive belts" keeps "new drive belts", "2 Amazon.com Key pads" keeps "Key pads". A phone
    that took its number leaves it as the rules in order read it ("APT" before a phone's mask)."""
    cleaned = _clean(text)
    masked, cutting = _masks_in_order(cleaned)
    if masked:
        found = [span for search, rule in _PHONE_STEPS for span in _spans(search, rule, cleaned)]
        if cutting:
            found += _cut_spans(cleaned, _Apart.of(cutting), _Apart.of(masked))
        masked = _joined(masked, found)
    result, count = _mask_spans(cleaned, masked)
    return RedactionResult(result, count > 0)


def _cut_spans(text: str, cutting: "_Apart", masked: "_Apart") -> list[tuple[int, int]]:
    """The reverse handles and addresses in `text` that a mask in `cutting` cut (_cut)."""
    found: list[tuple[int, int]] = []
    for search, rule in _CUT_STEPS:
        cue = _CUES[search]

        def cut_rule(
            match: re.Match[str], rule: _Rule = rule, cue: _Cue = cue
        ) -> list[tuple[int, int]] | None:
            spans = rule(match)
            if spans is None:
                return None
            return [span for span in spans if _cut(span, cue(match), cutting, masked)]

        found += _spans(search, cut_rule, text)
    return found


def _cut(span: tuple[int, int], cue: int, cutting: "_Apart", masked: "_Apart") -> bool:
    """A mask in `cutting` starts inside `span`, after its first character, and covers the
    first character of its cue (`cue`), or starts right at the end of `span`; and no mask stands
    in `span` before it. The rule read the contact as it would have in order, had the email or
    URL rule not taken the cue: a mask inside it (a platform handle in "4B instagram x_1 ig
    way.com") broke it there too."""
    index = bisect.bisect_right(cutting.starts, cue) - 1
    touching = bisect.bisect_left(cutting.starts, span[1])
    if index >= 0 and cutting.starts[index] > span[0] and cutting.spans[index][1] > cue:
        cut_at = cutting.starts[index]
    elif touching < len(cutting.starts) and cutting.starts[touching] == span[1]:
        cut_at = span[1]
    else:
        return False
    before = bisect.bisect_left(masked.starts, cut_at) - 1  # the last mask starting before it
    return before < 0 or masked.spans[before][1] <= span[0]


@dataclass(frozen=True)
class _Apart:
    """Spans sorted, the overlapping ones merged, and their starts (for bisection)."""

    spans: list[tuple[int, int]]
    starts: list[int]

    @classmethod
    def of(cls, spans: list[tuple[int, int]]) -> "_Apart":
        merged: list[tuple[int, int]] = []
        for start, end in sorted(spans):
            if merged and start < merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        return cls(merged, [start for start, _ in merged])


def _last_word(match: re.Match[str]) -> int:
    """Where the last word of `match` starts: the platform of a reverse handle, the number or
    the name word of a Spanish street, the grid street of the Miami grid."""
    text, start, end = match.string, match.start(), match.end()
    while end > start and not text[end - 1].isalnum():
        end -= 1
    while end > start and text[end - 1].isalnum():
        end -= 1
    return end


def _masks_in_order(text: str) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """Each rule on the text the rules before it masked (a mask is no word, so "unit 5B
    youtu.be/abc123" reads as a unit once the URL is masked): where the masks are in `text`,
    and which of them the email and URL rules made."""
    current = text
    origin = [(index, index + 1) for index in range(len(text))]  # each character's span in text
    masked: list[tuple[int, int]] = []
    by_emails_and_urls = 0
    for step, (search, rule) in enumerate(_STEPS):
        runs = [_unmarked_spans, _spans] if search in _UNMARKED_FIRST else [_spans]
        for run in runs:
            spans = list(run(search, rule, current))
            if spans:
                current, origin = _masked_with_origin(current, origin, spans, masked)
        if step < len(_EMAIL_AND_URL_STEPS):
            by_emails_and_urls = len(masked)
    return masked, masked[:by_emails_and_urls]


def _masked_with_origin(
    text: str,
    origin: list[tuple[int, int]],
    spans: list[tuple[int, int]],
    masked: list[tuple[int, int]],
) -> tuple[str, list[tuple[int, int]]]:
    """`text` with `spans` (in order; touching ones may share marks) replaced by MASK, and the
    origin of its characters; adds the span each mask hides in the cleaned text to `masked`."""
    pieces: list[str] = []
    new_origin: list[tuple[int, int]] = []
    position = 0
    for start, end in spans:
        hidden = (origin[start][0], origin[end - 1][1])
        masked.append(hidden)
        start = max(start, position)
        pieces += [text[position:start], MASK]
        new_origin += origin[position:start] + [hidden] * len(MASK)
        position = max(end, position)
    pieces.append(text[position:])
    new_origin += origin[position:]
    return "".join(pieces), new_origin


def _joined(masked: list[tuple[int, int]], found: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """`masked` grown by the spans in `found` that overlap or touch it, directly or through
    another such span. A span that meets no mask is one the rules in order passed over in its
    own context, so it stays out."""
    spans = sorted(
        [(start, end, True) for start, end in masked] + [(*span, False) for span in found]
    )
    joined: list[tuple[int, int]] = []
    group_start, group_end, group_masked = spans[0]
    for start, end, is_masked in spans[1:]:
        if start <= group_end:
            group_end, group_masked = max(group_end, end), group_masked or is_masked
            continue
        if group_masked:
            joined.append((group_start, group_end))
        group_start, group_end, group_masked = start, end, is_masked
    if group_masked:
        joined.append((group_start, group_end))
    return joined


def _clean(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    chars: list[str] = []
    for index, char in enumerate(text):
        category = unicodedata.category(char)
        if category in ("Cf", "Me") or char in INVISIBLE_FILLERS:
            continue
        if category == "Mn" and (not chars or not chars[-1].isalpha()):
            continue  # a mark on a digit or a symbol ("3̅0̅5̅"), not an accent on a letter
        chars.append(_fold(text, index, char))
    folded = "".join(chars)
    folded = _MIXED_WORD.sub(_fold_confusables, folded)
    folded = _DASHES.sub("-", folded)
    folded = _ODD_SEPARATOR.sub("-", folded)
    return folded.replace(chr(0xA0), " ")  # a no-break space reads as a space


def _fold(text: str, index: int, char: str) -> str:
    if char.isascii() or char in _KEEP_AS_IS:
        return char
    if char in _SCRIPT_DIGITS:
        window = text[max(0, index - 2) : index + 3]
        return unicodedata.normalize("NFKC", char) if _script_run(window) else char
    folded = unicodedata.normalize("NFKC", char)
    return folded if len(folded) == 1 and _FOLDABLE.fullmatch(folded) else char


def _script_run(window: str) -> bool:
    """Three superscript or subscript digits in a row somewhere in `window`."""
    run = 0
    for char in window:
        run = run + 1 if char in _SCRIPT_DIGITS else 0
        if run >= 3:
            return True
    return False


def _fold_confusables(match: re.Match[str]) -> str:
    word = match.group(0)
    if not any(char in _CONFUSABLES for char in word) or not re.search(r"[a-zA-Z]", word):
        return word
    return "".join(_CONFUSABLES.get(char, char) for char in word)


def _substitute(search: _Search, replace: _Replace, text: str) -> tuple[str, int]:
    """Like pattern.sub, but a kept match only skips one character, so a contact that starts
    inside it is still found ("fix 2 doors 1250 Ocean Dr")."""
    return _apply(text, _replacements(search, replace, text))


def _unmarked_spans(search: _Search, rule: _Rule, text: str) -> Iterator[tuple[int, int]]:
    """The same rule on `text` without its marks; each span also covers the marks inside its
    match and around it, so "gmail.c" + U+0483 + "om" is masked whole (see _UNMARKED_FIRST)."""
    kept = [index for index, char in enumerate(text) if char not in _MARK_CHARS]
    if len(kept) == len(text):
        return
    unmarked = "".join(text[index] for index in kept)
    kept.append(len(text))
    for start, end in _spans(search, rule, unmarked):
        yield kept[start - 1] + 1 if start else 0, kept[end]


def _spans(search: _Search, rule: _Rule, text: str) -> Iterator[tuple[int, int]]:
    """Where `rule` masks `text`. A kept match only skips one character, so a contact that
    starts inside it is still found ("fix 2 doors 1250 Ocean Dr")."""
    search_from = 0
    while (match := search.search(text, search_from)) is not None:
        spans = rule(match)
        if spans is None:
            search_from = match.start() + 1
            continue
        end = match.end()
        if isinstance(search, _RunSearch):
            end = search.mask_end(text, match)
            spans = [(match.start(), end)]
        yield from spans
        search_from = max(end, match.start() + 1)


def _whole(replace: _Replace) -> _Rule:
    """The rule that masks a whole match unless `replace` keeps it."""
    return lambda match: None if replace(match) is None else [match.span()]


def _replacements(search: _Search, replace: _Replace, text: str) -> Iterator[tuple[int, int, str]]:
    for start, end in _spans(search, _whole(replace), text):
        yield start, end, MASK


def _apply(text: str, spans: Iterable[tuple[int, int, str]]) -> tuple[str, int]:
    pieces: list[str] = []
    position, count = 0, 0
    for start, end, replacement in spans:
        pieces += [text[position:start], replacement]
        count += replacement.count(MASK)
        position = end
    pieces.append(text[position:])
    return "".join(pieces), count


def _mask(match: re.Match[str]) -> str | None:
    return MASK


def _missing_space(match: re.Match[str], tld: str) -> bool:
    """ "cooling.Me and my wife": a word TLD, capitalized, right after a lowercase letter."""
    start = match.start("tld")
    before = match.string[start - 2] if start >= 2 else ""
    return tld.lower() in _WORD_TLDS and tld[0].isupper() and not tld.isupper() and before.islower()


def _accented_word(text: str, dot: int, tld: str) -> bool:
    """ "El baño.es muy pequeño": a word TLD after a label with a non-ASCII letter, which is
    Spanish or Portuguese typing with a missing space, not a domain. Only the label glued to
    the dot at `dot` counts (an accented domain with a path or "www." is still one)."""
    if tld.lower() not in _WORD_TLDS:
        return False
    start = dot
    while start > 0 and _LABEL_CHAR.fullmatch(text[start - 1]) is not None:
        start -= 1
    return any(char.isalpha() and not char.isascii() for char in text[start:dot])


def _mask_url(match: re.Match[str]) -> str | None:
    tld = match.group("tld")
    if tld is not None and (
        _missing_space(match, tld) or _accented_word(match.string, match.start("tld") - 1, tld)
    ):
        return None
    return MASK


def _is_spelled_email(match: re.Match[str]) -> bool:
    at = match.group("at")
    weak_at = _WEAK_AT.fullmatch(at) is not None
    if weak_at and match.group("local").lower() in _COMMON_WORDS:
        return False  # "it at Amazon.com", "work at BestPools.com"
    if match.group("dot") != "." or not weak_at:
        return True  # "@", "(at)" and "arroba" make an address whatever its labels (#240)
    if _missing_space(match, match.group("tld")):
        return False  # "is at home.Me and my wife"
    # "Vivo en baño.es muy...": "en" is a word first. After "at" the address is masked whatever
    # its labels ("josé at acme.es", #240).
    spanish_en = _SPANISH_EN.fullmatch(at) is not None
    return not (spanish_en and _accented_word(match.string, match.start("dot"), match.group("tld")))


def _mask_provider_email(match: re.Match[str]) -> str | None:
    weak_at = _WEAK_AT.fullmatch(match.group("at")) is not None
    if weak_at and match.group("local").lower() in _COMMON_WORDS:
        return None  # "photos are at iCloud", "I work at Yahoo"
    return MASK


def _handle_shaped(handle: str) -> bool:
    if handle[0] == "@":
        return True
    if handle[0] == "$":
        return _CASHTAG_START.match(handle) is not None  # "$jdoe", not "$150"
    has_letter = re.search(r"[^\W\d_]", handle) is not None
    return has_letter and (
        re.search(r"[\d_.]", handle) is not None or _MARKED_LATIN.search(handle) is not None
    )


def _mask_handle(match: re.Match[str]) -> str | None:
    handle = match.group("id")
    if re.search(r"[^\W\d_]", handle) is None:
        return None  # an id has a letter; numbers are phones (masked before)
    if handle.lower().strip("@$") in _PLATFORM_WORDS:
        return None  # "Facebook/Instagram", "WhatsApp/text"
    strong = match.group("strong") is not None
    if match.group("cue") is not None or match.group("colon") is not None:
        return MASK if handle.lower() not in _NOT_AN_ID else None
    if match.group("linked") is not None and strong:
        return MASK if handle.lower() not in _NOT_AN_ID else None
    if match.group("dash") is not None and strong:
        return MASK if handle.lower() not in _NOT_AN_ID else None
    return MASK if _handle_shaped(handle) else None


def _mask_reverse_handle(match: re.Match[str]) -> str | None:
    handle = match.group("id").rstrip(".")
    return MASK if _handle_shaped(handle) else None


def _has_bare_function_word(words: list[str]) -> bool:
    """A function word inside the name between words that are not capitalized ("2 trees near
    the main road"); real names have them between capitalized words ("Ponce de Leon")."""
    function_words = re.compile(rf"{_FUNCTION_WORDS}", _FLAGS)
    for index, word in enumerate(words):
        if function_words.fullmatch(word) and index > 0:
            before, after = words[index - 1], words[index + 1] if index + 1 < len(words) else ""
            if not (before[:1].isupper() and after[:1].isupper()):
                return True
    return False


def _mask_street(match: re.Match[str]) -> str | None:
    words = (match.group("name") or "").split()
    if not words and match.group("grid") is None and match.group("direction") is None:
        return None
    if _has_bare_function_word(words):
        return None
    # A house number, one to three name words and a suffix is an address whatever its case or
    # whether the number looks like a year ("2000 ocean drive", "45 ocean drive"): privacy wins
    # over the few phrases that read the same ("12 new drive belts"). Only a longer phrase
    # before an everyday-noun suffix needs a capitalized street name or a 3-digit number.
    suffix = match.group("suffix")
    if len(words) > 3 and suffix.lower() in _COMMON_NOUNS:
        number = re.match(r"\d+", match.group("number"))
        digits = number.group(0) if number else ""
        named = suffix[:1].isupper() and words[-1][:1].isupper()
        if len(digits) < 3 and not named:
            return None
    return MASK


def _mask_reversed_street(match: re.Match[str]) -> str | None:
    number = match.group("number")
    if len(number) == 5 and number[:2] in ("32", "33", "34"):
        return None  # a Florida ZIP after a street name ("near Bird Rd 33155"), not a house
    name = match.group("name")
    if name.isdigit() and match.group("direction") is None:
        return None  # "Pack 100 ct 12 rolls"
    if match.group("suffix").lower() in _COMMON_NOUNS and not (
        name[:1].isupper() or name[:1].isdigit() or match.group("direction")
    ):
        return None
    return MASK


def _phones(match: re.Match[str]) -> list[tuple[int, int]]:
    """The phone-shaped windows of digit groups in one digit run; [] when it holds none, so the
    scan moves past the run (it was analyzed whole)."""
    run = match.group(0)
    if _glued_to_a_code(match) or _DOTTED_QUAD.fullmatch(run.strip("()[]")):
        return []
    # A measure after the run ("100 / 200 / 1500 sq ft"): a window that ends the run is a
    # quantity, not a phone. Earlier windows still count ("call 305-555-0199. 3 bedrooms").
    measure = _MEASURE_AFTER.match(match.string, match.end())
    quantity = measure is not None and (
        measure.group("inch") is None or _SHORT_NUMBER.fullmatch(run) is not None
    )
    groups = list(_GROUP.finditer(run))
    digits = [group.group(0) for group in groups]
    spans: list[tuple[int, int]] = []
    start = 0
    while start < len(groups):
        end = _window_end(run, groups, digits, start, quantity)
        if end is None:
            start += 1
            continue
        begin = groups[start].start()
        while begin > 0 and run[begin - 1] in "([+":
            begin -= 1
        spans.append((match.start() + begin, match.start() + groups[end - 1].end()))
        start = end
    return spans


def _glued_to_a_code(match: re.Match[str]) -> bool:
    """The digits end a model, serial or tracking code (WH12345678901, 1Z999AA1012345678): an
    uppercase or alphanumeric prefix glued to them. A word ("cell3055550199", "CELL...") is not."""
    text, start = match.string, match.start()
    while start > 0 and text[start - 1].isalnum():
        start -= 1
    prefix = text[start : match.start()]
    if not prefix or prefix.lower() in _CUE_PREFIXES:
        return False
    return prefix.isupper() or any(char.isdigit() for char in prefix)


def _window_end(
    run: str, groups: list[re.Match[str]], digits: list[str], start: int, quantity: bool
) -> int | None:
    """The end (exclusive) of the longest phone-shaped window of groups from `start`. Windows
    hold at most _MAX_WINDOW_GROUPS groups and _MAX_WINDOW_DIGITS digits, so a long list of
    numbers costs a linear scan. With `quantity`, a window may not end the run."""
    international = start < len(groups) and _after_plus(run, groups[start])
    best: int | None = None
    total = 0
    for end in range(start + 1, min(len(groups), start + _MAX_WINDOW_GROUPS) + 1):
        total += len(digits[end - 1])
        if total > _MAX_WINDOW_DIGITS:
            break
        if quantity and end == len(groups):
            break
        window_text = run[groups[start].start() : groups[end - 1].end()]
        if international and 10 <= total <= 15:
            best = end
            continue
        if _continues(run, groups, start, end) or not _plausible(window_text, digits[start:end]):
            continue
        joined = "".join(digits[start:end])
        if _is_us_phone(digits[start:end], joined) or _is_latin_mobile(joined, end - start):
            best = end
    return best


def _after_plus(run: str, group: re.Match[str]) -> bool:
    begin = group.start()
    return begin > 0 and run[begin - 1] == "+"


def _plausible(window_text: str, window: list[str]) -> bool:
    """Prices with cents ("450.00 / 650.00") and lists of round amounts ("450/600/1200") are not
    phones; fractions are not split digits ("1/2 3/4 1/4 3/8 5/8")."""
    if _CENTS.search(window_text):
        return False
    if len(window) >= 3 and all(int(group) % 50 == 0 for group in window):
        return False
    return not (all(len(group) == 1 for group in window) and "/" in window_text)


def _continues(run: str, groups: list[re.Match[str]], start: int, end: int) -> bool:
    """A window glued by "-" to a 5-digit or longer group on either side is part of another
    number (an order id such as 112-1234567-1234567), not a phone."""
    if end < len(groups):
        between = run[groups[end - 1].end() : groups[end].start()]
        if between == "-" and len(groups[end].group(0)) >= 5:
            return True
    if start > 0:
        between = run[groups[start - 1].end() : groups[start].start()]
        if between == "-" and len(groups[start - 1].group(0)) >= 5:
            return True
    return False


def _is_us_phone(window: list[str], joined: str) -> bool:
    sizes = tuple(len(group) for group in window)
    eleven = len(joined) == 11 and joined[0] == "1"
    if len(joined) != 10 and not eleven:
        return False
    if sizes in PHONE_GROUPS:
        return True
    if all(size == 1 for size in sizes):  # digits split by spaces
        return True
    # An area code, then the rest in any grouping of short groups ("786 55 50 199").
    return len(joined) == 10 and sizes[0] == 3 and len(sizes) >= 3 and max(sizes) <= 4


def _is_latin_mobile(joined: str, count: int) -> bool:
    if joined.startswith(("00", "011")) and 12 <= len(joined) <= 18:
        return True  # an international prefix instead of "+"
    if len(joined) == 11 and joined.startswith("04") and count <= 5:
        return True  # Venezuela: 0412-1234567, 0414-123.45.67
    return len(joined) == 10 and joined.startswith("535") and count <= 3  # Cuba: 53 5 1234567


# Order matters: emails and URLs before the handles and domains inside them; phones before
# platform handles, so "whatsapp 305 555 0199" loses the whole number; masks hold no letter or
# digit, so a later pattern never matches inside an earlier mask. A contact an earlier mask
# cuts is joined back whole (redact_contacts).
_SPELLED_EMAILS: Final = _RunSearch(
    _LOCAL_HEAD, _LOCAL_STEP, SPELLED_EMAIL, _is_spelled_email, tail="at"
)
_SPELLED_URLS: Final = _RunSearch(_DOMAIN_HEAD, _DOMAIN_STEP, SPELLED_URL)
_PHONE_STEPS: Final[tuple[tuple[_Search, _Rule], ...]] = (
    (SPELLED_PHONE, _whole(_mask)),
    (DIGIT_RUN, _phones),
)
# The rules that read their cue after the contact: an email or a URL masked before them can
# take a reverse handle's platform or an address's suffix, so they read the text without masks
# again (redact_contacts). A handle with its platform or sigil first keeps it before the id,
# and a mask that takes the id already hides the contact ("Email me at jane@gmail.com" keeps
# "Email me at"); a unit keeps its word before the number the same way ("apt 4B@x.com" keeps
# "apt").
_ADDRESS_STEPS: Final[tuple[tuple[_Search, _Rule], ...]] = (
    (STREET, _whole(_mask_street)),
    (REVERSED_STREET, _whole(_mask_reversed_street)),
    (GRID_OR_HIGHWAY, _whole(_mask)),
    (SPANISH_STREET, _whole(_mask)),
)
_REVERSE_HANDLE_STEP: Final[tuple[_Search, _Rule]] = (
    REVERSE_HANDLE,
    _whole(_mask_reverse_handle),
)
_CUT_STEPS: Final[tuple[tuple[_Search, _Rule], ...]] = (_REVERSE_HANDLE_STEP, *_ADDRESS_STEPS)
# Where the cue of each of them starts: what the email or URL mask must have taken (_cut).
_Cue = Callable[[re.Match[str]], int]
_CUES: Final[dict[_Search, _Cue]] = {
    REVERSE_HANDLE: _last_word,
    STREET: lambda match: match.start("suffix"),
    REVERSED_STREET: lambda match: match.start("number"),
    GRID_OR_HIGHWAY: _last_word,
    SPANISH_STREET: _last_word,
}
_EMAIL_AND_URL_STEPS: Final[tuple[tuple[_Search, _Rule], ...]] = (
    (SPACED_LETTERS_EMAIL, _whole(_mask)),
    (PLAIN_EMAIL, _whole(_mask)),
    (SPACED_EMAIL, _whole(_mask)),
    (_SPELLED_EMAILS, _whole(_mask)),
    (PROVIDER_EMAIL, _whole(_mask_provider_email)),
    (GLUED_EMAIL, _whole(_mask)),
    (_SPELLED_URLS, _whole(_mask)),
    (URL, _whole(_mask_url)),
)
_STEPS: Final[tuple[tuple[_Search, _Rule], ...]] = (
    *_EMAIL_AND_URL_STEPS,
    *_PHONE_STEPS,
    (PLATFORM_HANDLE, _whole(_mask_handle)),
    _REVERSE_HANDLE_STEP,
    (AT_HANDLE, _whole(_mask)),
    (CASHTAG, _whole(_mask)),
    *_ADDRESS_STEPS,
    (UNIT_OR_BOX, _whole(_mask)),
)
# The rules with a literal TLD or provider list run first on the text without its marks: a
# mark glued inside "gmail" or "com" splits the literal ("gmail.c" + U+0483 + "om", "jose at
# gm" + U+0483 + "ail", #240), and the mark class after every letter of the lists would make
# the patterns hundreds of kilobytes. The run on the text as it is follows and keeps what only
# the marks make a contact. Only a text with a mark pays for the extra run.
_UNMARKED_FIRST: Final[frozenset[_Search]] = frozenset(
    {PLAIN_EMAIL, SPACED_EMAIL, _SPELLED_EMAILS, PROVIDER_EMAIL, URL, _SPELLED_URLS}
)


# --- Known values ----------------------------------------------------------------------------
# Patterns cannot foresee every way people write a contact, so the values known for a request
# (the customer's account email and phone, the address lines) are masked first, whatever their
# formatting. The email and phone patterns are built from one value, with bounded gaps, so they
# stay linear; the address is a token scan.

_KNOWN_AT: Final = r"(?:\s*@\s*|\s*[(\[{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+(?:at|arroba)\s+)"
_KNOWN_DOT: Final = r"(?:\s*\.\s*|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+)"
_PHONE_GAP: Final = r"[^\d]{0,3}"  # up to three non-digits between two digits of the number
# A street suffix and its usual abbreviations, and the directions, for the known street.
_SUFFIX_GROUPS: Final = (
    ("street", "st", "str"),
    ("avenue", "ave", "av"),
    ("road", "rd"),
    ("drive", "dr", "drv"),
    ("boulevard", "blvd", "boul"),
    ("lane", "ln"),
    ("court", "ct"),
    ("place", "pl"),
    ("terrace", "ter", "terr"),
    ("way", "wy"),
    ("circle", "cir"),
    ("highway", "hwy"),
    ("parkway", "pkwy"),
    ("trail", "trl"),
    ("cove", "cv"),
    ("loop", "lp"),
    ("point", "pt"),
    ("square", "sq"),
    ("plaza", "plz"),
    ("causeway", "cswy"),
    ("expressway", "expy"),
)
_DIRECTION_GROUPS: Final = (
    ("n", "north"),
    ("s", "south"),
    ("e", "east"),
    ("w", "west"),
    ("ne", "northeast"),
    ("nw", "northwest"),
    ("se", "southeast"),
    ("sw", "southwest"),
)
# The known street and unit are found by a scan over word pieces, not by patterns (#172
# round 6): a pattern built from a stored line backtracks when the line repeats its parts. The
# scan reads each piece once and, at a house number only, at most _KNOWN_WINDOW pieces around
# it: O(pieces x window), whatever the stored line.
_KNOWN_WINDOW: Final = 6
# A piece: letters and digits only, or "#". What stands between two pieces (spaces, a period, a
# slash, an apostrophe...) is judged by the scan, never glued into a piece, so "Evergreen.Need",
# "Evergreen's", "Dir.742" and "Apt.4B" still show their parts.
_KNOWN_PIECE: Final = re.compile(r"[^\W_]+|#")
# Every form of a direction or a suffix, mapped to one: "northwest" is "nw", "terrace" is "ter".
_KNOWN_CANONICAL: Final[dict[str, str]] = {
    form: group[0] for groups in (_SUFFIX_GROUPS, _DIRECTION_GROUPS) for group in groups
    for form in group
}  # fmt: skip
_KNOWN_SUFFIXES: Final = frozenset(group[0] for group in _SUFFIX_GROUPS)
_KNOWN_DIRECTIONS: Final = frozenset(group[0] for group in _DIRECTION_GROUPS)
_KNOWN_PLACE_WORDS: Final = _KNOWN_SUFFIXES | _KNOWN_DIRECTIONS
# Every form of a direction or suffix as typed ("northwest", "nw", "terrace", "ter"), to find
# them glued to a name word: "nwmain", "evergreenter" (#172 round 8). Single letters are left
# out: "evergreens" is a plural, not "evergreen" + "s".
_KNOWN_FORMS: Final = frozenset(form for form in _KNOWN_CANONICAL if len(form) >= 2)
# The longest piece searched for glued words: a few words, never a whole run of text.
_KNOWN_MAX_GLUED: Final = 40
_KNOWN_UNIT_WORDS: Final = frozenset(
    {"apartment", "apartamento", "apto", "apt", "departamento", "depto", "unidad", "unit",
     "suite", "ste", "lot", "bldg"}
)  # fmt: skip
_KNOWN_NUMBER_MARKS: Final = frozenset({"#", "no", "nro", "num", "numero", "number"})
# Short words inside a street's name that are everyday words too ("Avenue of the Americas",
# "Calle de la Paz"): passable, never the name word a match needs.
_KNOWN_FUNCTION_WORDS: Final = frozenset(
    {"of", "the", "and", "at", "de", "la", "las", "los", "el", "del", "y"}
)
# What may stand between the house number and the first name word (and, when the name comes
# first, the street's other name words: "Martin Luther King 45").
_KNOWN_SKIPPABLE: Final = (
    _KNOWN_PLACE_WORDS | _KNOWN_UNIT_WORDS | _KNOWN_NUMBER_MARKS | _KNOWN_FUNCTION_WORDS
)


@dataclass(frozen=True)
class KnownValues:
    """A party's own contact details, masked before the patterns run: the customer's in their
    request shown to pros (#172), the pro's in their quote shown to the customer (#188). PII:
    never logged or returned."""

    emails: tuple[str, ...] = ()
    phones: tuple[str, ...] = ()
    streets: tuple[str, ...] = ()  # the address lines: the street (line1) and the unit (line2)


def redact_known(text: str, known: KnownValues) -> RedactionResult:
    """`text` with the known values masked, in any spacing, case or punctuation."""
    cleaned = _clean(text)
    masked = 0
    for pattern in _known_patterns(known):
        cleaned, count = _substitute(pattern, _mask, cleaned)
        masked += count
    cleaned, count = _mask_spans(cleaned, _known_spans(cleaned, known.streets))
    return RedactionResult(cleaned, masked + count > 0)


def redact_text(text: str, known: KnownValues) -> RedactionResult:
    """Both passes: the known values first, then every pattern of redact_contacts."""
    first = redact_known(text, known)
    second = redact_contacts(first.text)
    return RedactionResult(second.text, first.redacted or second.redacted)


def _known_patterns(known: KnownValues) -> list[re.Pattern[str]]:
    """The email and phone patterns; the address is a token scan (_known_spans)."""
    sources = [
        *(_email_pattern(email) for email in known.emails),
        *(_phone_pattern(phone) for phone in known.phones),
    ]
    return [re.compile(source, _FLAGS) for source in sources if source]


def _email_pattern(email: str) -> str | None:
    email = email.strip()
    if email.count("@") != 1:
        return None
    local, domain = email.split("@")

    def dotted(part: str) -> str:
        return _KNOWN_DOT.join(re.escape(piece) for piece in part.split(".") if piece)

    full = rf"(?<![\w.+-]){dotted(local)}{_KNOWN_AT}{dotted(domain)}(?![\w-])"
    # The local part alone, when it is handle-shaped ("juan.perez77"), names the address too.
    if re.search(r"[\d._]", local) and len(local) >= 5:
        return rf"{full}|(?<![\w.+-]){re.escape(local)}(?![\w-])"
    return full


def _phone_pattern(phone: str) -> str | None:
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) < 7:
        return None
    # An opening bracket belongs to the number: "(305)555-0199".
    core = r"[(\[]?" + _PHONE_GAP.join(digits)
    if len(digits) == 10:  # a US number: +1, 1, 001 or 011 may come first
        prefix = rf"(?:(?:(?:\+|00|011)\s*)?1{_PHONE_GAP})?"
    else:
        prefix = r"(?:(?:\+|00|011)\s*)?"
    return rf"(?<!\d){prefix}{core}(?!\d)"


def _known_spans(text: str, lines: tuple[str, ...]) -> list[tuple[int, int]]:
    """Where the known street (line1) and unit (line1's unit, line2) are in `text`."""
    tokens = _known_tokens(text)
    spans: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        street, units = _parse_known_line(line, street_line=index == 0)
        if street is not None:
            spans += _street_spans(text, tokens, street)
        for unit in units:
            spans += _unit_spans(text, tokens, unit)
    return spans


@dataclass(frozen=True)
class _KnownToken:
    key: str  # casefolded, without accents, directions and suffixes in their canonical form
    start: int
    end: int


def _known_tokens(text: str) -> list[_KnownToken]:
    return [
        _KnownToken(_known_key(match.group()), match.start(), match.end())
        for match in _KNOWN_PIECE.finditer(text)
    ]


def _known_key(piece: str) -> str:
    decomposed = unicodedata.normalize("NFKD", piece.casefold())
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    return _KNOWN_CANONICAL.get(plain, plain)


@dataclass(frozen=True)
class _KnownStreet:
    house: str | None  # the house number's digits; None for a line without one
    letter: str | None  # "123A", "123-A" or "123 A"
    range_end: str | None  # "12-14"
    fraction: tuple[str, str] | None  # "123 1/2"
    names: tuple[str, ...]  # in order; the first is the one a match needs
    suffixes: frozenset[str]


def _house_parts(key: str) -> tuple[str, str | None] | None:
    """("123", "a") for "123a", ("742", None) for "742"; None for anything else."""
    if key.isdigit() and len(key) <= 6:
        return key, None
    if 2 <= len(key) <= 7 and key[:-1].isdigit() and key[-1].isalpha():
        return key[:-1], key[-1]
    return None


def _known_words(text: str, tokens: list[_KnownToken]) -> list[tuple[str, int, int]]:
    """The stored line's words: (key, first piece, last piece). Pieces joined by an apostrophe
    are one word ("O'Brien" is "obrien")."""
    words: list[tuple[str, int, int]] = []
    for index, token in enumerate(tokens):
        joined = index > 0 and _is_apostrophe(text[tokens[index - 1].end : token.start])
        if joined and words:
            key, first, _ = words[-1]
            words[-1] = (key + token.key, first, index)
        else:
            words.append((token.key, index, index))
    return words


def _parse_known_line(line: str, *, street_line: bool) -> tuple[_KnownStreet | None, list[str]]:
    """The street and the unit ids of a stored address line. On the street line, each part is
    found anywhere: units ("Apt 4B", "#12") before or after the street; the house number (the
    first number outside a unit; a "#742" only when it is the only one); the name words, after
    the number, or before it in "Evergreen Ter 742" (words before the number are otherwise a
    building's name). The unit line is a unit id, with or without its unit word."""
    cleaned = _clean(line)
    tokens = _known_tokens(cleaned)
    words = _known_words(cleaned, tokens)
    keys = [word[0] for word in words]
    if not street_line:
        unit = "".join(k for k in keys if k not in _KNOWN_UNIT_WORDS | _KNOWN_NUMBER_MARKS)
        return None, [unit] if unit else []

    def gap(left: int, right: int) -> str:
        return cleaned[tokens[words[left][2]].end : tokens[words[right][1]].start]

    in_unit: set[int] = set()
    for index, key in enumerate(keys):
        if key in _KNOWN_UNIT_WORDS:
            after = index + 1
            while after < len(keys) and keys[after] in _KNOWN_NUMBER_MARKS:
                after += 1
            in_unit |= set(range(index, min(after + 1, len(keys))))
    hashed = {i + 1 for i, k in enumerate(keys) if k == "#" and i + 1 < len(keys)} - in_unit
    numbers = [i for i, k in enumerate(keys) if i not in in_unit and _house_parts(k)]
    plain = [i for i in numbers if i not in hashed]
    house_at = plain[0] if plain else (numbers[0] if numbers else None)
    in_unit |= {i for n in hashed if n != house_at for i in (n - 1, n)}
    units = _unit_ids(keys, in_unit)
    house = letter = range_end = None
    fraction: tuple[str, str] | None = None
    if house_at is None:
        rest = [i for i in range(len(keys)) if i not in in_unit]
    else:
        parts = _house_parts(keys[house_at])
        assert parts is not None  # noqa: S101 - house_at indexes a house number
        house, letter = parts
        rest = [i for i in range(house_at + 1, len(keys)) if i not in in_unit]
        nxt = house_at + 1
        if rest and rest[0] == nxt:
            between = gap(house_at, nxt).strip()
            if (
                nxt + 1 < len(keys)
                and keys[nxt].isdigit()
                and keys[nxt + 1].isdigit()
                and gap(nxt, nxt + 1) == "/"
            ):
                fraction, rest = (keys[nxt], keys[nxt + 1]), rest[2:]  # "123 1/2"
            elif keys[nxt].isdigit() and between == "-":
                range_end, rest = keys[nxt], rest[1:]  # "12-14"
            elif (
                len(keys[nxt]) == 1
                and keys[nxt].isalpha()
                and keys[nxt] not in _KNOWN_DIRECTIONS
                and not letter
            ):
                letter, rest = keys[nxt], rest[1:]  # "123 A Main", not "100 N Main"
        if not rest:
            rest = [i for i in range(house_at) if i not in in_unit]
    text_words = [
        keys[i] for i in rest if keys[i] not in _KNOWN_NUMBER_MARKS | _KNOWN_FUNCTION_WORDS
    ]
    names = [w for w in text_words if w not in _KNOWN_PLACE_WORDS]
    # A street named by a direction or a suffix word ("100 North Street", "5 Court St").
    names = names or [w for w in text_words if w not in _KNOWN_SUFFIXES] or text_words[:1]
    suffixes = frozenset(w for w in text_words if w in _KNOWN_SUFFIXES)
    if not names or (house is None and not suffixes and len(names) < 2):
        # Without a number, the whole name and a suffix, or two name words, are needed.
        return None, units
    street = _KnownStreet(house, letter, range_end, fraction, tuple(names[:5]), suffixes)
    return street, units


def _unit_ids(keys: list[str], in_unit: set[int]) -> list[str]:
    """Each run of unit words, as its id: "Apt 4B" is "4b", "#12" is "12"."""
    ids: list[str] = []
    run: list[str] = []
    for index in range(len(keys) + 1):
        if index in in_unit:
            run.append(keys[index])
            continue
        unit = "".join(k for k in run if k not in _KNOWN_UNIT_WORDS | _KNOWN_NUMBER_MARKS)
        if unit:
            ids.append(unit)
        run = []
    return ids


def _between(text: str, tokens: list[_KnownToken], left: int, right: int) -> str:
    return text[tokens[left].end : tokens[right].start]


def _is_apostrophe(gap: str) -> bool:
    return len(gap) == 1 and gap in _APOSTROPHES


def _standalone(text: str, tokens: list[_KnownToken], index: int, street: _KnownStreet) -> bool:
    """A direction or suffix piece that is a word of the address. Glued to the next piece by
    punctuation alone ("ter.742", "nw/main", "n.w"), it is when that piece belongs to the
    address too (a direction, a suffix, a name word, the house number, "#"); otherwise it is
    part of something else: the "w" of "w/2", the "e" of "e.g.", the "n" of "n/a". Before a
    space, a slash makes it "w/" ("w/ 2 seals"). After an apostrophe it is the "s" of
    "Evergreen's"."""
    if index > 0 and _is_apostrophe(_between(text, tokens, index - 1, index)):
        return False
    end = tokens[index + 1].start if index + 1 < len(tokens) else len(text)
    after = text[tokens[index].end : end]
    glued = after.split(maxsplit=1)[0] if after and not after[0].isspace() else ""
    if not glued:
        return True
    if any(_is_apostrophe(char) for char in glued):
        return False
    if glued == after and index + 1 < len(tokens):  # punctuation alone up to the next piece
        return _address_piece(tokens[index + 1].key, street)
    return "/" not in glued


def _joinable(street: _KnownStreet) -> frozenset[str]:
    """The pieces an address word may be glued to by punctuation alone."""
    house: set[str] = set()
    if street.house is not None:
        house.add(street.house)
        if street.letter:
            house.add(street.house + street.letter)
    return _KNOWN_PLACE_WORDS | frozenset(street.names) | frozenset(house) | {"#"}


def _address_piece(key: str, street: _KnownStreet) -> bool:
    """A piece of the street: a word of it, its house number, "#", or its words glued together
    ("stnw", "lutherking", "oceanblvd")."""
    return (
        key in _joinable(street)
        or _splits_into(key, _KNOWN_FORMS | frozenset(street.names))
        or _glued_name(key, street)
    )


def _splits_into(text: str, words: frozenset[str]) -> bool:
    """`text` is empty, or a run of `words` with nothing between them ("stnw" is st + nw)."""
    if len(text) > _KNOWN_MAX_GLUED:
        return False
    reachable = [True] + [False] * len(text)
    for end in range(1, len(text) + 1):
        reachable[end] = any(reachable[start] and text[start:end] in words for start in range(end))
    return reachable[len(text)]


def _glued_name(key: str, street: _KnownStreet) -> bool:
    """A piece holding the first name word with directions or suffixes glued before it, and the
    street's further words glued after it ("nwmain", "evergreenter", "martinluther")."""
    name = street.names[0]
    if key == name or len(key) > _KNOWN_MAX_GLUED:
        return False
    after_words = frozenset(street.names) | _KNOWN_FORMS
    start = key.find(name)
    while start != -1:
        before, after = key[:start], key[start + len(name) :]
        if _splits_into(before, _KNOWN_FORMS) and _splits_into(after, after_words):
            return True
        start = key.find(name, start + 1)
    return False


def _house_end(
    text: str, tokens: list[_KnownToken], index: int, street: _KnownStreet
) -> int | None:
    """The last piece of the street's house number when it starts at `index`; None when the
    piece is not that number, or is joined to another digit by a period, a comma or a slash
    ("742.5", "1,742", "742/12"): the only guard on the number. Letters and punctuation next
    to it are fine ("ter.742", "#742", "No.742")."""
    assert street.house is not None  # noqa: S101 - only called for a street with a number
    key = tokens[index].key
    for neighbour in (index - 1, index + 1):
        if 0 <= neighbour < len(tokens) and tokens[neighbour].key.isdigit():
            left, right = sorted((index, neighbour))
            if _between(text, tokens, left, right) in (".", ",", "/"):  # 742.5, 1,742, 742/12
                return None
    if street.letter and key == street.house + street.letter:
        return index
    if key != street.house:
        return None
    nxt = index + 1
    if nxt >= len(tokens):
        return index
    gap = _between(text, tokens, index, nxt).strip()
    if street.letter and tokens[nxt].key == street.letter and gap in ("", "-"):
        return nxt
    if street.range_end and tokens[nxt].key == street.range_end and gap == "-":
        return nxt
    if (
        street.fraction
        and nxt + 1 < len(tokens)
        and gap == ""
        and (tokens[nxt].key, tokens[nxt + 1].key) == street.fraction
        and _between(text, tokens, nxt, nxt + 1) == "/"
    ):
        return nxt + 1
    return index


def _word_at(text: str, tokens: list[_KnownToken], index: int, word: str, step: int) -> int | None:
    """The far piece of `word` when it starts (step 1) or ends (step -1) at `index`, its pieces
    joined by apostrophes ("O'Brien", "OBrien")."""
    collected, current = "", index
    for _ in range(4):
        piece = tokens[current].key
        collected = collected + piece if step > 0 else piece + collected
        if collected == word:
            return current
        if not word.startswith(collected) if step > 0 else not word.endswith(collected):
            return None
        nxt = current + step
        if not 0 <= nxt < len(tokens):
            return None
        left, right = sorted((current, nxt))
        if not _is_apostrophe(_between(text, tokens, left, right)):
            return None
        current = nxt
    return None


def _apostrophe_run(text: str, tokens: list[_KnownToken], index: int, step: int) -> tuple[str, int]:
    """The pieces joined by apostrophes from `index` in direction `step` ("o'brienrd"), as one
    key, and the far piece."""
    key, current = tokens[index].key, index
    for _ in range(3):
        nxt = current + step
        if not 0 <= nxt < len(tokens):
            break
        left, right = sorted((current, nxt))
        if not _is_apostrophe(_between(text, tokens, left, right)):
            break
        key = key + tokens[nxt].key if step > 0 else tokens[nxt].key + key
        current = nxt
    return key, current


def _street_spans(
    text: str, tokens: list[_KnownToken], street: _KnownStreet
) -> list[tuple[int, int]]:
    """At each house number: the first name word within the window after it ("742 nw
    evergreen"), or before it ("Evergreen Ter 742"); then the street's further words. A street
    without a number: its whole name, in order, and its suffix."""
    if street.house is None:
        return _whole_name_spans(text, tokens, street)
    spans: list[tuple[int, int]] = []
    for index in range(len(tokens)):
        end = _house_end(text, tokens, index, street)
        if end is None:
            continue
        found = _find_name(text, tokens, end, 1, street)
        if found is not None:
            last = _extend(text, tokens, found, 1, street)
            spans.append((tokens[index].start, tokens[last].end))
            continue
        found = _find_name(text, tokens, index, -1, street)
        if found is not None:
            first = _extend(text, tokens, found, -1, street)
            spans.append((tokens[first].start, tokens[end].end))
    return spans


def _find_name(
    text: str, tokens: list[_KnownToken], house: int, step: int, street: _KnownStreet
) -> int | None:
    """The far piece of the first name word within _KNOWN_WINDOW pieces of the house number,
    in direction `step`, across directions, suffixes, unit words, number marks and function
    words only (and, before the number, the street's other name words). Whatever punctuation
    stands between pieces is ignored (#172 round 7): for the customer's own address, masking a
    few words more across a sentence costs little, and a leak costs much ("evergreen No. 742",
    "evergreen ter. 742", "123 n.w., main"). The distance and the exact number are the limits."""
    passable = _KNOWN_SKIPPABLE | (frozenset(street.names) if step < 0 else frozenset())
    current = house
    for _ in range(_KNOWN_WINDOW):
        candidate = current + step
        if not 0 <= candidate < len(tokens):
            return None
        found = _word_at(text, tokens, candidate, street.names[0], step)
        if found is not None:
            return found
        key = tokens[candidate].key
        glued_key, far = _apostrophe_run(text, tokens, candidate, step)
        if _glued_name(glued_key, street):  # "evergreenter", "nwmain", "o'brienrd"
            return far
        # A direction glued to the name by a period ("123 N.Main") is still a direction.
        glued_to_name = (
            step > 0
            and candidate + 1 < len(tokens)
            and _between(text, tokens, candidate, candidate + 1) == "."
            and tokens[candidate + 1].key == street.names[0]
        )
        # Words glued together: "stnw"; before the number, the other names too ("lutherking").
        glue_words = _KNOWN_FORMS | (frozenset(street.names) if step < 0 else frozenset())
        glued_forms = key not in passable and _splits_into(key, glue_words)
        if (key not in passable and not glued_forms) or (
            key in _KNOWN_PLACE_WORDS
            and not glued_to_name
            and not _standalone(text, tokens, candidate, street)
        ):
            return None
        current = candidate
    return None


def _extend(
    text: str, tokens: list[_KnownToken], start: int, step: int, street: _KnownStreet
) -> int:
    """From the name word, over the street's further words, at most _KNOWN_WINDOW of them."""
    words = frozenset(street.names) | street.suffixes | _KNOWN_DIRECTIONS
    current = start
    for _ in range(_KNOWN_WINDOW):
        candidate = current + step
        if not 0 <= candidate < len(tokens) or tokens[candidate].key not in words:
            break
        if tokens[candidate].key in _KNOWN_PLACE_WORDS and not _standalone(
            text, tokens, candidate, street
        ):
            break
        current = candidate
    return current


def _whole_name_spans(
    text: str, tokens: list[_KnownToken], street: _KnownStreet
) -> list[tuple[int, int]]:
    """A stored street without a house number ("Evergreen Terrace"): every name word in order,
    then a suffix when the line has one."""
    spans: list[tuple[int, int]] = []
    for index in range(len(tokens)):
        current = _word_at(text, tokens, index, street.names[0], 1)
        for name in street.names[1:]:
            if current is None or current + 1 >= len(tokens):
                current = None
                break
            current = _word_at(text, tokens, current + 1, name, 1)
        if current is None:
            continue
        if street.suffixes:
            nxt = current + 1
            if nxt >= len(tokens) or tokens[nxt].key not in street.suffixes:
                continue
            current = nxt
        spans.append((tokens[index].start, tokens[_extend(text, tokens, current, 1, street)].end))
    return spans


def _unit_spans(text: str, tokens: list[_KnownToken], unit: str) -> list[tuple[int, int]]:
    """The unit id right after a unit word or "#" ("apt 4-b", "Apt.4B", "unit #4B", "Apt No.
    4B"): alone, an id is an everyday number or word ("12 outlets", "2 A/C")."""
    spans: list[tuple[int, int]] = []
    for index, token in enumerate(tokens):
        glued_word = next((w for w in _KNOWN_UNIT_WORDS if token.key == w + unit), None)
        if glued_word is not None:  # "apt4b"
            spans.append((token.start, token.end))
            continue
        if token.key not in _KNOWN_UNIT_WORDS and token.key != "#":
            continue
        first = index + 1
        while (
            token.key != "#"
            and first < len(tokens)
            and first - index <= 2
            and tokens[first].key in _KNOWN_NUMBER_MARKS
        ):
            first += 1
        collected = ""
        for position in range(first, min(first + 4, len(tokens))):
            gap = _between(text, tokens, position - 1, position).strip()
            allowed = ("", ".", ":", "#", "-") if position == first else ("", "-")
            if gap not in allowed and not (position == first and gap in (".:", ":#", ".#")):
                break
            collected += tokens[position].key
            if collected == unit:
                spans.append((token.start, tokens[position].end))
                break
            if not unit.startswith(collected):
                break
    return spans


def _mask_spans(text: str, spans: list[tuple[int, int]]) -> tuple[str, int]:
    """`text` with each span (merged when they overlap or touch) replaced by the mask."""
    pieces: list[str] = []
    position = count = 0
    for start, end in sorted(spans):
        if count and start <= position:  # overlaps or touches the previous mask: extend it
            if end > position:
                position = end
            continue
        pieces += [text[position:start], MASK]
        position = end
        count += 1
    pieces.append(text[position:])
    return "".join(pieces), count
