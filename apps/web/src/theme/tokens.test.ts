import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// apps/mobile/src/theme/tokens.json is the source of truth; globals.css mirrors it (#110).
const TOKENS_PATH = new URL("../../../mobile/src/theme/tokens.json", import.meta.url);
const CSS_PATH = new URL("../app/globals.css", import.meta.url);

type Tokens = { colors: Record<string, string>; radius: Record<string, number> };

function isRecordOf<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is Record<string, T> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isItem)
  );
}

const isString = (item: unknown): item is string => typeof item === "string";
const isNumber = (item: unknown): item is number => typeof item === "number";

function readTokens(): Tokens {
  const parsed: unknown = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tokens.json is not an object");
  }
  // Narrowed to an object above; each field is checked below.
  const { colors, radius } = parsed as Record<string, unknown>;
  if (!isRecordOf(colors, isString) || !isRecordOf(radius, isNumber)) {
    throw new Error("tokens.json needs colors (strings) and radius (numbers)");
  }
  return { colors, radius };
}

/** The custom properties declared in the @theme block of globals.css, by name without "--". */
function readThemeProperties(): Map<string, string> {
  const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = /@theme\s*\{([^}]*)\}/.exec(css);
  if (!block) throw new Error("globals.css has no @theme block");
  const properties = new Map<string, string>();
  for (const [, name, value] of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    properties.set(name, value.trim());
  }
  return properties;
}

const tokens = readTokens();
const theme = readThemeProperties();

describe("web theme mirrors the mobile tokens", () => {
  it("every mobile color token exists in the web theme with the same value", () => {
    for (const [name, hex] of Object.entries(tokens.colors)) {
      expect(theme.get(`color-${name}`)?.toLowerCase(), `--color-${name}`).toBe(hex.toLowerCase());
    }
  });

  it("every mobile radius token exists in the web theme", () => {
    for (const [name, pixels] of Object.entries(tokens.radius)) {
      expect(theme.get(`radius-${name}`), `--radius-${name}`).toBe(`${pixels}px`);
    }
  });

  it("the web theme has no color the tokens do not define", () => {
    const webColors = [...theme.keys()]
      .filter((name) => name.startsWith("color-"))
      .map((name) => name.slice("color-".length));

    expect(webColors.filter((name) => !(name in tokens.colors))).toEqual([]);
  });
});
