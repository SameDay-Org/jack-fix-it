import { requireNativeModule } from "expo";

import { createNativeUploadTask } from "../nativeUploadTask";

jest.mock("expo", () => ({ requireNativeModule: jest.fn() }));

it("creates expo-file-system's native upload handle from its FileSystem module", () => {
  class FileSystemUploadTask {}
  jest.mocked(requireNativeModule).mockReturnValue({ FileSystemUploadTask });

  expect(createNativeUploadTask()).toBeInstanceOf(FileSystemUploadTask);
  expect(requireNativeModule).toHaveBeenCalledWith("FileSystem");
});
