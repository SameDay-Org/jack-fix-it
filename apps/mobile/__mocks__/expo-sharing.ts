// Manual Jest mock, applied to every suite (root __mocks__): the share sheet is "available" and
// opens at once; a test reads the url and options off `shareAsync`.
import type { ResolvedSharePayload, SharePayload, SharingOptions } from "expo-sharing";

export const isAvailableAsync = jest.fn(async (): Promise<boolean> => true);
export const shareAsync = jest.fn(
  async (_url: string, _options?: SharingOptions): Promise<void> => undefined,
);
export const getSharedPayloads = jest.fn((): SharePayload[] => []);
export const getResolvedSharedPayloadsAsync = jest.fn(
  async (): Promise<ResolvedSharePayload[]> => [],
);
export const clearSharedPayloads = jest.fn((): void => undefined);
