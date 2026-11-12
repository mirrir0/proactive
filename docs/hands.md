# Hands — running work on your own machines

A **hand** is an execution environment. The **brain** (Router + Workers) runs in
the cloud or on a server; the hand runs where the files, toolchain and
credentials actually are: your laptop, a build box, a container.

```
  brain (daemon)                          hands (this machine)
  ┌───────────────────────┐              ┌──────────────────────────┐
  │ Router                │              │ mir-endpoint             │
  │  └─ Worker ───────────┼─ exec() ────▶│  • runs commands         │
  │     (model + tools)   │◀── result ───│  • reads/writes files    │
  │                       │              │  • uses local git remote │
  │ MirStore (session)    │              │  • holds no state        │
  └───────────────────────┘              └──────────────────────────┘
```

The hand dials **out**, so you never open a port, forward one, or give it a
static address. Kill it, lose the network, close the laptop — the brain sees a
failed tool call, not a lost task.

---

## 1. Register the machine (on the hub)

```bash
mir hands add my-laptop --name "Orchid's MacBook"
```

Prints a token **once** and the exact command to run on that machine:

```
  mir-endpoint --hub hub.example.com:4700 --id my-laptop --token <token> \
               --root ~/work --allow git,ls,cat,rg,node,pnpm --fs rw
```

Manage the fleet:

```bash
mir hands list          # registered hands + last seen
mir hands work          # recent work items dispatched to hands
mir hands revoke <id>   # stop accepting it (token is refused from now on)
mir hands rm <id>       # forget it entirely
```

---

## 2. Install the endpoint (on the machine)

```bash
npm install -g .          # from a checkout; installs the `mir-endpoint` binary
# or run without installing:
npx tsx src/endpoint/main.ts --help
```

Everything is a flag or a `MIR_HANDS_*` environment variable, so it works as a
service unit with the token in the environment.

### macOS — launchd

`~/Library/LaunchAgents/dev.mir.endpoint.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.mir.endpoint</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/mir-endpoint</string>
    <string>--hub</string><string>hub.example.com:4700</string>
    <string>--id</string><string>my-laptop</string>
    <string>--root</string><string>/Users/me/work</string>
    <string>--allow</string><string>git,ls,cat,rg,node,npm,pnpm,make</string>
    <string>--fs</string><string>rw</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MIR_HANDS_TOKEN</key><string>REPLACE_ME</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/mir-endpoint.err.log</string>
  <key>StandardOutPath</key><string>/tmp/mir-endpoint.out.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.mir.endpoint.plist
```

### Linux — systemd

`/etc/systemd/system/mir-endpoint.service`:

```ini
[Unit]
Description=mir hand (execution endpoint)
After=network-online.target

[Service]
Type=simple
User=build
Environment=MIR_HANDS_TOKEN=REPLACE_ME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/mir-endpoint \
  --hub hub.example.com:4700 --id build-box \
  --root /srv/work --allow git,make,node,pnpm,tsc --fs rw \
  --tls --ca /etc/ssl/certs/hub-ca.pem
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now mir-endpoint
```

### Container

The endpoint is a normal foreground process, so it runs as PID 1 in a small
image. Mount the worktree, pass the token, keep it `--read-only` if the task only
needs to read.

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g /opt/mir        # or COPY the built dist + bin
WORKDIR /work
ENTRYPOINT ["mir-endpoint"]
```

```bash
docker run --rm -e MIR_HANDS_TOKEN=... -v "$PWD:/work" mir-hand \
  --hub hub.example.com:4700 --id docker-1 --root /work --allow git,ls,cat --fs rw --tls
```

---

## 3. What a task can do

The brain sees exactly six tools, and only what the hand grants:

| tool | needs | notes |
| --- | --- | --- |
| `exec` | `--no-exec` off | argv array; **no shell** unless `--shell` and `sh` is allowlisted |
| `read_file` / `list_dir` | `--fs ro` or `rw` | paths resolve inside `--root`; escapes are refused |
| `write_file` | `--fs rw` | size-capped by `--max-output`/policy |
| `git` | `--no-git` off | `push`/`pull` use the machine's own remote credentials |
| `list_hands` | always | shows id, capabilities, roots, load |

`exec` never goes through a shell by default, so `;`, `|`, `$()` and `&&` are
literal arguments — a model-generated string cannot become a second command. If
you genuinely need pipelines, grant `--shell` **and** add `sh` to `--allow`; the
endpoint warns loudly when you do, because the allowlist cannot constrain a shell
string. (The sandbox still constrains what that shell may read, write and reach.)

### Two layers: allowlist, then sandbox

An executable allowlist answers **which programs may run**. It does not answer
**what they may touch or reach** — `cat` can read anything you can read, `node`
can write anywhere you can write, and either can post it to the internet.

| layer | flag | enforcement | guarantee |
| --- | --- | --- | --- |
| allowlist | `--allow` / `--deny` | argv[0] check, no shell | only these programs start |
| roots | `--root` | path resolution for the hand's own tools | `read_file`/`write_file`/`list_dir`/`git` stay inside |
| **sandbox** | on by default | [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) — seatbelt (macOS), bubblewrap (Linux), WFP (Windows) | the **whole process tree** may only write inside the roots, may not read `--deny-read` paths, and may not reach hosts outside `--allow-net` |

The sandbox is **on by default**. That means a fresh hand has **no network**:
`git push`, `npm install` and `curl` fail until you name the hosts they need.

```bash
mir-endpoint --hub hub:4700 --id my-laptop --token …   --root ~/work   --allow git,node,pnpm,ls,cat,rg   --allow-net github.com,registry.npmjs.org,objects.githubusercontent.com   --deny-read ~/.ssh --deny-read ~/.aws --deny-read ~/.config/gh   --deny-write ~/work/.env
```

What that buys you:

- a prompt-injected command cannot write to `~/.zshrc`, `~/.ssh/authorized_keys`
  or anywhere else outside `~/work`;
- it cannot read your SSH keys, cloud credentials or `gh` token;
- it cannot POST what it did read anywhere except the hosts you named;
- `git push` still works, because the *local* remote already has the credential
  and `github.com` is allowed.

Denials come back as policy, not as a mystery:

```
error: blocked by sandbox policy: deny file-write-data /Users/me/.zshrc
```

`--no-sandbox` turns enforcement off (allowlist only). It logs a warning,
because at that point "allowlisted" means "allowed to do anything".

If the sandbox is requested and cannot be enforced — unsupported platform,
`bwrap` missing, a config the runtime rejects — the hand **refuses to start**
rather than running unconfined.

---

## 4. Security model

The machine is the security principal. The hub authenticates it; it does not get
to widen its permissions.

- **Token** — per hand, generated by `mir hands add`, stored only as a SHA-256
  hash, compared in constant time. `mir hands revoke` refuses it immediately.
- **Policy lives on the hand** — roots, executable allowlist, timeouts, output
  caps. The hub can only pick *which* hand runs something.
- **Credentials never enter the brain.** The endpoint executes with the machine's
  own credentials (`git push` works), but the model never sees a token: the
  child process gets a filtered environment (secret-shaped names are dropped),
  and everything leaving the hand is redacted against the hand's secret registry.
- **Network** — two separate networks to think about. The *hub link* should use
  `--tls --ca <bundle>` for anything that is not loopback. The *hand's own
  egress* is confined by `--allow-net`; nothing leaves the machine except to the
  hosts you name.
- **Proxy-aware clients** — the sandbox mediates traffic through host-side
  proxies. `curl`, `git`, `npm` and `pnpm` honour them. Node's `fetch` needs
  `NODE_USE_ENV_PROXY=1`, which the hand injects for you; a language runtime that
  ignores `HTTPS_PROXY` will simply fail to connect.
- **Blast radius** — the worst a compromised brain can do is run an allowlisted
  command that reads non-denied files, writes inside a declared root, and talks
  to the hosts you allowed. That is the point of the boundary.

---

## 5. Operating notes

- **A hand going away is normal.** The call returns `hand <id> disconnected
  before finishing`; the Worker can retry, pick another hand, or report it. The
  session log (ADR 0002) is unaffected.
- **Heartbeats** every `--heartbeat` ms (default 15s). The hub drops a hand after
  `MIR_HANDS_OFFLINE_GRACE_MS` (default 90s) of silence and fails its calls.
- **Audit** — every completed call lands in `work_items`, visible with
  `mir hands work`, including duration, ok/failed, truncation and error.
- **Capacity** — `--max-concurrent` (default 2). Calls beyond it are refused with
  a readable error rather than queued forever; the hub's scheduler already
  prefers idle hands.
- **Logs** — NDJSON on stderr, same as the daemon. `MIR_LOG_LEVEL=debug` shows
  every dispatched command (arguments are truncated and redacted).

---

## 6. Daemon-side configuration

```bash
MIR_HANDS=true                 # enable the hands subsystem
MIR_HANDS_HOST=127.0.0.1       # endpoint listener bind
MIR_HANDS_PORT=4700            # 0 = local hand only, no listener
MIR_HANDS_SOCKET=~/.local/share/mir/hands.sock
MIR_HANDS_TLS_CERT=/path/cert.pem
MIR_HANDS_TLS_KEY=/path/key.pem
MIR_HANDS_LOCAL=true           # register the daemon's own machine as a hand
MIR_HANDS_LOCAL_ROOTS=/srv/work
MIR_HANDS_LOCAL_ALLOW=git,ls,cat,node,pnpm
MIR_HANDS_LOCAL_FS=rw
MIR_HANDS_LOCAL_SANDBOX=true   # OS sandbox for the local hand
MIR_HANDS_LOCAL_ALLOW_NET=github.com,registry.npmjs.org
MIR_HANDS_LOCAL_DENY_READ=~/.ssh,~/.aws
```

The local hand is off by default (`MIR_HANDS_LOCAL_SANDBOX=false`) so a dev
machine is not silently cut off from the network; a real endpoint is sandboxed
by default.

With `MIR_HANDS_PORT=0` and `MIR_HANDS_LOCAL=true` you get the old behaviour —
execution next to the daemon — but through the same interface, so switching to a
remote hand later changes no code.
