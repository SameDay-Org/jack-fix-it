// Manual Jest mock, applied to every suite (root __mocks__): the Payment Sheet as resolved jest.fn.
// By default the sheet opens and the customer pays; a test sets another answer per call. The real
// module reaches for its native TurboModule at import, so nothing of it is loaded here.
import type {
  InitPaymentSheetResult,
  InitStripeParams,
  PaymentSheet,
  PresentPaymentSheetResult,
} from "@stripe/stripe-react-native";

/** The real enum's values (types/Errors.ts). */
export enum PaymentSheetError {
  Failed = "Failed",
  Canceled = "Canceled",
  Timeout = "Timeout",
}

export const initStripe = jest.fn(async (_params: InitStripeParams): Promise<void> => undefined);
export const initPaymentSheet = jest.fn(
  async (_params: PaymentSheet.SetupParams): Promise<InitPaymentSheetResult> => ({}),
);
export const presentPaymentSheet = jest.fn(
  async (_options?: PaymentSheet.PresentOptions): Promise<PresentPaymentSheetResult> => ({}),
);
export const handleURLCallback = jest.fn(async (_url: string): Promise<boolean> => true);
