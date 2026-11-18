# @jack/mascot: Jack, the Jack Fix It mascot (#404)

## The character

Jack is the face of the professionals who do the work: a cheerful, competent home-services
pro, friendly rather than childish. He is drawn flat, from soft filled shapes, with a big
round head on a small body so that he reads at 32 px as well as at 256 px.

- **Hat:** a lime hard hat (the brand's green), with a darker ridge down its middle, a gloss on
  one side and a flat brim.
- **Face:** round, warm mid skin tone, short dark hair at the temples, two dark eyes with one
  highlight each, light brows, a small nose, blush on the cheeks. Expressions: neutral, smile,
  happy (laughing, eyes closed) and thinking (for the next poses).
- **Clothes:** a navy work shirt (`navy700`) with an open collar, a seam and a small lime patch
  with the "J" of Jack Fix It on the chest; a navy tool belt with a lime buckle, a pouch and a
  hammer in its loop; grey work trousers; tan work boots on dark soles.
- **Hands:** lime work gloves with darker cuffs, as a fist or an open hand.
- **Props:** an open-end wrench, a lime toolbox and a clipboard with a ticked list, in the same
  style, each drawn around the point a fist holds.

## An original character

Jack is not derived from any existing character. He was drawn for Jack Fix It from the brief
in `handoffs/mascot.md`, by hand, as SVG shapes in this package: no tracing, no reference
image, no stock art and no image generator.

He was kept clearly apart from the best-known cartoon builder on purpose:

| A classic cartoon builder                           | Jack                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| Yellow hard hat                                     | Lime hard hat with a ridge and a gloss, the brand's colour            |
| Checked orange or yellow shirt, blue overalls       | Plain navy work shirt with a "J" patch, a tool belt and grey trousers |
| A large nose, stubble, his own face and proportions | A small nose, no stubble, his own round face and proportions          |
| Bare hands                                          | Lime work gloves                                                      |

## Palette

Every colour is a token from `src/palette.ts`; a test fails on any other colour.

- **Brand** (docs/design/README.md, ADR 0008): `navy900` `#01172E`, `navy700` `#0B2D49`,
  `green500` `#5EB72B`, `green700` `#308127`, `white`, `gray50` `#F7FBFC`, `gray500` `#484F57`.
- **Mascot only:** `skin` `#C68A63`, `skinShade` `#A9704C`, `blush` `#DC8670`, `hair` `#2A1E18`,
  `mouth` `#5A1C24`, `tongue` `#E06D6D`, `metal` `#BAC4CE`, `metalShade` `#8A97A5`,
  `boot` `#B07443`, `sole` `#3A2A20`.

On white and light gray, Jack works as is. On navy his hat, face, gloves and boots carry the
figure and the shirt stays quiet; put him on a white or `gray50` bubble when he must stand out
from a navy surface.

## How it is built

- `src/shapes.ts`: the data. A pose is a tree of named groups (`data-part`) of flat filled
  shapes (`path`, `circle`, `ellipse`, `rect`) in a 200 x 200 box: no strokes, no gradients,
  no images, no text.
- `src/parts/`: the reusable parts (head, face expressions, hat, body, arms, props). An arm is
  a small rig: two angles and a glove; a pose only sets numbers.
- `src/poses.ts`: the poses. `MASCOT_POSES` is the public contract of the showcase's `Mascot`
  component (wave, point, celebrate, peek, thinking, tools; a test keeps both lists equal).
  Ready now: **wave**, **celebrate**, **tools**. Point, peek and thinking come with the
  animation (PR 2); the showcase switches to this package after #420 (PR 3).
- `src/render.ts`: an SVG string renderer (standalone files, the gallery, tests).
- `src/react.ts` (`@jack/mascot/react`): `<Mascot pose size title className>`, with the props
  of the showcase's component. With `title` it is an image (`role="img"`, named by its title);
  without it is decoration (`aria-hidden`).
- **The app** will map the same tree to `react-native-svg` (`G`, `Path`, `Circle`, `Ellipse`,
  `Rect` take the same attributes), so both draw the same Jack.

## Scripts

- `pnpm --filter @jack/mascot preview`: serves the gallery (the parts, then the poses at 32, 64,
  128 and 256 px on white, light gray and navy) on a free local port. Local only: there is no
  route for it in the site.
- `pnpm --filter @jack/mascot build`: writes each pose to `dist/poses/<pose>.svg` (and a titled
  copy) and `dist/gallery.html`, and fails when a pose is over 30 KB (they are 6 to 7 KB).
- `pnpm --filter @jack/mascot test`, `typecheck`.

The scripts run TypeScript with Node's own type stripping (no build step): the sources use
only erasable syntax and `.ts` import paths (`erasableSyntaxOnly` in tsconfig).
