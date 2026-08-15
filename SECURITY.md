# Security

Jun OS is a fan project you run on your own machine. This file says what it
assumes about that machine, what it fetches and from where, what it stores, and
how to report something you find.

## Threat model

**What the design assumes**

* One person, one trusted machine. Every user account on a Jun install can be
  created by anyone who can reach the port, so "who can reach the port" is the
  real access control.
* The person installing it is the machine's administrator, and is allowed to
  install Docker, Python and PHP on it.
* Whatever a model says is untrusted input. Lore, web search results, song
  lyrics and chat history all get fed back into the prompt, and none of it is
  a trusted instruction.

**What it defends against**

* *Being reachable by accident.* nginx publishes on `127.0.0.1` only, unless
  you set `BIND_ADDR` (see [Exposing it on purpose](#exposing-it-on-purpose)).
  On Windows every process binds `127.0.0.1` too.
* *A request forged by another page.* The session cookie is `HttpOnly`,
  `SameSite=Strict`, and every write checks `Sec-Fetch-Site` / `Origin` and
  refuses anything that isn't this exact origin. That last check matters more
  than it looks: to a browser, `localhost` is a single site whatever the port,
  so any other local app serving you a page counts as same-site and would
  otherwise have its forged requests carry your cookie.
* *Installing something other than what you read.* See
  [Install-time supply chain](#install-time-supply-chain).
* *Brute force and runaway cost.* Per-IP token buckets on the auth and chat
  endpoints, request size caps, and a body-size limit in PHP.
* *Containers escalating.* Every service runs with `no-new-privileges`, only
  nginx publishes a port, and everything else talks over the internal `omega`
  network.

**What it does not defend against**

* An attacker who already runs code as you. The SQLite DB, the memory notes and
  `.env` are files your user can read, by design.
* A malicious model, or a fine-tune someone swapped for the one you meant to
  pull. Ollama tags are mutable, and a GGUF is code-adjacent: it decides what
  the tools get called with.
* Prompt injection through the web search and lyrics tools. A page can tell her
  things. She has no tool that can write outside your own account's data, which
  is the limit that actually holds, not her judgment.
* Anyone on your LAN once you set `BIND_ADDR=0.0.0.0`.
* Multi-tenant hosting. If you host her for other people, their chats are on
  your box and that is a different job than this file covers.

## Install-time supply chain

The installers fetch code from other people and run it. What is checked:

| What | From | Verified how |
| --- | --- | --- |
| The repo itself | `github.com` over https | TLS, and `JUN_REPO` pointing anywhere but upstream needs `JUN_ALLOW_FORK=1` or an interactive yes. `JUN_REF` picks a branch or tag. Nothing pins a revision, so `main` is what you get by default and `main` moves. |
| Docker (Linux, only if missing) | `get.docker.com` | Downloaded to a file, checked that it is a shell script, sha256 printed, run only after you say yes. `JUN_DOCKER_SCRIPT_SHA256=<digest>` turns that into a hard check. It is never piped into a root shell. |
| Portable PHP (Windows) | `windows.php.net` | sha256 from `releases.json`, checked before unpacking. Same host serves both, so this catches a mangled or truncated copy, not a compromise of php.net itself. |
| CA bundle (Windows) | `curl.se` | sha256 from `cacert.pem.sha256`. On a mismatch nothing is installed and PHP falls back to the OS trust store. |
| git, Ollama, Python, llama.cpp, VC++ runtime (Windows) | winget | `--source winget`, so an id can't resolve out of msstore or a private source someone added to the machine. Package signatures are winget's job. |
| winget itself, if absent | PSGallery | Not automatic. It asks first, or takes `JUN_BOOTSTRAP_WINGET=1`. |
| Python packages | PyPI, `download.pytorch.org` | Exact versions in `tts/requirements*.txt` and `tools/requirements-recovery.txt`. Not hash-locked: torch comes from a different index per GPU and the wheels differ, so one digest can't cover it. Transitive deps float. |
| Base images | Docker Hub, ghcr.io | Version tags, not digests. `ollama/ollama:latest` and `ghcr.io/ggml-org/llama.cpp:server` are rolling on purpose, they track hardware support. Tags are mutable: pin them yourself if that matters to you. |
| Models | Hugging Face, via Ollama or llama.cpp | Tags only. Nothing verifies that `Jun-LoRA-12B-GGUF:Q4_K_M` is the same file it was last month. |

The one-liner install (`curl ... | bash`) runs whatever `main` says at that
moment, unread. Cloning first, reading `install.sh`, and running it from the
checkout is the recommended path, and the only one where what you read is what
you ran. `JUN_REF` holds the clone to a tag or branch, which is as close to a
pin as this gets.

## What talks to the internet

**During install:** github.com, your distro's package mirrors or Homebrew,
`get.docker.com` (Linux, only when Docker is missing), Docker Hub and ghcr.io
for base images, `windows.php.net` and `curl.se` (Windows), winget and PSGallery
(Windows), PyPI and `download.pytorch.org` when voice or karaoke is on.

**On first run:** Hugging Face, for the chat model through Ollama or llama.cpp,
and again for the voice and STT weights. demucs pulls its `htdemucs` weights
from Meta's public file host. All of it is cached, so it happens once.

**While you use her:**

* `html.duckduckgo.com` - only when your latest message begins with `/search `.
  The exact text after that prefix goes out once; the model cannot add chat or
  memory context to the query.
* `lrclib.net` - only when karaoke looks up lyrics for a song you loaded. Title,
  artist, album and duration go out.
* `openrouter.ai` - **only** if you chose OpenRouter as the provider, and then
  your messages go to their cloud. That is the whole point of the option, and it
  is not the default.

**Never:** there is no analytics, no crash reporting, no usage ping, no update
check, and nothing reports back to this project. An older build had a
`TELEMETRY` knob in `.env` for a chat-sharing feature that was never built and
nothing ever read. It is gone. Delete `TELEMETRY` and `TELEMETRY_INSTALL_ID`
from an old `.env` if you find them there.

## Where your data lives

**Docker:** the `omega_state` volume, mounted at `/var/lib/omega`
(`OMEGA_STATE_DIR`):

* `omega.sqlite` - accounts, password hashes, sessions, conversations and every
  message, relationship scores, bans.
* `memory/user-<id>/` - her notes about you, as Markdown, plus `journal.md`.
* `rl/`, `consolidating/` - rate-limit buckets and idle-consolidation locks.

Model weights sit in their own volumes (`ollama_data`, `tts_cache`,
`karaoke_cache`, `llamacpp_cache`), certificates in `letsencrypt` /
`selfsigned`.

**Windows bare metal:** all of it under `runtime\` in the install folder -
`runtime\state` for the same database and memory files, `runtime\php`,
`runtime\tts-venv`, `runtime\asset-recovery-venv`, `runtime\logs`.

**Both:** `.env` in the repo root, which holds your OpenRouter key if you set
one. The installers restrict it to your user (`chmod 600`, or an ACL on
Windows). It is gitignored.

**In your browser:** IndexedDB holds any game-mod zips you loaded, and
localStorage holds UI preferences. Mods are never uploaded, the server only ever
sees item names.

**Extracted game assets** land in `webapp/assets/`, are gitignored, and are for
your own use only - see the NOTICE in [LICENSE](LICENSE).

Nothing here is encrypted at rest. Encrypt the disk if that matters, and
remember your backups have all of it too.

## Exposing it on purpose

If you put her on the internet:

* `BIND_ADDR=0.0.0.0` is deliberate, and it should be the last thing you change,
  not the first.
* Do not expose an install that has the original game assets in it.
* Use `TLS_MODE=on` with the `prod` profile. Serving accounts and chat logs over
  plain http on a network you don't own is not worth it. Startup refuses a
  public bind without TLS unless `OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1` explicitly
  accepts that risk.
* Set `TRUST_PROXY=1` only when a proxy you control sets
  `X-Forwarded-For`. Without that, rate limiting counts every request as coming
  from the proxy.
* `OMEGA_ALLOWED_ORIGINS` (comma separated) is for a proxy that rewrites `Host`
  and would otherwise trip the cross-origin check.
* Anyone who can open the page can create an account. Put it behind something
  that decides who gets that far.
* Their chats are your responsibility now. See the hosting note in the README.

## Reporting a vulnerability

Please report privately first, through GitHub: **Security → Report a
vulnerability** on <https://github.com/efficiencyx/Jun>, which opens a private
advisory only the maintainers can see. Public issues are fine for anything that
isn't exploitable.

Useful in a report: what you did, what you expected, what happened, and the
version (`git rev-parse HEAD`). A proof of concept helps and is not required.

This is a small unpaid fan project with no SLA and no bounty. Expect a human
reply within a couple of weeks, and fixes on `main` rather than backported
releases.
