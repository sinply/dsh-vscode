// Fetch the non-host native payloads that the published VSIX has to contain.
//
// The VSIX is assembled on a Windows (win32-x64) machine, so a plain
// `npm install` only materialises the win32-x64 halves of the platform-split
// packages: node-pty ships every prebuild in its tarball, but @img/sharp-* and
// @vscode/ripgrep-* are separate packages and npm only installs the ones whose
// `os`/`cpu` fields match the host.
//
// The extension is published for Windows AND Linux (extensionKind is
// ["workspace"], so WSL / Remote-SSH / Codespaces run the extension host on the
// Linux side), and the bundled tree is a candidate on both — see
// BUNDLED_TREE_PLATFORMS in src/dshManager.ts. The linux-x64 payloads therefore
// have to be pulled in explicitly before packaging, or the bundled copy fails at
// `import sharp from "sharp"`, in the node-pty prebuild lookup, or — earliest of
// all — in dsh's own boot loader, before the server ever listens.
//
// Everything is driven by package-lock.json: the exact tarball URL and the
// sha512 integrity of every package are read from the lock, so this can never
// silently install a version different from the pinned dependency tree. Nothing
// is written to package.json and nothing is added to git; the unpacked
// directories live in node_modules/ like any other install.
//
// Idempotent: a package already unpacked at the pinned version is left alone.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** Payloads the package must carry for every platform it is a candidate on. */
const WANTED = [
  "node_modules/@img/sharp-linux-x64",
  "node_modules/@img/sharp-libvips-linux-x64",
  "node_modules/@vscode/ripgrep-linux-x64",
  // dsh boots through node-addon-native-custom-loader, which resolves a
  // per-platform `require_builtin.node` out of an optional package
  // (`node-addon-require-builtin-<platform>-<abi>`). Without it the CLI dies at
  // startup with "host preparation failed: No usable native binding found for
  // node-addon-require-builtin-linux-x64-gnu". koffi loads its .node the same way
  // from @koromix/koffi-<platform>.
  "node_modules/node-addon-require-builtin-linux-x64-gnu",
  "node_modules/@koromix/koffi-linux-x64"
];

const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

function download(url, dest, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`too many redirects for ${url}`));
          return;
        }
        download(new URL(res.headers.location, url).toString(), dest, redirects + 1).then(resolvePromise, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → HTTP ${status}`));
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolvePromise()));
      out.on("error", reject);
    }).on("error", reject);
  });
}

function installedVersion(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return undefined;
  }
}

let fetched = 0;
let skipped = 0;

for (const name of WANTED) {
  const entry = lock.packages?.[name];
  if (entry === undefined || typeof entry.resolved !== "string" || typeof entry.integrity !== "string") {
    throw new Error(`${name} is not pinned in package-lock.json (resolved + integrity) — refusing to guess`);
  }
  const target = join(root, name);
  if (installedVersion(target) === entry.version) {
    console.log(`[platform-deps] ${name} v${entry.version} already present — skipped`);
    skipped += 1;
    continue;
  }
  const stage = mkdtempSync(join(tmpdir(), "dsh-platform-"));
  const tarball = join(stage, "package.tgz");
  try {
    console.log(`[platform-deps] fetching ${name} v${entry.version}`);
    // eslint-disable-next-line no-await-in-loop
    await download(entry.resolved, tarball);
    const digest = createHash("sha512").update(readFileSync(tarball)).digest("base64");
    const expected = entry.integrity.replace(/^sha512-/, "");
    if (digest !== expected) {
      throw new Error(`integrity mismatch for ${name}: got sha512-${digest}, expected ${entry.integrity}`);
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    // bsdtar on Windows 10+ and GNU tar everywhere else both take these flags.
    execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", target], { stdio: "inherit" });
    console.log(`[platform-deps] ${name} v${installedVersion(target) ?? "?"} unpacked`);
    fetched += 1;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

console.log(`[platform-deps] ${fetched} fetched, ${skipped} already present`);
