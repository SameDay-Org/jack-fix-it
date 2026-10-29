import openapi from "../../../../../../packages/shared/openapi.json";
import { ADDRESS_MAX, addressErrors } from "../address";
import type { AddressFields } from "../requestDraft";

const valid: AddressFields = {
  line1: "12 Main St",
  line2: "",
  city: "Newark",
  state: "NJ",
  zipCode: "07102",
};

describe("the address bounds", () => {
  it("are the API's (AddressIn in the committed OpenAPI schema)", () => {
    const { properties } = openapi.components.schemas.AddressIn;

    expect(ADDRESS_MAX).toStrictEqual({
      line1: properties.line1.maxLength,
      line2: properties.line2.anyOf[0].maxLength,
      city: properties.city.maxLength,
    });
  });

  it("take 255/255/128 characters and refuse 256/256/129", () => {
    const at = { line1: "a".repeat(255), line2: "b".repeat(255), city: "c".repeat(128) };
    const over = { line1: "a".repeat(256), line2: "b".repeat(256), city: "c".repeat(129) };

    expect(addressErrors({ ...valid, ...at })).toStrictEqual({});
    expect(addressErrors({ ...valid, ...over })).toStrictEqual({
      line1: "tooLong",
      line2: "tooLong",
      city: "tooLong",
    });
  });

  it("count what is sent: the spaces around a field are trimmed first", () => {
    expect(
      addressErrors({ ...valid, line1: ` ${"a".repeat(255)} `, city: ` ${"c".repeat(128)} ` }),
    ).toStrictEqual({});
  });
});
