# Deploy z

This page gets z running on your machine, in Docker, behind a reverse proxy or on a private network, and covers backups and upgrades.

z is one Node process. It keeps everything in one data directory: the SQLite database, the master key that encrypts your secrets, and (when it generates one) the API access token. The process also serves the built web app.

Environment variables are listed in the [README](../README.md#configuration). This page only uses those.

## Local

You need Node 22.13 or newer and pnpm (the version is pinned in `package.json`; `corepack enable` installs it).

```sh
pnpm install --frozen-lockfile
pnpm --filter @z/web build
pnpm --filter @z/server start
```

```
[z] Generated a new master key at /…/apps/server/.data/master.key. Back it up: stored secrets cannot be decrypted without it.
[z] listening on http://127.0.0.1:8787 (serving web app)
[z] data dir /…/apps/server/.data; 8 plugin(s); auth off
```

Open `http://127.0.0.1:8787`. The server only listens on loopback by default, so no token is needed. `Z_DATA_DIR` is resolved against the server's working directory, which is `apps/server` under `pnpm --filter`. Use an absolute path if you want the data somewhere else.

For development, `pnpm dev` runs the server with reload, plus the Vite dev server on `:5173`, which proxies `/api` to `:8787`.

## Docker

```sh
docker build -t z .
docker run -d --name z -p 8787:8787 -v z-data:/data z
docker logs z
```

```
[z] Generated a new master key at /data/master.key. Back it up: stored secrets cannot be decrypted without it.
[z] Listening beyond localhost without Z_TOKEN: generated an access token in /data/access.token. Enter it in the web app.
[z] listening on http://0.0.0.0:8787 (serving web app)
[z] data dir /data; 8 plugin(s); auth on
```

- The image sets `Z_DATA_DIR=/data`, `PORT=8787` and `Z_HOST=0.0.0.0`. Mount a volume on `/data`, or everything is lost with the container.
- z will not run open when it listens beyond loopback. With no `Z_TOKEN`, it writes a random token to `/data/access.token` and requires it on every `/api` route, `/api/health` included. Read the token and paste it into the web app when it asks:

  ```sh
  docker exec z cat /data/access.token
  ```

- To choose the token yourself, pass `-e Z_TOKEN=…`. The setup checklist flags tokens under 32 characters; `openssl rand -hex 32` makes a good one.
- `docker stop z` sends SIGTERM to Node (PID 1), which stops tasks, channels and connectors before it exits.
- To publish the port on loopback only (when a proxy on the same host fronts it), use `-p 127.0.0.1:8787:8787`.

## Behind a reverse proxy

Terminate TLS in the proxy and forward everything to z. Two things matter:

1. **Streaming.** `GET /api/events` (live updates) and `POST /api/chat` (chat replies) are long-lived `text/event-stream` responses. The proxy must not buffer them and must not time out an idle stream; z sends a `ping` event every 15 seconds. z serves no WebSocket endpoints today; the upgrade lines in the nginx example do no harm and keep the block safe to reuse.
2. **`Z_PUBLIC_URL`.** z does not read `X-Forwarded-*` headers. Behind TLS it sees plain http, so set `Z_PUBLIC_URL=https://z.example.com`. Webhook channels (Slack, webhook) get their callback URL from it, and OAuth connectors use `$Z_PUBLIC_URL/oauth/callback` as the redirect URI. The setup checklist (**Settings → Setup**, or `POST /api/setup/check`) fetches `$Z_PUBLIC_URL/api/health` to confirm it reaches this server.

Caddy (gets a certificate on its own):

```caddyfile
z.example.com {
	reverse_proxy 127.0.0.1:8787 {
		# Stream live events and chat replies as they are written.
		flush_interval -1
	}
}
```

nginx:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name z.example.com;

    ssl_certificate     /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;

    # Chat requests carry the whole conversation.
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # Live events and chat replies are streamed: pass every byte on at once.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Check that events stream through the proxy. `?token=` is how EventSource clients authenticate. The `ready` event should appear at once, not when curl gives up:

```sh
curl -sN "https://z.example.com/api/events?token=$Z_TOKEN"
```

```
event: ready
data: {}
```

## Tailscale or LAN

To reach z from your phone or laptop over Tailscale or your home network without a public domain:

```sh
Z_HOST=0.0.0.0 pnpm --filter @z/server start
```

Because the host isn't loopback, z generates `access.token` in the data directory (or uses `Z_TOKEN`), exactly as in Docker. You can also set `Z_HOST` to your Tailscale address instead of `0.0.0.0`.

Some features need care on a private address:

- **OAuth connectors.** Providers only accept plain-http redirects to `localhost`. When you open z at `http://100.x.y.z:8787` and `Z_PUBLIC_URL` is unset, z asks for `http://localhost:8787/oauth/callback` as the redirect. After you approve, your browser lands on a localhost page that doesn't load. Copy that address from the address bar and paste it into the connector's *Browser didn't come back?* box (`POST /api/connectors/:id/oauth/complete`). The state in it is checked, single use and valid for 10 minutes, like the real callback. See [connectors](connectors.md#oauth).
- **MCP servers on your network.** Connectors refuse localhost, private ranges and plain http unless you start z with `Z_ALLOW_PRIVATE_MCP=1`. The browser plugin has the same switch, `Z_ALLOW_PRIVATE_BROWSER=1`.
- **Webhook channels** (Slack, the generic webhook) need the platform to reach z, so they need a public `Z_PUBLIC_URL`. Telegram, Discord and X connect out and work without one.
- **Web Push** needs a secure context in the browser: https, or `localhost`.

## Backups

Everything is in the data directory (`/data` in Docker):

| File | What it is |
| --- | --- |
| `z.db`, `z.db-wal`, `z.db-shm` | The SQLite database (WAL mode): settings, tasks, memories, threads and every sealed secret |
| `master.key` | The AES-256 key for the sealed secrets, unless you pass `Z_MASTER_KEY` |
| `access.token` | The generated API token, if z made one |

**Back up the master key separately and keep it safe.** Provider keys, channel secrets, connector URLs, headers and OAuth tokens, plugin settings, saved sign-ins, push keys and the VAPID key are encrypted with it. Without it the database still opens, but none of those secrets can be decrypted, and you would have to enter every key again. If you set `Z_MASTER_KEY`, that value is the key: store it in your password manager. The setup checklist keeps a *Master key backed up* item open until you confirm it.

Offline backup (stop, copy the whole directory, start):

```sh
docker stop z
docker run --rm -v z-data:/data -v "$PWD":/backup node:22-slim tar czf /backup/z-backup.tgz -C /data .
docker start z
```

Online snapshot of the database while z runs (the master key and token still need copying on their own):

```sh
docker exec z node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('/data/z.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker cp z:/data/backup.db ./z-backup.db
```

To restore, put the files back into an empty data directory or volume, then start z:

```sh
docker volume create z-data-restored
docker run --rm -v z-data-restored:/data -v "$PWD":/backup node:22-slim tar xzf /backup/z-backup.tgz -C /data
docker run -d --name z -p 8787:8787 -v z-data-restored:/data z
```

**Settings → Data** (`GET /api/export`) downloads a JSON export of everything except secrets. It is a record you can read, not a backup you can restore.

## Upgrades

Schema migrations run automatically at startup. Each named migration that the `schema_migrations` table hasn't recorded runs in its own transaction and is recorded when it finishes. `PRAGMA user_version` keeps the count, which the diagnostics export shows as `schemaVersion`. Migrations are append-only, so an older database always moves forward. Back up first; there is no downgrade path.

From source:

```sh
git pull
pnpm install --frozen-lockfile
pnpm --filter @z/web build
pnpm --filter @z/server start
```

Docker:

```sh
git pull
docker build -t z .
docker rm -f z
docker run -d --name z -p 8787:8787 -v z-data:/data z
```

Tasks that were running when z stopped resume from their saved conversation. A task that stopped in the middle of a write or external tool call is marked `interrupted` and never re-run automatically; see [architecture](architecture.md#run-flows).

---

The commands on this page were run on 2026-10-28 against z 0.1.0, on other host ports. Not run: `pnpm dev` (it binds the fixed Vite port 5173), `git pull`, and the Tailscale and TLS steps; the Caddy and nginx configs were checked with `caddy validate` and `nginx -t` and, without TLS, proxied the event stream as shown.
