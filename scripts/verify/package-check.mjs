// The packaged artifact: extension version, bundled dsh, adapter identity, the
// deliberate LibreOffice trim — and then a real boot of dsh FROM THE EXTRACTED
// TREE, which is what catches a `.vscodeignore` rule that dropped something the
// runtime needs.
//
//   node scripts/verify/package-check.mjs [path/to.vsix]

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { REPO, extractVsix, findVsix, loadWithStubbedVscode, mkTempHome, panelAdapter, stubVscode, suite } from "./harness.mjs";

/** True when `rel` is a non-empty file, or a directory with at least one entry
 * (version-suffixed payload names make exact file assertions brittle). */
function holdsFiles(abs) {
  try {
    const st = statSync(abs);
    if (st.isFile()) return st.size > 0;
    if (st.isDirectory()) return readdirSync(abs).length > 0;
  } catch {
    /* missing */
  }
  return false;
}

/** The native payloads each bundled-tree platform needs at runtime. Mirrors
 * platform.mjs's PAYLOADS, but asserted against the EXTRACTED vsix: this is the
 * artifact that actually reaches a Linux machine. */
const NATIVE = {
  "win32-x64": [
    "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
    "node_modules/@img/sharp-win32-x64/lib",
    "node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe",
    "node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt",
    "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
    "node_modules/sherpa-onnx-win-x64"
  ],
  "linux-x64": [
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "node_modules/@img/sharp-linux-x64/lib",
    "node_modules/@img/sharp-libvips-linux-x64/lib",
    "node_modules/@vscode/ripgrep-linux-x64/bin/rg",
    "node_modules/node-addon-require-builtin-linux-x64-gnu/prebuilt",
    "node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
    // POSIX session write lease (flock) + landlock sandbox launcher — Windows
    // uses a named kernel semaphore instead, so only Linux carries this one.
    "node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node",
    "node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node"
  ]
};

const s = suite("package check");
const vsix = process.argv.slice(2).find((a) => a.endsWith(".vsix")) ?? findVsix();
if (vsix === undefined || !existsSync(vsix)) {
  console.log("  skip: no .vsix in the repo root (run `npm run package` first)");
  process.exit(0);
}
console.log(`  vsix: ${path.basename(vsix)} (${(statSync(vsix).size / 1024 / 1024).toFixed(2)} MB)`);

const dir = extractVsix(vsix);
const ext = path.join(dir, "extension");
const read = (rel) => readFileSync(path.join(ext, rel), "utf8");
const json = (rel) => JSON.parse(read(rel).replace(/^\uFEFF/, ""));
const { PANEL_INJECT } = panelAdapter();
const home = mkTempHome();
const { BUNDLED_TREE_PLATFORMS, DshManager } = loadWithStubbedVscode("out/dshManager.js", stubVscode());
let manager;

try {
  const pkg = json("package.json");
  const bundled = json("node_modules/@deepseek-ai/dsh/package.json");
  const declared = pkg.dependencies?.["@deepseek-ai/dsh"];
  const repoPkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  s.check("extension version matches the repo", pkg.version === repoPkg.version, `vsix=${pkg.version} repo=${repoPkg.version}`);
  s.check("bundled dsh matches the declared dependency", bundled.version === declared, `declared=${declared} bundled=${bundled.version}`);
  s.check("panel-inject.js is byte-identical to the repo", read("panel-inject.js") === readFileSync(path.join(REPO, "panel-inject.js"), "utf8"));
  const frontend = read("node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html");
  s.check("bundled frontend ships the current adapter", frontend.includes(PANEL_INJECT));
  s.check("bundled frontend splits panels (marker present)", frontend.includes("[data-dsh-panel"));
  s.check("compiled entry points shipped", existsSync(path.join(ext, "out", "extension.js")) && existsSync(path.join(ext, "out", "chatPanel.js")));
  const cli = path.join(ext, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  s.check("bundled dsh CLI shipped", existsSync(cli));
  s.check("office plugin kept", existsSync(path.join(ext, "node_modules", "@deepseek-ai", "dsh-office-to-pdf", "package.json")));
  s.check("heavy LibreOffice payload excluded (deliberate trim)", !existsSync(path.join(ext, "node_modules", "@deepseek-ai", "libreoffice-kit-win32-x64")));
  s.check("dev-only verification suite excluded", !existsSync(path.join(ext, "scripts", "verify")));
  for (const platform of BUNDLED_TREE_PLATFORMS) {
    const missing = (NATIVE[platform] ?? []).filter((rel) => !holdsFiles(path.join(ext, rel)));
    s.check(`packaged tree ships the ${platform} native payloads`, missing.length === 0, missing.join(", "));
  }

  // boot dsh from the extracted tree — the real proof the package is complete
  manager = new DshManager({
    port: 0,
    home,
    cliPath: cli,
    autoInstall: false,
    autoRestart: false,
    cwd: dir,
    onInfo: () => {},
    log: (l) => console.log("  [dsh]", l),
  });
  await manager.start();
  s.check("dsh boots from the packaged tree", manager.info.state === "running", `state=${manager.info.state}`);
  s.check("packaged frontend supports split panels at runtime", manager.info.panelSupport === true);
} finally {
  if (manager !== undefined) { try { await manager.stop(); } catch {} }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

process.exit(s.finish() ? 0 : 1);
