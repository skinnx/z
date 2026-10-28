/**
 * z service worker: offline app shell, and Web Push notices with Approve / Deny, or a question's
 * answer choices, right on the notification. Built into /sw.js by vite.config.ts, which injects the
 * build's file list.
 */
const PRECACHE = self.__PRECACHE__;
const CACHE = `z-shell-${self.__VERSION__}`;
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/badge-96.png"];
const ICON = "/icon-192.png";
const BADGE = "/badge-96.png";

const LABELS = {
  en: { approve: "Approve", deny: "Deny", approved: "Approved", denied: "Denied", decided: "Already decided", open: "Open", answered: "Answered", alreadyAnswered: "Already answered" },
  vi: {
    approve: "Duyệt",
    deny: "Từ chối",
    approved: "Đã duyệt",
    denied: "Đã từ chối",
    decided: "Đã được quyết định",
    open: "Mở",
    answered: "Đã trả lời",
    alreadyAnswered: "Đã được trả lời",
  },
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...SHELL, ...PRECACHE]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("z-shell-") && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/hooks/")) return;
  if (request.mode === "navigate") {
    // Network first so a deploy shows up at once; the cached shell when offline.
    event.respondWith(fetch(request).catch(() => caches.match("/").then((hit) => hit ?? Response.error())));
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith("/assets/")) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // A truncated body is not the whole action: never offer to approve it from the notification.
  const actionable = Boolean(data.approvalId) && data.truncated !== true;
  const question = data.question && Array.isArray(data.question.choices) ? data.question : null;
  event.waitUntil(
    labels().then((t) =>
      self.registration.showNotification(data.title || "z", {
        body: data.body || "",
        tag: data.approvalId || (question ? `question:${question.taskId}` : data.id),
        icon: ICON,
        badge: BADGE,
        data: { path: data.path || "/", approvalId: data.approvalId, truncated: data.truncated === true, body: data.body || "", question },
        requireInteraction: Boolean(data.approvalId || question),
        actions: actionable
          ? [
              { action: "approve", title: t.approve },
              { action: "deny", title: t.deny },
            ]
          : question
            ? questionActions(question.choices, t)
            : [],
      }),
    ),
  );
});

/**
 * Up to two choices (`answer:<i>`) plus "Open" when the platform shows that many actions. Choices are
 * offered only when all of them fit: a question showing one of two options would mislead.
 */
function questionActions(choices, t) {
  const max = typeof Notification !== "undefined" && Notification.maxActions ? Notification.maxActions : 2;
  if (choices.length > Math.min(2, max)) return [{ action: "open", title: t.open }];
  const answers = choices.map((choice, i) => ({ action: `answer:${i}`, title: choice }));
  return answers.length < max ? [...answers, { action: "open", title: t.open }] : answers;
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const { path = "/", approvalId, truncated = false, body = "", question = null } = notification.data || {};
  notification.close();
  const choice = question && /^answer:\d$/.test(event.action) ? question.choices[Number(event.action.slice(7))] : undefined;
  if (approvalId && !truncated && (event.action === "approve" || event.action === "deny")) {
    event.waitUntil(decide(approvalId, event.action === "approve", path, body));
  } else if (choice !== undefined) {
    event.waitUntil(answer(question.taskId, choice, path));
  } else {
    event.waitUntil(openApp(path));
  }
});

/** Same call as the app's Approve / Deny. Without a valid token (401) or a connection, open the app instead. */
async function decide(id, approve, path, body) {
  const token = await idbGet("token");
  let response;
  try {
    response = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ approve }),
    });
  } catch {
    return openApp(path);
  }
  const t = await labels();
  const title = response.ok ? (approve ? t.approved : t.denied) : response.status === 409 ? t.decided : null;
  if (!title) return openApp(path);
  await self.registration.showNotification(title, { body, tag: id, icon: ICON, badge: BADGE, silent: true });
}

/** Same call as the app's answer buttons. 409: answered elsewhere already. Otherwise failures open the app. */
async function answer(taskId, text, path) {
  const token = await idbGet("token");
  let response;
  try {
    response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text }),
    });
  } catch {
    return openApp(path);
  }
  const t = await labels();
  const title = response.ok ? t.answered : response.status === 409 ? t.alreadyAnswered : null;
  if (!title) return openApp(path);
  await self.registration.showNotification(title, {
    body: response.ok ? text : "",
    tag: `question:${taskId}`,
    icon: ICON,
    badge: BADGE,
    silent: true,
  });
}

async function openApp(path) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (!client) return self.clients.openWindow(path);
  await client.focus();
  client.postMessage({ type: "navigate", path });
}

async function labels() {
  return LABELS[await idbGet("lang")] ?? LABELS.en;
}

/** The page mirrors its bearer token and language here (see src/lib/pwa.ts). */
function idbGet(key) {
  return new Promise((resolve) => {
    const open = indexedDB.open("z", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const request = open.result.transaction("kv").objectStore("kv").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    };
  });
}
