import {
  cardScale,
  clampTilt,
  decorativeBars,
  formatPublicCode,
  groundShadow,
  guillochePath,
  ID_CARD_ASPECT,
  ID_CARD_BASE_WIDTH,
  idCardGeometry,
  MAX_TILT,
  parallaxOffset,
  placeOf,
  rosettePath,
  SHEEN_REST,
  sheenPose,
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

describe("clampTilt", () => {
  it("holds a lean within the card's limit, or within the one given", () => {
    expect(clampTilt(40)).toBe(MAX_TILT);
    expect(clampTilt(-40)).toBe(-MAX_TILT);
    expect(clampTilt(5)).toBe(5);
    expect(clampTilt(20, 14)).toBe(14);
  });
});

describe("parallaxOffset", () => {
  it("slides a raised part toward the edge that leans back, a sunk one away, in proportion", () => {
    const raised = parallaxOffset(0, 20, 4);
    const sunk = parallaxOffset(0, 20, -4);
    expect(raised.x).toBeCloseTo(4 * Math.tan((20 * Math.PI) / 180), 6);
    expect(sunk.x).toBeCloseTo(-raised.x, 6);
    expect(parallaxOffset(0, 20, 8).x).toBeCloseTo(raised.x * 2, 6);
    // A lean around X that tips the top edge away moves a raised part up.
    expect(parallaxOffset(10, 0, 4).y).toBeLessThan(0);
  });

  it("is still at rest", () => {
    const rest = parallaxOffset(0, 0, 8);
    expect(rest.x).toBeCloseTo(0, 10);
    expect(rest.y).toBeCloseTo(0, 10);
  });
});

describe("cardScale", () => {
  it("is the lift at rest and on either face, and grows a little edge-on", () => {
    expect(cardScale(1, 0)).toBe(1);
    expect(cardScale(1.03, 180)).toBeCloseTo(1.03, 10);
    expect(cardScale(1, 90)).toBeCloseTo(1.05, 10);
    expect(cardScale(1, -90)).toBeCloseTo(1.05, 10);
  });
});

describe("groundShadow", () => {
  it("sits under the card at rest, a little below it", () => {
    const rest = groundShadow(0, 0, 1, 0, 1);
    expect(rest.translateX).toBeCloseTo(0, 10);
    expect(rest.translateY).toBeGreaterThan(0);
    expect(rest).toMatchObject({ scaleX: 1, scaleY: 1, opacity: 1 });
  });

  it("moves against the lean and foreshortens with the card", () => {
    const leaning = groundShadow(0, MAX_TILT, 1, 0, 1);
    expect(leaning.translateX).toBeLessThan(0);
    expect(groundShadow(0, -MAX_TILT, 1, 0, 1).translateX).toBeCloseTo(-leaning.translateX, 6);
    expect(leaning.scaleX).toBeCloseTo(Math.cos((MAX_TILT * Math.PI) / 180), 6);
  });

  it("sinks, spreads and fades as the card lifts, and narrows edge-on mid-flip", () => {
    const rest = groundShadow(0, 0, 1, 0, 1);
    const lifted = groundShadow(0, 0, 1.03, 0, 1);
    expect(lifted.translateY).toBeGreaterThan(rest.translateY);
    expect(lifted.scaleY).toBeGreaterThan(1);
    expect(lifted.opacity).toBeLessThan(1);
    const edgeOn = groundShadow(0, 0, 1.08, 90, 1);
    expect(edgeOn.scaleX).toBeLessThan(0.2);
    expect(edgeOn.scaleX).toBeGreaterThan(0);
  });

  it("scales its offsets with the card", () => {
    expect(groundShadow(0, 10, 1, 0, 3).translateX).toBeCloseTo(
      groundShadow(0, 10, 1, 0, 1).translateX * 3,
      6,
    );
  });
});

describe("sheenPose", () => {
  it("rests at its rest strength, centered", () => {
    const rest = sheenPose(0, 0, 320, 202);
    expect(rest.strength).toBe(SHEEN_REST);
    expect(rest.translateX).toBeCloseTo(0, 10);
    expect(rest.translateY).toBeCloseTo(0, 10);
  });

  it("slides with the lean and brightens to full at the limit", () => {
    const right = sheenPose(0, MAX_TILT, 320, 202);
    expect(right.translateX).toBeGreaterThan(0);
    expect(right.strength).toBe(1);
    expect(sheenPose(MAX_TILT, 0, 320, 202).translateY).toBeLessThan(0);
  });
});

describe("decorativeBars", () => {
  it("draws the same strip for the same code, another for another, inside its width", () => {
    const first = decorativeBars("K7Q2-9MXA", 156);
    expect(decorativeBars("K7Q2-9MXA", 156)).toEqual(first);
    expect(decorativeBars("9MXA-K7Q2", 156)).not.toEqual(first);
    expect(first.length).toBeGreaterThan(20);
    for (const bar of first) {
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(156);
    }
    // In order, never overlapping.
    first.slice(1).forEach((bar, i) => expect(bar.x).toBeGreaterThan(first[i].x + first[i].width));
  });
});

describe("the security print", () => {
  it("draws the guilloche as interlaced waves, the same every time", () => {
    const waves = guillochePath();
    expect(waves).toBe(guillochePath());
    // Two families of nine waves, one subpath each.
    expect(waves.match(/M/g)).toHaveLength(18);
  });

  it("draws the rosette as closed rings around an open center", () => {
    const rosette = rosettePath(100, 100, 50);
    expect(rosette.match(/M/g)).toHaveLength(7);
    expect(rosette.match(/Z/g)).toHaveLength(7);
    // No point closer to the center than the innermost ring's scallops reach.
    const points = [...rosette.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) =>
      Math.hypot(Number(x) - 100, Number(y) - 100),
    );
    expect(Math.min(...points)).toBeGreaterThan(50 * 0.3);
  });
});
