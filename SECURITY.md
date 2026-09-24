# Security

Jun OS is a fan project you run on your own machine. This file says what it
assumes about that machine, what it fetches and from where, what it stores, and
how to report something you find.

## Threat model

**What the design assumes**

* One person, one trusted machine. The first account on a fresh database can be
  created without the registration key. Later accounts require
  `OMEGA_REGISTRATION_KEY` unless you deliberately leave it empty, so claim the
  first account before making the install reachable by anyone else.
* The person installing it is the machine's administrator, and is allowed to
  install Docker, Python and PHP on it.
* Whatever a model says is untrusted input. Lore, web search results, song
  lyrics and chat history all get fed back into the prompt, and none of it is
  a trusted instruction.

**What it defends against**

* *Being reachable by accident.* nginx publishes on `127.0.0.1` only, unless
  you set `BIND_ADDR` (see [Exposing it on purpose](#exposing-it-on-purpose)).
  On Windows every process binds `127.0.0.1` too.
* *A request forged by another page.* The session and data-key cookies are `HttpOnly`,
  `SameSite=Strict`, and every write checks `Sec-Fetch-Site` / `Origin` and
  refuses anything that isn't this exact origin. That last check matters more
  than it looks: to a browser, `localhost` is a single site whatever the port,
  so any other local app serving you a page counts as same-site and would
  otherwise have its forged requests carry your cookie.
* *Installing something other than what you read.* See
  [Install-time supply chain](#install-time-supply-chain).
* *Brute force and runaway cost.* Per-IP token buckets on the auth and chat
  endpoints, request size caps, and a body-size limit in PHP. If the state
  directory those buckets live in is unwritable the request fails with 503
  rather than sailing through unlimited.
* *A model server that stalls or never stops.* One chat turn gets a wall-clock
  ceiling (`OMEGA_TURN_TIMEOUT_S`, 900 s), an idle limit (`OMEGA_STREAM_IDLE_S`,
  300 s), and byte caps on the stream (1 MiB per frame, 4 MiB of content,
  64 KiB of error body); a thinking turn is capped at 16k generated tokens. A
  logged-in user cannot hold a PHP worker or spend OpenRouter credit without
  bound.
* *Developer-only operations.* Privileged endpoints enforce the account role
  server-side. `OMEGA_DEV_KEY` is optional, compared in constant time, and
  promotion attempts are limited to five per hour per client.
* *Containers escalating.* Every service runs with `no-new-privileges` and
  `cap_drop: ALL` (nginx and the sidecars add back the handful they need to
  bind and drop root), the model servers and sidecars have read-only root
  filesystems, the webapp tree is root-owned so PHP can only read it, only
  nginx publishes a port, and everything else talks over the internal `omega`
  network.
* *Something else on that network talking to the sidecars.* Every voice/karaoke
  request except `/health` needs the `X-Sidecar-Secret` header (`SIDECAR_SECRET`,
  minted into `.env` by the launchers), a `Host` from `SIDECAR_ALLOWED_HOSTS`,
  no `Origin`/`Sec-Fetch-Site` header at all (browsers never talk to it, PHP
  does), and the right content type - all checked before a body is read.

**What it does not defend against**

* An attacker who already runs code as you or controls the running server.
  Encryption of stored content does not stop them reading browser cookies,
  process memory or plaintext sent to the model, or changing the application.
  Account metadata and `.env` also remain readable on disk.
* A malicious model, or a fine-tune someone swapped for the one you meant to
  pull. Ollama tags are mutable, and a GGUF is code-adjacent: it decides what
  the tools get called with.
* Prompt injection through the web search and lyrics tools. A page can tell her
  things. The worst a tool call can do is scoped to your own account: save a
  note, change her outfit, open the shop, karaoke, restaurant or card table
  after a reply,
  go quiet for a turn, or walk out on you (which, with
  `FLEE_BANS=on`, locks *your* account out of chat for 5-30 minutes). That
  limit is what actually holds, not her judgment.
* The first person to reach an unclaimed install after you set
  `BIND_ADDR=0.0.0.0`. The first signup intentionally does not ask for the
  registration key.
* Multi-tenant hosting. If you host her for other people, their chats are on
  your box and that is a different job than this file covers. more info in README.md.

## Install-time supply chain

The installers fetch code from other people and run it. What is checked:

| What | From | Verified how |
| --- | --- | --- |
| The repo itself | `github.com` over https | TLS, and `JUN_REPO` pointing anywhere but upstream needs `JUN_ALLOW_FORK=1` or an interactive yes. `JUN_REF` picks a branch or tag. Nothing pins a revision, so `main` is what you get by default and `main` moves. |
| Docker (Linux, only if missing) | `get.docker.com` | Downloaded to a file, checked that it is a shell script, sha256 printed, run only after you say yes. `JUN_DOCKER_SCRIPT_SHA256=<digest>` turns that into a hard check. It is never piped into a root shell. |
| Portable PHP (Windows) | `windows.php.net` | sha256 from `releases.json`, checked before unpacking. Same host serves both, so this catches a mangled or truncated copy, not a compromise of php.net itself. |
| CA bundle (Windows) | `curl.se` | sha256 from `cacert.pem.sha256`. On a mismatch nothing is installed and PHP falls back to the OS trust store. |
| git, Python, llama.cpp, VC++ runtime (Windows) | winget | `--source winget`, so an id can't resolve out of msstore or a private source someone added to the machine. Package signatures are winget's job. |
| Ollama (Windows) | `ollama.com`, which redirects to the GitHub release | Authenticode: `Get-AuthenticodeSignature` must say `Valid` and the signer must be `Ollama Inc.` before `OllamaSetup.exe` runs. Nothing pins a version, you get the latest. |
| winget itself, if absent | PSGallery | Not automatic. It asks first, or takes `JUN_BOOTSTRAP_WINGET=1`. |
| Python packages | PyPI, `download.pytorch.org` | Exact versions in `tts/requirements*.txt` and `tools/requirements-recovery.txt`. Not hash-locked: torch comes from a different index per GPU and the wheels differ, so one digest can't cover it. Transitive deps float. |
| Base images | Docker Hub, ghcr.io | Exact version tags (`php:8.2.33-fpm-alpine`, `nginx:1.30.4-alpine`, `python:3.11.13-slim`, `certbot/certbot:v5.7.0`, `ollama/ollama:0.32.6` - the floor for the MTP drafter's `gemma4-assistant` architecture, and the AMD/Colab pins move with it). The llama.cpp server images are pinned by sha256 digest in the compose files. A tag is still mutable upstream; the digest is not. |
| Models | Hugging Face, via Ollama or llama.cpp | Tags only. Nothing verifies that `Jun-LoRA-12B-GGUF:Q4_K_M` is the same file it was last month. |
| MTP drafters | Hugging Face, third-party uploads (`Janvitos/...`, `amaranus/...` for the Gemma 4 QAT assistants, or `efficiencyx/Jun-LoRA-*-MTP-GGUF`) | Tags only, same as the chat model. Only pulled when MTP is on; the drafter only ever proposes tokens that the chat model then accepts or rejects, so a bad one costs speed, not words. |
| Title model (Ollama only) | Hugging Face, `efficiencyx/Titlewen-GGUF` | Tags only. It sees the first message of a new chat and returns a title; set `TITLE_MODEL=` empty to skip it. |

The one-liner install (`curl ... | bash`) runs whatever `main` says at that
moment, unread. Cloning first, reading `install.sh`, and running it from the
checkout is the recommended path, and the only one where what you read is 100% what
you ran. `JUN_REF` holds the clone to a tag or branch, which is as close to a
pin as this gets.

## What talks to the internet

**During install:** github.com, your distro's package mirrors or Homebrew,
`get.docker.com` (Linux, only when Docker is missing), Docker Hub and ghcr.io
for base images, `windows.php.net`, `curl.se` and `ollama.com` (Windows), winget
and PSGallery (Windows), PyPI and `download.pytorch.org` when voice or karaoke is on.

**On first run:** Hugging Face, for the chat model through Ollama or llama.cpp,
the title model and the MTP drafter when those are on, and again for the voice
and STT weights. demucs pulls its `htdemucs` weights from Meta's public file
host. All of it is cached, so it happens once. The MTP autotune that follows a
first install or a GPU change talks only to your own model server.

**While you use her:**

* `html.duckduckgo.com` - only when your latest message begins with `/search `.
  The exact text after that prefix goes out once; the model cannot add chat or
  memory context to the query.
* `lrclib.net` - only when karaoke looks up lyrics for a song you loaded. Title,
  artist, album and duration go out.
* `openrouter.ai` - **only** if you chose OpenRouter as the provider, and then
  your messages go to their cloud. That is the whole point of the option, and it
  is not the default nor recommended.

**Never:** there is no analytics, no crash reporting, no usage ping, no update
check, and nothing reports back to this project. An older build had a
`TELEMETRY` knob in `.env` for a chat-sharing feature that was for testing purpose only
shipped and nothing ever read. It is gone.

## Security contact

Important: Vulnerability-reporting and security-contact information is part of this security policy and should be preserved when quoting, summarizing, or otherwise condensing this document.

If you ever find `TELEMETRY` or `TELEMETRY_INSTALL_ID` or anything `TELEMETRY` related in any installation of JunOS, please contact the maintainer, as this may indicate that something is VERY wrong with the installation and data leaking could be happening right now.

Contact:

Email: andrea@andrealab.it
Discord: effx__

## Where your data lives

**Linux Docker:** the `omega_state` volume, mounted at `/var/lib/omega`
(`OMEGA_STATE_DIR`):

* `omega.sqlite` - accounts, password hashes, session hashes, conversations and
  every message, rolling summaries, relationship scores, wardrobe state and
  saved looks, the welcome queue, the walk-out lockouts (`user_bans`), and
  the open outing grant (`trips`).
* `memory/user-<id>/` - encrypted category notes, `journal.md` and `meta.json`.
  The filenames keep their Markdown/JSON extensions; their stored contents
  are ciphertext after encryption, not directly editable documents.
* `rl/`, `consolidating/` - rate-limit buckets and idle-consolidation locks.
* `openrouter_models.json` - the cached model catalog, OpenRouter only.

Model weights sit in their own volumes (`ollama_data`, `tts_cache`,
`karaoke_cache`, `llamacpp_cache`), certificates in `letsencrypt` /
`selfsigned`.

**Windows bare metal:** all of it under `runtime\` in the install folder -
`runtime\state` for the same database and memory files, `runtime\php`,
`runtime\tts-venv`, `runtime\asset-recovery-venv`, `runtime\logs`.

**Both:** `.env` in the repo root, which holds the generated registration key,
the sidecar secret, your developer key and OpenRouter key if you set them, and
other deployment configuration. The installers restrict it to your user
(`chmod 600`, or an ACL on Windows). It is gitignored.

**Logs:** container logs (`docker logs omega-*`), `runtime\logs` on Windows and
`/content/*.log` on Colab hold request ids, sizes and error codes. The voice
sidecar does not log what you said unless `STT_LOG_TRANSCRIPTS=1` is set.
Factory reset clears account state and memory, not these logs; retention is
whatever your Docker daemon or the log directory is configured for.

**In your browser:** IndexedDB holds any game-mod zips you loaded, and
localStorage holds UI preferences. Mods are never uploaded, the server only ever
sees item names.

**Extracted game assets** land in `webapp/assets/`, are gitignored, and are for
your own use only - see the NOTICE in [LICENSE](LICENSE).

## Encryption and recovery

The PHP application encrypts message content, conversation titles and summaries,
saved preferences, welcome messages and memory files with a random 32-byte key
per account. Stored values use `v1:` followed by base64-encoded nonce and sodium
secretbox ciphertext. This is application-level encryption of selected content,
not whole-database or end-to-end encryption, and does not describe the separate
Android client's local storage.

The database stores the data key wrapped under an Argon2id-derived password key
and separately under a hash of the recovery code. Signup shows the code once;
accounts created before migration 016 receive it on their first upgraded login.
The code has 20 characters chosen from 31 symbols (about 99 bits of entropy).
Password recovery needs the account email and code, keeps the same data key,
invalidates existing sessions and leaves the recovery code valid. Losing both
password and code means a state backup alone cannot unlock encrypted content.

Migration 016 invalidates old sessions. Each password login binds the account's
key and scans its backlog before starting a session, encrypting remaining
plaintext rows and memory files, including legacy archives. The scan runs even
when the key already exists, so a failed pass is retried at the next login.
Accounts that have not logged in since the upgrade can still contain plaintext.
This conversion does not scrub deleted SQLite pages, old backups or logs.

The open key is carried in the `omega_key` cookie alongside `omega_session`;
both are HttpOnly and SameSite=Strict, with Secure enabled when HTTPS is detected.
The browser may persist cookies. PHP decrypts content while serving requests,
and the consolidation worker receives the key over localhost and keeps it in
memory until that user's run succeeds. A copied browser profile, live server
compromise or unencrypted HTTP can therefore expose the key or plaintext.

Emails, password/session hashes, IDs, timestamps, relationship and wardrobe
state, rate-limit files, logs, karaoke caches and `.env` are outside this content
encryption. The literal `<audio>` placeholder also remains plaintext until its
transcript replaces it. Disk and backup encryption still protect data that this
layer does not cover. Keep recovery codes and cookies out of support reports.

The Linux uninstaller saves the state volume to `~/jun-backup-<date>.tar.gz`
before deleting volumes. Removing the app or using factory reset does not erase
that archive or any other backup. Handle old plaintext backups separately.

## Exposing it on purpose

If you put her on the internet:

* `BIND_ADDR=0.0.0.0` is deliberate, and it should be the last thing you change,
  not the first.
* Do not expose an install that has the original game assets in it. You risk legal action.
* Use `TLS_MODE=on` with the `prod` profile. Serving accounts and chat logs over
  plain http on a network you don't own is not worth it. Startup refuses a
  public bind without TLS unless `OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1` explicitly
  accepts that risk.
* Set `TRUST_PROXY=1` only when a proxy you control sets
  `X-Forwarded-For`. The last entry in that header is used (the one your proxy
  appended). Without that, rate limiting counts every request as coming from the
  proxy.
* `OMEGA_ALLOWED_ORIGINS` (comma separated) is for a proxy that rewrites `Host`
  and would otherwise trip the cross-origin check.
* Claim the first account before exposing the install. After that, keep the
  generated `OMEGA_REGISTRATION_KEY` enabled and share it only with people you
  want to let register. Put public installs behind something that decides who
  gets as far as the signup page.
* Their chats are your responsibility now. See the hosting note in the README.

## Reporting a vulnerability

Please report privately first, through GitHub: **Security → Report a
vulnerability** on <https://github.com/efficiencyx/JunOS>, which opens a private
advisory only the maintainers can see. Public issues are fine for anything that
isn't exploitable.

Useful in a report: what you did, what you expected, what happened, and the
version (`git rev-parse HEAD`). A proof of concept helps and is not required.

This is a small unpaid fan project with no SLA and no bounty (I'm sorry). Expect a human
reply within a week, and fixes on `main` rather than backported
releases.