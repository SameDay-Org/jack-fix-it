/** The app media of the showcase page: the screen in the hero, then one per feature. */
export const MEDIA_IDS = [
  "home",
  "describe",
  "quotes",
  "pay",
  "track",
  "chat",
  "reviews",
  "pros",
] as const;

export type MediaId = (typeof MEDIA_IDS)[number];

/** Showcase media lives in `public/showcase/` and is served under this path. */
export const MEDIA_PATH_PREFIX = "/showcase/";
/** A clip runs 6 to 12 seconds (handoffs/showcase-media-needed.md). */
export const CLIP_SECONDS = { min: 6, max: 12 } as const;

/** A still image under `MEDIA_PATH_PREFIX`, with the pixel size of its file. */
export type Poster = { src: string; width: number; height: number };

type Clip =
  | {
      /** Site path of the H.264 file. */
      mp4: string;
      /** Site path of the VP9 file. */
      webm: string;
      /** How long the clip runs, in seconds. */
      duration: number;
    }
  // No footage yet: the page shows the poster alone.
  | { mp4: null; webm: null; duration: null };

export type ShowcaseMedia = Clip & {
  id: MediaId;
  /** The still: shown before the clip plays, and on its own while there is no clip. */
  poster: Poster;
  /** i18n key of the text alternative: what the screen shows. */
  alt: `showcase.media.${MediaId}`;
  /**
   * True while the poster is a low-resolution capture standing in for the final footage
   * (what to record is listed in handoffs/showcase-media-needed.md).
   */
  placeholder: boolean;
};

const NO_CLIP = { mp4: null, webm: null, duration: null } as const;

/** Today's stills: the 320 x 640 emulator captures, scaled up to twice their size. */
function placeholderPoster(id: MediaId): Poster {
  return { src: `${MEDIA_PATH_PREFIX}posters/${id}.webp`, width: 640, height: 1280 };
}

function placeholder(id: MediaId): ShowcaseMedia {
  return {
    id,
    poster: placeholderPoster(id),
    alt: `showcase.media.${id}`,
    placeholder: true,
    ...NO_CLIP,
  };
}

/**
 * Every screen is a real capture of the app with sample data: nothing here is a mockup.
 * An entry stays a `placeholder` until its final capture and clip replace it.
 */
export const MEDIA: Record<MediaId, ShowcaseMedia> = {
  home: placeholder("home"),
  describe: placeholder("describe"),
  quotes: placeholder("quotes"),
  pay: placeholder("pay"),
  track: placeholder("track"),
  chat: placeholder("chat"),
  reviews: placeholder("reviews"),
  pros: placeholder("pros"),
};
