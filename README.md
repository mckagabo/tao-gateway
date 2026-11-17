# TAO gateway

Keeps each TopBrainer expert inside their own folders in TAO's back office (`assessment.topbrainer.com/backoffice`).
TAO Community Edition has no per-folder access control, so without this every expert sees every test and item.

It sits between nginx and TAO for the back office only. Exam taking never passes through it.

- `src/policy.js` – the rules (who may reach what). Start here.
- `src/uri.js`, `src/params.js` – finding and rewriting TAO addresses in a request.
- `src/sessions.js` – which browser session is which TAO login.
- `src/db.js` – read-only questions to TAO's database (whose folder, whose resource).
- `src/server.js` – the proxy.

`npm test` runs the unit tests (no TAO or database needed).

## How ownership is decided

- An expert's folders are the ones whose label carries `[TB-AUTHOR:<their TopBrainer id>]`, one per tree (Tests, Items).
- A resource is theirs if it is inside one of those folders, or its label carries `[TB:<their id>:…]`.
- Everything else belongs to admin only.

## Modes

- `MODE=observe` – forwards everything untouched; logs `would_deny` / `would_pass` (with a folder swap) lines.
- `MODE=enforce` + `ENFORCE_LOGINS=<login>` – rules apply to that login only (a trial).
- `MODE=enforce` + `ENFORCE_LOGINS=*` – rules apply to everyone except `ADMIN_LOGINS`.

## Install (stage 1, observe only)

1. Copy this folder to the TAO server as `/home/tao/tao-gateway`.
2. Create the read-only database user (pick your own password):
   ```
   docker exec -it tao-ce-pgsql-1 psql -U postgres -d postgres
   create role tao_gateway_ro login password 'PICK_A_PASSWORD';
   grant connect on database postgres to tao_gateway_ro;
   grant usage on schema public to tao_gateway_ro;
   grant select on statements to tao_gateway_ro;
   \q
   ```
3. `cp .env.example .env`, put that password in `DATABASE_URL`, `chmod 600 .env`. Leave `MODE=observe`.
4. `docker compose up -d --build`, then `curl -s http://127.0.0.1:8090/__gateway/health` → `{"ok":true,"mode":"observe"}`.
5. Add `nginx-snippet.conf` to the site file, `nginx -t && systemctl reload nginx`.
6. Watch: `docker logs -f tao-gateway`.

Off switch: comment out the `location /backoffice/` block in nginx and reload. TAO is then reached directly, as before.
