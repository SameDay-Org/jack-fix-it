import {
  DEFAULT_LOCATION_TIMEOUT_SECONDS,
  ETA_MAX_MINUTES,
  ETA_MIN_MINUTES,
  nextEta,
  previousEta,
  readProJobsConfig,
  type ProJobsConfig,
} from "../config";

const read = (etaPresets?: string, locationTimeoutSeconds?: string) =>
  readProJobsConfig({ etaPresets, locationTimeoutSeconds });
/** The photo and Job's done values, the others unset. */
const readPhotos = (
  photoMaxPerKind?: string,
  doneRetrySeconds?: string,
  doneRetryWindowSeconds?: string,
) =>
  readProJobsConfig({
    etaPresets: undefined,
    locationTimeoutSeconds: undefined,
    photoMaxPerKind,
    doneRetrySeconds,
    doneRetryWindowSeconds,
  });

const PRESETS_ERROR = /EXPO_PUBLIC_JOB_ETA_PRESETS must list whole minutes from 5 to 240/;
const TIMEOUT_ERROR = /EXPO_PUBLIC_CHECK_IN_LOCATION_TIMEOUT_SECONDS must be a positive whole/;

describe("readProJobsConfig", () => {
  it("offers 10, 20, 30, 45 and 60 minutes and waits 20 s for a location when nothing is set", () => {
    expect(read()).toEqual({
      etaPresetsMinutes: [10, 20, 30, 45, 60],
      locationTimeoutMs: 20_000,
      photoMaxPerKind: 10,
      doneRetryIntervalMs: 3_000,
      doneRetryWindowMs: 30_000,
    });
    expect(DEFAULT_LOCATION_TIMEOUT_SECONDS).toBe(20);
  });

  it.each(["", "   "])("treats a blank value (%j) as unset", (blank) => {
    expect(readPhotos(blank, blank, blank)).toEqual(read(blank, blank));
    expect(read(blank, blank)).toEqual({
      etaPresetsMinutes: [10, 20, 30, 45, 60],
      locationTimeoutMs: 20_000,
      photoMaxPerKind: 10,
      doneRetryIntervalMs: 3_000,
      doneRetryWindowMs: 30_000,
    });
  });

  it("reads custom presets, spaces around the commas allowed, up to the API's bounds", () => {
    expect(read("5, 15 ,240").etaPresetsMinutes).toEqual([5, 15, 240]);
    expect(read(" 30 ").etaPresetsMinutes).toEqual([30]);
    expect(read(`${ETA_MIN_MINUTES},${ETA_MAX_MINUTES}`).etaPresetsMinutes).toEqual([5, 240]);
  });

  it.each([
    ["below 5 minutes", "4,10"],
    ["zero", "0,10"],
    ["above 240 minutes", "10,241"],
    ["not ascending", "20,10"],
    ["a duplicate", "10,10,20"],
    ["a fraction", "10,12.5"],
    ["a negative number", "-5,10"],
    ["an exponent", "1e1,20"],
    ["a hex number", "0x10"],
    ["a word", "ten,20"],
    ["an empty part in the middle", "10,,20"],
    ["a trailing comma", "10,20,"],
    ["a leading comma", ",10"],
    ["only commas", ","],
  ])("refuses presets with %s (%j)", (_label, raw) => {
    expect(() => read(raw)).toThrow(PRESETS_ERROR);
  });

  it("waits the configured number of seconds for a location", () => {
    expect(read(undefined, "45").locationTimeoutMs).toBe(45_000);
    expect(read(undefined, " 1 ").locationTimeoutMs).toBe(1_000);
  });

  it.each([
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a fraction", "1.5"],
    ["a word", "soon"],
  ])("refuses a location timeout that is %s (%j)", (_label, raw) => {
    expect(() => read(undefined, raw)).toThrow(TIMEOUT_ERROR);
  });

  it("reads the job photo cap and Job's done's retry interval and window", () => {
    expect(readPhotos("4", "2", "20")).toMatchObject({
      photoMaxPerKind: 4,
      doneRetryIntervalMs: 2_000,
      doneRetryWindowMs: 20_000,
    });
    expect(readPhotos(undefined, "5", "5").doneRetryWindowMs).toBe(5_000);
  });

  it.each([
    ["a zero photo cap", ["0", undefined, undefined], /EXPO_PUBLIC_JOB_PHOTO_MAX_PER_KIND/],
    ["a fractional retry", [undefined, "1.5", undefined], /EXPO_PUBLIC_JOB_DONE_RETRY_SECONDS/],
    ["a word for the window", [undefined, undefined, "soon"], /EXPO_PUBLIC_JOB_DONE_RETRY_WINDOW/],
    ["a window shorter than one retry", [undefined, "10", "5"], /must be at least/],
  ] as const)("refuses %s", (_label, [max, retry, window], error) => {
    expect(() => readPhotos(max, retry, window)).toThrow(error);
  });

  it("reads the EXPO_PUBLIC values once, when the module loads", () => {
    const saved = { ...process.env };
    process.env.EXPO_PUBLIC_JOB_ETA_PRESETS = "15,30";
    process.env.EXPO_PUBLIC_CHECK_IN_LOCATION_TIMEOUT_SECONDS = "10";
    process.env.EXPO_PUBLIC_JOB_PHOTO_MAX_PER_KIND = "6";
    process.env.EXPO_PUBLIC_JOB_DONE_RETRY_SECONDS = "4";
    process.env.EXPO_PUBLIC_JOB_DONE_RETRY_WINDOW_SECONDS = "40";
    try {
      let loaded: ProJobsConfig | undefined;
      jest.isolateModules(() => {
        loaded = (jest.requireActual("../config") as typeof import("../config")).proJobsConfig;
      });
      expect(loaded).toEqual({
        etaPresetsMinutes: [15, 30],
        locationTimeoutMs: 10_000,
        photoMaxPerKind: 6,
        doneRetryIntervalMs: 4_000,
        doneRetryWindowMs: 40_000,
      });
    } finally {
      process.env = saved;
    }
  });
});

/** Every value the custom stepper can show: 5 to 60 by 5, then 75 to 240 by 15. */
const GRID = [
  ...Array.from({ length: 12 }, (_, i) => (i + 1) * 5),
  ...Array.from({ length: 12 }, (_, i) => 75 + i * 15),
];

describe("nextEta and previousEta", () => {
  it("step by 5 minutes under an hour and by 15 from an hour", () => {
    expect(nextEta(5)).toBe(10);
    expect(nextEta(55)).toBe(60);
    expect(nextEta(60)).toBe(75);
    expect(nextEta(75)).toBe(90);
    expect(previousEta(10)).toBe(5);
    expect(previousEta(60)).toBe(55);
    expect(previousEta(75)).toBe(60);
    expect(previousEta(240)).toBe(225);
  });

  it("snap an off-step value onto the grid in the direction pressed", () => {
    expect(nextEta(7)).toBe(10);
    expect(previousEta(7)).toBe(5);
    expect(nextEta(62)).toBe(75);
    expect(previousEta(62)).toBe(60);
    expect(previousEta(70)).toBe(60);
  });

  it("stay within 5 to 240 minutes", () => {
    expect(nextEta(240)).toBe(240);
    expect(nextEta(235)).toBe(240);
    expect(previousEta(5)).toBe(5);
    expect(previousEta(6)).toBe(5);
    expect(nextEta(0)).toBe(5);
  });

  it("walk the whole range up and down through valid values only", () => {
    const up = [ETA_MIN_MINUTES];
    while (up[up.length - 1] < ETA_MAX_MINUTES) up.push(nextEta(up[up.length - 1]));
    expect(up).toEqual(GRID);

    const down = [ETA_MAX_MINUTES];
    while (down[down.length - 1] > ETA_MIN_MINUTES) down.push(previousEta(down[down.length - 1]));
    expect(down).toEqual([...GRID].reverse());
  });

  it("come back to the same value after one step each way", () => {
    for (const value of GRID) {
      if (value < ETA_MAX_MINUTES) expect(previousEta(nextEta(value))).toBe(value);
      if (value > ETA_MIN_MINUTES) expect(nextEta(previousEta(value))).toBe(value);
    }
  });
});
