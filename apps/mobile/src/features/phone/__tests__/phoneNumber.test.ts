import {
  editNationalDigits,
  formatE164,
  formatNational,
  isValidNational,
  nationalDigits,
  toE164,
} from "../phoneNumber";

describe("phone number formatter", () => {
  it("formats the national number as it is typed", () => {
    const typed = "4155550123";
    const shown = Array.from(typed, (_, index) => formatNational(typed.slice(0, index + 1)));
    expect(shown).toEqual([
      "(4",
      "(41",
      "(415",
      "(415) 5",
      "(415) 55",
      "(415) 555",
      "(415) 555-0",
      "(415) 555-01",
      "(415) 555-012",
      "(415) 555-0123",
    ]);
    expect(formatNational("")).toBe("");
  });

  it("strips everything but digits, and stops at ten", () => {
    expect(nationalDigits("(415) 555-0123", "+1")).toBe("4155550123");
    expect(nationalDigits("415.555.0123 ext", "+1")).toBe("4155550123");
    expect(nationalDigits("415555012399", "+1")).toBe("4155550123");
  });

  it("drops the calling code an autofill or a paste brings along", () => {
    expect(nationalDigits("+1 415 555 0123", "+1")).toBe("4155550123");
    expect(nationalDigits("+14155550123", "+1")).toBe("4155550123");
    expect(nationalDigits("14155550123", "+1")).toBe("4155550123");
    // Ten digits that happen to start with 1 are not a calling code.
    expect(nationalDigits("1415555012", "+1")).toBe("1415555012");
  });

  it("deleting a separator deletes the digit before it, so the cursor never sticks", () => {
    expect(editNationalDigits("(415) 555", "(415) 55", "+1")).toBe("41555");
    expect(editNationalDigits("(415) 5", "(415) ", "+1")).toBe("415");
    // The dash deleted mid-text: the digit before it goes (the 5), not the last one.
    expect(editNationalDigits("(415) 555-0", "(415) 5550", "+1")).toBe("415550");
    expect(editNationalDigits("(415) 555-0123", "(415) 5550123", "+1")).toBe("415550123");
    expect(editNationalDigits("(415", "(4156", "+1")).toBe("4156");
  });

  it("an autofill or paste of the same number is taken as it is, never as a deleted separator", () => {
    expect(editNationalDigits("(415) 555-0123", "+14155550123", "+1")).toBe("4155550123");
    expect(editNationalDigits("(415) 555-0123", "4155550123", "+1")).toBe("4155550123");
  });

  it("builds E.164 from the calling code and the ten digits", () => {
    expect(toE164("+1", "4155550123")).toBe("+14155550123");
  });

  it("accepts a complete US number and rejects short or malformed input", () => {
    expect(isValidNational("4155550123")).toBe(true);
    expect(isValidNational("415555012")).toBe(false); // short
    expect(isValidNational("")).toBe(false);
    expect(isValidNational("1155550123")).toBe(false); // area code starts with 1
    expect(isValidNational("4151550123")).toBe(false); // exchange starts with 1
  });

  it("shows a stored E.164 number in the national format behind its calling code", () => {
    expect(formatE164("+14155550123", "+1")).toBe("+1 (415) 555-0123");
    expect(formatE164("+447700900123", "+1")).toBe("+447700900123");
  });
});
