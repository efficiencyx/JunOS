import os

KOKORO_SAMPLE_RATE = 24000
KOKORO_DEFAULT = "af_heart"

# Kokoro-82M's EN voices. some are trained way better than
# others, all load fine.
KOKORO_VOICES = [
    "af_heart", "af_bella", "af_aoede", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "af_alloy", "af_jessica",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
]

# pocket-tts voice names pick timbre, not language. each has an
# embedding for every POCKET_LANGUAGES entry. giovanni, lola,
# juergen, rafael and estelle keep the accent of their non-English
# speakers.
POCKET_DEFAULT = "eve"
POCKET_VOICES = [
    "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette",
    "eponine", "eve", "fantine", "george", "jane", "jean", "javert", "marius",
    "mary", "michael", "paul", "peter_yearsley", "stuart_bell", "vera",
    "giovanni", "lola", "juergen", "rafael", "estelle",
]

# language picks the weights through load_model(language=...).
# upstream configs only. the french, spanish and german _24l
# builds are the 24 layer ones. id picks the model, label is just
# UI text.
POCKET_DEFAULT_LANG = "english"
POCKET_LANGUAGES = [
    {"id": "english", "label": "English"},
    {"id": "french_24l", "label": "French"},
    {"id": "german_24l", "label": "German"},
    {"id": "italian", "label": "Italian"},
    {"id": "portuguese", "label": "Portuguese"},
    {"id": "spanish_24l", "label": "Spanish"},
]
POCKET_LANG_IDS = frozenset(lang["id"] for lang in POCKET_LANGUAGES)

DEFAULT_ENGINE = "kokoro"
TTS_ENGINES = ("kokoro", "pockettts")

# tts | karaoke. this only changes the pre-warm at startup and
# what /health says. every route is mounted in both roles and
# 503s when the thing it needs isn't there.
SIDECAR_ROLE = os.environ.get("SIDECAR_ROLE", "tts").strip().lower()

# "demucs" is a fake engine. it's not a TTS voice, but shoving it
# in the same lifecycle lets a separation job kick the TTS
# engines out while it runs, and vice versa, and it holds
# state.inflight so the reaper can't yank a model out from under a
# running job.
ALL_ENGINES = TTS_ENGINES + ("demucs",)

# one TTS engine loaded at a time, switching drops the others.
# this is the idle unload timeout, 0 turns it off. a cold reload
# from HF_HOME takes a few seconds.
TTS_IDLE_UNLOAD_S = float(os.environ.get("TTS_IDLE_UNLOAD_S", "180"))
REAP_INTERVAL_S = 20.0

# cap on the /stt request body. 16kHz mono PCM16 is ~32KB/s so
# 4MB is roughly 2min of audio. one of a whole chain of caps,
# api/stt.php lists them all.
STT_MAX_BYTES = 4 * 1024 * 1024
STT_MAX_DURATION_S = float(os.environ.get("STT_MAX_DURATION_S", "120"))

# empty string means detect it per utterance, which costs another
# decode pass and is shaky under ~2s of audio. so just name the
# language when you know it. must agree with STT_MODEL,
# docker/tts.Dockerfile explains the pairing.
STT_LANG = (os.environ.get("STT_LANG", "").strip().lower() or None)

# karaoke sends whole songs, not utterances, so it gets its own
# much bigger cap. the stems we split out sit in a temp dir per
# token and go away once both have been fetched, or after this
# TTL when a client just never comes back.
SEP_MAX_BYTES = 50 * 1024 * 1024
SEP_TTL_S = 15 * 60
# how many split songs sit on disk waiting to be fetched. each is
# two full-length wavs (~100MB a song), and /tmp is a 1g tmpfs in
# compose. past this the oldest one goes.
SEP_MAX_JOBS = max(1, int(os.environ.get("SEP_MAX_JOBS", "4")))
SEP_MAX_DURATION_S = float(os.environ.get("SEP_MAX_DURATION_S", "900"))

TTS_MAX_QUEUE = max(0, int(os.environ.get("TTS_MAX_QUEUE", "8")))
TTS_QUEUE_WAIT_S = float(os.environ.get("TTS_QUEUE_WAIT_S", "30"))

# only PHP talks to this thing. the browser never does, it goes
# through api/tts.php and friends, which hold the session check
# and the rate limiter. so a request straight from a browser
# (Origin or Sec-Fetch-Site set) is wrong by definition and gets
# a 403 whatever else it carries. SIDECAR_SECRET is the shared
# header PHP sends, start.sh/start.ps1/colab mint one. empty
# means an old .env or a hand-rolled compose, we log it once and
# fall back to the Host allowlist alone.
SIDECAR_SECRET = os.environ.get("SIDECAR_SECRET", "").strip()
SIDECAR_ALLOWED_HOSTS = {
    h.strip().lower() for h in os.environ.get(
        "SIDECAR_ALLOWED_HOSTS", "localhost,127.0.0.1,::1,tts,karaoke").split(",")
    if h.strip()}
# what each POST route takes in its body. anything else is a 415
# before the body gets read.
RAW_AUDIO_PATHS = {"/stt", "/separate", "/transcribe_timed"}
JSON_PATHS = {"/tts", "/warm", "/separate/stem"}
JSON_MAX_BYTES = 16 * 1024
