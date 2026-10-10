// Pure CLI-resolution and panel-URL rules — the two upstream gaps this port
// closes, both verifiable without a server:
//
//   installRootOf()   `npm root -g` prints the node_modules DIRECTORY, while
//                     every scanner joins another `node_modules` under it; and
//   panelSrc()        ChatPanel reports an unpinned tab as "" (not undefined),
//                     which dropped `seed=1` from every default/settings tab.
//
//   node scripts/verify/resolve.mjs

import { loadWithStubbedVscode, stubVscode, suite } from "./harness.mjs";

const s = suite("cli resolution + panel url");
const { installRootOf } = loadWithStubbedVscode("out/dshManager.js", stubVscode());
const { stateBody } = loadWithStubbedVscode("out/webviewHtml.js", stubVscode());

const winRoot = "C:\\Users\\t\\AppData\\Roaming\\npm\\node_modules";
s.check("installRootOf strips a trailing `node_modules` (win32 npm -g)", installRootOf(winRoot) === "C:\\Users\\t\\AppData\\Roaming\\npm", installRootOf(winRoot));
s.check("installRootOf strips a trailing `node_modules` (posix)", installRootOf("/usr/lib/node_modules") === "/usr/lib", installRootOf("/usr/lib/node_modules"));
s.check("installRootOf tolerates trailing separators", installRootOf("/usr/lib/node_modules/") === "/usr/lib", installRootOf("/usr/lib/node_modules/"));
s.check("installRootOf leaves a normal root alone", installRootOf("/opt/dsh") === "/opt/dsh", installRootOf("/opt/dsh"));
s.check("installRootOf is case-insensitive about the segment", installRootOf("/opt/Node_Modules") === "/opt", installRootOf("/opt/Node_Modules"));
s.check("installRootOf never throws on empty input", installRootOf("") === "", JSON.stringify(installRootOf("")));

const info = { state: "running", url: "http://127.0.0.1:1/", guiUrl: "http://127.0.0.1:2/", panelSupport: true, browserAuth: false };
const srcOf = (sessionId, opts) => {
  const html = stateBody(info, sessionId, opts);
  const m = /src="([^"]*)"/.exec(html);
  return m === null ? html : m[1].replaceAll("&amp;", "&");
};

const seeded = srcOf("", { seedSession: "session-abc" });
s.check("an unpinned tab seeds the last conversation", seeded.includes("&session=session-abc&seed=1"), seeded);
s.check("an unpinned tab without a seed carries no session", !srcOf("", undefined).includes("session="), srcOf("", undefined));
const pinned = srcOf("session-pin");
s.check("a pinned tab carries the session without seed", pinned.includes("&session=session-pin") && !pinned.includes("seed=1"), pinned);
const settings = srcOf("", { seedSession: "session-abc", openSettings: true });
s.check("the settings boot keeps both the seed and the flag", settings.includes("&session=session-abc&seed=1") && settings.includes("&openSettings=1"), settings);

process.exit(s.finish() ? 0 : 1);
