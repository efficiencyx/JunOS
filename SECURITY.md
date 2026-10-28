# Security

Jun OS is a fan project you run on your own machine. This file says what it
assumes about that machine, what it fetches and from where, what it stores, and
how to report something you find.

## Threat model

**What the design assumes**

* One person, one trusted machine. The first account on a fresh database can be
  created without the registration key, but only while `BIND_ADDR` is
  loopback. Later accounts, and the first one on an install that is already
  listening off loopback, require `OMEGA_REGISTRATION_KEY` unless you
  deliberately leave it empty.
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
* *Someone else on the wifi using her model.* `LAN_INFERENCE` is off by
  default. On, `api/model.php` answers nothing without the 256-bit
  `JUN_LAN_TOKEN` (constant-time compare, per-IP rate limit), stores nothing,
  and only generates: no account, chat, memory or file is reachable through
  it. The phone pins the desktop's local CA by the SHA-256 in the pairing QR,
  so somebody in the middle on the network can't pose as the PC and collect
  the token. The token sits in that QR, though: a photo of the code is a key,
  and a new `JUN_LAN_TOKEN` is how you take it back.
* *Something else on that network talking to the sidecars.* Every voice/karaoke
  request except `/health` needs a `Host` from `SIDECAR_ALLOWED_HOSTS`, no
  `Origin`/`Sec-Fetch-Site` header at all (browsers never talk to it, PHP
  does), and the right content type, and - while `SIDECAR_SECRET` is set,
  which the launchers mint into `.env` - the matching `X-Sidecar-Secret`
  header. All of it is checked before a body is read. `SIDECAR_SECRET=`
  (empty) switches the secret check off on purpose and leaves only the
  `Host` and browser-header checks; the sidecar logs a warning at startup
  when it runs that way.

**What it does not defend against**

* An attacker who already runs code as you or controls the running server.
  Encryption of stored content does not stop them reading browser cookies,
  process memory or plaintext sent to the model, or changing the application.
  Account metadata and `.env` also remain readable on disk.
* A malicious model, or a fine-tune someone swapped for the one you meant to
  pull. Ollama tags are mutable, and a GGUF is code-adjacent: it decides what
  the tools get called with.
* Prompt injection through the web search and lyrics tools. A page can tell her
  things, including what to search for next. Her own queries go through the
  same private-term check as above, so a page can't make her search for your
  memories. The worst a tool call can do is scoped to your own account: save a
  note, change her outfit, open the shop, karaoke, restaurant or card table
  after a reply,
  go quiet for a turn, or walk out on you (which, with
  `FLEE_BANS=on`, locks *your* account out of chat for 5-30 minutes). That
  limit is what actually holds, not her judgment.
* The first person to reach an unclaimed install through a tunnel or reverse
  proxy you point at a loopback bind. PHP only sees `BIND_ADDR`, so it still
  lets the first signup through without the key. Claim the account before
  you open the tunnel.
* Multi-tenant hosting. If you host her for other people, their chats are on
  your box and that is a different job than this file covers. more info in README.md.

## Install-time supply chain

The Linux installer changes these things outside its own folder, and records
them in `.install-changes` so `uninstall.sh` can offer to undo them:

* **The `docker` group.** Membership is root without a password for every
  process you run. Express and Custom both ask, defaulting to no. An
  unattended run (`JUN_YES=1` without Express, or no terminal) leaves
  Docker behind `sudo` unless `JUN_DOCKER_GROUP=1` is set.
* **`net.ipv4.ip_unprivileged_port_start=80`**, only with rootless Docker,
  written to `/etc/sysctl.d/99-jun-unprivileged-ports.conf`. Rootless Docker
  can't publish `:80` without it. It applies system-wide, so any program can
  then bind ports 80 and up. The uninstaller restores the previous value.
* **The NVIDIA Container Toolkit**, only with an NVIDIA card that Docker
  can't use yet. On apt, dnf/yum, zypper and rpm-ostree it comes from
  NVIDIA's own repository (`nvidia.github.io/libnvidia-container`), which
  the installer adds along with NVIDIA's signing key. pacman takes it from
  the distro. Then `nvidia-ctk runtime configure` registers it in Docker's
  `daemon.json` and Docker restarts. Rootful Docker: Express and unattended
  runs say yes, Custom asks `[Y/n]`, `JUN_NVIDIA_TOOLKIT=0` skips it. The
  uninstaller leaves the package and the repository in place, like Docker
  itself, and prints what to remove.
* **`no-cgroups = true` in `/etc/nvidia-container-runtime/config.toml`**,
  only with rootless Docker, which can't hand a GPU to a container without
  it. It applies to every Docker on the machine, so the installer always
  asks first (`[y/N]`, Express included); an unattended run needs
  `JUN_NVIDIA_TOOLKIT=1`. The uninstaller sets it back to `false`.

Both installers can also add one thing to your trust stores, and ask first
(default yes, `JUN_TRUST_CA=0` skips it):

* **Jun's local certificate authority.** Every install makes its own CA and
  signs the HTTPS certificate with it. Trusting it is what removes the
  browser warning. On Linux it goes in the system store (needs `sudo`) and
  in every Chrome/Chromium and Firefox NSS database under your home
  (`certutil`), on macOS in the System keychain, and on Windows and WSL in
  the current user's Root store, where Windows shows its own confirmation
  dialog. The CA carries critical `nameConstraints`: it can only vouch for
  `localhost`, `.local`, `.lan`, `.internal`, `.home.arpa`, loopback,
  private, link-local and CGNAT addresses, plus the hosts that were in the
  certificate when the CA was made. A browser refuses anything else it
  signs, so its key (in the `selfsigned` volume, `runtime\caddy\tls\ca.key`
  on Windows) can't be used to impersonate a public site. The uninstallers
  remove it again, from `runtime/jun-ca.pem` on Linux and the thumbprint in
  `runtime\caddy\tls\trusted` on Windows. By hand, look for
  "Jun OS local CA" in the browser's or the OS certificate manager.

Pairing the phone (`./start.sh phone`) can make one more change, and asks
first:

* **https in firewalld.** Fedora and Bazzite block 443 from the network by
  default, so the phone can't connect. It adds the `https` service to the
  firewalld zone of each interface with a private address, runtime and
  permanent, through `sudo`, and records the zones as `firewalld_https` in
  `.install-changes`. The uninstaller removes the service from those zones.
  ufw isn't touched: Docker's published ports bypass it.

Installs from before `.install-changes` existed have nothing recorded, so
`uninstall.sh` reverts nothing for them. Undo the changes by hand with
`sudo gpasswd -d "$USER" docker`, then
`sudo rm /etc/sysctl.d/99-jun-unprivileged-ports.conf`, then
`sudo sysctl net.ipv4.ip_unprivileged_port_start=1024`.

The installers fetch code from other people and run it. What is checked:

| What | From | Verified how |
| --- | --- | --- |
| The installer you start | a published release on `github.com/<repo>/releases` (`JunSetup-<tag>.exe`, or `install.sh` / `install.ps1` from `releases/latest/download/`) | TLS. Always a published release's own assets, never `main`. The release's `SHA256SUMS` lists every file, but it sits in the same release, so it catches a broken download, not a compromised account. |
| The repo itself | `github.com` over https | TLS, and `JUN_REPO` pointing anywhere but upstream needs `JUN_ALLOW_FORK=1` or an interactive yes. By default you get the tag of the newest full release (`JUN_CHANNEL=stable`); `latest` follows pre-releases too, `experimental` follows `main`, which moves, and is only used when you pick it. While Jun is in beta, release tags are not locked on GitHub and can still be moved. `JUN_REF` picks an exact branch or tag. A versioned `JunSetup-<tag>.exe` also carries the tag's commit hash (`JUN_PIN_SHA`) and refuses to install code whose commit doesn't match, checked before checkout. |
| NVIDIA Container Toolkit (Linux, only with an NVIDIA card Docker can't use) | `nvidia.github.io/libnvidia-container`, or the distro's repos on Arch | TLS for the key and the repo file. After that the package manager checks NVIDIA's signature: apt on the repo's `Release` file, dnf/zypper on the repo metadata (`repo_gpgcheck`, the rpms themselves aren't signed). When it asks: [Install-time supply chain](#install-time-supply-chain). |
| Docker (Linux, only if missing) | `get.docker.com` | Downloaded to a file, checked that it is a shell script, sha256 printed, run only after you say yes. `JUN_DOCKER_SCRIPT_SHA256=<digest>` turns that into a hard check. It is never piped into a root shell. |
| Portable PHP (Windows) | `windows.php.net` | sha256 from `releases.json`, checked before unpacking. Same host serves both, so this catches a mangled or truncated copy, not a compromise of php.net itself. Every install and update compares the PHP already in `runtime\php` with the newest build in `releases.json` and replaces it when it's older, so a PHP security fix reaches an existing install on its next update. |
| CA bundle (Windows) | `curl.se` | sha256 from `cacert.pem.sha256`. On a mismatch nothing is installed and PHP falls back to the OS trust store. |
| git, Python, llama.cpp, VC++ runtime (Windows) | winget | `--source winget`, so an id can't resolve out of msstore or a private source someone added to the machine. llama.cpp is pinned to `b11804`, the same build the Docker images run. Package signatures are winget's job. |
| Which release is current | `api.github.com` (anonymous, read-only), then `github.com/<repo>/releases/latest` | TLS. One or two requests to the releases endpoint per run to turn the channel into a tag, skipped for `experimental` and when `JUN_REF` is set. When the API doesn't answer, the website's `/releases/latest` redirect names the newest full release instead. Drafts are invisible to both. If neither answers, a fresh install stops rather than fall back to `main`. |
| Ollama (Windows) | `ollama.com`, which redirects to the GitHub release | Authenticode: `Get-AuthenticodeSignature` must say `Valid` and the signer must be `Ollama Inc.` before `OllamaSetup.exe` runs. Nothing pins a version, you get the latest. |
| Caddy (Windows) | GitHub release | Version and sha512 pinned in `install.ps1`; the zip is refused when the digest differs. |
| Android build | `services.gradle.org`, GitHub release, PyPI, Maven Central / Google Maven | The Gradle distribution (`android/gradlew`, `android/gradle-bootstrap.ps1`), the sherpa-onnx AAR and the UnityPy / tpk_ar source archives are pinned by sha256 and refused on a mismatch. Maven libraries are pinned by exact version only. |
| winget itself, if absent | PSGallery | Not automatic. It asks first, or takes `JUN_BOOTSTRAP_WINGET=1`. |
| Python packages | PyPI, `download.pytorch.org` | Exact versions in `tts/requirements*.txt` and `tools/requirements-recovery.txt`. Not hash-locked: torch comes from a different index per GPU and the wheels differ, so one digest can't cover it. Transitive deps float. |
| Base images | Docker Hub, ghcr.io | Exact version tags (`php:8.5.12-fpm-alpine`, `nginx:1.30.6-alpine`, `python:3.11.17-slim`, `certbot/certbot:v5.8.0`, `ollama/ollama:0.40.10` - 0.32 is the floor for the MTP drafter's `gemma4-assistant` architecture, and the AMD/Colab pins move with it). The llama.cpp server images are pinned by sha256 digest in the compose files. The php image builds APCu from its GitHub tag (`krakjoe/apcu`, version and sha256 pinned in `docker/php.Dockerfile`), not from pecl.php.net. A tag is still mutable upstream; the digest is not. |
| Models | Hugging Face, via Ollama or llama.cpp | Tags only. Nothing verifies that `Jun-LoRA-12B-GGUF:Q4_K_M` is the same file it was last month. |
| MTP drafters | Hugging Face, third-party uploads (`Janvitos/...`, `amaranus/...` for the Gemma 4 QAT assistants, or `efficiencyx/Jun-LoRA-*-MTP-GGUF`) | Tags only, same as the chat model. Only pulled when MTP is on; the drafter only ever proposes tokens that the chat model then accepts or rejects, so a bad one costs speed, not words. |
| Title model (Ollama and llama.cpp) | Hugging Face, `efficiencyx/Titlewen-GGUF` | Tags only. It sees the first message of a new chat and returns a title; set `TITLE_MODEL=` empty to skip it. |
| vLLM (Colab/Kaggle notebook, TPU only) | PyPI | `vllm-tpu==0.32.0`, installed into its own venv. Not hash-locked, transitive deps (jax, torch) float. |
| cloudflared (notebook, inference-only mode) | GitHub release | Version and sha256 pinned in `colab.ipynb`; the download is refused when the digest differs. |

The one-liner install (`curl ... | bash`) runs whatever `main`'s `install.sh`
says at that moment, unread. That script only gets as far as the clone: it then
hands off to the `install.sh` inside the release it checked out, which does the
rest. Cloning first, reading `install.sh`, and running it from the checkout is
still the recommended path, and the only one where what you read is 100% what
you ran. Every release also carries the three install scripts and a
`SHA256SUMS` file. On Windows, a versioned `JunSetup-<tag>.exe` is a real pin:
tag plus commit hash, verified. `JunSetup` carries `JunOS.exe` (the start/stop/update window) from its own build
and hands it to `install.ps1`. Otherwise `install.ps1` downloads `JunOS.exe`
from the release the checkout is on, or the newest
release when it's on `main`, and installs it only when it matches that
release's `SHA256SUMS`. Without a match it skips it and the shortcut runs
`jun-manager.ps1` from the checkout instead.

## What talks to the internet

**During install:** github.com and api.github.com (which release is current), your distro's package mirrors or Homebrew,
`get.docker.com` (Linux, only when Docker is missing), `nvidia.github.io` (Linux,
only when an NVIDIA card needs the container toolkit), Docker Hub and ghcr.io
for base images, `windows.php.net`, `curl.se` and `ollama.com` (Windows), winget
and PSGallery (Windows), PyPI and `download.pytorch.org` when voice or karaoke is on.

**On first run:** Hugging Face, for the chat model through Ollama or llama.cpp,
the title model and the MTP drafter when those are on, and again for the voice
and STT weights. demucs pulls its `htdemucs` weights from Meta's public file
host. All of it is cached, so it happens once. The MTP autotune that follows a
first install or a GPU change talks only to your own model server.

**On every start, only if you said yes to the update checker** (`UPDATE_CHECK=on`,
the installers ask): one anonymous request to `api.github.com` for the release
list of the repo you installed from, or `github.com/<repo>/releases/latest` when
the API is rate limited. GitHub sees your IP and a `JunOS-update-check`
user agent, nothing else is sent. The answer is only compared against the tag
you're on: a newer release gets a line after boot, a newer `-security` release
stops the start (see [Security releases](#security-releases)). It never
downloads or changes anything.

**While you use her:**

* `html.duckduckgo.com`, or the page you linked - only when your latest
  message begins with `/search `. Her first lookup is exactly the text after
  that prefix, and a lone link is fetched instead of searched. She can then
  run up to two related searches of her own. The server refuses any of those
  that carries an email, a long number, or a name, place or number from your
  memories, her journal or your messages in that chat, unless you typed it
  in the `/search` yourself. She can never fetch a link of her own choosing.
* `lrclib.net` - only when karaoke looks up lyrics for a song you loaded. Title,
  artist, album and duration go out.
* `openrouter.ai` - **only** if you chose OpenRouter as the provider, and then
  your messages go to their cloud. That is the whole point of the option, and it
  is not the default nor recommended.
* `*.trycloudflare.com` - **only** if you pointed `OLLAMA_URL` or `VLLM_URL` at
  `colab.ipynb` running in inference-only mode (by hand, with `start.sh link`,
  the manager's Notebook link button, or the installer's Cloud option). Each
  start also sends that URL one `GET /api/tags` or `/v1/models` with the key,
  to notice a link that went stale. Every prompt then goes to your
  notebook on Google's machine through Cloudflare, with what rides along with
  it: the recent history, recalled memories and lore. Your account, the
  database and the memory files stay here. The tunnel ends at
  `tools/inference-gate.py`, which wants a per-run 256-bit bearer key, compares
  it in constant time and only passes chat and read endpoints, so somebody who
  finds the URL can't use the GPU or touch the model store. Cloudflare
  terminates TLS on a quick tunnel, so it can read that traffic in transit.

**The Android app** sends nothing anywhere in Local mode beyond the one-time
model, voice and asset downloads. In LAN mode it talks to the paired PC on your
network and nothing else. In Cloud mode it sends every prompt to the notebook's
`*.trycloudflare.com` URL, with the same contents and the same gate as the PC
case above, and the picker says so next to the option. Chats, memory and the
database stay on the phone in every mode. A pairing only ever comes from a code
you confirm in the app, deep links from a web page included. The one exception
is **Start Colab session**: the app opens Colab in its own WebView, and Step 3
hands the link over through a `window.junos` bridge that only exists in frames
from `colab.research.google.com` and `*.googleusercontent.com`, inside that one
WebView. Only a `mode=cloud` link is accepted, and it pairs without a dialog
because you started the session. Your Google sign-in happens in that WebView,
which hides its WebView markers (user agent, `X-Requested-With`) because
Google's login page refuses WebViews. The app never reads the page beyond the
bridge messages, and the cookies stay in the app's own WebView storage.

**Never:** there is no analytics, no crash reporting, no usage ping, no
automatic update, and nothing reports back to this project. The update checker
above is opt-in and only reads GitHub's public release list. An older build had a
`TELEMETRY` knob in `.env` for a chat-sharing feature that was for testing purpose only
shipped and nothing ever read. It is gone.

## Security releases

A release whose tag ends in `-security` (`v1.0.5-security`,
`v1.0.5-beeeta-security`) fixes a vulnerability bad enough that running the
old version is the bigger risk, the kind where the advisory says to stop her
until you've updated. The bar is [GHSA-3p7p-m86h-9j93](https://github.com/efficiencyx/JunOS/security/advisories/GHSA-3p7p-m86h-9j93):
unauthenticated remote code execution in the bundled PHP. A routine fix, a
hardening change or a bug that needs an account or local access ships as a
normal release.

With the update checker on, `start.sh` and `start.ps1` refuse to start a
version older than a published `-security` release on the install's channel,
print the release link and exit with code 3. The Windows manager offers its
Update button from there. `./start.sh --ignore-security`,
`.\start.ps1 -IgnoreSecurity` or `JUN_IGNORE_SECURITY=1` start anyway. The release workflow
drafts `-security` tags as full releases so Stable installs and the
`releases/latest` one-liners get them. Installs on `main` are never stopped,
the fix lands there first.

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
`selfsigned` (the local CA's key included).

**Windows bare metal:** all of it under `runtime\` in the install folder -
`runtime\state` for the same database and memory files, `runtime\php`,
`runtime\tts-venv`, `runtime\asset-recovery-venv`, `runtime\logs`.

**Both:** `.env` in the repo root, which holds the generated registration key,
the sidecar secret, your developer key and OpenRouter key if you set them, and
other deployment configuration. The installers restrict it to your user
(`chmod 600`, or an ACL on Windows). It is gitignored.

**Logs:** container logs (`docker logs omega-*`), `runtime\logs` on Windows and
`/content/*.log` on Colab (`/kaggle/working/*.log` on Kaggle) hold request
ids, sizes and error codes, plus the `Host` name of any request the bare-metal
router refused. The notebook's `gate.log` holds method and status only, no
paths or headers. The voice
sidecar does not log what you said unless `STT_LOG_TRANSCRIPTS=1` is set.
Factory reset clears account state and memory, not these logs; retention is
whatever your Docker daemon or the log directory is configured for.

**In your browser:** IndexedDB holds any game-mod zips you loaded, and
localStorage holds UI preferences plus the unsent text in each chat's message
box, in plain text until you send it or sign out. Mods are never uploaded, the server only ever
sees item names.

**Extracted game assets** land in `webapp/assets/`, are gitignored, and are for
your own use only - see [NOTICE](NOTICE). `/api/assets.php?probe` tells a
logged-in session whether the rig files are there (one boolean, no paths); the
page shows placeholder art when they are not.

## Encryption and recovery

The PHP application encrypts message content, conversation titles and summaries,
saved preferences, welcome messages, walk-out reasons, memory files and the per-line
breakdown of karaoke takes with a random 32-byte key per account. Take scores stay
plaintext, and the song they belong to is an HMAC under that key, never the file hash. Stored values use `v1:` followed by base64-encoded nonce and sodium
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
* Use `TLS_MODE=on` with the `prod` profile. The default is HTTPS on a
  certificate from the install's own local CA (nginx on Docker, Caddy in
  front of `php -S` on Windows), and plain http only ever redirects to it.
  That keeps the traffic encrypted, but a browser that hasn't trusted the CA
  has no way to tell your box from someone sitting between it and you, so a
  click-through warning is fine on your own network and not on one you
  don't own. The CA's name constraints also keep it from covering a public
  domain.
* Set `TRUST_PROXY=1` only when a proxy you control sets
  `X-Forwarded-For`. The last entry in that header is used (the one your proxy
  appended). Without that, rate limiting counts every request as coming from the
  proxy.
* `OMEGA_ALLOWED_ORIGINS` (comma separated) is for a proxy that rewrites `Host`
  and would otherwise trip the cross-origin check.
* `LAN_INFERENCE=on` is for your own network. With `BIND_ADDR=0.0.0.0` on a
  box reachable from the internet, the token is all that stands between a
  stranger and your GPU. Keep the pairing QR to yourself and rotate
  `JUN_LAN_TOKEN` when a phone is lost.
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