/**
 * Local reverse proxy 127.0.0.1:<random> → the dsh web server.
 *
 * dsh 0.1.2+ authenticates browsers with a SameSite=Strict cookie minted by a
 * 303 token exchange at GET /?token=…; a cross-origin VS Code webview iframe
 * can never send that cookie, so the embedded GUI would be 401. This proxy
 * lives in the extension host (Node): it injects the minted/forged browser
 * cookie into every forwarded request, sanitizes browser-sourced headers
 * (Host/Origin/sec-fetch-*), and tunnels WebSocket upgrades
 * (`/api/remote.mux`). The webview then talks to a plain loopback server with
 * no browser-cookie requirements — split-panel query params survive as-is.
 */

import * as http from "node:http";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** Headers the browser sets that would confuse the upstream trust fence. */
const STRIP_HEADERS = new Set([
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "host"
]);

/** Cookie value of one validated browser session (`name=value`), optional. */
export type CookieProvider = () => Promise<string | undefined> | string | undefined;

/** One settings write the dsh server REFUSED to persist, as seen on the wire. */
export interface RejectedSettingsWrite {
  /** Settings namespace the GUI wrote (e.g. "ui-settings-general"), when the
   * request body carried one. */
  ns?: string;
  /** The patch the GUI sent, when the request body carried one. */
  patch?: unknown;
  /** Whatever the server answered with. */
  message: string;
}

/** Called once per rejected settings write. Never allowed to disturb the pipe. */
export type SettingsRejectionHook = (rejection: RejectedSettingsWrite) => void;

/** The ONE endpoint whose bodies the proxy inspects (the GUI's own writes). */
const SETTINGS_PATH = "/api/settings/update";
/** Never buffer more than this much of a request/response body. Anything
 * larger is passed through untouched and simply not inspected. */
const CAPTURE_LIMIT = 1 << 20;

/**
 * Is this a settings/update answer the server REFUSED to persist?
 *
 * dsh answers HTTP 200 with `{"result":{"ok":false,"error":{…}}}` for a write it
 * could not apply — notably the "profile reload requires the root Include
 * entry" state, where reads keep working while every write is dropped, so the
 * page shows nothing at all. Everything that is not a parseable `ok:false`
 * envelope (compressed, streamed, HTML, empty) counts as not-rejected, so a
 * body we cannot read can never be turned into a false recovery.
 */
export function readSettingsRejection(responseBody: string): { rejected: boolean; message?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { rejected: false };
  }
  const result = (parsed as { result?: unknown }).result;
  if (result === null || typeof result !== "object") return { rejected: false };
  const envelope = result as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  if (envelope.ok !== false) return { rejected: false };
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "";
  const message = typeof envelope.error?.message === "string" ? envelope.error.message : "";
  return {
    rejected: true,
    message: code !== "" && message !== "" ? `${code}: ${message}` : code !== "" ? code : message !== "" ? message : "settings write rejected"
  };
}

/** Pull `{ns, patch}` out of a settings/update request body. dsh 0.1.2+ uses a
 * typert envelope (`payload: {args: {ns, patch}}`); the older wire put the
 * descriptor straight into `payload`. Both shapes are accepted; anything
 * unreadable yields an empty result rather than an exception. */
export function readSettingsArgs(requestBody: string): { ns?: string; patch?: unknown } {
  let payload: unknown;
  try {
    payload = (JSON.parse(requestBody) as { payload?: unknown }).payload;
  } catch {
    return {};
  }
  let args: unknown = payload;
  if (payload !== null && typeof payload === "object" && "args" in (payload as Record<string, unknown>)) {
    args = (payload as { args?: unknown }).args;
  }
  if (args === null || args === undefined || typeof args !== "object") return {};
  const record = args as { ns?: unknown; patch?: unknown };
  return { ns: typeof record.ns === "string" ? record.ns : undefined, patch: record.patch };
}

export class GuiProxy {
  private server?: http.Server;
  private readonly targetPort: number;
  private readonly cookie: CookieProvider;
  private readonly onSettingsRejected?: SettingsRejectionHook;
  private lastPort?: number;

  constructor(targetPort: number, cookie: CookieProvider, onSettingsRejected?: SettingsRejectionHook) {
    this.targetPort = targetPort;
    this.cookie = cookie;
    this.onSettingsRejected = onSettingsRejected;
  }

  /** `http://127.0.0.1:<port>/` while running. */
  get url(): string | undefined {
    return this.lastPort === undefined ? undefined : `http://127.0.0.1:${this.lastPort}/`;
  }

  async start(): Promise<number> {
    if (this.server !== undefined) return this.lastPort ?? 0;
    const target = { host: "127.0.0.1", port: this.targetPort };
    const server = http.createServer((req, res) => {
      void this.forward(server, req, res, target).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(`gui proxy: ${String(err)}`);
      });
    });
    server.on("upgrade", (req, socket, head) => {
      this.forwardUpgrade(req, socket, head, target);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.lastPort = (server.address() as AddressInfo).port;
    return this.lastPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    this.lastPort = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async forward(
    server: http.Server,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number }
  ): Promise<void> {
    // A rejected settings write is invisible otherwise: the GUI is its own
    // origin inside the webview, dsh answers HTTP 200, and the extension never
    // sees the exchange. Inspect this ONE endpoint (bounded, pass-through) so a
    // refusal can be turned into the documented manual workaround.
    const inspect = (req.method ?? "").toUpperCase() === "POST" && (req.url ?? "").split("?")[0] === SETTINGS_PATH;

    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (STRIP_HEADERS.has(lower)) continue;
      if (lower === "connection" || lower === "upgrade" || lower === "transfer-encoding") continue;
      // Ask for an uncompressed answer on the one endpoint whose body has to be
      // readable: a gzip body would defeat the JSON check and silently disable
      // the recovery. The page still receives a valid answer either way.
      if (inspect && lower === "accept-encoding") continue;
      headers[key] = value;
    }
    headers.host = `${target.host}:${target.port}`;
    const cookie = await this.cookie();
    if (cookie !== undefined && cookie !== "") headers.cookie = cookie;

    let requestBody = "";
    if (inspect) {
      req.on("data", (chunk: Buffer) => {
        if (requestBody.length < CAPTURE_LIMIT) requestBody += chunk.toString("utf8");
      });
    }

    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        if (inspect) {
          let responseBody = "";
          upstreamRes.on("data", (chunk: Buffer) => {
            if (responseBody.length < CAPTURE_LIMIT) responseBody += chunk.toString("utf8");
          });
          upstreamRes.on("end", () => this.reportSettingsRejection(requestBody, responseBody));
        }
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`gui proxy: ${err.message}`);
    });
    req.pipe(upstream);
  }

  /** Hand a refused settings write to the hook. The bytes are already on their
   * way to the page, so a malformed body or a throwing hook must never change
   * what the webview receives. */
  private reportSettingsRejection(requestBody: string, responseBody: string): void {
    const hook = this.onSettingsRejected;
    if (hook === undefined) return;
    try {
      const rejection = readSettingsRejection(responseBody);
      if (!rejection.rejected) return;
      const { ns, patch } = readSettingsArgs(requestBody);
      hook({ ns, patch, message: rejection.message ?? "settings write rejected" });
    } catch {
      /* proxy-side only: never let this reach the response */
    }
  }

  private forwardUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: { host: string; port: number }): void {
    const up = net.connect(target.port, target.host, () => {
      const raw =
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        `Host: ${target.host}:${target.port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"] ?? ""}\r\n` +
        `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? "13"}\r\n` +
        (req.headers["sec-websocket-protocol"] !== undefined ? `Sec-WebSocket-Protocol: ${String(req.headers["sec-websocket-protocol"])}\r\n` : "") +
        "\r\n";
      // The cookie is read before the handshake packet: the WebSocket handshake
      // must carry it in the first upstream packet.
      void Promise.resolve(this.cookie()).then((cookie) => {
        const withCookie = cookie !== undefined && cookie !== "" ? raw.replace("HTTP/1.1\r\n", `HTTP/1.1\r\nCookie: ${cookie}\r\n`) : raw;
        up.write(withCookie);
        if (head !== undefined && head.length > 0) up.write(head);
      });
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  }
}
