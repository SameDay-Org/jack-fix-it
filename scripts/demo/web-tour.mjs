// Jack Fix It demo: the web tour (admin panel + public site), recorded scene by scene.
//
// A headless browser (Playwright, the msedge channel by default) at 1280x720, a drawn cursor
// (a headless recording has no OS cursor), one WebM per scene plus a numbered scene list
// (scenes.md / scenes.json) and a still per beat for review. docs/demo-video.md has the scene
// table and the pacing notes.
//
// It writes: the scenes take a request, approve documents and a pro, move a ticket and resolve
// the dispute. Run `seed_demo.py --reset` before each take; every step is guarded, so a second
// run on used data finishes but shows less.
//
// Usage (from scripts/demo, after `pnpm install --ignore-workspace`):
//   node web-tour.mjs --base http://localhost:3000 --out ./tour [--scenes queue,pros] [--headed]
// Environment:
//   DEMO_STAFF_PASSWORD_FILE  file holding the demo password (default ./.demo-password, where
//                             seed_demo.py keeps it); never printed
//   DEMO_ADMIN_EMAIL          the demo admin (default admin@example.com)
//   DEMO_STAGING_HOST         the one non-local host allowed (staging), optional
//   DEMO_WAITING_PRO          name on the waiting pro's card (default "Maria")
//   DEMO_DISPUTE_CODE         request code of the disputed job to resolve (default: first open)
//   DEMO_PARTIAL_RELEASE      dollars released to the pro in the partial (default "250.00")
//   DEMO_TIME_ZONE            the zone the panel's times read in (default America/New_York)
//   DEMO_BROWSER_CHANNEL      the installed browser Playwright drives (default msedge)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    out: { type: "string", default: "./tour" },
    scenes: { type: "string", default: "" },
    headed: { type: "boolean", default: false },
  },
});

// ---- Guard: local or the named staging host only, never production. ----
const ALLOWED = new Set(["localhost", "127.0.0.1", process.env.DEMO_STAGING_HOST].filter(Boolean));
const BASE = new URL(args.base);
if (!ALLOWED.has(BASE.hostname)) {
  console.error(`refusing: ${BASE.hostname} is not localhost, 127.0.0.1 or DEMO_STAGING_HOST`);
  process.exit(2);
}
const base = BASE.origin;
const OUT = args.out;
const RAW = join(OUT, ".raw");

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD_FILE = process.env.DEMO_STAFF_PASSWORD_FILE ?? join(HERE, ".demo-password");
const ADMIN = process.env.DEMO_ADMIN_EMAIL ?? "admin@example.com";
const WAITING_PRO = process.env.DEMO_WAITING_PRO ?? "Maria";
const DISPUTE_CODE = process.env.DEMO_DISPUTE_CODE ?? "";
const PARTIAL = process.env.DEMO_PARTIAL_RELEASE ?? "250.00";
const TIME_ZONE = process.env.DEMO_TIME_ZONE ?? "America/New_York";
const CHANNEL = process.env.DEMO_BROWSER_CHANNEL ?? "msedge";
const VIEW = { width: 1280, height: 720 };

// Each scene: its storyboard number(s) (docs/demo-video.md) and its title, in tour order.
const STORY = {
  queue: ["5, 14", "Queue: buckets, a card, take it"],
  pros: ["5", "Pros: documents one by one, approve the pro"],
  support: ["14", "Support: a ticket, in progress"],
  kpis: ["14", "KPIs: range, hover, keyboard"],
  disputes: ["13", "Disputes: both sides, a partial, the confirmation"],
  site: ["1", "Public site: landing, /app, /for-pros"],
  "site-es": ["1 (ES)", "Public site in Spanish"],
  closing: ["15", "Closing: landing hero"],
};
const WANTED = args.scenes ? args.scenes.split(",") : Object.keys(STORY);
const unknown = WANTED.filter((id) => !(id in STORY));
if (unknown.length) {
  console.error(`unknown scene(s): ${unknown.join(", ")}. Known: ${Object.keys(STORY).join(", ")}`);
  process.exit(2);
}

if (!existsSync(PASSWORD_FILE)) {
  console.error("no demo password file: run seed_demo.py, or set DEMO_STAFF_PASSWORD_FILE");
  process.exit(2);
}
mkdirSync(RAW, { recursive: true });

// ---- The drawn cursor: an arrow that follows Playwright's mouse, a ring on each press. ----
const CURSOR = () => {
  if (window.top !== window) return;
  const KEY = "__tourCursor";
  const install = () => {
    if (!document.body || document.getElementById(KEY)) return;
    const style = document.createElement("style");
    style.id = `${KEY}-style`;
    style.textContent = `
      #${KEY}{position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;
        z-index:2147483647;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));will-change:transform}
      .${KEY}-ring{position:fixed;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;
        border:3px solid #62b72f;pointer-events:none;z-index:2147483646;
        animation:${KEY}-ring .55s ease-out forwards}
      @keyframes ${KEY}-ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}`;
    const cursor = document.createElement("div");
    cursor.id = KEY;
    cursor.setAttribute("aria-hidden", "true");
    cursor.innerHTML =
      '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2l18 10.5-7.6 1.6 4.6 8.4-3.4 1.8-4.6-8.5L4 21z" fill="#0b1b2b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    // A document without storage (about:blank, an opaque origin) throws on sessionStorage:
    // the cursor then starts off the frame and is not remembered there.
    const recall = () => {
      try {
        return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      } catch {
        return null;
      }
    };
    const saved = recall() ?? { x: -60, y: -60 };
    const place = (x, y) => {
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ x, y }));
      } catch {
        // No storage here: nothing to remember.
      }
    };
    place(saved.x, saved.y);
    document.head.append(style);
    document.body.append(cursor);
    // Not window[KEY]: the element's id already names a window property of that name.
    if (!window[`${KEY}Bound`]) {
      window[`${KEY}Bound`] = true;
      document.addEventListener("mousemove", (e) => place(e.clientX, e.clientY), true);
      document.addEventListener(
        "mousedown",
        (e) => {
          const ring = document.createElement("div");
          ring.className = `${KEY}-ring`;
          ring.style.left = `${e.clientX}px`;
          ring.style.top = `${e.clientY}px`;
          document.body.append(ring);
          setTimeout(() => ring.remove(), 600);
        },
        true,
      );
    }
  };
  document.addEventListener("DOMContentLoaded", install);
  // React may re-render the body: put the cursor back if it goes.
  setInterval(install, 250);
};

// ---- Pacing helpers. ----
const beat = (page, ms = 900) => page.waitForTimeout(ms);

/** Glides the drawn cursor to the middle of `locator` (scrolling it into view first). */
async function glide(page, locator, { steps = 28, pause = 350 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`not visible: ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  await beat(page, pause);
  return box;
}

/** Glide, press (the ring shows), release: a click a viewer can follow. */
async function press(page, locator, opts) {
  await glide(page, locator, opts);
  await page.mouse.down();
  await beat(page, 90);
  await page.mouse.up();
}

/** Types at a readable speed into a field reached by the cursor. */
async function type(page, locator, text, delay = 65) {
  await press(page, locator);
  await locator.pressSequentially(text, { delay });
}

/** Eased scroll of the window to `y` over `ms`. */
async function scrollTo(page, y, ms = 1600) {
  await page.evaluate(
    ([target, duration]) =>
      new Promise((done) => {
        const start = window.scrollY;
        const span = Math.min(target, document.documentElement.scrollHeight - innerHeight) - start;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / duration);
          const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          window.scrollTo(0, start + span * ease);
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [y, ms],
  );
}

/** Scrolls `locator` near the top third of the view, eased. */
async function bring(page, locator, ms = 1200) {
  const y = await locator.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await scrollTo(page, Math.max(0, y - 140), ms);
}

/** A panel page is ready when its loading frame has given way to one h1. */
const ready = (page) =>
  page.waitForFunction(
    () =>
      document.querySelectorAll("main h1").length === 1 &&
      !document.querySelector('[aria-busy="true"]'),
    null,
    { timeout: 15000 },
  );

/** True (after a still of the empty list) when a scene's subject is gone: an earlier take
 * used it up. The scene ends there; reseed for the full one. */
async function nothingLeft(locator, still) {
  if (await locator.count()) return false;
  await still("nothing-left");
  return true;
}

// ---- One scene = one context = one WebM. ----
const browser = await chromium.launch({ channel: CHANNEL, headless: !args.headed });
let storageState;
const scenes = [];

async function scene(id, story, title, run) {
  const number = String(scenes.length + 1).padStart(2, "0");
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: TIME_ZONE,
    colorScheme: "light",
    reducedMotion: "no-preference",
    recordVideo: { dir: RAW, size: VIEW },
    storageState,
  });
  await context.addInitScript(CURSOR);
  const issues = [];
  const foreign = new Set();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith("http") && !ALLOWED.has(url.hostname)) {
      foreign.add(url.hostname);
      // Never let the tour leave for another host (production included).
      if (route.request().isNavigationRequest()) return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => issues.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && issues.push(`console: ${m.text()}`));
  page.on(
    "response",
    (r) => r.status() >= 400 && issues.push(`http ${r.status()}: ${new URL(r.url()).pathname}`),
  );
  let shot = 0;
  const still = async (name) =>
    page.screenshot({
      path: join(OUT, `${number}-${id}-${String(++shot).padStart(2, "0")}-${name}.png`),
    });
  const t0 = Date.now();
  let failed = null;
  try {
    await run(page, still);
  } catch (error) {
    failed = error.message.split("\n")[0];
    await still("failed").catch(() => {});
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const video = page.video();
  await context.close();
  const file = `${number}-${id}.webm`;
  if (video) {
    await video.saveAs(join(OUT, file));
    await video.delete();
  }
  scenes.push({ number, id, story, title, file, seconds, failed, issues, foreign: [...foreign] });
  console.log(
    `${number} ${id}: ${seconds}s${failed ? ` FAILED ${failed}` : ""}${issues.length ? ` issues ${issues.length}` : ""}`,
  );
}

// ---- Sign in once (recorded too: the login is a usable shot), keep the session. ----
async function signIn() {
  const password = readFileSync(PASSWORD_FILE, "utf8").trim();
  await scene("login", "5", "Staff sign-in", async (page, still) => {
    await page.goto(`${base}/admin/login`);
    await beat(page, 800);
    await type(page, page.locator('input[name="email"]'), ADMIN, 45);
    await page.locator('input[name="password"]').click();
    await page.locator('input[name="password"]').fill(password); // never typed into a log
    await beat(page, 400);
    await press(page, page.locator('button[type="submit"]'));
    await page.waitForURL((u) => !u.pathname.startsWith("/admin/login"));
    await page.waitForLoadState("networkidle");
    await still("home");
    await beat(page, 1200);
    storageState = await page.context().storageState();
  });
}

// ---- The scenes. ----
const SCENES = {
  // Storyboard 5 (first half) and 14 (queue actions).
  async queue(page, still) {
    await page.goto(`${base}/admin/queue`);
    await ready(page);
    await beat(page, 1200);
    await still("new");
    for (const tab of [/^Urgent/, /^Waiting on customer/, /^Scheduled today/, /^Problems/]) {
      await press(page, page.getByRole("link", { name: tab }));
      await ready(page);
      await beat(page, 1300);
    }
    await press(page, page.getByRole("link", { name: /^New/ }));
    await ready(page);
    await beat(page, 800);
    // The newest request nobody holds in New, else in Urgent (so "Take this request" shows).
    const unheld = () =>
      page.locator('main a[href^="/admin/requests/"]:visible', { hasText: "Nobody" }).first();
    let card = unheld();
    if (!(await card.count())) {
      await press(page, page.getByRole("link", { name: /^Urgent/ }));
      await ready(page);
      card = unheld();
    }
    if (await nothingLeft(card, still)) return;
    await glide(page, card);
    await beat(page, 700);
    await still("card");
    await press(page, card);
    await ready(page);
    await beat(page, 1200);
    await still("request");
    await bring(page, page.getByRole("heading", { name: "Request" }), 1400);
    await beat(page, 1500);
    await scrollTo(page, 0, 1000);
    const take = page.getByRole("button", { name: "Take this request" });
    if (await take.count()) {
      await press(page, take);
      await page.getByRole("heading", { name: "Who holds it" }).waitFor();
      await beat(page, 1600);
      await still("taken");
    }
  },

  // Storyboard 5 (second half): the waiting pro, documents one by one, then the pro.
  async pros(page, still) {
    await page.goto(`${base}/admin/pros`);
    await ready(page);
    await beat(page, 1200);
    let card = page.locator('main a[href^="/admin/pros/"]', { hasText: WAITING_PRO }).first();
    if (!(await card.count())) card = page.locator('main a[href^="/admin/pros/"]').first();
    if (await nothingLeft(card, still)) return;
    await press(page, card);
    await ready(page);
    await beat(page, 1500);
    await still("pro");
    await bring(page, page.getByRole("heading", { name: "Documents", exact: true }));
    await beat(page, 1200);
    // A document opens in a new tab in the product; the recording has no tab bar, so the
    // tour shows the file in place and comes back (images only: headless Edge downloads PDFs).
    const file = page.getByRole("link", { name: /^Open the file/ }).first();
    if (await file.count()) {
      const href = await file.getAttribute("href");
      await glide(page, file);
      await beat(page, 500);
      const response = await page.goto(new URL(href, base).href);
      const type = response?.headers()["content-type"] ?? "";
      if (type.startsWith("image/")) {
        await beat(page, 2500);
        await still("document");
      }
      await page.goBack();
      await ready(page);
      await bring(page, page.getByRole("heading", { name: "Documents", exact: true }), 600);
    }
    // Approve each pending document, one at a time (the list re-renders after each).
    for (let i = 0; i < 6; i += 1) {
      const approve = page.locator("main form button[name='decision'][value='approved']").first();
      if (!(await approve.count())) break;
      await press(page, approve);
      await page.waitForLoadState("networkidle");
      await beat(page, 1300);
    }
    await still("documents-approved");
    const approvePro = page.getByRole("button", { name: "Approve pro" });
    if (await approvePro.count()) {
      await press(page, approvePro);
      await beat(page, 900);
      await still("confirm");
      await press(page, page.getByRole("button", { name: "Yes, approve" }));
      await page.waitForLoadState("networkidle");
      await scrollTo(page, 0, 1200);
      await beat(page, 1800);
      await still("approved");
    }
  },

  // Storyboard 14: support.
  async support(page, still) {
    await page.goto(`${base}/admin/support`);
    await ready(page);
    await beat(page, 1200);
    const ticket = page.locator('main a[href^="/admin/support/"]').first();
    if (await nothingLeft(ticket, still)) return;
    await press(page, ticket);
    await ready(page);
    await beat(page, 2000);
    await still("ticket");
    const inProgress = page.getByRole("button", { name: "In progress" });
    if (await inProgress.count()) {
      await press(page, inProgress);
      await page.waitForLoadState("networkidle");
      await beat(page, 1500);
      await still("in-progress");
    }
  },

  // Storyboard 14: KPIs (range, hover, keyboard).
  async kpis(page, still) {
    await page.goto(`${base}/admin/kpis`);
    await ready(page);
    await beat(page, 1500);
    await still("30d");
    for (const range of ["Last 7 days", "Last 90 days", "Last 30 days"]) {
      await press(page, page.getByRole("link", { name: range }));
      await ready(page);
      await beat(page, 1400);
    }
    // The day chart: the focusable group (arrow keys move the day); the first one is requests.
    const chart = page.locator('main [role="group"][tabindex="0"]').first();
    await bring(page, chart, 1400);
    const box = await glide(page, chart);
    // Sweep the pointer across the days, slowly enough for the tooltip to follow.
    for (let k = 0.08; k <= 0.92; k += 0.06) {
      await page.mouse.move(box.x + box.width * k, box.y + box.height * 0.5, { steps: 6 });
      await beat(page, 160);
    }
    await still("hover");
    await page.mouse.move(box.x + box.width + 40, box.y - 30, { steps: 10 });
    await chart.focus();
    await beat(page, 500);
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("ArrowLeft");
      await beat(page, 380);
    }
    await still("keyboard");
    await beat(page, 800);
  },

  // Storyboard 13: the dispute, both sides, a partial, the confirmation.
  async disputes(page, still) {
    await page.goto(`${base}/admin/disputes`);
    await ready(page);
    await beat(page, 1300);
    const link = DISPUTE_CODE
      ? page.getByRole("link", { name: DISPUTE_CODE }).first()
      : page.locator('main a[href^="/admin/disputes/"]').first();
    if (await nothingLeft(link, still)) return;
    await press(page, link);
    await ready(page);
    await beat(page, 1400);
    await still("detail");
    for (const heading of ["The customer's report", "The pro's reply", "Photos", "Money"]) {
      const h = page.getByRole("heading", { name: heading });
      if (await h.count()) {
        await bring(page, h, 1100);
        await beat(page, 1700);
      }
    }
    await still("money");
    const partial = page.locator("input[name='decision-choice'][value='partial']");
    if (!(await partial.count())) {
      // Resolved in an earlier take: nothing left to decide. Reseed for the full scene.
      await still("already-resolved");
      return;
    }
    await bring(page, page.getByRole("heading", { name: "Resolve" }), 1100);
    await press(page, partial);
    await beat(page, 500);
    await type(page, page.getByLabel("Amount released to the pro"), PARTIAL, 110);
    await type(
      page,
      page.locator("main textarea"),
      "Partial: one wall needs a touch-up, the rest is as quoted.",
      30,
    );
    await beat(page, 600);
    await press(page, page.getByRole("button", { name: "Review the decision" }));
    await beat(page, 1500);
    await still("confirm");
    const code = page.locator("main form input[autocapitalize='characters']");
    if (await code.count()) {
      const jobCode = (await page.locator("main h1").textContent()).match(/JF-\d+/)?.[0] ?? "";
      await type(page, code, jobCode, 90);
    }
    await press(page, page.locator("main form button[type='submit']"));
    // The refund is a real Stripe TEST call: the page says "Resolving..." for a few seconds.
    // The decision has landed once its form is gone.
    await partial.waitFor({ state: "detached", timeout: 45000 });
    await page.waitForLoadState("networkidle");
    await scrollTo(page, 0, 1200);
    await beat(page, 2500);
    await still("resolved");
  },

  // Storyboard 1: the public site.
  async site(page, still) {
    for (const path of ["/", "/app", "/for-pros"]) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      await beat(page, 1500);
      await still(path === "/" ? "landing" : path.slice(1));
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await scrollTo(page, Math.min(height, 2600), 3200);
      await beat(page, 700);
      await scrollTo(page, 0, 1200);
      await beat(page, 500);
    }
  },

  // The Spanish variants: heroes only.
  async "site-es"(page, still) {
    for (const path of ["/es", "/es/app", "/es/for-pros"]) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      await beat(page, 2200);
      await still(path.slice(1).replace("/", "-"));
    }
  },

  // Storyboard 15: the closing shot.
  async closing(page, still) {
    await page.goto(`${base}/`);
    await page.waitForLoadState("networkidle");
    await page.mouse.move(VIEW.width + 50, VIEW.height + 50); // the cursor off the frame
    await beat(page, 5000);
    await still("hero");
  },
};

await signIn();
for (const id of WANTED) await scene(id, STORY[id][0], STORY[id][1], SCENES[id]);
await browser.close();
rmSync(RAW, { recursive: true, force: true });

const list = scenes
  .map(
    (s) =>
      `${s.number}. **${s.title}** (storyboard ${s.story}) - \`${s.file}\`, ${s.seconds} s` +
      (s.failed ? ` - FAILED: ${s.failed}` : "") +
      (s.issues.length ? `\n   - issues: ${s.issues.join("; ")}` : "") +
      (s.foreign.length ? `\n   - other hosts: ${s.foreign.join(", ")}` : ""),
  )
  .join("\n");
writeFileSync(join(OUT, "scenes.md"), `# Web tour scenes (${base})\n\n${list}\n`);
writeFileSync(join(OUT, "scenes.json"), JSON.stringify(scenes, null, 2));
const failed = scenes.filter((s) => s.failed).length;
console.log(`${scenes.length} scenes, ${failed} failed -> ${OUT}`);
process.exit(failed ? 1 : 0);
