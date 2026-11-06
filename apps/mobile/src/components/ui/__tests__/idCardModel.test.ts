import {
  formatPublicCode,
  ID_CARD_ASPECT,
  ID_CARD_BASE_WIDTH,
  idCardGeometry,
  placeOf,
} from "../idCardModel";

describe("formatPublicCode", () => {
  it.each([
    ["K7Q29MXA", "K7Q2-9MXA"],
    ["k7q29mxa", "K7Q2-9MXA"],
    ["K7Q2-9MXA", "K7Q2-9MXA"],
    ["K7Q2 9MXA", "K7Q2-9MXA"],
    ["ABC", "ABC"],
    ["ABCDEFGHIJ", "ABCD-EFGH-IJ"],
    ["", ""],
    ["--", ""],
  ])("groups %p as %p", (code, grouped) => {
    expect(formatPublicCode(code)).toBe(grouped);
  });
});

describe("placeOf", () => {
  it.each([
    ["Fort Lauderdale", "FL", "Fort Lauderdale, FL"],
    [" Miami ", " FL ", "Miami, FL"],
    ["Miami", undefined, "Miami"],
    [undefined, "FL", "FL"],
    ["", "  ", ""],
    [undefined, undefined, ""],
  ])("joins %p and %p as %p", (city, state, place) => {
    expect(placeOf(city, state)).toBe(place);
  });
});

describe("idCardGeometry", () => {
  it("is ID-1 shaped at the design width, unit 1", () => {
    expect(idCardGeometry(ID_CARD_BASE_WIDTH)).toEqual({ width: 320, height: 202, unit: 1 });
    expect(ID_CARD_ASPECT).toBeCloseTo(85.6 / 54, 5);
  });

  it.each([
    [288, 182, 0.9],
    [960, 606, 3],
  ])("scales to %d dp: %d dp tall, unit %d", (width, height, unit) => {
    expect(idCardGeometry(width)).toEqual({ width, height, unit });
  });
});
