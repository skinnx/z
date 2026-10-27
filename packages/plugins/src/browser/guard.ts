/**
 * The SSRF guard for the browser. Chromium is forced through this local HTTP proxy, so every
 * navigation, redirect hop, subresource, worker fetch and WebSocket is checked with the same rules
 * as fetch_page. (Playwright's request routing doesn't see redirect hops, so it can't do this.)
 * The proxy connects to the address it checked, so DNS rebinding can't swap it afterwards.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { errorMessage, resolvePublicHost } from "../util.ts";

export type GuardProxy = { server: string; close: () => void };

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "transfer-encoding", "upgrade"];

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = { ...headers };
  for (const name of HOP_BY_HOP) delete out[name];
  return out;
}

/** The proxy the host itself must use for https (HTTPS_PROXY), as Chromium would have used. */
const httpsProxy = (() => {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  try {
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
})();

/** A socket to host:port: straight to the checked address, or through HTTPS_PROXY when one is set. */
function tunnel(host: string, address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (!httpsProxy) {
      const socket = connect(port, address, () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
      return;
    }
    const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    const socket = connect(Number(httpsProxy.port) || 80, httpsProxy.hostname, () => {
      const auth = httpsProxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(httpsProxy.username)}:${decodeURIComponent(httpsProxy.password)}`).toString("base64")}\r\n`
        : "";
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let response = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      socket.off("error", reject);
      if (!/^HTTP\/1\.[01] 200/.test(response.toString("latin1", 0, end))) {
        socket.destroy();
        return reject(new Error(`Upstream proxy refused ${target}`));
      }
      if (response.length > end + 4) socket.unshift(response.subarray(end + 4));
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

export async function startGuardProxy(onBlocked: (target: string) => void): Promise<GuardProxy> {
  const resolved = new Map<string, { expires: number; address: Promise<string> }>();
  /** One public address for `host` (IPv4 preferred), cached briefly; rejects for private hosts. */
  const publicAddress = (host: string) => {
    const hit = resolved.get(host);
    if (hit && hit.expires > Date.now()) return hit.address;
    const address = resolvePublicHost(host).then((all) => all.find((a) => isIP(a) === 4) ?? all[0]!);
    resolved.set(host, { expires: Date.now() + 30_000, address });
    return address;
  };

  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  // Plain http: the request line carries the absolute URL.
  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("not http");
    } catch {
      res.writeHead(400).end();
      return;
    }
    let address: string;
    try {
      address = await publicAddress(url.hostname);
    } catch (error) {
      onBlocked(url.origin);
      res.writeHead(403, { "content-type": "text/plain" }).end(`Blocked by z: ${errorMessage(error)}`);
      return;
    }
    const upstream = httpRequest(
      {
        host: address,
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers: endToEnd(req.headers),
        setHost: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, endToEnd(up.headers));
        up.pipe(res);
      },
    );
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });

  // https and WebSockets tunnel with CONNECT host:port.
  server.on("connect", async (req, client: Socket, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(req.url ?? "");
    const host = match?.[1] ?? match?.[2];
    if (!match || !host) return void client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const port = Number(match[3]);
    let upstream: Socket;
    try {
      const address = await publicAddress(host).catch((error) => {
        onBlocked(new URL(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`).origin);
        throw error;
      });
      upstream = await tunnel(host, address, port);
    } catch (error) {
      const blocked = /Refusing/.test(errorMessage(error));
      return void client.end(`HTTP/1.1 ${blocked ? "403 Forbidden" : "502 Bad Gateway"}\r\n\r\n`);
    }
    track(upstream);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as { port: number };
  return {
    server: `http://127.0.0.1:${port}`,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
