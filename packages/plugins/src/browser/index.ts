import { definePlugin, defineTool, type LoginVault, type ToolContext } from "@z/core";
import type { Browser, BrowserContext, ElementHandle, Frame, Page, Request } from "playwright-core";
import { z } from "zod";
import { assertPublicUrl, errorMessage, sleep, truncate } from "../util.ts";
import { startGuardProxy, type GuardProxy } from "./guard.ts";
import { DESCRIBE_SCRIPT, LOGIN_FIELDS_SCRIPT, RESOLVE_SCRIPT, SNAPSHOT_SCRIPT, invoke, type SnapshotResult } from "./snapshot.ts";
import { totp } from "./totp.ts";

const ACTION_TIMEOUT = 20_000;
const IDLE_MS = 5 * 60_000;
const VIEWPORT = { width: 1280, height: 800 };
const INSTALL_HINT =
  "Install it on the z server with `pnpm --filter @z/plugins add playwright-core` and `npx playwright install chromium`, " +
  "or set a Chrome executable path or a CDP URL in the Browser plugin settings.";

/**
 * Z_ALLOW_PRIVATE_BROWSER=1 on the z server lets the browser open localhost and private networks
 * (a self-hosted app, a local test page). Off by default: pages could otherwise probe the LAN.
 */
const allowPrivate = process.env.Z_ALLOW_PRIVATE_BROWSER === "1";

/** Checked without loading it, so the plugin can say up front that it can't work. */
const installed = (() => {
  try {
    import.meta.resolve("playwright-core");
    return true;
  } catch {
    return false;
  }
})();

// ─── Session ────────────────────────────────────────────────────────────────
// One browser and one context, shared by every caller (tool calls carry no task or chat id),
// launched on first use and closed after IDLE_MS without calls. Calls run one at a time.

type Session = {
  key: string;
  browser: Browser;
  context: BrowserContext;
  page: Page | null;
  proxy: GuardProxy;
  /** Requests the guard refused during the current call. */
  blocked: string[];
  dialogs: string[];
  /** Confirm dialogs raised by an approved action (e.g. "Delete this?"); dismiss the rest. */
  acceptDialogs: boolean;
  idle?: NodeJS.Timeout;
  closed?: boolean;
};

let current: Promise<Session> | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Element numbers are never reused within a process, so a stale number can't hit another element. */
let nextRef = 1;
/** What each number showed when the agent last saw it; approval cards and pre-action checks read this. */
const seen = new Map<number, { role: string; name: string; secret: boolean; host: string }>();
/** Origin of the page the agent last saw, and the vault it was given: browser_sign_in's approval card reads these. */
let lastOrigin: string | null = null;
let lastVault: LoginVault | undefined;

const firstLine = (text: string) => text.split("\n")[0]!.trim();

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

async function launch(settings: Record<string, string>, key: string): Promise<Session> {
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch {
    throw new Error(`Browser unavailable: playwright-core is not installed. ${INSTALL_HINT}`);
  }
  const blocked: string[] = [];
  const proxy = await startGuardProxy((target) => blocked.push(target), allowPrivate);
  // `<-loopback>` stops Chromium's implicit proxy bypass for localhost, so those go through the guard too.
  const viaGuard = { server: proxy.server, bypass: "<-loopback>" };
  let browser: Browser;
  let context: BrowserContext;
  try {
    if (settings.cdpUrl) {
      browser = await pw.chromium.connectOverCDP(settings.cdpUrl, { timeout: ACTION_TIMEOUT });
      context = await browser.newContext({ proxy: viaGuard, viewport: VIEWPORT, acceptDownloads: false });
    } else {
      browser = await pw.chromium.launch({
        ...(settings.executablePath ? { executablePath: settings.executablePath } : {}),
        proxy: viaGuard,
        timeout: 60_000,
        // WebRTC can reach LAN addresses over UDP, outside the proxy.
        args: ["--force-webrtc-ip-handling-policy", "--webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
      context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false });
    }
  } catch (error) {
    proxy.close();
    throw new Error(`Browser unavailable: ${firstLine(errorMessage(error))}. ${INSTALL_HINT}`);
  }
  context.setDefaultTimeout(ACTION_TIMEOUT);
  context.setDefaultNavigationTimeout(ACTION_TIMEOUT);

  const session: Session = { key, browser, context, page: null, proxy, blocked, dialogs: [], acceptDialogs: false };
  // New tabs (target=_blank, window.open) become the page the agent is looking at.
  context.on("page", (page) => {
    session.page = page;
    page.on("dialog", (dialog) => {
      const accept = session.acceptDialogs || dialog.type() === "beforeunload";
      session.dialogs.push(`${dialog.type()} "${truncate(dialog.message(), 200)}" (${accept ? "accepted" : "dismissed"})`);
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on("close", () => {
      if (session.page === page) session.page = context.pages().at(-1) ?? null;
    });
  });
  browser.on("disconnected", () => void close(session));
  return session;
}

async function close(session: Session) {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.idle);
  if (current && (await current.catch(() => null)) === session) current = null;
  await session.context.close().catch(() => {});
  // For a CDP connection this disconnects and leaves the user's Chrome running.
  await session.browser.close().catch(() => {});
  session.proxy.close();
}

async function open(settings: Record<string, string>): Promise<Session> {
  const key = JSON.stringify([settings.executablePath ?? "", settings.cdpUrl ?? ""]);
  const existing = current && (await current.catch(() => null));
  if (existing && existing.key === key && existing.browser.isConnected()) return existing;
  if (existing) await close(existing);
  const starting = launch(settings, key);
  current = starting;
  starting.catch(() => {
    if (current === starting) current = null;
  });
  return starting;
}

/** Run `fn` against the shared browser, one call at a time. */
function withBrowser<T>(ctx: ToolContext, fn: (session: Session) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    ctx.signal.throwIfAborted();
    lastVault = ctx.vault;
    const session = await open(ctx.settings);
    clearTimeout(session.idle);
    session.blocked.length = 0;
    session.dialogs.length = 0;
    try {
      return await fn(session);
    } finally {
      session.acceptDialogs = false;
      session.idle = setTimeout(() => void close(session), IDLE_MS);
      session.idle.unref();
    }
  });
  queue = run.catch(() => {});
  return run;
}

function activePage(session: Session): Page {
  if (!session.page || session.page.isClosed()) throw new Error("No page is open. Call browser_open first.");
  return session.page;
}

// ─── Page helpers ───────────────────────────────────────────────────────────

async function snapshot(page: Page, scope: { ref?: number; selector?: string } = {}) {
  const source = invoke(SNAPSHOT_SCRIPT, {
    next: nextRef,
    ref: scope.ref ?? null,
    selector: scope.selector ?? null,
    hrefs: scope.ref !== undefined,
    maxScan: 200_000,
  });
  let result: SnapshotResult;
  try {
    result = await page.evaluate(source);
  } catch (error) {
    // The page navigated mid-evaluation; read the new document once it's there.
    if (!/context was destroyed|navigat/i.test(errorMessage(error))) throw error;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    result = await page.evaluate(source);
  }
  if ("error" in result) throw new Error(result.error);
  nextRef = Math.max(nextRef, result.next);
  const host = hostOf(result.url);
  lastOrigin = originOf(result.url);
  for (const [ref, role, name, secret] of result.elements) seen.set(ref, { role, name, secret, host });
  for (const ref of seen.keys()) {
    if (seen.size <= 5000) break;
    seen.delete(ref);
  }
  return result;
}

function pageOutput(session: Session, page: Extract<SnapshotResult, { text: string }>, maxChars: number, find?: string) {
  let text = page.text;
  let matches: number | undefined;
  if (find) {
    const needle = find.toLowerCase();
    const lines = text.split("\n").filter((line) => line.toLowerCase().includes(needle));
    matches = lines.length;
    text = lines.join("\n");
  }
  const shown = truncate(text, maxChars);
  return {
    url: page.url,
    title: page.title,
    text: shown,
    truncated: shown.length < text.length,
    ...(matches !== undefined ? { matches } : {}),
    ...(session.blocked.length ? { blockedRequests: [...new Set(session.blocked)].slice(0, 20) } : {}),
    ...(session.dialogs.length ? { dialogs: [...session.dialogs] } : {}),
  };
}

/** The element behind `ref`, refusing if it's gone or no longer what the agent (and approval card) saw. */
async function element(page: Page, ref: number): Promise<ElementHandle> {
  const handle = await page.evaluateHandle(invoke(RESOLVE_SCRIPT, ref));
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    throw new Error(`Element [${ref}] is not on the current page. Call browser_read for fresh numbers.`);
  }
  const now = (await page.evaluate(invoke(DESCRIBE_SCRIPT, ref))) as { role: string; name: string } | null;
  const before = seen.get(ref);
  if (before && now && now.name !== before.name) {
    await el.dispose();
    throw new Error(
      `Element [${ref}] changed from ${before.role} "${before.name}" to ${now.role} "${now.name}". Call browser_read and try again.`,
    );
  }
  return el as ElementHandle;
}

/** Wait for whatever an action set off: a navigation, a new tab, or just network activity. */
async function settle(session: Session, page: Page, started: () => boolean, signal: AbortSignal) {
  await sleep(400, signal);
  const target = session.page && !session.page.isClosed() ? session.page : page;
  if (target === page && started()) {
    await page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 10_000, signal }).catch(() => {});
  }
  await target.waitForLoadState("load", { timeout: 10_000, signal }).catch(() => {});
  await target.waitForLoadState("networkidle", { timeout: 2_000, signal }).catch(() => {});
  return target;
}

/** Run `action` on `page`, then wait for what it set off; resolves to the page it led to. */
async function andSettle(session: Session, page: Page, signal: AbortSignal, action: () => Promise<void>): Promise<Page> {
  let navigating = false;
  let committed = false;
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigating = true;
  };
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) committed = true;
  };
  page.on("request", onRequest);
  page.on("framenavigated", onNavigated);
  try {
    await action();
    return await settle(session, page, () => navigating && !committed, signal);
  } finally {
    page.off("request", onRequest);
    page.off("framenavigated", onNavigated);
  }
}

/** Perform an approved action on element `ref`, then return a fresh snapshot of where it led. */
function act(ctx: ToolContext, ref: number, action: (el: ElementHandle, page: Page) => Promise<void>) {
  return withBrowser(ctx, async (session) => {
    const page = activePage(session);
    const el = await element(page, ref);
    session.acceptDialogs = true;
    try {
      const target = await andSettle(session, page, ctx.signal, () => action(el, page));
      return pageOutput(session, await snapshot(target), 8000);
    } finally {
      await el.dispose().catch(() => {});
    }
  });
}

/** `"Place order" on shop.example.com`, from what the agent was shown. */
function describe(ref: number): string {
  const el = seen.get(ref);
  if (!el) return `element [${ref}]`;
  return `${el.name ? `"${truncate(el.name, 60)}"` : el.role} on ${el.host}`;
}

const typed = (ref: number, text: string) =>
  seen.get(ref)?.secret ? "••••" : `"${truncate(text.replace(/\s+/g, " "), 60)}"`;

// ─── Tools ──────────────────────────────────────────────────────────────────

const ELEMENT = z.number().int().min(1).describe("Element number from the latest snapshot, e.g. 12 for [12]");

const openTool = defineTool({
  description:
    "Open a URL in a real headless browser (runs JavaScript) and return its text with numbered interactive " +
    "elements like `[12] button \"Sign in\"`, for browser_click / browser_type / browser_select / browser_submit. " +
    "Prefer web_fetch_page for plain reading; use this for interactive or JavaScript-heavy pages.",
  risk: "read",
  inputSchema: z.object({
    url: z.string().min(1),
    maxChars: z.number().int().min(1000).max(20_000).default(8000),
  }),
  execute: ({ url, maxChars }, ctx) =>
    withBrowser(ctx, async (session) => {
      const target = await (allowPrivate ? httpUrl(url) : assertPublicUrl(url)).catch((error) => {
        throw new Error(`Refusing to open ${url}: ${errorMessage(error)}`);
      });
      ctx.log(`open ${target.origin}`);
      const page = session.page && !session.page.isClosed() ? session.page : await session.context.newPage();
      session.page = page;
      let status: number | null = null;
      try {
        status = (await page.goto(target.href, { waitUntil: "domcontentloaded", signal: ctx.signal }))?.status() ?? null;
      } catch (error) {
        const message = firstLine(errorMessage(error));
        // The guard refuses https by failing the CONNECT tunnel.
        const blocked = /ERR_TUNNEL_CONNECTION_FAILED/.test(message) && session.blocked.at(-1);
        if (blocked) throw new Error(`Refusing to open ${url}: it led to a private address (${blocked})`);
        throw new Error(`Opening ${url} failed: ${message}`);
      }
      // Plain http is refused with a 403 page from the guard; don't leave it showing.
      const blocked = session.blocked.find((origin) => hostOf(origin) === hostOf(page.url()));
      if (blocked) {
        await page.goto("about:blank").catch(() => {});
        throw new Error(`Refusing to open ${url}: it led to a private address (${blocked})`);
      }
      await page.waitForLoadState("load", { timeout: 10_000, signal: ctx.signal }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 2_000, signal: ctx.signal }).catch(() => {});
      return { status, ...pageOutput(session, await snapshot(page), maxChars) };
    }),
});

const read = defineTool({
  description:
    "Read the current browser page again (after it changed, or beyond a truncated snapshot). Optionally scope it " +
    "to a CSS selector or an element number (which also lists link URLs), or keep only lines containing `find`.",
  risk: "read",
  inputSchema: z.object({
    selector: z.string().min(1).optional(),
    element: ELEMENT.optional(),
    find: z.string().min(1).optional().describe("Case-insensitive text; only matching lines are returned"),
    maxChars: z.number().int().min(500).max(20_000).default(8000),
  }),
  execute: ({ selector, element: ref, find, maxChars }, ctx) =>
    withBrowser(ctx, async (session) => {
      const page = activePage(session);
      const scope = ref !== undefined ? { ref } : selector ? { selector } : {};
      return pageOutput(session, await snapshot(page, scope), maxChars, find);
    }),
});

type Screenshot = { url: string; title: string; description: string; mediaType: "image/png"; data: string };

const screenshot = {
  ...defineTool({
    description: "Take a PNG screenshot of the current browser viewport, for checking layout or anything text misses.",
    risk: "read",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withBrowser(ctx, async (session) => {
        const page = activePage(session);
        const png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", signal: ctx.signal });
        const { y, height } = (await page.evaluate(
          "({ y: Math.round(scrollY), height: document.documentElement.scrollHeight })",
        )) as { y: number; height: number };
        const title = await page.title();
        const url = page.url();
        const description =
          `Screenshot of "${title}" (${url}): ${VIEWPORT.width}×${VIEWPORT.height} viewport, ` +
          `scrolled to ${y}px of ${height}px. Use browser_read for the page text.`;
        const shot: Screenshot = { url, title, description, mediaType: "image/png", data: png.toString("base64") };
        // Persisted tool events and text-only fallbacks get the description, not ~100 KB of base64.
        return { ...shot, toJSON: () => ({ url, title, description }) };
      }),
  }),
  /** AI SDK `toModelOutput`: hands the PNG itself to vision models. */
  toModelOutput: ({ output }: { output: Partial<Screenshot> }) =>
    output.data
      ? {
          type: "content" as const,
          value: [
            { type: "text" as const, text: output.description ?? "" },
            { type: "file" as const, mediaType: "image/png", data: { type: "data" as const, data: output.data } },
          ],
        }
      : { type: "text" as const, value: output.description ?? "Screenshot unavailable." },
};

const click = defineTool({
  description: "Click a numbered element on the current browser page. Returns the page afterwards.",
  risk: "write",
  inputSchema: z.object({ element: ELEMENT }),
  summarize: ({ element: ref }) => `Click ${describe(ref)}`,
  execute: ({ element: ref }, ctx) => {
    ctx.log(`click [${ref}]`);
    return act(ctx, ref, (el) => el.click({ signal: ctx.signal }));
  },
});

const type = defineTool({
  description:
    "Replace the text in a numbered field on the current browser page, without submitting. " +
    "Use browser_submit to type and press Enter.",
  risk: "write",
  inputSchema: z.object({ element: ELEMENT, text: z.string().max(10_000) }),
  summarize: ({ element: ref, text }) => `Type ${typed(ref, text)} into ${describe(ref)}`,
  execute: ({ element: ref, text }, ctx) => {
    ctx.log(`type into [${ref}]`);
    return act(ctx, ref, (el) => fill(el, text, ctx.signal));
  },
});

const submit = defineTool({
  description:
    "Submit a form from a numbered field or button on the current browser page: optionally type `text` into it " +
    "first, then press Enter. This sends data to the site.",
  risk: "external",
  inputSchema: z.object({ element: ELEMENT, text: z.string().max(10_000).optional() }),
  summarize: ({ element: ref, text }) =>
    text === undefined ? `Submit ${describe(ref)}` : `Submit ${typed(ref, text)} via ${describe(ref)}`,
  execute: ({ element: ref, text }, ctx) => {
    ctx.log(`submit [${ref}]`);
    return act(ctx, ref, async (el) => {
      if (text !== undefined) await fill(el, text, ctx.signal);
      await el.press("Enter", { signal: ctx.signal });
    });
  },
});

const select = defineTool({
  description: "Choose option(s) of a numbered <select> on the current browser page, by label or value.",
  risk: "write",
  inputSchema: z.object({ element: ELEMENT, options: z.array(z.string()).min(1).max(50) }),
  summarize: ({ element: ref, options }) =>
    `Select ${options.map((o) => `"${truncate(o, 40)}"`).join(", ")} in ${describe(ref)}`,
  execute: ({ element: ref, options }, ctx) => {
    ctx.log(`select in [${ref}]`);
    return act(ctx, ref, async (el) => {
      await el.selectOption(options, { signal: ctx.signal });
    });
  },
});

// ─── Saved sign-ins ─────────────────────────────────────────────────────────
// The model asks for a sign-in; z fills the owner's saved login into the page itself, so the
// password never enters the model's context, tool inputs or outputs, or task events.
// (Idea from CopilotKit OpenDuet's password vault, MIT; re-implemented here on Playwright.)

const LOCALHOST = ["localhost", "127.0.0.1", "[::1]"];

/** http(s) check without the public-address rule, for Z_ALLOW_PRIVATE_BROWSER. */
async function httpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are allowed");
  return url;
}

/** `example.com` or `https://example.com/login` → `https://example.com`. */
const expectedOrigin = (raw: string) => originOf(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);

type LoginFields = Record<"username" | "password" | "otp" | "submit", ElementHandle | null>;

/** The page's sign-in fields (see LOGIN_FIELDS_SCRIPT), handed to `fn` and disposed after. */
async function withLoginFields<T>(page: Page, fn: (fields: LoginFields) => Promise<T>): Promise<T> {
  const found = await page.evaluateHandle(`(${LOGIN_FIELDS_SCRIPT})()`);
  const handles = await Promise.all((["username", "password", "otp", "submit"] as const).map((key) => found.getProperty(key)));
  try {
    const [username, password, otp, submit] = handles.map((h) => h.asElement() as ElementHandle | null);
    return await fn({ username: username!, password: password!, otp: otp!, submit: submit! });
  } finally {
    await Promise.all([found, ...handles].map((h) => h.dispose().catch(() => {})));
  }
}

const signIn = defineTool({
  description:
    "Sign in on the current browser page with the login the owner saved for this exact site (Settings → Security → " +
    "Saved sign-ins). z fills the username, password and any authenticator code itself and submits; you never see " +
    "them, and must never ask the owner for a password in chat. Open the site's sign-in page with browser_open first. " +
    "Pass `origin` when you know which site you mean: z refuses if the page is anywhere else.",
  risk: "write",
  ownerOnly: true,
  inputSchema: z.object({
    origin: z.string().max(300).optional().describe("The site you expect to be on, e.g. https://example.com"),
  }),
  summarize: ({ origin }) => {
    const target = (origin && expectedOrigin(origin)) || lastOrigin;
    if (!target) return "Sign in with a saved login";
    const user = lastVault?.username(target);
    return `Sign in to ${hostOf(target)}${user ? ` as ${user}` : ""}`;
  },
  execute: ({ origin }, ctx) =>
    withBrowser(ctx, async (session) => {
      let page = activePage(session);
      const secrets: string[] = [];
      // Belt and braces: nothing a page echoes back (URL, title) may carry a filled value out.
      const scrub = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("••••"), text);
      const done = async (signedIn: boolean, note: string) => ({
        signedIn,
        url: scrub(page.url()),
        title: scrub(await page.title().catch(() => "")),
        note,
      });

      const here = originOf(page.url());
      if (!here || !/^https?:/.test(here)) return done(false, "No web page is open. Open the site's sign-in page with browser_open first.");
      const wanted = origin === undefined ? here : expectedOrigin(origin);
      if (wanted !== here) {
        return done(
          false,
          `Refused: the page is on ${here}, not ${wanted ?? origin}. A saved sign-in is only filled on its own site; ` +
            "this may be a look-alike. Do not retry on this page.",
        );
      }
      if (!here.startsWith("https:") && !LOCALHOST.includes(new URL(here).hostname)) {
        return done(false, `Refused: ${here} is not https, so the password would travel unencrypted.`);
      }
      if (!ctx.vault) return done(false, "Saved sign-ins are not available to this run.");
      const login = await ctx.vault.login(here);
      if (!login) {
        return done(
          false,
          `No sign-in is saved for ${here}. Ask the owner to add one under Settings → Security → Saved sign-ins ` +
            "(they have been notified), then try again. Never ask for the password in chat.",
        );
      }
      secrets.push(login.password);
      ctx.log(`sign in to ${here}`);

      // Re-checked before every fill: any step (or a script on the page) can redirect elsewhere.
      const onSite = () => originOf(page.url()) === here;
      let filledPassword = false;
      let filledCode = false;
      let missingCode = false;
      try {
        for (let step = 0; step < 4 && onSite() && !missingCode; step++) {
          const next = await withLoginFields(page, async (f) => {
            let field: ElementHandle;
            if (f.password && !filledPassword) {
              if (f.username) await f.username.fill(login.username, { signal: ctx.signal });
              if (!onSite()) return null;
              await f.password.fill(login.password, { signal: ctx.signal });
              filledPassword = true;
              field = f.password;
            } else if (f.otp && filledPassword && !filledCode) {
              if (!login.totp) {
                missingCode = true;
                return null;
              }
              const code = totp(login.totp);
              secrets.push(code);
              await f.otp.fill(code, { signal: ctx.signal });
              filledCode = true;
              field = f.otp;
            } else if (f.username && step === 0) {
              // Username-first flows show the password field on the next screen.
              await f.username.fill(login.username, { signal: ctx.signal });
              field = f.username;
            } else return null;
            const { submit } = f;
            return andSettle(session, page, ctx.signal, () =>
              submit ? submit.click({ signal: ctx.signal }) : field.press("Enter", { signal: ctx.signal }),
            );
          });
          if (!next) break;
          page = next;
        }
      } catch (error) {
        throw new Error(`Signing in to ${here} failed: ${scrub(firstLine(errorMessage(error)))}`);
      }

      if (!filledPassword) {
        return done(false, `Found no password field on ${page.url() === "about:blank" ? here : scrub(page.url())}. Open the site's sign-in page (or click its "Sign in" link) and try again.`);
      }
      if (missingCode) {
        return done(false, `${here} asks for a verification code and no authenticator secret is saved for it. Ask the owner to add it to the saved sign-in, or to finish signing in themselves.`);
      }
      const left = onSite() ? await withLoginFields(page, async (f) => (f.otp ? "code" : f.password ? "form" : null)) : null;
      if (left) {
        return done(
          false,
          left === "code"
            ? "The site still asks for a verification code: the saved authenticator secret may be wrong."
            : "The site still shows its sign-in form: the saved login may be wrong, or it wants something else (a captcha?). Tell the owner; do not try other credentials.",
        );
      }
      return done(true, `Signed in to ${here} with the saved login${filledCode ? " and an authenticator code" : ""}.`);
    }),
});

/** `fill` for inputs, textareas and contenteditables; keystrokes for custom widgets. */
async function fill(el: ElementHandle, text: string, signal: AbortSignal) {
  try {
    await el.fill(text, { signal });
  } catch (error) {
    if (!/not an <input>|not editable|contenteditable/i.test(errorMessage(error))) throw error;
    await el.click({ signal });
    await el.type(text, { signal });
  }
}

export default definePlugin({
  id: "browser",
  name: "Browser",
  description: installed
    ? "A real headless Chromium: open pages, read them with numbered elements, screenshot, click, type or " +
      "submit forms, and sign in with your saved logins without the model seeing them (with your approval). " +
      "Private-network addresses are blocked."
    : `Unavailable: playwright-core is not installed. ${INSTALL_HINT}`,
  settings: [
    { key: "executablePath", label: "Chrome/Chromium executable path (optional; defaults to Playwright's Chromium)" },
    { key: "cdpUrl", label: "Connect to a running Chrome over CDP instead (optional, e.g. http://localhost:9222)" },
  ],
  tools: { open: openTool, read, screenshot, click, type, submit, select, sign_in: signIn },
  enabledByDefault: installed,
});
