## Summary

<!-- What changed? Keep this focused on behavior reviewers can verify. -->

## Why

<!-- What problem does this solve? Link the issue with "Closes #123" when applicable. -->

## Validation

<!-- List the exact commands and manual checks you ran, plus their results. Say "not run" and explain why when a relevant check was unavailable. -->

- [ ] I ran targeted syntax or automated checks for the files I changed.
- [ ] I exercised the affected behavior directly where practical.
- [ ] I checked the relevant service or browser logs.

## Platforms affected

<!-- Docker CPU/NVIDIA/AMD, Windows, Colab, Android, or not applicable. -->

## Checklist

- [ ] The change is focused and preserves existing APIs and configuration unless documented otherwise.
- [ ] I updated documentation and `.env.example` when behavior or configuration changed.
- [ ] I did not include secrets, private chat data, model weights, or extracted/recovered game assets.
- [ ] Frontend changes remain dependency-free ES modules and use consistent `?v=` cache-busters.
- [ ] For changes under `webapp/`, I ran `./sync-webapp.sh` (`-s` only for static files) and hard-refreshed, or explained above why I could not.
- [ ] Streaming changes handle markers split across arbitrary chunks and do not expose hidden action or bookkeeping tags.
- [ ] Prompt changes preserve prefix stability and keep dynamic context after the user's question, unless the PR explicitly explains why that invariant changes.

## Screenshots or recordings

<!-- Add these for visible changes. Do not include copyrighted recovered assets or private conversations. -->

