import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { useSession } from "@/api";

import { signedIn } from "../../home/__tests__/helpers";
import { CustomerOnly } from "../CustomerOnly";

jest.mock("@/api", () => ({ useSession: jest.fn() }));
// Where a redirect sends the screen; it draws nothing.
const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock("expo-router", () => ({ Redirect: (props: { href: string }) => mockRedirect(props) }));

beforeEach(() => mockRedirect.mockClear());

describe("CustomerOnly", () => {
  it("builds the wallet's screens for a customer", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await render(
      <CustomerOnly>
        <Text>wallet</Text>
      </CustomerOnly>,
    );

    expect(screen.getByText("wallet")).toBeOnTheScreen();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each(["pro", "agent", "admin"] as const)(
    "sends a %s back to Account and builds nothing for them",
    async (role) => {
      jest.mocked(useSession).mockReturnValue(signedIn({ role }));
      await render(
        <CustomerOnly>
          <Text>wallet</Text>
        </CustomerOnly>,
      );

      expect(screen.queryByText("wallet")).toBeNull();
      expect(mockRedirect).toHaveBeenCalledWith({ href: "/account" });
    },
  );
});
