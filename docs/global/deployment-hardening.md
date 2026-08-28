# Deployment hardening

What this stack exposes by default, what an operator opts into, and the reference edge that makes
the opt-ins safe. Companion to `pilot-runbook.md` (how to bring the stack up) and `threat-model.md`
(what the application-level controls defend against). This file covers the network boundary only.

## Every published port binds loopback

`docker-compose.yml` publishes every host port on `127.0.0.1`. Reaching any of these from another
machine is something a deployment states explicitly — by setting a bind-address variable, or by
tunnelling — never something it inherits from a default.

| Service | Host bind | Profile | Authentication | What reaching it grants |
| --- | --- | --- | --- | --- |
| `mongo` | `127.0.0.1:27018` | none (default) | none, unless enabled below | Every document, audit row, session and API-key hash in the corpus |
| `prometheus` | `127.0.0.1:9090` | `observability` | none | Request volumes, error rates and model spend, per tenant |
| `temporal` | `127.0.0.1:7233` | `temporal`, `temporal-ui`, `full` | none | Read, signal and terminate any workflow |
| `temporal-ui` | `127.0.0.1:8233` | `temporal-ui` | none | Complete workflow histories: questions, conflict payloads, approval decisions |
| `api` | `127.0.0.1:3001` | `full` | session cookie | The REST surface, bypassing `web`'s nginx |
| `mcp` | `${MCP_BIND_ADDRESS:-127.0.0.1}:3002` | `full` | PAT per call | The MCP tool surface |
| `web` | `${WEB_BIND_ADDRESS:-127.0.0.1}:8090` | `full` | session cookie | The SPA and, through it, the API |

Only `web` and `mcp` carry a bind-address knob, because only those two are surfaces a deployment
has a reason to serve. `mongo`, `prometheus`, `temporal` and `temporal-ui` have none: they take no
credential of their own, so loopback is the whole of their access control. Reach them remotely with
an SSH tunnel, which terminates on the host as a loopback connection like any other:

```sh
ssh -N -L 8233:127.0.0.1:8233 operator@host
```

Setting `WEB_BIND_ADDRESS` or `MCP_BIND_ADDRESS` to `0.0.0.0` publishes plaintext HTTP — a session
cookie and a PAT respectively, in the clear. Do it only behind the TLS edge below.

## Profiles keep the unauthenticated surfaces out of a routine bring-up

```sh
docker compose up -d mongo                      # database alone, for tests and the eval
docker compose --profile full up -d             # the application stack: migrate, api, worker, mcp, web
docker compose --profile observability up -d    # prometheus
docker compose --profile temporal up -d         # temporal server + its postgres, no UI
docker compose --profile temporal-ui up -d      # the UI, bringing the server with it
```

`full` starts neither Prometheus nor the Temporal UI. Both read across every tenant and neither has
a login, so each is asked for by name. Combine profiles to get both at once:

```sh
docker compose --profile full --profile observability up -d
```

## Database authentication

Off by default; the `mongo` container starts with no user and accepts any connection reaching it —
including from any other container on the compose network. Loopback binding is the only control
until this is enabled, which makes enabling it the right move for anything beyond a single-operator
laptop.

**The user is created on first initialisation of an empty data volume only.** Enabling this against
a populated `evidence_ops_data` volume starts `mongod` with authentication and no user to
authenticate as. Both paths are below.

Three places have to agree, or the stack comes up healthy and every query fails to authenticate.

1. **`.env.mongo-auth.local`** — the credentials the image creates on first init. Create it beside
   `docker-compose.yml`; the `mongo` service reads it as an optional `env_file`, and the existing
   `.env.*.local` rule in `.gitignore` keeps it out of git. An absent file leaves both variables
   unset, which is what makes the default posture identical to no authentication at all.

   ```sh
   MONGODB_INITDB_ROOT_USERNAME="evidence-ops"
   MONGODB_INITDB_ROOT_PASSWORD="<generated>"
   ```

2. **`MONGO_AUTH` in `.env`** — the `user:pass@` prefix compose interpolates into the containers'
   `MONGO_DB_URI`. It lives in `.env` rather than the file above because compose interpolates
   `${VAR}` from `.env` and the shell only, never from a service's `env_file`. Percent-encode the
   password if it contains any of `: / ? # [ ] @`.

   ```sh
   MONGO_AUTH="evidence-ops:<generated>@"
   ```

3. **`MONGO_DB_URI` in `.env`** — for host-run processes only (`start:dev`, `worker:dev`,
   `migrate:up`, the eval), which reach the database at `localhost:27018` rather than `mongo:27017`
   and therefore need their own URI. An inline `environment:` value beats `env_file`, so this never
   reaches the containers.

   ```sh
   MONGO_DB_URI="mongodb://evidence-ops:<generated>@localhost:27018/evidence-ops?directConnection=true&authSource=admin"
   ```

`authSource=admin` is not optional and is already in the compose URIs: the image creates the user in
`admin`, while a URI with `/evidence-ops` in its path would otherwise look for it in `evidence-ops`.
It is inert while no credential is supplied.

### Enabling it on a fresh volume

```sh
docker compose --profile full down -v
docker compose --profile full up -d
```

`down -v` destroys the corpus, the audit log and the search indexes. `0001-baseline.ts` blocks
until `$search`/`$vectorSearch` report READY on the way back up, so the first bring-up is slow.

### Enabling it on a populated volume

Create the user before the credentials take effect, using the localhost exception — `mongod` permits
creating the first user over loopback while no user exists:

```sh
docker compose exec mongo mongosh --quiet --eval \
  'db.getSiblingDB("admin").createUser({user: "evidence-ops", pwd: passwordPrompt(), roles: [{role: "root", db: "admin"}]})'
```

Then write the three files above and recreate the stack (`docker compose --profile full up -d
--force-recreate`) so `mongod` restarts with authentication enabled.

### Verifying

```sh
docker compose exec mongo mongosh --quiet --eval 'db.getSiblingDB("evidence-ops").evidencechunks.countDocuments()'
```

Unauthenticated, this must fail with `Unauthorized` once authentication is on. A count coming back
means `mongod` restarted without it.

## Reference TLS-terminating reverse proxy

The stack speaks plaintext HTTP throughout; TLS terminates at an edge proxy the deployment owns.
This nginx server block is the reference shape — one edge, two upstreams, both loopback-published by
compose on the same host.

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name evidence.example.com;

    ssl_certificate     /etc/letsencrypt/live/evidence.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/evidence.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=63072000" always;

    # The SPA, and the API behind it: `web`'s own nginx proxies /api to the api container.
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Server-sent events: answers, document lists and workflow runs stream from the API. Buffering
    # holds a stream in nginx until it fills a buffer, which presents as a UI that never updates.
    location /api/v1/ {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    # The MCP surface. Streamable HTTP responses are chunked and long-lived for the same reason.
    location /mcp {
        proxy_pass http://127.0.0.1:3002/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}

server {
    listen 80;
    server_name evidence.example.com;
    return 308 https://$host$request_uri;
}
```

Alongside it:

```sh
WEB_BIND_ADDRESS=127.0.0.1     # the default; the edge reaches it over loopback
MCP_BIND_ADDRESS=127.0.0.1     # likewise
TRUST_PROXY_HOPS=2             # api: this edge, then web's nginx
MCP_TRUST_PROXY_HOPS=1         # mcp: this edge only
CORS_ORIGIN=https://evidence.example.com
URL=https://evidence.example.com
```

### Why those hop counts, and what breaks at other values

`req.ip` is what the API's user-keyed throttle buckets, the login IP fallback and the MCP pre-auth IP
limiter all key on. Express derives it by walking the `X-Forwarded-For` chain from the right and
discarding as many entries as there are trusted hops, so the number has to be the number of proxies
actually in front of that process — counted per process, which is why `api` and `mcp` read separate
variables. The reference edge reaches `api` through `web`'s nginx (two hops) and `mcp` directly
(one).

- **Too high** — more hops than exist — is a limiter bypass. A caller reaching the listener directly
  appends whatever it likes to `X-Forwarded-For` and picks its own bucket, or charges its requests
  to someone else's.
- **Too low** — the default of `0`, or leaving `TRUST_PROXY_HOPS` unset behind an edge — collapses
  every caller onto the proxy's own address and one shared bucket. That over-refuses: one hostile
  caller can exhaust the budget for everyone. It is the direction a misconfiguration must fail in,
  and it is why the defaults are `0` for `mcp` and `1` for `api` rather than a guess at an edge.

Two deployment properties make a non-zero count safe, and both are load-bearing:

1. **The listener is reachable only through the proxy.** The compose publishes bind loopback, so a
   request that skips the edge has to come from the host itself.
2. **The proxy appends rather than overwrites.** `$proxy_add_x_forwarded_for` appends the peer
   address to whatever the client sent, so the entry the proxy contributed is the rightmost one and
   a client-supplied prefix is inert. Replacing it with `proxy_set_header X-Forwarded-For
   $remote_addr` is also correct at one hop; passing the client's header through unchanged is not.

`test/mcp/mcp-http-app.spec.ts` pins both directions: two forwarded callers get separate budgets, a
forged prefix (`9.9.9.9, 1.1.1.1`) stays in the forger's own bucket, and at zero hops the header is
ignored entirely.

## Reachability scan

The falsifiable check on all of the above, run on the host after a bring-up:

```sh
docker compose --profile full up -d
sudo lsof -nP -iTCP -sTCP:LISTEN | grep -E '3001|3002|7233|8090|8233|9090|27018'   # macOS
ss -tlnp | grep -E '3001|3002|7233|8090|8233|9090|27018'                          # Linux
```

Every line must show `127.0.0.1:<port>`, never `*:<port>` or `0.0.0.0:<port>`. Confirm from a second
machine that nothing answers:

```sh
nmap -Pn -p 3001,3002,7233,8090,8233,9090,27018 <host>
```

Every port must report `closed` or `filtered`. A port reporting `open` from another machine is the
signal that a bind-address override, a stray `-p` publish, or a `docker run` outside compose has
reopened the surface this file exists to keep closed.
