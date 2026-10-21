# Jack Fix It design direction

## Status

- **Decided 2026-10-20 by Cesar.** The mobile app takes the look of the partner deck: lime green
  on deep navy, white rounded "bubble" surfaces, bold headlines. This supersedes the navy +
  orange palette in the context doc.
- **The name stays Jack Fix It.** The deck says "Joe Fix It"; the name does not change.
- **On iPhone the app uses real Liquid Glass** (iOS 26+), on the navigation and controls layer
  only: [ADR 0008](../adr/0008-mobile-visual-language.md).
- **Values are provisional** until #18 delivers the final design system. Tokens are implemented
  in #114 (mobile) and #110 (web).

## Palette

Each hex was sampled with Pillow from a region inside the reference crops in `reference/`: the
per-channel median of a flat area, of the most saturated 20% of pixels for colored glyphs and
fills, or of the darkest 10% for text and shaded edges. A near-white sample is rounded to pure
white. `danger` is the one derived value, because no red in the crops is text-safe.

| Token       | Hex       | Role                                                    | Source                                                                    |
| ----------- | --------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `navy-900`  | `#01172E` | Deep near-black navy: hero and header background        | 02b, phone screen above the panel                                         |
| `navy-700`  | `#0B2D49` | Secondary dark surface: cards and fields on navy        | 02b, rounded panel on the phone screen                                    |
| `green-500` | `#5EB72B` | Lime accent: CTAs, highlights, accent headline words    | 02a, search button                                                        |
| `green-700` | `#308127` | Dark green: text-safe green, links, pressed CTA         | 01a, shaded edge of the numbered circle                                   |
| `white`     | `#FFFFFF` | Bubble surfaces, text on navy                           | 03, search field (`#FDFDFD`)                                              |
| `gray-50`   | `#F7FBFC` | App background                                          | 03, tab bar background                                                    |
| `gray-500`  | `#484F57` | Muted text: supporting lines, captions, placeholders    | 01b, bubble text                                                          |
| `danger`    | `#DF1C2C` | Errors, destructive actions                             | Derived: 04c red (`#E53341`, 4.30:1) darkened in HSL lightness to pass AA |
| `success`   | `#409C2C` | Success icons and status dots (not text)                | 01a, numbered circle                                                      |
| `warning`   | `#EAA745` | Warning fills and badges, always with `navy-900` on top | 03, "Electrical" tile bolt                                                |

Samples that fail AA as text were not used for text: the placeholder gray in 03 (`#92959C`,
3.00:1 on white) and the pill red in 04c (`#E53341`, 4.30:1).

### Contrast

WCAG 2.x relative luminance, `(L1 + 0.05) / (L2 + 0.05)`, computed from the hex values above.
AA for text is ≥ 4.5:1. Icons and status dots need ≥ 3:1 (WCAG 1.4.11).

| Foreground  | Background  | Ratio   | Use                                         | AA text |
| ----------- | ----------- | ------- | ------------------------------------------- | ------- |
| `white`     | `navy-900`  | 18.05:1 | Hero headline and body on navy              | Pass    |
| `white`     | `navy-700`  | 14.13:1 | Text on dark secondary surfaces             | Pass    |
| `green-500` | `navy-900`  | 7.12:1  | Accent headline words on navy               | Pass    |
| `green-500` | `navy-700`  | 5.58:1  | Accent text on dark secondary surfaces      | Pass    |
| `navy-900`  | `green-500` | 7.12:1  | Primary CTA label                           | Pass    |
| `white`     | `green-700` | 4.89:1  | Pressed CTA label                           | Pass    |
| `navy-900`  | `white`     | 18.05:1 | Body text on bubbles                        | Pass    |
| `navy-900`  | `gray-50`   | 17.33:1 | Body text on the app background             | Pass    |
| `gray-500`  | `white`     | 8.30:1  | Muted text on bubbles                       | Pass    |
| `gray-500`  | `gray-50`   | 7.96:1  | Muted text on the app background            | Pass    |
| `green-700` | `white`     | 4.89:1  | Green text and links on bubbles             | Pass    |
| `green-700` | `gray-50`   | 4.69:1  | Green text on the app background            | Pass    |
| `danger`    | `white`     | 4.84:1  | Error text on bubbles                       | Pass    |
| `danger`    | `gray-50`   | 4.64:1  | Error text on the app background            | Pass    |
| `white`     | `danger`    | 4.84:1  | Destructive button label                    | Pass    |
| `navy-900`  | `warning`   | 8.69:1  | Warning badge text                          | Pass    |
| `success`   | `white`     | 3.49:1  | Success icon (non-text, ≥ 3:1)              | Icon    |
| `white`     | `green-500` | 2.53:1  | **Forbidden**                               | Fail    |
| `green-500` | `white`     | 2.53:1  | **Forbidden** as text; decoration only      | Fail    |
| `navy-900`  | `green-700` | 3.69:1  | **Forbidden**: pressed CTA label is white   | Fail    |
| `gray-500`  | `navy-700`  | 1.70:1  | **Forbidden**: on navy, muted text is white | Fail    |

Rules:

- **No white text on `green-500`.** Use `navy-900` on green.
- `green-500`, `success` and `warning` are never text on light surfaces. Green text on light
  surfaces is `green-700`; success text is `green-700`.
- Text on Liquid Glass meets the same AA bar (ADR 0008).

## Shape

- **Radius scale:** `sm` 12, `md` 16, `lg` 24, `xl` 32, `pill` 9999. Inputs and small tiles use
  `sm`/`md`, bubbles `lg`, hero sheets and large panels `xl`. No sharp corners.
- **Continuous corners on iOS** (`borderCurve: 'continuous'`), so radii read as squircles.
- **Bubbles:** content sits on white surfaces with a soft navy-tinted shadow (`navy-900` at low
  opacity, large blur, small y offset), not a hairline border.
- **Pills:** buttons, chips, search fields and status tags.
- **Icon tiles:** circles (status, numbered steps, avatars) or squircles (category tiles).
- **Chat-bubble callouts:** white bubbles with a small tail for tips and prompts, as in 01 and 04.
- **Spacing:** 4-pt grid.

## Type

- **Display:** a heavy geometric sans (800–900 weight) for headlines, as in the deck. Short
  headlines may set one key word in `green-500` on navy.
- **Body:** a clean sans, regular and semibold.
- **Candidates:** display Montserrat, Plus Jakarta Sans or Poppins; body Inter or the system font
  (SF Pro, Roboto). **The final choice is pending #18 and #30.**

| Style      | Size / line height | Weight |
| ---------- | ------------------ | ------ |
| `display`  | 34 / 40            | 800    |
| `title-1`  | 28 / 34            | 800    |
| `title-2`  | 22 / 28            | 700    |
| `headline` | 17 / 22            | 600    |
| `body`     | 16 / 24            | 400    |
| `callout`  | 15 / 20            | 400    |
| `footnote` | 13 / 18            | 400    |
| `caption`  | 12 / 16            | 500    |

Every style scales with the system font size; layouts hold at font scale 1.3.

## Iconography

Simple glyphs with one stroke style (one icon set, one stroke weight), no illustrations inside
icons. Category icons sit in squircle tiles; status icons in circles.

## Surfaces

A light app: `gray-50` background with white bubbles, under deep-navy hero headers, as in
reference 03. Navy carries the hero, the search pill and the primary moment of each screen;
content below is light. **Dark mode is not in MVP scope.**

## Liquid Glass

On iOS 26+ the navigation and controls layer (tab bar, top bars, sheets, floating buttons,
toasts) uses native Liquid Glass. Content cards never use glass; they stay solid white bubbles.
Android, iOS < 26 and Reduce Transparency get solid or near-solid surfaces with the same
shapes. Details and fallbacks: [ADR 0008](../adr/0008-mobile-visual-language.md).

## What not to copy

The deck is a **look** reference only. Its copy and features never override the product rules
(`AGENTS.md`, legal copy and real features only).

- The name "Joe" and the "JOE FIX IT" logo. The product is Jack Fix It.
- The claims "Job Guarantee", "Service guarantee", "Upfront Pricing", "insured" pros,
  "Warranty" and "Protected payment" as a customer promise.
- Non-MVP categories: HVAC, plumbing, electrical, roofing, appliances, pest control. Only the 5
  MVP categories ship.
- Features the MVP does not have, such as "Background check" (post-MVP; in the MVP an admin
  approves pros by hand).
- The deck's taglines ("Real people. Real solutions.", "Same needs. A better way."); the
  taglines and CTA in the context doc §2 stay.
- AI or robot imagery, and stock photos of people used as UI.
- Review counts, ratings and statistics shown in the mockups.

## Reference images

Visual-only crops of the deck's app slides: shapes and colors, no deck copy. The logo and
category tiles in 03 fall under "What not to copy".

| Image                                                                  | What to take from it                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [01a-numbered-circle-card.jpg](reference/01a-numbered-circle-card.jpg) | Numbered green circle on a white rounded card over navy                          |
| [01b-search-bubble.jpg](reference/01b-search-bubble.jpg)               | Chat-bubble callout with a tail and icon rows, on a rounded card                 |
| [01c-chat-bubbles.jpg](reference/01c-chat-bubbles.jpg)                 | Stacked white chat bubbles with tails and soft shadows                           |
| [02a-search-pill.jpg](reference/02a-search-pill.jpg)                   | White pill search field with a lime button, on the navy phone screen             |
| [02b-phone-lower-panel.jpg](reference/02b-phone-lower-panel.jpg)       | Rounded `navy-700` panel on the `navy-900` screen                                |
| [03-app-home-mockup.jpg](reference/03-app-home-mockup.jpg)             | App home: navy hero header, pill search, squircle tiles, green CTA pill, tab bar |
| [04a-speech-bubbles.jpg](reference/04a-speech-bubbles.jpg)             | Speech bubbles with tails, a circular check icon in a confirmation bubble        |
| [04b-green-pill-end.jpg](reference/04b-green-pill-end.jpg)             | Green pill shape with a soft gradient                                            |
| [04c-red-pill-end.jpg](reference/04c-red-pill-end.jpg)                 | Red pill shape with a soft gradient                                              |
