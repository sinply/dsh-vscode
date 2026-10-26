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
    // Speech-to-text (voice input) native library. Windows uses a named kernel
    // semaphore for the session write lease, so node-addon-system has no win32
    // payload — sherpa is the only 0.2.1 addition on this side.
    "node_modules/sherpa-onnx-win-x64",
  ],
  "linux-x64": [
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "node_modules/@img/sharp-linux-x64/lib",
    // @img/sharp-linux-x64/index.cjs resolves this package as its libvips payload.
    "node_modules/@img/sharp-libvips-linux-x64/lib",
    "node_modules/@vscode/ripgrep-linux-x64/bin/rg",
    "node_modules/node-addon-require-builtin-linux-x64-gnu/prebuilt",
    "node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
    // POSIX `flock` = the session WRITE LEASE (Windows uses a named semaphore
    // instead, which is why a missing linux payload is invisible on Windows and
    // kills the first materialising write on Linux), plus the landlock-run
    // sandbox launcher that ships in the same package.
    "node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node",
    "node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run",
    "node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node",
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

// --- derived: every platform-split dependency HAS its payload ---------------
//
// A hand-maintained list only catches what someone remembered to add. dsh 0.2.1
// introduced two new platform-split native families (@deepseek-ai/node-addon-system
// and sherpa-onnx); the Windows install satisfied both on the host side, so the
// missing linux payloads were invisible until the first session write threw
// MODULE_NOT_FOUND. This derives the requirement from the installed tree instead:
// whatever declares a `<name>-<platform>-<arch>` optionalDependency for a bundled
// platform must actually have that package installed and shipped.
const DELIBERATELY_EXCLUDED = new Map([
  ["@deepseek-ai/libreoffice-kit-win32-x64", "office→pdf runtime, trimmed from the vsix on purpose"],
  ["@vscode/vsce-sign-win32-x64", "dev-only tooling (vsce), never loaded at runtime"],
  ["@vscode/vsce-sign-linux-x64", "dev-only tooling (vsce), never loaded at runtime"],
]);
const packagesRoot = path.join(REPO, "node_modules");
const packageDirs = [];
try {
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const inner of readdirSync(path.join(packagesRoot, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory()) packageDirs.push(path.join(packagesRoot, entry.name, inner.name));
      }
    } else {
      packageDirs.push(path.join(packagesRoot, entry.name));
    }
  }
} catch {
  /* the tree itself is missing — the payload checks above already failed */
}
const declaredPlatformPayloads = new Map();
for (const dir of packageDirs) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    continue;
  }
  const optional = manifest?.optionalDependencies;
  if (optional === null || typeof optional !== "object") continue;
  for (const name of Object.keys(optional)) {
    const platform = BUNDLED_TREE_PLATFORMS.find((candidate) => name.endsWith(`-${candidate}`));
    if (platform !== undefined) declaredPlatformPayloads.set(name, { platform, declaredBy: manifest?.name ?? "?" });
  }
}
s.check("the tree declares platform-split optional deps (the derived check is not vacuous)", declaredPlatformPayloads.size > 0, `${declaredPlatformPayloads.size} declared`);
const missingPayloads = [...declaredPlatformPayloads].filter(
  ([name]) => !DELIBERATELY_EXCLUDED.has(name) && !existsSync(path.join(packagesRoot, name))
);
s.check(
  "every declared bundled-platform payload is installed",
  missingPayloads.length === 0,
  missingPayloads.map(([name, info]) => `${name} (declared by ${info.declaredBy}, ${info.platform})`).join("; ")
);
const strippedPayloads = [...declaredPlatformPayloads.keys()].filter(
  (name) => !DELIBERATELY_EXCLUDED.has(name) && ignoredBy(`node_modules/${name}`) !== undefined
);
s.check("no .vscodeignore rule strips a declared platform payload", strippedPayloads.length === 0, strippedPayloads.join(", "));
for (const [name, why] of DELIBERATELY_EXCLUDED) {
  s.check(`deliberate exclusion is still a real dependency: ${name} — ${why}`, declaredPlatformPayloads.has(name));
}

// --- packaging fetches what a Windows host cannot install -------------------

const fetchScript = path.join(REPO, "scripts", "fetch-platform-deps.mjs");
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8").replace(/^\uFEFF/, ""));
s.check("scripts/fetch-platform-deps.mjs exists", existsSync(fetchScript));
s.check("fetch-platform-deps runs before packaging", /fetch-platform-deps/.test(pkg.scripts?.["vscode:prepublish"] ?? ""));
if (existsSync(fetchScript)) {
  const script = readFileSync(fetchScript, "utf8");
  // Every non-host platform in the list needs its platform-split packages named.
  for (const platform of BUNDLED_TREE_PLATFORMS.filter((p) => p !== "win32-x64")) {
    for (const prefix of ["@img/sharp-", "@vscode/ripgrep-", "node-addon-require-builtin-", "@koromix/koffi-", "@deepseek-ai/node-addon-system-", "sherpa-onnx-"]) {
      s.check(`fetch covers ${prefix}${platform}`, script.includes(`${prefix}${platform}`));
    }
  }
}

process.exit(s.finish() ? 0 : 1);
