// The bundled tree's platform contract — the one thing that silently turned the
// extension into an unstable dsh server on Linux.
//
// `resolveCli()` offers the tree shipped inside the package as a candidate, and
// `preferNewer` keeps the FIRST candidate on a version tie, so a bundled copy
// beats an equally new PATH/global install. That is only safe on a platform
// whose native payloads are actually in the archive: node-pty
// (`import * as nodePty from "node-pty"` in @deepseek-ai/dsh-subprocess-local),
// sharp (`import sharp from "sharp"` in @deepseek-ai/dsh-attachment-local) and
// @vscode/ripgrep all resolve per platform — and before any of those load, dsh's
// own boot loader needs a per-platform require_builtin.node, which is what
// actually killed the Linux tree first:
//   "host preparation failed: No usable native binding found for
//    node-addon-require-builtin-linux-x64-gnu (auto)"
//
// Three things have to agree, and this suite is what keeps them agreeing:
//   BUNDLED_TREE_PLATFORMS in src/dshManager.ts   ← the runtime guard
//   node_modules/ on this checkout                ← what packaging can ship
//   .vscodeignore                                 ← what packaging will ship
//
//   node scripts/verify/platform.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO, loadWithStubbedVscode, stubVscode, suite } from "./harness.mjs";

const s = suite("platform contract");
const { BUNDLED_TREE_PLATFORMS, bundledTreeUsable } = loadWithStubbedVscode("out/dshManager.js", stubVscode());

// What each supported platform needs on disk. Directories are checked as
// "exists and holds at least one file" so a sharp/ripgrep version bump does not
// break the suite (the .node / .so / rg payloads carry version in their names).
const PAYLOADS = {
  "win32-x64": [
    "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
    "node_modules/@img/sharp-win32-x64/lib",
    "node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe",
    // dsh's boot loader resolves its native `require_builtin.node` from this
    // optional package; koffi (used by dsh-subprocess-local) does the same.
    "node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt",
    "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
  ],
  "linux-x64": [
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "node_modules/@img/sharp-linux-x64/lib",
    // @img/sharp-linux-x64/index.cjs resolves this package as its libvips payload.
    "node_modules/@img/sharp-libvips-linux-x64/lib",
    "node_modules/@vscode/ripgrep-linux-x64/bin/rg",
    "node_modules/node-addon-require-builtin-linux-x64-gnu/prebuilt",
    "node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
  ],
};

function holdsFiles(rel) {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return false;
  try {
    if (readdirSync(abs).length > 0) return true;
  } catch {
    /* not a directory */
  }
  return readFileSync(abs).length > 0;
}

// --- the runtime guard ------------------------------------------------------

s.check(
  "BUNDLED_TREE_PLATFORMS is a platform-arch list",
  Array.isArray(BUNDLED_TREE_PLATFORMS) &&
    BUNDLED_TREE_PLATFORMS.length > 0 &&
    BUNDLED_TREE_PLATFORMS.every((p) => typeof p === "string" && /^[a-z0-9]+-[a-z0-9]+$/.test(p)),
  JSON.stringify(BUNDLED_TREE_PLATFORMS)
);
s.check("the guard is exact, not a prefix match", typeof bundledTreeUsable === "function");
for (const platform of ["win32", "linux", "darwin"]) {
  for (const arch of ["x64", "arm64"]) {
    const key = `${platform}-${arch}`;
    const expected = BUNDLED_TREE_PLATFORMS.includes(key);
    s.check(
      `bundledTreeUsable("${platform}", "${arch}") === ${expected}`,
      bundledTreeUsable(platform, arch) === expected
    );
  }
}
s.check("an unknown platform is never usable", bundledTreeUsable("freebsd", "x64") === false);

// --- payloads present in the tree -------------------------------------------

for (const platform of BUNDLED_TREE_PLATFORMS) {
  for (const rel of PAYLOADS[platform] ?? []) {
    s.check(`shipped: ${rel}`, holdsFiles(rel));
  }
}
s.check(
  "every supported platform has a payload list here (kept in sync)",
  BUNDLED_TREE_PLATFORMS.every((p) => Array.isArray(PAYLOADS[p]) && PAYLOADS[p].length > 0)
);

// --- .vscodeignore does not strip them --------------------------------------

const ignoreRules = readFileSync(path.join(REPO, ".vscodeignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.replace(/^\//, ""));

function ignoredBy(rel) {
  const escaped = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const rule of ignoreRules) {
    const rx = new RegExp(
      `^${rule
        .split("**")
        .map((part) => part.split("*").map(escaped).join("[^/]*"))
        .join(".*")}$`
    );
    if (rx.test(rel)) return rule;
  }
  return undefined;
}

const required = BUNDLED_TREE_PLATFORMS.flatMap((p) => PAYLOADS[p] ?? []);
const stripped = required.map((rel) => [rel, ignoredBy(rel)]).filter(([, rule]) => rule !== undefined);
s.check(
  "no .vscodeignore rule strips a required payload",
  stripped.length === 0,
  stripped.map(([rel, rule]) => `${rel} ⇐ ${rule}`).join("; ")
);
// The rule matcher must actually reject something, or the check above is vacuous.
s.check("the ignore matcher works (darwin payload stays excluded)", ignoredBy("node_modules/@img/sharp-darwin-arm64/lib") !== undefined);

// --- packaging fetches what a Windows host cannot install -------------------

const fetchScript = path.join(REPO, "scripts", "fetch-platform-deps.mjs");
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8").replace(/^\uFEFF/, ""));
s.check("scripts/fetch-platform-deps.mjs exists", existsSync(fetchScript));
s.check("fetch-platform-deps runs before packaging", /fetch-platform-deps/.test(pkg.scripts?.["vscode:prepublish"] ?? ""));
if (existsSync(fetchScript)) {
  const script = readFileSync(fetchScript, "utf8");
  // Every non-host platform in the list needs its platform-split packages named.
  for (const platform of BUNDLED_TREE_PLATFORMS.filter((p) => p !== "win32-x64")) {
    for (const prefix of ["@img/sharp-", "@vscode/ripgrep-", "node-addon-require-builtin-", "@koromix/koffi-"]) {
      s.check(`fetch covers ${prefix}${platform}`, script.includes(`${prefix}${platform}`));
    }
  }
}

process.exit(s.finish() ? 0 : 1);
