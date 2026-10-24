/** A video over `maxBytes`; videos are never re-encoded, so it cannot be made to fit. */
export class MediaTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("The video is larger than the upload limit");
    this.name = "MediaTooLargeError";
  }
}

/** A video whose size the phone cannot tell, so it cannot be checked against the upload limit. */
export class MediaSizeUnknownError extends Error {
  constructor() {
    super("The video's size could not be found");
    this.name = "MediaSizeUnknownError";
  }
}

/** A video in a format the API does not take (MP4 and QuickTime only). */
export class UnsupportedMediaError extends Error {
  constructor() {
    super("The video format is not supported");
    this.name = "UnsupportedMediaError";
  }
}
