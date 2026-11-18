// Node's fs, typed here: the app's tsconfig carries no Node types.
type Entry = { name: string; isDirectory: () => boolean };
const { readdirSync, readFileSync } = jest.requireActual<{
  readdirSync: (path: string, options: { withFileTypes: true }) => Entry[];
  readFileSync: (path: string, encoding: "utf8") => string;
}>("fs");
const resolveFile = (require as unknown as { resolve: (id: string) => string }).resolve;

// The app's source folder, found from a file in it.
const SHEET_FILE = resolveFile("../paymentSheet");
const SRC = SHEET_FILE.slice(
  0,
  SHEET_FILE.search(/[\\/]features[\\/]payments[\\/]paymentSheet\.ts$/),
);

/** Every .ts and .tsx file of the app under `dir`, leaving tests out. */
function appFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : appFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// The API keeps the legacy ephemeral key in its answers for one release (#253c, removed in #436).
// A sheet given that key has full rights over the customer's cards: no app code may read it, or
// hand Stripe a key under its own name.
const DEPRECATED = /ephemeral_key_secret|customerEphemeralKeySecret/;

describe("the deprecated ephemeral key", () => {
  it("is read nowhere in the app: the sheet uses the CustomerSession only", () => {
    const files = appFiles(SRC);
    // The walk found the app, the payment sheet among it.
    expect(files.map((file) => file.replace(/\\/g, "/"))).toContain(SHEET_FILE.replace(/\\/g, "/"));
    expect(files.filter((file) => DEPRECATED.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
