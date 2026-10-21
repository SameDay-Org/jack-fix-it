import { fireEvent, render, screen } from "@testing-library/react-native";

import { Avatar } from "../Avatar";

const images = () => screen.getByRole("image").queryAll((node) => node.type === "Image");

describe("Avatar", () => {
  it('renders initials for "maria lopez"', async () => {
    await render(<Avatar name="maria lopez" />);

    expect(screen.getByText("ML")).toBeTruthy();
    expect(screen.getByRole("image", { name: "maria lopez" })).toBeTruthy();
  });

  it("single word gives one initial", async () => {
    await render(<Avatar name="Jack" />);

    expect(screen.getByText("J")).toBeTruthy();
  });

  it("blank name gives no text", async () => {
    await render(<Avatar name="   " />);

    expect(screen.getByRole("image")).toBeTruthy();
    expect(screen.queryByText(/\S/)).toBeNull();
  });

  it("falls back to initials when the image errors", async () => {
    await render(<Avatar name="maria lopez" imageUri="https://images.invalid/maria.png" />);
    expect(screen.queryByText("ML")).toBeNull();
    expect(images()).toHaveLength(1);

    await fireEvent(images()[0], "error");

    expect(screen.getByText("ML")).toBeTruthy();
    expect(images()).toHaveLength(0);
  });
});
