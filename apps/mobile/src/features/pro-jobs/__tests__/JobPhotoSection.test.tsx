import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  apiGet,
  apiPost,
  NetworkError,
  uploadMedia,
  UploadFailedError,
  useSession,
  type UploadMediaOptions,
} from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { prepareMedia, type PickedMedia } from "../../media/compress";
import { chooseMediaSource } from "../../media/mediaSource";
import { proJobsConfig } from "../config";
import type { JobPhoto, JobPhotoKind, ProJob } from "../phase";
import { ProJobScreen } from "../ProJobScreen";
import {
  arrived,
  freezeClock,
  hoursFromNow,
  JOB_ID,
  minutesFromNow,
  navigation,
  NO_PHOTO_COUNTS,
  onTheWay,
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

const { mockSession, mockSignOut } = jest.requireMock<{
  mockSession: { generation: number };
  mockSignOut: () => void;
}>("@/api");

const PHOTOS = "/v1/pros/me/jobs/{job_id}/photos";
const MAX = proJobsConfig.photoMaxPerKind;
const OFFLINE = "We couldn't reach Jack Fix It. Check your connection and try again.";

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
  working({ photos: { before, after, ...NO_PHOTO_COUNTS } });

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

const toast = () => toastStore.getState().current;
const section = (kind: JobPhotoKind) => within(screen.getByTestId(`pro-job-photos-${kind}`));
const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const isDisabled = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState?.disabled === true;
const statusOf = (kind: JobPhotoKind, index: number) =>
  section(kind).getByTestId(`media-item-${index}-status`);
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

describe("JobPhotoSection on the pro's job screen", () => {
  describe("which sections show", () => {
    it.each([
      ["on the way", onTheWay()],
      ["checked in", arrived()],
    ])("%s: the before photos only, open to add", async (_, job) => {
      await open(job);

      expect(section("before").getByRole("header", { name: "Before photos" })).toBeTruthy();
      expect(section("before").getByTestId("pro-job-photos-before-add")).toBeTruthy();
      expect(isDisabled("pro-job-photos-before-add")).toBe(false);
      expect(screen.getByText("Add photos")).toBeTruthy();
      expect(screen.getByLabelText("Add before photos")).toBeTruthy();
      expect(section("before").getByText("Up to 10 photos")).toBeTruthy();
      expect(screen.queryByTestId("pro-job-photos-after")).toBeNull();
    });

    it("a locked check-in shows no photo section", async () => {
      await open(onTheWay({ arrival_code_locked: true }));

      expect(screen.queryByTestId("pro-job-photos-before")).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after")).toBeNull();
    });

    it("working: before and after, both open to add, after saying it is required", async () => {
      await open(working());

      expect(section("before").getByTestId("pro-job-photos-before-add")).toBeTruthy();
      expect(section("after").getByTestId("pro-job-photos-after-add")).toBeTruthy();
      expect(
        section("after").getByText(
          "Required. Show the finished work: Job's done needs at least one, and Maria can see them in the app.",
        ),
      ).toBeTruthy();
      // Two Add buttons on one screen: the same short words, each named for its photos.
      expect(section("after").getByLabelText("Add after photos")).toBeTruthy();
      expect(section("before").getByLabelText("Add before photos")).toBeTruthy();
    });

    it("completed: the saved photos read-only, each tile named by its place", async () => {
      await open(
        working({
          status: "completed",
          completed_at: minutesFromNow(-1),
          photos: { before: [photo(1)], after: photos(2, 3), ...NO_PHOTO_COUNTS },
        }),
      );

      expect(screen.getByRole("image", { name: "Before photo 1 of 1" })).toBeTruthy();
      expect(screen.getByRole("image", { name: "After photo 1 of 3" })).toBeTruthy();
      expect(screen.getByRole("image", { name: "After photo 2 of 3" })).toBeTruthy();
      expect(screen.getByRole("image", { name: "After photo 3 of 3" })).toBeTruthy();
      expect(screen.queryByTestId("pro-job-photos-before-add")).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after-add")).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after-count")).toBeNull();
    });

    it("cancelled with no photos shows no photo section", async () => {
      await open(proJob({ status: "cancelled" }));

      expect(screen.queryByTestId("pro-job-photos-before")).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after")).toBeNull();
    });
  });

  it("a photo whose URL expired shows the frame, the others their image", async () => {
    await open(workingWith([photo(1, { expires_at: minutesFromNow(-1) }), photo(2)]));

    const expired = within(screen.getByTestId("pro-job-photos-after-tiles-0"));
    expect(expired.getByTestId("media-frame")).toBeTruthy();
    expect(screen.queryByTestId("pro-job-photos-after-tiles-0-image")).toBeNull();
    expect(screen.getByTestId("pro-job-photos-after-tiles-1-image").props.source).toEqual({
      uri: photo(2).url,
    });
  });

  describe("adding", () => {
    it("Add asks camera or library, opens the library for photos, and shows the upload's progress", async () => {
      await open(working());

      await addPhotos("after", 1);

      expect(chooseMediaSource).toHaveBeenCalledWith(expect.any(Function), {
        acceptsVideo: false,
      });
      expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ mediaTypes: ["images"], selectionLimit: MAX }),
      );
      expect(uploadMedia).toHaveBeenCalledTimes(1);
      expect(pending[0]?.options).toMatchObject({
        purpose: "job_photo",
        file: { uri: "file:///picked/1.jpg.compressed", contentType: "image/jpeg" },
      });
      expect(section("after").getByText("After photo 1")).toBeTruthy();

      await act(async () => pending[0]?.options.onProgress?.(0.4));
      expect(statusOf("after", 0)).toHaveTextContent("Uploading… 40%");
      // Nothing to save yet: the upload is still going.
      expect(screen.queryByTestId("pro-job-photos-after-save")).toBeNull();
    });

    it("a failed upload says so and Retry uploads it again", async () => {
      await open(working());
      await addPhotos("after", 1);

      await act(async () => pending[0]?.reject(new UploadFailedError("network")));
      await flush();

      expect(statusOf("after", 0)).toHaveTextContent(
        "Upload failed. Check your connection and try again.",
      );
      await act(async () =>
        fireEvent.press(section("after").getByRole("button", { name: "Retry After photo 1" })),
      );
      await flush();
      expect(uploadMedia).toHaveBeenCalledTimes(2);
      await finishUpload(1);
      expect(statusOf("after", 0)).toHaveTextContent("Uploaded");
    });

    it("picked photos are named after the saved ones and counted with them", async () => {
      await open(workingWith([photo(1)]));

      await addUploaded("after", 1);

      expect(section("after").getByRole("image", { name: "After photo 1 of 1" })).toBeTruthy();
      expect(section("after").getByText("After photo 2")).toBeTruthy();
      expect(screen.getByTestId("pro-job-photos-after-count")).toHaveTextContent(
        `2 of ${MAX} photos`,
      );
      expect(screen.getByTestId("pro-job-photos-after-final")).toHaveTextContent(
        "Saved photos can't be removed.",
      );
      expect(screen.getByText("Save 1 photo")).toBeTruthy();
    });

    it("the library offers only as many as still fit", async () => {
      await open(workingWith(photos(1, 3)));

      await addPhotos("after", 1);

      expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ selectionLimit: MAX - 3 }),
      );
    });

    it("a full job closes Add and says it holds the most", async () => {
      await open(workingWith(photos(1, MAX)));

      expect(isDisabled("pro-job-photos-after-add")).toBe(true);
      expect(screen.getByTestId("pro-job-photos-after-count")).toHaveTextContent(
        `That's the most this job holds (${MAX}).`,
      );
      await pressed("pro-job-photos-after-add");
      expect(chooseMediaSource).not.toHaveBeenCalled();
    });
  });

  describe("saving", () => {
    it("Save waits while a photo still uploads", async () => {
      await open(working());
      await addPhotos("after", 2);
      await finishUpload(0);

      expect(screen.getByText("Save 1 photo")).toBeTruthy();
      expect(isDisabled("pro-job-photos-after-save")).toBe(true);

      await finishUpload(1);
      expect(screen.getByText("Save 2 photos")).toBeTruthy();
      expect(isDisabled("pro-job-photos-after-save")).toBe(false);
    });

    it("Save attaches one key per request, in the order picked, in the session it started in", async () => {
      const first = deferred<ProJob>();
      const second = deferred<ProJob>();
      jest
        .mocked(apiPost)
        .mockReturnValueOnce(first.promise as ReturnType<typeof apiPost>)
        .mockReturnValueOnce(second.promise as ReturnType<typeof apiPost>);
      await open(working());
      await addUploaded("after", 2);

      await pressed("pro-job-photos-after-save");
      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(apiPost).toHaveBeenLastCalledWith(
        PHOTOS,
        { kind: "after", upload_keys: [keyOf(1)] },
        { auth: true, generation: 1, params: { job_id: JOB_ID } },
      );
      // While it saves, nothing else can be added.
      expect(isDisabled("pro-job-photos-after-add")).toBe(true);

      await act(async () => first.resolve(workingWith([photo(1)])));
      await flush();
      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(apiPost).toHaveBeenLastCalledWith(
        PHOTOS,
        { kind: "after", upload_keys: [keyOf(2)] },
        { auth: true, generation: 1, params: { job_id: JOB_ID } },
      );

      await act(async () => second.resolve(workingWith([photo(1), photo(2)])));
      await flush();

      // Saved: the picked rows leave, the tiles show both, Job's done opens.
      expect(rows("after")).toHaveLength(0);
      expect(screen.queryByTestId("pro-job-photos-after-save")).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after-final")).toBeNull();
      expect(screen.getByRole("image", { name: "After photo 1 of 2" })).toBeTruthy();
      expect(screen.getByRole("image", { name: "After photo 2 of 2" })).toBeTruthy();
      expect(isDisabled("pro-job-done")).toBe(false);
      expect(Haptics.notificationAsync).toHaveBeenCalledWith(
        Haptics.NotificationFeedbackType.Success,
      );
      expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
        "2 after photos saved.",
        { queue: true },
      );
      expect(toast()).toBeNull();
    });

    it("before photos save as before", async () => {
      jest
        .mocked(apiPost)
        .mockResolvedValueOnce(
          onTheWay({ photos: { before: [photo(1)], after: [], ...NO_PHOTO_COUNTS } }),
        );
      await open(onTheWay());
      await addUploaded("before", 1);

      await pressed("pro-job-photos-before-save");
      await flush();

      expect(apiPost).toHaveBeenCalledWith(
        PHOTOS,
        { kind: "before", upload_keys: [keyOf(1)] },
        { auth: true, generation: 1, params: { job_id: JOB_ID } },
      );
      expect(screen.getByRole("image", { name: "Before photo 1 of 1" })).toBeTruthy();
      expect(rows("before")).toHaveLength(0);
    });

    it("an upload too old to attach leaves the list and asks for it again; the rest still go in", async () => {
      jest
        .mocked(apiPost)
        .mockRejectedValueOnce(new ApiError(422, "upload_expired"))
        .mockResolvedValueOnce(workingWith([photo(2)]));
      await open(working());
      await addUploaded("after", 2);

      await pressed("pro-job-photos-after-save");
      await flush();

      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(rows("after")).toHaveLength(0);
      const notice = within(screen.getByTestId("pro-job-photos-after-turned-away-expired"));
      expect(notice.getByText("This photo took too long")).toBeTruthy();
      expect(notice.getByText("Add it again.")).toBeTruthy();
      expect(screen.getByRole("image", { name: "After photo 1 of 1" })).toBeTruthy();
      expect(toast()).toBeNull();
    });

    it("two uploads too old to attach are asked for again together", async () => {
      jest.mocked(apiPost).mockRejectedValue(new ApiError(422, "upload_expired"));
      await open(working());
      await addUploaded("after", 2);

      await pressed("pro-job-photos-after-save");
      await flush();

      expect(rows("after")).toHaveLength(0);
      const notice = within(screen.getByTestId("pro-job-photos-after-turned-away-expired"));
      expect(notice.getByText("2 photos took too long")).toBeTruthy();
      expect(notice.getByText("Add them again.")).toBeTruthy();

      // Adding again clears the notice.
      await addPhotos("after", 1);
      expect(screen.queryByTestId("pro-job-photos-after-turned-away")).toBeNull();
    });

    it("an upload the API refuses leaves the list and says it couldn't be saved", async () => {
      jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "invalid_photo"));
      await open(working());
      await addUploaded("after", 1);

      await pressed("pro-job-photos-after-save");
      await flush();

      expect(rows("after")).toHaveLength(0);
      const notice = within(screen.getByTestId("pro-job-photos-after-turned-away-refused"));
      expect(notice.getByText("This photo couldn't be saved")).toBeTruthy();
      expect(notice.getByText("Add it again.")).toBeTruthy();
      expect(screen.queryByTestId("pro-job-photos-after-turned-away-expired")).toBeNull();
    });

    it("a job already full says so, stops there and asks for the job again", async () => {
      jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "job_photo_limit"));
      await open(working());
      await addUploaded("after", 2);
      const gets = jest.mocked(apiGet).mock.calls.length;

      await pressed("pro-job-photos-after-save");
      await flush();

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(toast()).toMatchObject({
        message: `This job already has ${MAX} after photos.`,
        tone: "danger",
      });
      await waitFor(() => expect(jest.mocked(apiGet).mock.calls.length).toBeGreaterThan(gets));
    });

    it("offline: says so, and the photos not saved stay for another try", async () => {
      jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(false));
      await open(working());
      await addUploaded("after", 2);

      await pressed("pro-job-photos-after-save");
      await flush();

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(toast()).toMatchObject({ message: OFFLINE, tone: "danger" });
      expect(rows("after")).toHaveLength(2);
      expect(screen.getByText("Save 2 photos")).toBeTruthy();
      expect(isDisabled("pro-job-photos-after-save")).toBe(false);
      expect(screen.queryByTestId("pro-job-photos-after-turned-away")).toBeNull();
    });

    it("a photo already on the job counts as saved, silently", async () => {
      jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "duplicate_photo"));
      await open(working());
      await addUploaded("after", 1);
      jest.mocked(apiGet).mockResolvedValue(workingWith([photo(1)]));

      await pressed("pro-job-photos-after-save");
      await flush();

      expect(rows("after")).toHaveLength(0);
      expect(toast()).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after-turned-away")).toBeNull();
      // The job is asked for again and shows the photo.
      expect(await screen.findByRole("image", { name: "After photo 1 of 1" })).toBeTruthy();
    });

    it("a sign-out while saving stops the save and shows nothing", async () => {
      const first = deferred<ProJob>();
      jest.mocked(apiPost).mockReturnValueOnce(first.promise as ReturnType<typeof apiPost>);
      await open(working());
      await addUploaded("after", 2);

      await pressed("pro-job-photos-after-save");
      expect(apiPost).toHaveBeenCalledTimes(1);

      await act(async () => mockSignOut());
      await act(async () => first.resolve(workingWith([photo(1)])));
      await flush();

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(toast()).toBeNull();
      expect(screen.queryByTestId("pro-job-photos-after-turned-away")).toBeNull();
      expect(screen.queryAllByTestId(/^media-item-\d+$/)).toHaveLength(0);
      expect(AccessibilityInfo.announceForAccessibilityWithOptions).not.toHaveBeenCalledWith(
        expect.stringContaining("saved"),
        expect.anything(),
      );
      expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    });
  });

  describe("photos and the job moving on", () => {
    it("before photos picked while checked in are still there, unsaved, after Start job", async () => {
      await open(arrived());
      await addUploaded("before", 1);
      jest.mocked(apiPost).mockResolvedValueOnce(working());

      await pressed("pro-job-start");
      await flush();

      expect(await screen.findByTestId("pro-job-done")).toBeTruthy();
      expect(rows("before")).toHaveLength(1);
      expect(section("before").getByText("Save 1 photo")).toBeTruthy();
      expect(section("before").getByLabelText("Save 1 before photo")).toBeTruthy();
    });

    it("a photo removed while Save runs is never attached", async () => {
      const first = deferred<ProJob>();
      jest.mocked(apiPost).mockReturnValueOnce(first.promise as ReturnType<typeof apiPost>);
      await open(working());
      await addUploaded("after", 2);

      await pressed("pro-job-photos-after-save");
      await act(async () => fireEvent.press(screen.getByLabelText("Remove After photo 2")));
      await act(async () => first.resolve(workingWith([photo(1)])));
      await flush();

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(rows("after")).toHaveLength(0);
    });

    it("Job's done waits for photos picked and not saved yet, and says so", async () => {
      await open(workingWith([photo(1)]));
      expect(isDisabled("pro-job-done")).toBe(false);

      await addPhotos("before", 1);
      expect(isDisabled("pro-job-done")).toBe(true);
      expect(screen.getByTestId("pro-job-done-message").props.children).toBe(
        "Save your photos first.",
      );

      await finishUpload(0);
      expect(isDisabled("pro-job-done")).toBe(true);

      await act(async () => fireEvent.press(screen.getByLabelText("Remove Before photo 1")));
      expect(isDisabled("pro-job-done")).toBe(false);
      expect(screen.queryByTestId("pro-job-done-message")).toBeNull();
    });

    it("while Job's done is out, adding and saving photos wait for its answer", async () => {
      const done = deferred<ProJob>();
      jest.mocked(apiPost).mockReturnValueOnce(done.promise as ReturnType<typeof apiPost>);
      await open(workingWith([photo(1)]));

      await pressed("pro-job-done");

      expect(isDisabled("pro-job-photos-after-add")).toBe(true);
      expect(isDisabled("pro-job-photos-before-add")).toBe(true);
      await act(async () => done.reject(new ApiError(409, "after_photos_required")));
      await flush();
      expect(isDisabled("pro-job-photos-after-add")).toBe(false);
    });

    it("the dock's line has no live region: the announcement is its one voice", async () => {
      await open(working());

      expect(screen.getByTestId("pro-job-done-message").props.accessibilityLiveRegion).toBe(
        undefined,
      );
    });
  });
});
