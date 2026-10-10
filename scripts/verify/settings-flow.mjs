// The settings button must keep working: open → close → open again — and a write
// the server REFUSES must not be invisible.
//
// Three layers are covered:
//   0. The settings/update wire itself: the proxy recognises a `ok:false`
//      envelope, reads the `{ns, patch}` back out of the request, and hands it to
//      the recovery hook — while still passing the upstream bytes through
//      unchanged. (No server needed: a stub upstream answers the denial.)
//   1. ChatPanel delivery, under BOTH webview-host behaviours — a byte-identical
//      html being dropped (no reload, so no new iframe-ready) and every html
//      reloading. The second and third clicks must still reach the page.
//   2. The adapter's own guard, measured in a headless browser against a live
//      server: a leftover unrelated dialog (the pre-release notice) must not
//      block reopening. Layer 2 is skipped when no origin/Chrome is available.
//
//   node scripts/verify/settings-flow.mjs [origin]

import * as http from "node:http";
import { forgeCookie, launchChrome, loadWithStubbedVscode, originArg, rpc, sleep, stubVscode, suite, waitFor } from "./harness.mjs";

const s = suite("settings flow");

// ---- 0. the refusal wire format (stub upstream, no dsh) -------------------
{
  const { GuiProxy, readSettingsRejection, readSettingsArgs } = loadWithStubbedVscode("out/guiProxy.js", stubVscode());
  const refused = JSON.stringify({
    result: {
      ok: false,
      error: { code: "settings/rejected", message: "dsh: profile reload requires the root Include entry", details: { ns: "ui-settings-general" } },
    },
  });
  const accepted = JSON.stringify({ result: { ok: true, value: {} } });
  s.check("a refused write is recognised", readSettingsRejection(refused).rejected === true);
  s.check(
    "the refusal keeps the upstream message",
    /profile reload requires the root Include entry/.test(readSettingsRejection(refused).message ?? ""),
    readSettingsRejection(refused).message
  );
  s.check("an accepted write is not a refusal", readSettingsRejection(accepted).rejected === false);
  s.check(
    "an unreadable body is never a refusal",
    readSettingsRejection("<html>502</html>").rejected === false && readSettingsRejection("").rejected === false && readSettingsRejection("{}").rejected === false
  );

  const wire = JSON.stringify({
    type: "client-request",
    rpcId: "verify-1",
    method: "settings/update",
    payload: { args: { ns: "ui-settings-general", patch: { welcomeNoticeVersion: "2026-08-13.1" } } },
  });
  s.check(
    "typert wire args are read back",
    readSettingsArgs(wire).ns === "ui-settings-general" && readSettingsArgs(wire).patch?.welcomeNoticeVersion === "2026-08-13.1",
    JSON.stringify(readSettingsArgs(wire))
  );
  const legacy = JSON.stringify({ payload: { ns: "ui-theme", patch: { preference: "dark" } } });
  s.check("raw payload args are read back", readSettingsArgs(legacy).ns === "ui-theme", JSON.stringify(readSettingsArgs(legacy)));
  s.check("an unreadable request body yields nothing", readSettingsArgs("not json").ns === undefined);

  // The proxy must see the refusal AND leave the exchange untouched.
  const upstreamSeen = [];
  const upstream = http.createServer((req, res) => {
    upstreamSeen.push({ url: req.url ?? "", encoding: req.headers["accept-encoding"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end((req.url ?? "").includes("case=ok") ? accepted : refused);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const seen = [];
  const proxy = new GuiProxy(upstream.address().port, () => "dsh-auth-stub=v1.x", (rejection) => seen.push(rejection));
  await proxy.start();
  try {
    const post = (suffix) =>
      fetch(`${proxy.url}api/settings/update${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept-encoding": "gzip, deflate" },
        body: wire,
      }).then((r) => r.text());
    s.check("the refusal still reaches the page byte-identically", (await post("?case=reject")) === refused);
    s.check("the proxy reported exactly one refusal", seen.length === 1, JSON.stringify(seen));
    s.check("the reported namespace is the one that was written", seen[0]?.ns === "ui-settings-general");
    s.check("the reported patch is the one that was written", seen[0]?.patch?.welcomeNoticeVersion === "2026-08-13.1");
    // A compressed answer would make the JSON check impossible, so the inspected
    // request must not advertise gzip — a silent skip here means no recovery.
    s.check("the inspected POST asks for an uncompressed answer", upstreamSeen[0]?.encoding === undefined, String(upstreamSeen[0]?.encoding));
    s.check("an accepted write reports nothing", (await post("?case=ok")) === accepted && seen.length === 1, `seen=${seen.length}`);
    // Only /api/settings/update is inspected — other POSTs must stay invisible
    // (and untouched: their accept-encoding survives).
    await fetch(`${proxy.url}api/session/create`, { method: "POST", headers: { "accept-encoding": "gzip, deflate" }, body: "{}" });
    // A GET on the settings endpoint is a read, never a write.
    await fetch(`${proxy.url}api/settings/update`);
    s.check("only POST /api/settings/update is inspected", seen.length === 1, `seen=${seen.length}`);
    s.check(
      "other requests keep their accept-encoding",
      upstreamSeen.some((h) => h.url.includes("session/create") && h.encoding === "gzip, deflate"),
      JSON.stringify(upstreamSeen)
    );
  } finally {
    await proxy.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

// ---- 1. delivery through ChatPanel ---------------------------------------
for (const mode of ["skip", "reload"]) {
  const created = [];
  const vscodeStub = {
    ViewColumn: { Active: -1 },
    ColorThemeKind: { Light: 1, Dark: 2 },
    Uri: { joinPath: (b, ...p) => ({ fsPath: [b?.fsPath ?? b, ...p].join("/") }) },
    window: {
      activeColorTheme: { kind: 2 },
      createWebviewPanel: () => {
        const panel = {
          title: "t", revealCount: 0, posted: [], html: "", _last: undefined, _msg: [], assignments: 0,
          webview: {
            set html(value) {
              panel.assignments++;
              const unchanged = panel._last === value;
              panel._last = value;
              panel.html = value;
              if (unchanged && mode === "skip") return; // host drops identical content
              setTimeout(() => { for (const fn of panel._msg) fn({ source: "dsh-vscode-panel", type: "iframe-ready" }); }, 1);
            },
            get html() { return panel.html; },
            postMessage: (m) => { panel.posted.push(m); },
            onDidReceiveMessage: (fn) => { panel._msg.push(fn); return { dispose() {} }; },
          },
          reveal() { this.revealCount++; },
          onDidDispose() { return { dispose() {} }; },
          dispose() {},
        };
        created.push(panel);
        return panel;
      },
    },
  };
  const { ChatPanel } = loadWithStubbedVscode("out/chatPanel.js", vscodeStub);
  const panel = new ChatPanel(() => {}, { fsPath: "ext" }, () => {}, () => {});
  panel.update({ state: "running", url: "http://127.0.0.1:3080", panelSupport: true });
  const tag = mode === "skip" ? "identical html dropped by the host" : "every html reloads";

  panel.openSettings("session-A");
  s.check(`[${tag}] cold tab boots with the modal URL`, created[0].html.includes("openSettings=1"));
  await sleep(60);
  s.check(`[${tag}] cold tab loaded exactly one document`, created[0].assignments === 1, `assignments=${created[0].assignments}`);

  created[0].posted = [];
  panel.openSettings("session-A");
  await sleep(80);
  s.check(`[${tag}] 2nd click reaches the live page`, created[0].posted.some((m) => m?.type === "open-settings"), JSON.stringify(created[0].posted));
  s.check(`[${tag}] 2nd click needed no reload`, created[0].assignments === 1, `assignments=${created[0].assignments}`);

  created[0].posted = [];
  panel.openSettings("session-A");
  await sleep(80);
  s.check(`[${tag}] 3rd click also reaches the page`, created[0].posted.some((m) => m?.type === "open-settings"));

  created[0].posted = [];
  panel.openSession("session-B", "B");
  await sleep(80);
  s.check(`[${tag}] session switch re-renders the tab`, created[0].assignments >= 2, `assignments=${created[0].assignments}`);
  s.check(`[${tag}] session switch pinned to B`, created[0].html.includes("session=session-B"));
  s.check(`[${tag}] no message leaked into the unloaded document`, created[0].posted.length === 0, JSON.stringify(created[0].posted));
}

// ---- 2. the adapter against a live server (best effort) -------------------
const origin = originArg();
let live = false;
try {
  const { cookie } = forgeCookie(origin);
  const list = await rpc(origin, cookie, "session/list", { _request: {} });
  live = Array.isArray(list?.value?.items);
} catch { /* no live server / no credentials */ }

const chrome = live ? await launchChrome({ port: 9345 }) : undefined;
if (!live || chrome === undefined) {
  console.log(`  skip live adapter checks (${live ? "no Chrome" : `no reachable server at ${origin}`})`);
} else {
  try {
    const { cookie, name, value } = forgeCookie(origin);
    await chrome.cdp.send("Network.setCookie", { name, value, url: `${origin}/`, path: "/", sameSite: "Strict" });
    const dialogState = `(() => {
      const isSettings = (d) => d.querySelector('[class*="_navTitle"], [class*="_navCell"], [class*="_navList"]') !== null;
      const all = [...document.querySelectorAll('[role="dialog"]')];
      const visible = all.filter((d) => d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden');
      return {
        settingsVisible: visible.filter(isSettings).length,
        otherVisible: visible.filter((d) => !isSettings(d)).map((d) => (d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24)),
      };
    })()`;
    await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center&openSettings=1` });
    const booted = await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
    await sleep(3000);
    const first = await chrome.cdp.eval(dialogState);
    s.check("live: first open shows the settings modal", booted && first.settingsVisible > 0, `visible=${first.settingsVisible}`);
    // close it (Escape) and reopen through the host message, three times
    let allCycles = true;
    for (let i = 0; i < 3; i++) {
      await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(1500);
      const closed = await chrome.cdp.eval(dialogState);
      await chrome.cdp.eval(`window.postMessage({ source: 'dsh-vscode-host', type: 'open-settings' }, '*')`);
      await sleep(2500);
      const opened = await chrome.cdp.eval(dialogState);
      if (closed.settingsVisible !== 0 || opened.settingsVisible === 0) allCycles = false;
      if (i === 0) s.check("live: unrelated dialogs stay mounted (the trap)", Array.isArray(closed.otherVisible), `others=${JSON.stringify(closed.otherVisible)}`);
    }
    s.check("live: three close/reopen cycles all succeed", allCycles);
    s.check("live: no page errors", chrome.cdp.errors.length === 0, chrome.cdp.errors.slice(0, 2).join(" | "));
  } finally {
    await chrome.close();
  }
}

process.exit(s.finish() ? 0 : 1);
