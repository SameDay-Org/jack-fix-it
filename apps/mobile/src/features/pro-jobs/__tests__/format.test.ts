import i18n from "@/i18n";

import { Platform } from "react-native";

import { formatInstantDay, formatTimeOfDay } from "@/features/opportunities/format";

import {
  addressLines,
  addressText,
  customerName,
  dayLabel,
  mapsUrl,
  whenLabel,
  type JobAddress,
} from "../format";
import { proJob } from "./helpers";

const t = i18n.t.bind(i18n);
const EN = "en-US";

/**
 * Instants on the local calendar of whatever zone the run uses, so "Today" and "Tomorrow" are
 * read against local midnight and never against a fixed UTC string.
 */
const local = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

describe("dayLabel", () => {
  const now = local(11, 7, 23, 30);

  it("says Today for any time on the same local day", () => {
    expect(dayLabel(t, local(11, 7, 0, 0), now, EN)).toBe("Today");
    expect(dayLabel(t, local(11, 7, 23, 59), now, EN)).toBe("Today");
  });

  it("says Tomorrow once the job is past local midnight, even minutes away", () => {
    expect(dayLabel(t, local(11, 8, 0, 0), now, EN)).toBe("Tomorrow");
    expect(dayLabel(t, local(11, 8, 23, 59), now, EN)).toBe("Tomorrow");
  });

  it("writes the date for any other day, before or after", () => {
    expect(dayLabel(t, local(11, 9, 0, 0), now, EN)).toBe(formatInstantDay(local(11, 9, 0), EN));
    expect(dayLabel(t, local(11, 9, 0, 0), now, EN)).toBe("Mon, Nov 9");
    expect(dayLabel(t, local(11, 6, 23, 59), now, EN)).toBe("Fri, Nov 6");
  });

  it("counts calendar days across a 23 or 25 hour day", () => {
    // US clocks move on 2026-03-08 and 2026-11-01; in a zone without DST these are ordinary days.
    expect(dayLabel(t, local(3, 9, 0, 30), local(3, 8, 0, 30), EN)).toBe("Tomorrow");
    expect(dayLabel(t, local(11, 2, 0, 30), local(11, 1, 23, 30), EN)).toBe("Tomorrow");
    expect(dayLabel(t, local(11, 1, 23, 30), local(11, 1, 0, 30), EN)).toBe("Today");
  });

  it("is lowercase inside a sentence; a date stays as it is", () => {
    expect(dayLabel(t, local(11, 7, 9), now, EN, "inline")).toBe("today");
    expect(dayLabel(t, local(11, 8, 9), now, EN, "inline")).toBe("tomorrow");
    expect(dayLabel(t, local(11, 9, 9), now, EN, "inline")).toBe("Mon, Nov 9");
    expect(whenLabel(t, new Date(local(11, 7, 14)).toISOString(), now, EN, "inline")).toMatch(
      /^today, 2:00\sPM$/,
    );
  });

  it("speaks the app's language", async () => {
    await i18n.changeLanguage("es");
    try {
      expect(dayLabel(t, local(11, 7, 9), now, "es")).toBe("Hoy");
      expect(dayLabel(t, local(11, 8, 9), now, "es")).toBe("Mañana");
      expect(dayLabel(t, local(11, 7, 9), now, "es", "inline")).toBe("hoy");
      expect(dayLabel(t, local(11, 8, 9), now, "es", "inline")).toBe("mañana");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("whenLabel", () => {
  const now = local(11, 7, 8);

  it("joins the day and the local time of the start", () => {
    const today = local(11, 7, 14);
    const label = whenLabel(t, new Date(today).toISOString(), now, EN);
    expect(label).toBe(`Today, ${formatTimeOfDay(today, EN)}`);
    expect(label).toMatch(/^Today, 2:00\sPM$/);
  });

  it("writes the date for a job two days out", () => {
    const later = local(11, 9, 9, 30);
    expect(whenLabel(t, new Date(later).toISOString(), now, EN)).toMatch(/^Mon, Nov 9, 9:30\sAM$/);
  });
});

describe("customerName", () => {
  it("shows the first name, trimmed", () => {
    expect(customerName(proJob())).toBe("Maria");
    expect(customerName(proJob({ customer_first_name: "  Ana " }))).toBe("Ana");
  });

  it.each([null, "", "   "])("has no name to show for %j", (name) => {
    expect(customerName(proJob({ customer_first_name: name }))).toBeNull();
  });
});

const ADDRESS: JobAddress = {
  line1: "1200 Las Olas Blvd",
  line2: "Apt 4",
  city: "Fort Lauderdale",
  state: "FL",
  zip_code: "33301",
};

describe("addressLines and addressText", () => {
  it("puts the street and unit first, then the city, state and ZIP", () => {
    expect(addressLines(ADDRESS)).toEqual([
      "1200 Las Olas Blvd, Apt 4",
      "Fort Lauderdale, FL 33301",
    ]);
    expect(addressText(ADDRESS)).toBe("1200 Las Olas Blvd, Apt 4, Fort Lauderdale, FL 33301");
  });

  it.each([null, "", "  "])("leaves the unit out when line 2 is %j", (line2) => {
    const address = { ...ADDRESS, line2 };
    expect(addressLines(address)).toEqual(["1200 Las Olas Blvd", "Fort Lauderdale, FL 33301"]);
    expect(addressText(address)).toBe("1200 Las Olas Blvd, Fort Lauderdale, FL 33301");
  });

  it("trims the street lines", () => {
    expect(addressLines({ ...ADDRESS, line1: " 1200 Las Olas Blvd ", line2: " Apt 4 " })[0]).toBe(
      "1200 Las Olas Blvd, Apt 4",
    );
  });
});

describe("mapsUrl", () => {
  afterEach(() => {
    jest.restoreAllMocks(); // Platform.OS
  });

  const tricky: JobAddress = { ...ADDRESS, line2: "Unit #4 & Rear" };
  const query =
    "1200%20Las%20Olas%20Blvd%2C%20Unit%20%234%20%26%20Rear%2C%20Fort%20Lauderdale%2C%20FL%2033301";

  it("opens Apple Maps with an address search on iOS", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    expect(mapsUrl(tricky)).toBe(`https://maps.apple.com/?q=${query}`);
  });

  it("opens the Android map chooser with an address search on Android", () => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(mapsUrl(tricky)).toBe(`geo:0,0?q=${query}`);
  });

  it("encodes the address so it never breaks the link", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const url = mapsUrl(tricky);
    expect(url).not.toMatch(/[ #&]/);
    expect(decodeURIComponent(url.slice("geo:0,0?q=".length))).toBe(addressText(tricky));
  });
});
