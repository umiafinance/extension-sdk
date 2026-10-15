import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createProviderVerificationPopup,
  renderPopupTemplate,
} from "./reclaim-provider-verification-popup.js";

const template = readFileSync(
  new URL("./reclaim-provider-verification-popup.html", import.meta.url),
  "utf8",
);

test("shows generic instructions and the bound session", () => {
  const html = renderPopupTemplate(template, { sessionId: "abc123" });
  assert.doesNotMatch(html, /Default Provider|reclaim-popup-provider/);
  assert.match(html, /Sign in to this site if needed/);
  assert.match(html, /Keep this tab open while verification runs/);
  assert.match(html, /id="reclaim-session-id">abc123</);
  assert.doesNotMatch(html, /\{\{/);
});

test("escapes markup in the substituted session ID", () => {
  const html = renderPopupTemplate(template, {
    sessionId: "</span><script>alert(2)</script>",
  });
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;\/span&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test("keeps quotes inside the attribute they are rendered into", () => {
  const html = renderPopupTemplate('<span title="{{providerName}}"></span>', {
    providerName: `Bob's "Bank" & Co`,
  });
  assert.equal(html, '<span title="Bob&#39;s &quot;Bank&quot; &amp; Co"></span>');
});

test("treats replacement patterns in a value literally", () => {
  const rendered = {
    "$&": "$&amp;",
    $1: "$1",
    "$'": "$&#39;",
    "$`": "$`",
    $$: "$$",
    "$<name>": "$&lt;name&gt;",
  };
  for (const [value, html] of Object.entries(rendered)) {
    assert.equal(renderPopupTemplate("[{{providerName}}]", { providerName: value }), `[${html}]`);
  }
});

test("leaves placeholders without a value untouched", () => {
  assert.equal(renderPopupTemplate("{{logoUrl}} {{sessionId}}", { sessionId: "s" }), "{{logoUrl}} s");
});

test("the popup follows the saved Hub theme and releases its listener", async () => {
  const previous = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch };
  const popup = {
    dataset: {},
    style: { setProperty() {} },
    querySelector: (selector) =>
      selector === ".reclaim-popup-header" ? { addEventListener() {} } : null,
    querySelectorAll: () => [],
  };
  let onChanged;
  let removed;
  let finishRead;
  globalThis.chrome = {
    runtime: { getURL: (path) => path },
    storage: {
      local: { get: () => new Promise((resolve) => (finishRead = resolve)) },
      onChanged: {
        addListener: (listener) => (onChanged = listener),
        removeListener: (listener) => (removed = listener),
      },
    },
  };
  globalThis.document = {
    createElement: () => popup,
    getElementById: () => null,
    head: { appendChild() {} },
    addEventListener() {},
  };
  globalThis.fetch = async () => ({ text: async () => "template" });
  try {
    const instance = createProviderVerificationPopup("session-1");
    onChanged({ umiaTheme: { newValue: "dark" } }, "local");
    assert.equal(instance.element.dataset.umiaTheme, "dark");
    assert.equal(instance.element.style.visibility, "visible");
    finishRead({ umiaTheme: "light" });
    await Promise.resolve();
    assert.equal(instance.element.dataset.umiaTheme, "dark");
    onChanged({ umiaTheme: { newValue: "system" } }, "local");
    assert.equal(instance.element.dataset.umiaTheme, undefined);
    instance.dispose();
    assert.equal(removed, onChanged);
    await new Promise(setImmediate);
  } finally {
    Object.assign(globalThis, previous);
  }
});
