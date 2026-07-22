# Chatterbox / Nano reference voices

The `chatterbox` and `chatternano` engines are zero-shot voice cloners: a "voice"
is a reference `.wav` in this directory. Files here are baked into the tts image
(`COPY tts/voices/ /app/voices/`); a compose mount over `/app/voices` can add or
override clips at runtime without a rebuild.

## Add a voice

Drop `<name>.wav` here. The stem becomes the voice name shown in the picker.

- **`default.wav`** is the out-of-box voice — Chatterbox uses it in place of its
  built-in default, and Nano (which is clone-only) needs it to make any sound.
- Name must match `^[a-z][a-z0-9_]*$` — lowercase letters/digits/underscore,
  starting with a letter (e.g. `default.wav`, `soft_v2.wav`). Others are ignored.
- Must be `.wav`. Sample rate/channels don't matter; the model resamples.

## What clones well

- ~7-20s (about 10s is the sweet spot); under ~3s clones poorly.
- One speaker, clean — no music, overlapping voices, or heavy reverb/noise. The
  model copies whatever it hears, hiss included.
- Natural, expressive English delivery in the tone you want.
