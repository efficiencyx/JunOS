# Contributing to Jun OS

Thanks for helping Jun OS improve. Bug fixes, compatibility work, documentation, accessibility improvements, and focused features are welcome.

Jun OS comes from an adult game and its project spaces are intended for adults (18+) only. Keep reports and contributions professional, avoid explicit material that is not necessary to understand a technical change, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For a bug or setup problem, search existing issues and read [When things go sideways](README.md#when-things-go-sideways). Use the matching issue form and include a minimal reproduction, environment details, the commit or release you tested, and short redacted logs.

For a larger feature, open a feature request before investing significant time. That gives maintainers a chance to confirm fit and flag architecture or licensing constraints early. Small, well-contained fixes can go straight to a pull request.

Report exploitable vulnerabilities privately as described in [SECURITY.md](SECURITY.md#reporting-a-vulnerability), not in a public issue.

## Asset and privacy rules

The source code is Apache-2.0 licensed, but the original game's art and other assets are not. Never commit or attach:

- files recovered into `webapp/assets/`;
- raw game archives, Live2D source assets, or screenshots that redistribute those assets;
- model weights or private training data;
- `.env` files, API keys, registration keys, recovery codes, session/data-key cookies, passwords, chat history, memory notes, or journals.

The complete asset terms are in [NOTICE](NOTICE). Use synthetic or self-created fixtures when a test needs media.

## Development setup

Create a branch from `main`, copy `.env.example` to `.env`, and use the installation path you intend to change. The usual Docker development loop is:

```sh
./start.sh
./sync-webapp.sh
```

Use `./sync-webapp.sh -s` only when every changed file is static. PHP opcache does not watch timestamps, so PHP changes require the full command. After moving or deleting files, add `--clean` so the old paths are removed from the containers. Hard-refresh the browser after synchronizing.

The Windows installation is managed by `install.ps1` and `start.ps1`. `installer-gui.ps1` is a WPF front end over the same `install.ps1`: it collects answers, exports the matching `JUN_*` variables plus `JUN_YES=1`, and runs the script, so installer behavior changes belong in `install.ps1` and only the questions belong in the GUI. `tools/build-installer-exe.ps1` compiles it into `JunSetup.exe` with `install.ps1` embedded as base64; with `-PinRef`/`-PinSha` it also bakes in a tag and that tag's commit, and the exe then installs that exact commit and nothing else. Both installers resolve a release channel (`JUN_CHANNEL`: stable, latest, experimental) to a tag through the GitHub releases API (the website's `/releases/latest` redirect when the API is rate limited), and never fall back to `main` unless experimental was picked. The documented one-liners and `JunSetup.exe` are fetched from `releases/latest/download/`, so a release's own scripts start the install. After cloning they hand off to the `install.ps1`/`install.sh` inside the checkout (`JUN_HANDOFF=1`), so the installer that configures a release is always the one that shipped with it. Keep that handoff working when you change either script. The Colab deployment lives in `colab.ipynb`, and `android/` is a separate Gradle project. See [the architecture guide](docs/architecture.md) before changing a cross-service flow.

## Project invariants

Some choices that look incidental are required for correctness:

- Keep the static prompt prefix and unchanged conversation history byte-stable so the model backend can reuse its prompt cache.
- Append live context after the current user's question. The fine-tuning dataset was built in that order.
- Treat streamed response markers as arbitrarily split across network chunks. Action and bookkeeping tags must never flash in the visible chat.
- Keep `webapp/js` as plain, dependency-free ES modules. If a module cache-buster changes, update every import of that module.
- Make voice and karaoke features degrade gracefully when their sidecars are unavailable.
- Do not add embeddings to lore or memory retrieval; the repository intentionally uses keyword/IDF scoring, and word matching over decrypted chat history.
- After editing `tools/lore_dataset.jsonl`, run `php tools/build_lore_index.php` and commit the rebuilt `webapp/lore_corpus.txt` with it. Retrieval only reads the corpus, and CI fails when the two don't match.
- Do not upload client-side mod assets to the server. Only item metadata may leave the browser.
- Preserve the optional Compose profiles and account for Docker, bare-metal Windows, and Colab when a shared path changes.

## Validation

There is no single project-wide local test command. Run checks proportional to the change and list the exact commands and results in your pull request. Useful focused checks include:

```sh
php -l webapp/api/changed-file.php
python -m py_compile path/to/changed_file.py
cp webapp/js/changed-file.js /tmp/changed-file.mjs
node --check /tmp/changed-file.mjs
shellcheck -S error path/to/changed-script.sh
```

For Android changes:

```sh
cd android
sh ./gradlew :app:testDebugUnitTest --no-daemon
```

For Compose changes, validate every affected overlay and profile. For runtime changes, exercise the affected behavior and inspect the relevant container logs. CI runs JavaScript, JSON, Python, PHP, shell, Compose, Docker, Windows, and Android checks; a focused contribution does not need to reproduce unrelated expensive jobs locally.

Do not say a check passed if it was not run. Record missing hardware or unavailable services plainly.

## Cutting a release

Releases live on the public repo, and the installers and the README links read whatever the newest published one carries. So the order matters.

1. Push a `v*` tag (`vX.Y.Z` for a full release, anything with a `-`, like `vX.Y.Z-beta`, for a pre-release). A tag ending in `-security` (`vX.Y.Z-security`, `vX.Y.Z-beta-security`) drafts as a full release and makes every older install with the update checker on refuse to start until it updates, so it's only for the vulnerabilities [SECURITY.md](SECURITY.md#security-releases) describes. Publish the advisory with it and say in the notes what to do.
2. `.github/workflows/release-installer.yml` builds `JunSetup-<tag>.exe` pinned to that tag's commit and `JunOS.exe` (the manager window from `jun-manager.ps1`, compiled with `tools/build-installer-exe.ps1 -Manager` first and embedded into the setup exe with `-EmbedManager`), plus `JunOS-<tag>.apk` (the signed release build of `android/`), and puts them, `install.sh`, `install.ps1`, `installer-gui.ps1` and `SHA256SUMS` on a **draft** release for the tag. A draft you already made in the UI for that tag is reused.
3. Swap the apk: `tools/release-apk-local.sh vX.Y.Z --upload`, with the same four signing values as below in the environment. CI's apk uses LiteRT-LM from Maven, which has no `Session.clone()` yet, so the phone's prefix cache stays off in it. The script rebuilds the apk from the public checkout at the tag against the upstream build in [NOTICE](NOTICE) section 6, refuses if the signing certificate differs from the draft's apk, and rewrites the apk line in `SHA256SUMS`. Re-pushing the tag refills the draft with CI's apk, so run it again after that. This step goes away once a Maven release has `clone()`.
4. Write the notes, check the pre-release box is right, publish. Stable installs follow the newest full release, Latest follows the newest of either kind.

The apk job needs four secrets in the `release` environment (Settings, Environments, deployment rule limited to `v*` tags, so nothing but a tag build can read the key): `JUN_ANDROID_KEYSTORE_BASE64` (the release keystore, base64), `JUN_ANDROID_STORE_PASSWORD`, `JUN_ANDROID_KEY_ALIAS` and `JUN_ANDROID_KEY_PASSWORD`. Without them a tag fails instead of shipping an unsigned apk. Every apk has to come from that same keystore, Android refuses an update signed by a different key, so keep a backup of it. The `versionCode` is the commit count of the tagged commit.

Publishing before the workflow finishes leaves the release without its exe and apk for good. Delete nothing: fix forward with the next tag.

## Pull requests

Keep each pull request to one coherent change and avoid unrelated formatting or cleanup. Complete the pull request template, link related issues, and include screenshots or recordings for visual changes without exposing copyrighted assets or private conversations.

Match the surrounding code style. Prefer clear naming and small control flow over explanatory comments; comments should record only constraints or behavior that would otherwise be easy to break.

By contributing, you agree that your contribution is provided under this repository's [Apache License 2.0](LICENSE) (section 5 of the license covers contributions).

