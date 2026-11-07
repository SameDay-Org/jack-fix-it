import "@/i18n";

import { act, fireEvent, screen, within } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiGet, apiPost, uploadMedia, useSession, type UploadMediaOptions } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { prepareMedia, type PickedMedia } from "../../media/compress";
import { chooseMediaSource } from "../../media/mediaSource";
import { proJobsConfig } from "../config";
import type { JobPhoto, JobPhotoKind, ProJob } from "../phase";
import { ProJobScreen } from "../ProJobScreen";
import {
  freezeClock,
  hoursFromNow,
  JOB_ID,
  minutesFromNow,
  navigation,
  proJob,
  renderWithQuery,
  signedIn,
  working,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
// Root manual mock (apps/mobile/__mocks__): named here so the test and the screen share one instance.
jest.mock("expo-haptics");
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the loading skeleton's endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("../../media/compress", () => ({ prepareMedia: jest.fn(), compressImage: jest.fn() }));
// "Camera or library" answers at once: the sheet's route is not part of this screen.
jest.mock("../../media/mediaSource", () => ({
  ...jest.requireActual("../../media/mediaSource"),
  chooseMediaSource: jest.fn(),
  closeMediaSourceSheet: jest.fn(),
}));

const { mockSession } = jest.requireMock<{ mockSession: { generation: number } }>("@/api");

const PHOTOS = "/v1/pros/me/jobs/{job_id}/photos";
const MAX = proJobsConfig.photoMaxPerKind;
const COMPLETE = "/v1/pros/me/jobs/{job_id}/complete";
const PHOTOS_FAILED = "We couldn't prepare your after photos. Add another one.";

/** Signed URLs and upload keys: neither may reach a log. */
const URL_MARK = "storage.test";
const KEY_MARK = "job_photo/";
const keyOf = (n: number) => `u/pro/${KEY_MARK}${String(n).padStart(32, "0")}.jpg`;

/** The nth photo on the job, its URL signed for an hour unless a test says otherwise. */
const photo = (n: number, overrides: Partial<JobPhoto> = {}): JobPhoto => ({
  id: `00000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`,
  content_type: "image/jpeg",
  url: `https://${URL_MARK}/job-photos/${n}.jpg?X-Amz-Signature=sig-${n}`,
  expires_at: hoursFromNow(1),
  ...overrides,
});
const photos = (from: number, count: number): JobPhoto[] =>
  Array.from({ length: count }, (_, index) => photo(from + index));

/** The job working, with these after photos on it. */
const workingWith = (after: JobPhoto[], before: JobPhoto[] = []): ProJob =>
  working({ photos: { before, after } });

const asset = (n: number): ImagePicker.ImagePickerAsset => ({
  uri: `file:///picked/${n}.jpg`,
  width: 4032,
  height: 3024,
  type: "image",
  mimeType: "image/jpeg",
  fileSize: 3_000_000,
});

/** Uploads the test settles by hand, in the order they started. */
type Pending = {
  options: UploadMediaOptions;
  resolve: () => void;
  reject: (error: unknown) => void;
};
let pending: Pending[];
let pickedSoFar: number;

const section = (kind: JobPhotoKind) => within(screen.getByTestId(`pro-job-photos-${kind}`));
const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const isDisabled = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState?.disabled === true;
const rows = (kind: JobPhotoKind) => section(kind).queryAllByTestId(/^media-item-\d+$/);

/** Renders the screen and waits for the job's title (the API answered). */
async function open(job: ProJob) {
  jest.mocked(apiGet).mockResolvedValue(job);
  const view = await renderWithQuery(<ProJobScreen />);
  await screen.findByTestId("pro-job-title");
  return view;
}

/** Add, from the library, `count` photos of the kind; their uploads start one at a time. */
async function addPhotos(kind: JobPhotoKind, count: number) {
  const assets = Array.from({ length: count }, () => asset((pickedSoFar += 1)));
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
    canceled: false,
    assets,
  });
  await pressed(`pro-job-photos-${kind}-add`);
  await flush();
}

/** The nth upload (from 0) lands with its key; the next one in the queue starts. */
async function finishUpload(index: number) {
  await act(async () => pending[index]?.resolve());
  await flush();
}

/** Adds `count` photos of the kind and lets every upload land. */
async function addUploaded(kind: JobPhotoKind, count: number) {
  const first = pending.length;
  await addPhotos(kind, count);
  for (let index = first; index < first + count; index += 1) await finishUpload(index);
}

let consoleSpies: jest.SpyInstance[];
let announceSpies: jest.SpyInstance[];

beforeEach(() => {
  jest.clearAllMocks();
  freezeClock();
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  mockSession.generation = 1;
  pending = [];
  pickedSoFar = 0;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockReset().mockResolvedValue(proJob());
  jest.mocked(apiPost).mockReset();
  jest.mocked(chooseMediaSource).mockResolvedValue("library");
  jest.mocked(prepareMedia).mockImplementation(async (file: PickedMedia) => ({
    uri: `${file.uri}.compressed`,
    contentType: "image/jpeg",
    kind: file.kind,
  }));
  jest.mocked(uploadMedia).mockImplementation(
    (options) =>
      new Promise((resolve, reject) => {
        const n = Number(options.file.uri.replace(/\D/g, ""));
        pending.push({ options, resolve: () => resolve({ key: keyOf(n) }), reject });
      }),
  );
  announceSpies = [
    jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => undefined),
    jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined),
  ];
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    jest.spyOn(console, method),
  );
  toastStore.setState({ current: null });
});

afterEach(() => {
  // Whatever happened in the test, no log line carried an upload key or a signed URL.
  const logged = consoleSpies.flatMap((spy) => spy.mock.calls).map((args) => String(args));
  consoleSpies.forEach((spy) => spy.mockRestore());
  announceSpies.forEach((spy) => spy.mockRestore());
  dismissToast();
  jest.useRealTimers();
  for (const line of logged) {
    expect(line).not.toContain(KEY_MARK);
    expect(line).not.toContain(URL_MARK);
  }
});

describe("a photo whose attachment is on its way cannot be removed (#63 B round 1, B3)", () => {
  it("the first photo's Remove is off while its POST is in flight", async () => {
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await open(working());
    await addUploaded("after", 1);
    await pressed("pro-job-photos-after-save");
    expect(apiPost).toHaveBeenCalledTimes(1);
    try {
      const remove = screen.queryByLabelText("Remove After photo 1");
      expect(remove === null || remove.props.accessibilityState?.disabled === true).toBe(true);
    } finally {
      await act(async () => answer.resolve(workingWith([photo(1)])));
      await flush();
    }
  });

  it("a tap on that Remove does nothing: the row stays, then the photo lands as a saved tile", async () => {
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await open(working());
    await addUploaded("after", 1);
    await pressed("pro-job-photos-after-save");
    await act(async () => fireEvent.press(screen.getByLabelText("Remove After photo 1")));
    expect(rows("after")).toHaveLength(1);

    await act(async () => answer.resolve(workingWith([photo(1)])));
    await flush();
    expect(await screen.findByRole("image", { name: "After photo 1 of 1" })).toBeTruthy();
    expect(rows("after")).toHaveLength(0);
    expect(screen.queryByLabelText("Remove After photo 1")).toBeNull();
  });

  it("a photo still waiting its turn can be removed, and is never sent", async () => {
    const first = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(first.promise as ReturnType<typeof apiPost>);
    await open(working());
    await addUploaded("after", 2);
    await pressed("pro-job-photos-after-save");
    const second = screen.getByLabelText("Remove After photo 2");
    expect(second.props.accessibilityState?.disabled).not.toBe(true);
    await act(async () => fireEvent.press(second));

    await act(async () => first.resolve(workingWith([photo(1)])));
    await flush();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(rows("after")).toHaveLength(0);
  });
});

describe("after photos whose copies failed free their place (#63 B round 1, B1)", () => {
  it("at the cap, Add stays off until Job's done finds them unusable", async () => {
    await open(workingWith(photos(1, MAX)));
    expect(isDisabled("pro-job-photos-after-add")).toBe(true);
    expect(screen.queryByTestId("pro-job-photos-after-failed")).toBeNull();
  });

  it("after after_photos_required at the cap: the note, Add on, a replacement saved, Job's done goes through", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "after_photos_required"));
    await open(workingWith(photos(1, MAX)));
    await pressed("pro-job-done");
    await flush();
    expect(screen.getByTestId("pro-job-done-message").props.children).toBe(PHOTOS_FAILED);
    expect(section("after").getByTestId("pro-job-photos-after-failed").props.children).toBe(
      `${MAX} photos couldn't be processed. Add another one.`,
    );
    expect(isDisabled("pro-job-photos-after-add")).toBe(false);
    // The failed ones are set aside: the job holds none the customer can see.
    expect(section("after").getByTestId("pro-job-photos-after-count").props.children).toBe(
      `Up to ${MAX} photos`,
    );

    await addUploaded("after", 1);
    // The picker was offered every place the cap leaves (failed copies aside).
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectionLimit: MAX }),
    );
    jest.mocked(apiPost).mockResolvedValueOnce(workingWith(photos(1, MAX + 1)));
    await pressed("pro-job-photos-after-save");
    await flush();
    expect(apiPost).toHaveBeenLastCalledWith(
      PHOTOS,
      { kind: "after", upload_keys: [keyOf(1)] },
      { auth: true, generation: 1, params: { job_id: JOB_ID } },
    );
    // A new photo on the job: Job's done starts over, and the note goes.
    expect(screen.queryByTestId("pro-job-photos-after-failed")).toBeNull();
    expect(screen.queryByTestId("pro-job-done-message")).toBeNull();

    jest.mocked(apiPost).mockResolvedValueOnce({
      ...workingWith(photos(1, MAX + 1)),
      status: "completed",
      completed_at: minutesFromNow(0),
    });
    await pressed("pro-job-done");
    await flush();
    expect(jest.mocked(apiPost).mock.calls.at(-1)?.[0]).toBe(COMPLETE);
  });

  it("the rows the API keeps per place bound the room: past twice the cap nothing more fits", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "after_photos_required"));
    await open(workingWith(photos(1, 2 * MAX)));
    await pressed("pro-job-done");
    await flush();
    expect(screen.getByTestId("pro-job-done-message").props.children).toBe(PHOTOS_FAILED);
    expect(isDisabled("pro-job-photos-after-add")).toBe(true);
  });
});
