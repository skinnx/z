/**
 * In-page script that turns the DOM into compact text with numbered interactive elements:
 *
 *   # Hacker News
 *   1. [3] link "Show HN: …" (example.com)
 *   [41] textbox "Search" value="cats" [42] button "Go"
 *
 * Numbers come from a counter z passes in, so they are never reused within a browser session:
 * a stale number fails to resolve instead of hitting a different element. Elements are kept in
 * page-side WeakRefs (nothing is written into the DOM). Password and card/OTP fields are masked.
 * Written as a string because this package doesn't compile against the DOM lib.
 */
export const SNAPSHOT_SCRIPT = String.raw`(opts) => {
  const KEY = "__zSnapshot";
  let state = window[KEY];
  if (!state) {
    state = { next: opts.next, ids: new WeakMap(), refs: new Map() };
    Object.defineProperty(window, KEY, { value: state });
  }
  state.next = Math.max(state.next, opts.next);

  const collapse = (text) => (text || "").replace(/\s+/g, " ").trim();
  const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
  const BUTTON_INPUTS = ["button", "submit", "reset", "image"];
  const TEXT_ROLES = ["textbox", "searchbox", "combobox", "spinbutton", "slider"];
  const INTERACTIVE = new Set([
    "link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "tab",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "treeitem",
  ]);

  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if ((tag === "a" || tag === "area") && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return "";
      if (BUTTON_INPUTS.includes(type) || type === "file") return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    return "";
  };

  const secret = (el) =>
    el.localName === "input" &&
    ((el.type || "").toLowerCase() === "password" || /cc-|one-time-code|password/i.test(el.getAttribute("autocomplete") || ""));

  const nameOf = (el, role) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = collapse(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
      if (text) return text;
    }
    const label = collapse(el.getAttribute("aria-label"));
    if (label) return label;
    if (el.labels && el.labels.length) {
      // Text of the labels, minus the control itself when it sits inside one (a <select>'s options).
      let text = "";
      for (const label of el.labels) {
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!el.contains(node)) text += " " + node.data;
      }
      text = collapse(text);
      if (text) return text;
    }
    if (el.localName === "input") {
      const type = (el.type || "").toLowerCase();
      if (type === "image") return collapse(el.alt) || "Submit";
      if (BUTTON_INPUTS.includes(type)) return collapse(el.value) || (type === "reset" ? "Reset" : "Submit");
    } else if (!TEXT_ROLES.includes(role) && role !== "listbox") {
      const text = collapse(el.innerText);
      if (text) return text;
      const img = el.querySelector("img[alt]");
      if (img && collapse(img.alt)) return collapse(img.alt);
      const titled = el.querySelector("[title]");
      if (titled && collapse(titled.getAttribute("title"))) return collapse(titled.getAttribute("title"));
    }
    const own = collapse(el.getAttribute("title") || el.getAttribute("placeholder") || "");
    if (own || role !== "link" || !el.href) return own;
    // An unlabeled link (logo, icon): its address is the best name there is.
    const href = new URL(el.href);
    return href.origin === location.origin ? href.pathname + href.search : href.host + href.pathname;
  };

  const describe = (el) => {
    const role = roleOf(el) || "clickable";
    return { role, name: clip(nameOf(el, role), 100) };
  };
  state.describe = (ref) => {
    const el = state.refs.get(ref)?.deref();
    return el && el.isConnected ? describe(el) : null;
  };

  const refOf = (el) => {
    let ref = state.ids.get(el);
    if (!ref) {
      ref = state.next++;
      state.ids.set(el, ref);
      state.refs.set(ref, new WeakRef(el));
    }
    return ref;
  };

  const elements = [];
  const token = (el, role) => {
    const ref = refOf(el);
    const name = clip(nameOf(el, role), 100);
    elements.push([ref, role, name, secret(el)]);
    let out = "[" + ref + "] " + role + (name ? " " + JSON.stringify(name) : "");
    const tag = el.localName;
    if (tag === "input" || tag === "textarea") {
      const type = (el.type || "").toLowerCase();
      if (role === "checkbox" || role === "radio") {
        if (el.checked) out += " checked";
      } else if (role !== "button") {
        if (type && type !== "text" && type !== "search" && tag === "input") out += " type=" + type;
        if (el.value) out += " value=" + (secret(el) ? '"••••"' : JSON.stringify(clip(collapse(el.value), 80)));
      }
    } else if (tag === "select") {
      const chosen = [...el.selectedOptions].map((o) => collapse(o.label)).join(", ");
      if (chosen) out += " value=" + JSON.stringify(clip(chosen, 80));
      const options = [...el.options].slice(0, 20).map((o) => clip(collapse(o.label), 40));
      out += " options=[" + options.join(" | ") + (el.options.length > 20 ? " | …" : "") + "]";
    } else if (role === "textbox" && el.isContentEditable) {
      const text = collapse(el.innerText);
      if (text) out += " value=" + JSON.stringify(clip(text, 80));
    } else if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
      if (el.getAttribute("aria-checked") === "true") out += " checked";
    }
    if (el.getAttribute("aria-expanded")) out += el.getAttribute("aria-expanded") === "true" ? " expanded" : " collapsed";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out += " disabled";
    if (opts.hrefs && role === "link" && el.href) out += " → " + el.href;
    return out;
  };

  const lines = [];
  let line = [];
  let size = 0;
  const flush = () => {
    const text = collapse(line.join(" "));
    line = [];
    if (text) {
      lines.push(text);
      size += text.length + 1;
    }
  };

  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)/;
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "canvas", "math", "object", "embed"]);
  const LEAF_ROLES = new Set(["link", "button", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "option"]);

  const walk = (node, parentStyle) => {
    if (size > opts.maxScan) return;
    if (node.nodeType === 3) {
      if (!parentStyle || parentStyle.visibility === "visible") line.push(node.data);
      return;
    }
    if (node.nodeType === 11) {
      for (const child of node.childNodes) walk(child, parentStyle);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag) || el.inert || el.getAttribute("aria-hidden") === "true") return;
    const style = getComputedStyle(el);
    if (style.display === "none") return;
    if (tag === "iframe" || tag === "frame") {
      line.push("[iframe" + (el.title ? " " + JSON.stringify(collapse(el.title)) : "") + "]");
      return;
    }
    const block = BLOCK.test(style.display);
    if (block) flush();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) line.push("#".repeat(Number(heading[1])));
    else if (style.display === "list-item") line.push("-");

    let role = roleOf(el);
    const shown = style.visibility === "visible" && (style.display === "contents" || el.checkVisibility());
    if (!INTERACTIVE.has(role) && shown && style.cursor === "pointer" && tag !== "label" &&
        !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer")) {
      role = "clickable";
    }
    if (shown && (INTERACTIVE.has(role) || role === "clickable")) {
      line.push(token(el, role));
      if (LEAF_ROLES.has(role) || tag === "select" || tag === "textarea" || el.isContentEditable) {
        if (block) flush();
        return;
      }
      if (role === "clickable") line.push(":");
    } else if (tag === "img" && collapse(el.alt) && shown) {
      line.push("[img " + JSON.stringify(clip(collapse(el.alt), 80)) + "]");
    }
    if (el.shadowRoot) walk(el.shadowRoot, style);
    else if (tag === "slot") {
      const assigned = el.assignedNodes({ flatten: true });
      for (const child of assigned.length ? assigned : el.childNodes) walk(child, style);
    } else for (const child of el.childNodes) walk(child, style);
    if (block || heading) flush();
  };

  let root = document.body || document.documentElement;
  if (opts.ref != null) {
    root = state.refs.get(opts.ref)?.deref();
    if (!root || !root.isConnected) return { error: "Element [" + opts.ref + "] is not on the current page" };
  } else if (opts.selector) {
    root = document.querySelector(opts.selector);
    if (!root) return { error: "No element matches " + opts.selector };
  }
  walk(root, root.parentElement ? getComputedStyle(root.parentElement) : null);
  flush();
  return { title: document.title, url: location.href, text: lines.join("\n"), elements, next: state.next };
}`;

export type SnapshotOptions = { next: number; ref: number | null; selector: string | null; hrefs: boolean; maxScan: number };

export type SnapshotResult =
  | { error: string }
  | { title: string; url: string; text: string; elements: [ref: number, role: string, name: string, secret: boolean][]; next: number };

/** Source for `page.evaluate` that calls `script` with `arg`. */
export const invoke = (script: string, arg: unknown) => `(${script})(${JSON.stringify(arg)})`;

/** Current role and name of a numbered element, or null when it's gone. */
export const DESCRIBE_SCRIPT = `(ref) => window.__zSnapshot?.describe?.(ref) ?? null`;

/** The element behind a number, for Playwright to act on. */
export const RESOLVE_SCRIPT = `(ref) => { const el = window.__zSnapshot?.refs.get(ref)?.deref(); return el && el.isConnected ? el : null; }`;
