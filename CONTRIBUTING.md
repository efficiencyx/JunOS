# Contributing to Jun OS

Thanks for helping Jun OS improve. Bug fixes, compatibility work, documentation, accessibility improvements, and focused features are welcome.

Jun OS comes from an adult game and its project spaces are intended for adults (18+) only. Keep reports and contributions professional, avoid explicit material that is not necessary to understand a technical change, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For a bug or setup problem, search existing issues and read [When things go sideways](README.md#when-things-go-sideways). Use the matching issue form and include a minimal reproduction, environment details, the commit or release you tested, and short redacted logs.

For a larger feature, open a feature request before investing significant time. That gives maintainers a chance to confirm fit and flag architecture or licensing constraints early. Small, well-contained fixes can go straight to a pull request.

Report exploitable vulnerabilities privately as described in [SECURITY.md](SECURITY.md#reporting-a-vulnerability), not in a public issue.

## Asset and privacy rules

The source code is MIT licensed, but the original game's art and other assets are not. Never commit or attach:

- files recovered into `webapp/assets/`;
- raw game archives, Live2D source assets, or screenshots that redistribute those assets;
- model weights or private training data;
- `.env` files, API keys, registration keys, passwords, chat history, memory notes, or journals.

The complete asset terms are in the NOTICE section of [LICENSE](LICENSE). Use synthetic or self-created fixtures when a test needs media.

## Development setup

Create a branch from `main`, copy `.env.example` to `.env`, and use the installation path you intend to change. The usual Docker development loop is:

```sh
./start.sh
./sync-webapp.sh
```

Use `./sync-webapp.sh -s` only when every changed file is static. PHP opcache does not watch timestamps, so PHP changes require the full command. Hard-refresh the browser after synchronizing.

The Windows installation is managed by `install.ps1` and `start.ps1`. `installer-gui.ps1` is a WPF front end over the same `install.ps1`: it collects answers, exports the matching `JUN_*` variables plus `JUN_YES=1`, and runs the script, so installer behavior changes belong in `install.ps1` and only the questions belong in the GUI. `tools/build-installer-exe.ps1` compiles it into `JunSetup.exe` with `install.ps1` embedded as base64, and `.github/workflows/release-installer.yml` attaches that exe to tagged releases. The Colab deployment lives in `colab.ipynb`, and `android/` is a separate Gradle project. See [the architecture guide](docs/architecture.md) before changing a cross-service flow.

## Project invariants

Some choices that look incidental are required for correctness:

- Keep the static prompt prefix and unchanged conversation history byte-stable so the model backend can reuse its prompt cache.
- Append live context after the current user's question. The fine-tuning dataset was built in that order.
- Treat streamed response markers as arbitrarily split across network chunks. Action and bookkeeping tags must never flash in the visible chat.
- Keep `webapp/js` as plain, dependency-free ES modules. If a module cache-buster changes, update every import of that module.
- Make voice and karaoke features degrade gracefully when their sidecars are unavailable.
- Do not add embeddings to lore or memory retrieval; the repository intentionally uses keyword/IDF and SQL text matching.
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

## Pull requests

Keep each pull request to one coherent change and avoid unrelated formatting or cleanup. Complete the pull request template, link related issues, and include screenshots or recordings for visual changes without exposing copyrighted assets or private conversations.

Match the surrounding code style. Prefer clear naming and small control flow over explanatory comments; comments should record only constraints or behavior that would otherwise be easy to break.

By contributing, you agree that your contribution is provided under this repository's [MIT license](LICENSE).

