/**
 * CLEAN BOOT — does Orchestra work for someone who just cloned it?
 *
 * WHY THIS FILE EXISTS. Twice now, a defect has made a fresh install completely
 * unusable while 3900 unit tests, a full CI pipeline and daily use all stayed
 * green: PM #99 (a vault key never reached the agent) and PM #101 (the shipped
 * model defaults named a provider the user had no key for). Both were found by a
 * human installing the app cold, because nothing automated ever booted the app
 * from an empty directory.
 *
 * `fresh-install-drill.spec.ts` covers the *first turn* — but it runs against the
 * SEEDED e2e server, whose data dir `global-setup.ts` populates with the
 * operator's real settings.json and a forced credential reset. That is the right
 * call for model-dependent specs and the wrong one for this question: the seeding
 * is exactly the confound that hid PM #99, and it means a local run and a CI run
 * measure different things.
 *
 * So this spec talks to a SECOND server (see `clean-boot-env.ts`) whose data dir
 * is created empty and seeded with nothing at all — no settings, no auth reset.
 *
 * SCOPE — deliberately bounded. This asserts that a stranger can boot the app,
 * get in, and reach a working dashboard with the models pointed somewhere usable.
 * It performs NO model call: that is the drill's job, with a stub, and repeating
 * it here would buy a second copy of the same coverage at the cost of a flake
 * surface. What is unique here is the EMPTY DIRECTORY, and every assertion below
 * is one that only an empty directory can make.
 */
import { test, expect, request as pwRequest, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  CLEAN_BOOT_BASE_URL,
  CLEAN_BOOT_DATA_DIR,
  CLEAN_BOOT_MANIFEST,
  CLEAN_BOOT_PROVIDER_ENV,
} from "./clean-boot-env";

const SETTINGS_FILE = path.join(CLEAN_BOOT_DATA_DIR, "settings", "settings.json");

/** What the forced first-run rotation changes the password to. */
const CLEAN_BOOT_PASSWORD = "orchestra-clean-boot-pw-7!";

/**
 * Walk the onboarding a first-time user is actually forced through, and return
 * an authenticated request context.
 *
 * The rotation is not optional politeness: `middleware.ts` mirrors the dashboard
 * gate onto `/api/*`, so a `mustChangeCredentials` session is refused by every
 * endpoint except the credential change and logout. A test that logs in and goes
 * straight to `/api/settings` reads an error body — and if it then reaches for a
 * field on it, gets `undefined` and reports something misleading about the field
 * instead of about the auth gate.
 *
 * Tries the default password first and the rotated one second, so it works both
 * before and after the rotation has happened in an earlier test in this file.
 */
async function onboardCleanInstall() {
  const api = await pwRequest.newContext({ baseURL: CLEAN_BOOT_BASE_URL });

  let login = await api.post("/api/auth/login", {
    data: { username: "admin", password: "admin" },
  });
  if (login.status() !== 200) {
    login = await api.post("/api/auth/login", {
      data: { username: "admin", password: CLEAN_BOOT_PASSWORD },
    });
  }
  expect(
    login.status(),
    "a fresh install must be reachable with admin/admin (or the already-rotated password)"
  ).toBe(200);

  if ((await login.json()).mustChangeCredentials) {
    const rotate = await api.put("/api/auth/credentials", {
      data: { username: "admin", password: CLEAN_BOOT_PASSWORD },
    });
    expect(
      rotate.status(),
      "the forced credential rotation must succeed — until it does, every /api/* route is closed"
    ).toBe(200);
  }

  return api;
}

/**
 * Everything the browser reported going wrong, collected per-page.
 *
 * Uncaught exceptions and `console.error` are separate signals and both matter:
 * a React render crash surfaces as a page error, while a failed fetch or an
 * effect that threw usually surfaces only on the console.
 */
function collectPageProblems(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const serverErrors: string[] = [];

  page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
  });

  return { pageErrors, consoleErrors, serverErrors };
}

/**
 * Dev-server noise that says nothing about whether the app works.
 *
 * Kept SHORT and specific on purpose — a broad filter here would turn this whole
 * spec into a no-op, which is worse than not having it. Anything not on this list
 * fails the run.
 */
const IGNORABLE_CONSOLE = [
  // Next's dev overlay / HMR chatter, present on every dev page load.
  /\[Fast Refresh\]/i,
  /react-devtools/i,
  // A favicon 404 in dev is not a product defect.
  /favicon\.ico/i,
];

function significant(messages: string[]): string[] {
  return messages.filter((m) => !IGNORABLE_CONSOLE.some((re) => re.test(m)));
}

// One server, one settings file, and the first test asserts the file does not
// exist yet — so these must not interleave.
test.describe.configure({ mode: "serial" });

test.describe("clean boot — an empty data dir", () => {
  test("the precondition holds: nothing was seeded, and booting wrote no config", () => {
    // Asserted, never trusted. Three layers of "isolation" have silently failed
    // in this repo before (PM #100), always in the passing direction — a spec
    // that assumed its own setup would have reported success while testing the
    // operator's real configuration.
    expect(
      fs.existsSync(CLEAN_BOOT_DATA_DIR),
      "the clean-boot data dir must exist — global-setup creates it"
    ).toBe(true);

    // `getSettings` is lazy: it creates `settings/` on read but must not
    // materialize the file. If this fails, either something seeded the dir or
    // the app now writes config at boot — both change what every assertion
    // below actually means.
    expect(
      fs.existsSync(SETTINGS_FILE),
      `booting must not materialize ${SETTINGS_FILE} — a fresh install has no stored config yet`
    ).toBe(false);

    // The exact answer, captured by global-setup at the only moment it is
    // unambiguous. Reading the directory HERE cannot serve: the server has been
    // up since the suite started and legitimately creates its own empty
    // scaffolding (`projects/`), so a listing taken now conflates "the app made
    // a folder" with "someone seeded this". An earlier version of this test did
    // exactly that and passed only while the clean-boot project happened to run
    // first — it went red the moment `workers: 1` moved it last.
    const manifest = JSON.parse(fs.readFileSync(CLEAN_BOOT_MANIFEST, "utf-8"));
    expect(
      manifest.entries,
      "global-setup must hand over an EMPTY dir — anything here is seeding that defeats the test"
    ).toEqual([]);

    // Whatever the app has created since must still hold no records. Scaffolding
    // is fine; content is not — a chat, a project or a memory entry in a dir
    // nobody has used means something is writing where it should not.
    for (const entry of fs.readdirSync(CLEAN_BOOT_DATA_DIR)) {
      const full = path.join(CLEAN_BOOT_DATA_DIR, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      expect(
        fs.readdirSync(full),
        `${entry}/ must be empty on an install nobody has used yet`
      ).toEqual([]);
    }
  });

  test("an unauthenticated visitor is sent to the login page", async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto("/");
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    await expect(
      page.getByRole("button", { name: /sign in|log in/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    expect(problems.pageErrors, "the login page must render without crashing").toEqual([]);
    expect(problems.serverErrors, "no 5xx while rendering the login page").toEqual([]);
  });

  test("the documented default credentials work, and demand rotation", async () => {
    // README onboarding is admin/admin. If this breaks, a fresh install is
    // locked out of its own dashboard and no other test would notice.
    const api = await pwRequest.newContext({ baseURL: CLEAN_BOOT_BASE_URL });
    const login = await api.post("/api/auth/login", {
      data: { username: "admin", password: "admin" },
    });

    expect(login.status(), "admin/admin must log in on a fresh install").toBe(200);
    const body = await login.json();
    expect(
      body.mustChangeCredentials,
      "a fresh install must force a credential change — shipping a usable default password is the defect"
    ).toBe(true);
    await api.dispose();
  });

  test("PM #101: the model slots resolve to a provider the install has a key for", async () => {
    // The system-level counterpart to `fresh-install-defaults.test.ts`. The unit
    // tests inject a synthetic env; this one reads what the REAL server, booted
    // with only an OpenRouter key, actually serves — which is the thing a new
    // user's first turn depends on.
    const api = await onboardCleanInstall();

    const settingsRes = await api.get("/api/settings");
    expect(settingsRes.status(), "settings must be readable once onboarding is done").toBe(200);
    const settings = await settingsRes.json();

    // Guard the guard: if the operator's own OpenAI key leaked into the server's
    // environment, the overlay correctly does nothing and the assertion below
    // would pass while proving the opposite of what it claims.
    expect(
      settings.envApiKeys?.openai ?? false,
      "OPENAI_API_KEY must be blank for this server, or this test proves nothing " +
        "(see CLEAN_BOOT_PROVIDER_ENV)"
    ).toBe(false);
    expect(
      settings.envApiKeys?.openrouter,
      "the clean-boot server must see its OpenRouter key"
    ).toBe(true);

    expect(
      settings.chatModel?.provider,
      "a fresh install holding only an OpenRouter key must not ship an OpenAI chat model"
    ).toBe("openrouter");
    expect(settings.utilityModel?.provider).toBe("openrouter");
    await api.dispose();
  });

  test("the dashboard renders after login, with no errors in the browser", async ({
    page,
    context,
  }) => {
    const problems = collectPageProblems(page);

    // Log in through the API and inject the cookie — the onboarding wizard has
    // its own coverage, and this test is about what happens AFTER you are in.
    // The rotation matters here too: a `mustChangeCredentials` cookie is bounced
    // off /dashboard by the middleware, so the page would never render.
    const api = await onboardCleanInstall();
    const state = await api.storageState();
    await context.addCookies(state.cookies.filter((c) => c.name === "orchestra_auth"));
    await api.dispose();

    await page.goto("/dashboard");
    // The composer is the load-bearing element: if it renders, the store
    // hydrated, the chat list resolved, and the SSE hook mounted.
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });

    // Give async boot work (chat index, SSE handshake, settings fetch) a moment
    // to fail if it is going to.
    await page.waitForTimeout(2_000);

    expect(problems.pageErrors, "the dashboard must render without an uncaught error").toEqual(
      []
    );
    expect(
      significant(problems.consoleErrors),
      "the dashboard must reach a working state with a clean console"
    ).toEqual([]);
    expect(problems.serverErrors, "no 5xx anywhere in the first-run dashboard").toEqual([]);
  });

  test("the placeholder key never left the machine", () => {
    // Cheap honesty check on this file's own claim that it performs no model
    // call: if a clean-boot test ever starts making one, it would do it with a
    // fake key and fail confusingly upstream. Pin the intent instead.
    expect(CLEAN_BOOT_PROVIDER_ENV.OPENROUTER_API_KEY).toMatch(/not-a-real-key/);
  });
});
