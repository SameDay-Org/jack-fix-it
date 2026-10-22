"""Masking contact details in free text (#172 now, chat #72 later): one shared redactor.

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
with lowercase or function-word names, and text inside images (#173 handles media). A 10-digit
order or serial number is masked like a phone: hiding a number is the safe side.

The patterns are data in this module; it does no I/O and keeps no state. Every pattern is
anchored so a 2,000-character input (the description limit) is handled in milliseconds.
"""

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

MASK: Final = "•••"

_FLAGS: Final = re.IGNORECASE
_APOSTROPHES: Final = "'" + chr(0x2019)

# --- Cleaning --------------------------------------------------------------------------------
# Characters dropped before matching: format characters (zero-width spaces, joiners, soft
# hyphen, bidi controls; Unicode category Cf), enclosing marks such as the keycap (Me), and a
# few fillers.
_FILLERS: Final = frozenset(
    chr(code) for code in (0x034F, 0x115F, 0x1160, 0x3164, *range(0xFE00, 0xFE10))
)
# Characters folded to their ASCII form (NFKC) when that form is one ASCII letter, digit or one
# of "@.-/()": fullwidth forms, mathematical letters and digits, circled digits. Superscript
# and subscript digits only in a run of three or more ("call ³⁰⁵..."), so "ft²" stays.
_FOLDABLE: Final = re.compile(r"[a-zA-Z0-9@.\-/()]")
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
_DASH_CODES: Final = (*range(0x2010, 0x2016), 0x2212, 0xFE58, 0xFE63, 0xFF0D)
_DASHES: Final = re.compile("[" + "".join(map(chr, _DASH_CODES)) + "]")

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
_START: Final = r"(?<![\w.%+@-])"  # never start inside a word or a dotted chain
# Possessive, so a long dotted chain is never re-split; Unicode letters too ("josé.pérez").
_LOCAL: Final = r"[\w+][\w.%+-]*+"  # any valid start: "_jane", "__x", "+tag"
_AT: Final = r"(?:\s*@\s*|\s*[(\[{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+(?:at|arroba|en)\s+)"
_STRONG_AT: Final = r"(?:\s*@\s*|\s*[(\[{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+arroba\s+)"
_SPELLED_DOT: Final = r"(?:\.|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+)"
_ONLY_SPELLED_DOT: Final = r"(?:\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+)"
PLAIN_EMAIL: Final = re.compile(
    rf"{_START}{_LOCAL}@[a-z0-9-]++(?:[.,][a-z0-9-]++)*?[.,][a-z]{{2,}}\b", _FLAGS
)
SPACED_EMAIL: Final = re.compile(
    rf"{_START}{_LOCAL}\s*@\s*[a-z0-9-]++(?:\s*\.\s*[a-z0-9-]++)*?\s*\.\s*{_TLD_END}", _FLAGS
)
# "maria at gmail dot com", "juan dot perez at gmail dot com", "jane (at) outlook.com". With a
# bare " at " and a plain dot, the local part may not be a common word ("it at Amazon.com").
SPELLED_EMAIL: Final = re.compile(
    rf"{_START}(?P<local>{_LOCAL}(?:{_ONLY_SPELLED_DOT}[a-z0-9_-]++)*)"
    rf"(?P<at>{_AT})[a-z0-9-]++(?:{_SPELLED_DOT}[a-z0-9-]++)*?(?P<dot>{_SPELLED_DOT})"
    rf"(?P<tld>{_TLD_END})",
    _FLAGS,
)
# A provider with no TLD, or with a TLD typed loosely ("gmail com", "gmailcom", "gmail,com").
PROVIDER_EMAIL: Final = re.compile(
    rf"{_START}(?P<local>{_LOCAL})(?P<at>{_AT}){_PROVIDERS}"
    rf"(?:\s*[.,]?\s*(?:dot\s+|punto\s+)?(?:com|net|es|mx)\b)?",
    _FLAGS,
)
# "local@word" glued, whatever comes next: an address with its domain cut short.
GLUED_EMAIL: Final = re.compile(rf"{_START}[^\W\d_]{_LOCAL}@[a-z][a-z0-9-]++\b", _FLAGS)
# An email typed letter by letter: "j a n e @ g m a i l . c o m".
SPACED_LETTERS_EMAIL: Final = re.compile(
    r"(?<!\S)(?:[a-z0-9]\s){2,40}@\s(?:[a-z0-9]\s?){2,40}(?:\.\s?(?:[a-z]\s?){2,6})?", _FLAGS
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
_DOMAIN_START: Final = r"(?<![\w.@-])"
URL: Final = re.compile(
    rf"(?:https?://|\bwww\s*\.\s*)\S+"
    rf"|{_DOMAIN_START}[a-z0-9][a-z0-9-]*+(?:\.[a-z0-9-]++)*?\.[a-z]{{2,}}/\S*"
    rf"|{_DOMAIN_START}[a-z0-9][a-z0-9-]*+(?:\.[a-z0-9-]++)*?\.(?P<tld>{_TLD_END})"
    rf"|{_DOMAIN_START}[a-z0-9][a-z0-9-]{{2,}}\s*\.\s+(?:com|net|org|co|us|io|miami)\b"
    rf"|{_DOMAIN_START}[a-z0-9][a-z0-9-]{{2,}}\s+\.\s*(?:com|net|org|co|us|io|miami)\b"
    rf"|{_DOMAIN_START}[a-z0-9-]{{2,}}(?:\s+(?:dot|punto)\s+[a-z0-9-]+)*\s+(?:dot|punto)\s+"
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
    r"(?P<id>[@$]?[^\W_][\w.-]{1,29})(?![\w])",
    _FLAGS,
)
# A handle written before its platform: "j.doe.fixit (insta)". The token is possessive and its
# shape is checked in _mask_reverse_handle, so a long dotted chain costs one pass.
REVERSE_HANDLE: Final = re.compile(
    rf"(?<![\w@.])(?P<id>[^\W_][\w.]*+)\s*[(\[]?\s*(?:on\s+|en\s+)?{_STRONG_PLATFORMS}\b",
    _FLAGS,
)
# Words that follow "insta is" in ordinary sentences, so are not an id.
_NOT_AN_ID: Final = frozenset(
    {"fine", "ok", "okay", "good", "great", "better", "best", "easier", "faster", "down", "not",
     "free", "working", "broken", "the", "a", "my", "your", "private", "public", "new", "old",
     "bien", "mejor", "gratis", "privado", "privada", "nuevo", "nueva", "empty", "gone"}
)  # fmt: skip
# "@name" and "$cashtag", but not "@5pm", "@noon", "@home", "@tomorrow", a price or a currency.
AT_HANDLE: Final = re.compile(
    r"(?<![\w.@])@(?:\s(?=[\w.-]*[\d_.]))?(?!\d{1,2}(?::\d\d)?\s*(?:[ap]\.?m\.?)?\b|"
    r"\d+\s*(?:ft|in|cm|mm|m|hrs?|h|mins?|hours?)\b|"
    r"(?:noon|night|home|work|casa|today|tomorrow|tonight|ma(?:ñ|n)ana)\b)"
    r"[a-z0-9_](?:[a-z0-9_.-]{0,28}[a-z0-9_])?",
    _FLAGS,
)
CASHTAG: Final = re.compile(r"(?<![\w$])\$(?!(?-i:[A-Z]{3})\b)[a-z][a-z0-9_-]{1,19}\b", _FLAGS)

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


@dataclass(frozen=True)
class RedactionResult:
    text: str
    redacted: bool  # True when at least one contact detail was masked


def redact_contacts(text: str) -> RedactionResult:
    """`text` with every contact detail it recognizes replaced by MASK (see the module doc)."""
    cleaned = _clean(text)
    masked = 0
    for pattern, replace in _STEPS:
        cleaned, count = _substitute(pattern, replace, cleaned)
        masked += count
    return RedactionResult(cleaned, masked > 0)


def _clean(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    chars: list[str] = []
    for index, char in enumerate(text):
        category = unicodedata.category(char)
        if category in ("Cf", "Me") or char in _FILLERS:
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


def _substitute(pattern: re.Pattern[str], replace: _Replace, text: str) -> tuple[str, int]:
    """Like pattern.sub, but a kept match only skips one character, so a contact that starts
    inside it is still found ("fix 2 doors 1250 Ocean Dr")."""
    pieces: list[str] = []
    position, count = 0, 0
    search_from = 0
    while (match := pattern.search(text, search_from)) is not None:
        replacement = replace(match)
        if replacement is None:
            search_from = match.start() + 1
            continue
        pieces += [text[position : match.start()], replacement]
        count += replacement.count(MASK)
        position = search_from = max(match.end(), match.start() + 1)
    pieces.append(text[position:])
    return "".join(pieces), count


def _mask(match: re.Match[str]) -> str | None:
    return MASK


def _missing_space(match: re.Match[str], tld: str) -> bool:
    """ "cooling.Me and my wife": a word TLD, capitalized, right after a lowercase letter."""
    start = match.start("tld")
    before = match.string[start - 2] if start >= 2 else ""
    return tld.lower() in _WORD_TLDS and tld[0].isupper() and not tld.isupper() and before.islower()


def _mask_url(match: re.Match[str]) -> str | None:
    tld = match.group("tld")
    if tld is not None and _missing_space(match, tld):
        return None
    return MASK


def _mask_spelled_email(match: re.Match[str]) -> str | None:
    weak_at = re.fullmatch(r"\s+(?:at|en)\s+", match.group("at"), _FLAGS) is not None
    if weak_at and match.group("local").lower() in _COMMON_WORDS:
        return None  # "it at Amazon.com", "work at BestPools.com"
    if match.group("dot") == "." and _missing_space(match, match.group("tld")):
        return None  # "is at home.Me and my wife"
    return MASK


def _mask_provider_email(match: re.Match[str]) -> str | None:
    weak_at = re.fullmatch(r"\s+(?:at|en)\s+", match.group("at"), _FLAGS) is not None
    if weak_at and match.group("local").lower() in _COMMON_WORDS:
        return None  # "photos are at iCloud", "I work at Yahoo"
    return MASK


def _handle_shaped(handle: str) -> bool:
    if handle[0] == "@":
        return True
    if handle[0] == "$":
        return re.match(r"\$[^\W\d_]", handle) is not None  # "$jdoe", not "$150"
    has_letter = re.search(r"[^\W\d_]", handle) is not None
    return has_letter and re.search(r"[\d_.]", handle) is not None


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


def _phones(match: re.Match[str]) -> str | None:
    """Masks every phone-shaped window of digit groups in one digit run. Returns the run itself
    when it holds no phone, so the scan moves past it (it was analyzed whole)."""
    run = match.group(0)
    if _glued_to_a_code(match) or _DOTTED_QUAD.fullmatch(run.strip("()[]")):
        return run
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
        spans.append((begin, groups[end - 1].end()))
        start = end
    if not spans:
        return run
    pieces, cursor = [], 0
    for begin, finish in spans:
        pieces += [run[cursor:begin], MASK]
        cursor = finish
    pieces.append(run[cursor:])
    return "".join(pieces)


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
# digit, so a later pattern never matches inside an earlier mask.
_STEPS: Final[tuple[tuple[re.Pattern[str], _Replace], ...]] = (
    (SPACED_LETTERS_EMAIL, _mask),
    (PLAIN_EMAIL, _mask),
    (SPACED_EMAIL, _mask),
    (SPELLED_EMAIL, _mask_spelled_email),
    (PROVIDER_EMAIL, _mask_provider_email),
    (GLUED_EMAIL, _mask),
    (URL, _mask_url),
    (SPELLED_PHONE, _mask),
    (DIGIT_RUN, _phones),
    (PLATFORM_HANDLE, _mask_handle),
    (REVERSE_HANDLE, _mask_reverse_handle),
    (AT_HANDLE, _mask),
    (CASHTAG, _mask),
    (STREET, _mask_street),
    (REVERSED_STREET, _mask_reversed_street),
    (GRID_OR_HIGHWAY, _mask),
    (SPANISH_STREET, _mask),
    (UNIT_OR_BOX, _mask),
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
    """A customer's own contact details for one request, masked before the patterns run. PII:
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


def _standalone(text: str, tokens: list[_KnownToken], index: int) -> bool:
    """A direction or suffix piece that is a word of its own: not the "w" of "w/", the "e" of
    "e.g." or the "s" of "Evergreen's"."""
    if index > 0 and _is_apostrophe(_between(text, tokens, index - 1, index)):
        return False
    after = text[tokens[index].end : tokens[index + 1].start if index + 1 < len(tokens) else None]
    if after.startswith("/") or _is_apostrophe(after):
        return False
    following = tokens[index + 1].key if index + 1 < len(tokens) else ""
    return not (after == "." and following not in _KNOWN_PLACE_WORDS)


def _house_end(
    text: str, tokens: list[_KnownToken], index: int, street: _KnownStreet
) -> int | None:
    """The last piece of the street's house number when it starts at `index`; None when the
    piece is not that number, or is part of a decimal or a thousands group ("2.50", "1,742")."""
    assert street.house is not None  # noqa: S101 - only called for a street with a number
    key = tokens[index].key
    for neighbour in (index - 1, index + 1):
        if 0 <= neighbour < len(tokens) and tokens[neighbour].key.isdigit():
            left, right = sorted((index, neighbour))
            if _between(text, tokens, left, right) in (".", ","):
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
        # A direction glued to the name by a period ("123 N.Main") is still a direction.
        glued_to_name = (
            step > 0
            and candidate + 1 < len(tokens)
            and _between(text, tokens, candidate, candidate + 1) == "."
            and tokens[candidate + 1].key == street.names[0]
        )
        if key not in passable or (
            key in _KNOWN_PLACE_WORDS
            and not glued_to_name
            and not _standalone(text, tokens, candidate)
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
        if tokens[candidate].key in _KNOWN_PLACE_WORDS and not _standalone(text, tokens, candidate):
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
    """`text` with each span (merged when they overlap) replaced by the mask."""
    pieces: list[str] = []
    position = count = 0
    for start, end in sorted(spans):
        if start < position:  # overlaps the previous mask: extend it
            if end > position:
                position = end
            continue
        pieces += [text[position:start], MASK]
        position = end
        count += 1
    pieces.append(text[position:])
    return "".join(pieces), count
