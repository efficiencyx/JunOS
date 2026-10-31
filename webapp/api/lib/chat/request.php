<?php

// a 20 s window at WATCH_FRAME_EVERY=1
const WATCH_MAX_FRAMES = 20;
const WATCH_FRAME_MAX_BYTES = 200 * 1024;
const WATCH_FRAME_MAX_PX = 768;
// 25 s of 16 kHz mono plus the header. her audio encoder tops out
// at 30 s a clip
const WATCH_AUDIO_MAX_BYTES = 25 * 32000 + 44;

function chat_parse_request(string $provider): array {
    // big enough for a base64 wav plus the history. nginx caps
    // /api/chat.php at 4m and THAT's the limit that actually bites,
    // this one just has to sit above it. see the audio field below.
    $body = json_decode(read_body(6 * 1024 * 1024), true);
    if (!is_array($body) || !isset($body['messages']) || !is_array($body['messages'])) {
        sse_fail('invalid_request');
    }

    // the client sends the whole conversation every turn and compact
    // only moves a pointer, it never trims what the browser holds. so
    // past 160 we drop the oldest instead of failing, or the 161st
    // message kills the chat for good. the summary skip below shifts
    // by the same count, the dropped rows are the oldest ones and so
    // are the covered ones.
    $droppedOldest = max(0, count($body['messages']) - 160);
    if ($droppedOldest > 0) $body['messages'] = array_slice($body['messages'], -160);
    foreach ($body['messages'] as $m) {
        if (!is_array($m)) sse_fail('invalid_request');
        if (!in_array($m['role'] ?? '', ['user', 'assistant', 'system'], true)) sse_fail('invalid_request');
        $content = $m['content'] ?? '';
        if (!is_string($content) || strlen($content) > 16 * 1024) sse_fail('invalid_request');
    }

    $audioB64 = '';
    if (isset($body['audio'])) {
        if (!is_string($body['audio'])) sse_fail('invalid_request');
        $wav = base64_decode($body['audio'], true);
        if ($wav === false || strlen($wav) > 4 * 1024 * 1024 || substr($wav, 0, 4) !== 'RIFF') {
            sse_fail('invalid_request');
        }
        $audioB64 = $body['audio'];
        unset($wav);
    }
    $watch = chat_parse_watch($body);
    $frames = chat_parse_frames($body, $watch !== null);
    if ($watch !== null && count($watch['frames_at']) !== count($frames)) $watch['frames_at'] = [];
    if ($watch !== null && $audioB64 !== '' && strlen(base64_decode($audioB64)) > WATCH_AUDIO_MAX_BYTES) {
        sse_fail('invalid_request');
    }
    // a whisper turn arrives as plain text and looks typed. the flag
    // is what earns it the "who is he talking to" block below, an
    // audio turn gets it for free. on the couch the audio is the
    // video's, not his
    $spoken = $watch === null && ($audioB64 !== '' || !empty($body['voice']));
    // the "hear everything" switch. she still hears it as spoken, but
    // no side-talk block and overheard is ignored. there for anyone
    // alone at the desk, and for the languages her audio encoder
    // half hears: italian speech with the block on went silent on
    // 14/24 lines that WERE for her, whisper text of the same lines
    // held 21/24
    if (!empty($body['hear_all'])) $spoken = false;

    $model = default_chat_model();
    if (isset($body['model']) && is_string($body['model']) && $body['model'] !== '') {
        if (!preg_match('/^[a-z0-9._:\\/\-]{1,64}$/i', $body['model'])) sse_fail('invalid_request');
        $model = $body['model'];
    }
    $model = resolve_chat_model($model);

    // she hears through the mmproj (the multimodal projector) that
    // sits next to the GGUF. ollama and llama.cpp both say whether
    // the loaded one does audio, OpenRouter + the Android build
    // can't take it at all. client hears this and falls back to
    // stt.php
    if ($frames && !provider_model_sees($provider, $model)) sse_fail('vision_unsupported');
    if ($audioB64 !== '' && !provider_model_hears($provider, $model)) {
        sse_fail('audio_unsupported');
    }

    $reasoning = 'low';
    if (isset($body['reasoning'])) {
        if (!in_array($body['reasoning'], ['auto', 'low', 'medium', 'high'], true)) sse_fail('invalid_request');
        $reasoning = (string)$body['reasoning'];
    }

    $outfitContext = '';
    if (isset($body['outfit_context'])) {
        if (!is_string($body['outfit_context']) || strlen($body['outfit_context']) > 8 * 1024) {
            sse_fail('invalid_request');
        }
        $outfitContext = trim($body['outfit_context']);
    }

    // mod item names, this turn only. the server has never stored a
    // mod and is not starting now. it needs the list purely so
    // change_outfit can tell "you don't own that" apart from "that's
    // a modded item".
    $modItems = [];
    if (isset($body['mod_items'])) {
        if (!is_array($body['mod_items'])) sse_fail('invalid_request');
        foreach (array_slice($body['mod_items'], 0, 60) as $item) {
            if (!is_string($item)) continue;
            $item = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $item));
            if ($item !== '') $modItems[] = mb_substr($item, 0, 80);
        }
    }

    $clientTime = chat_clean_text($body['client_time'] ?? '', 80);

    // minutes east of UTC, so the achievement day and the 2-5 am
    // window are Anon's and not the container's
    $tz = isset($body['tz']) && is_int($body['tz']) ? $body['tz'] : 0;

    $idle = isset($body['idle']) && $body['idle'] === true;
    $ephemeral = !empty($body['ephemeral']) || $watch !== null;
    $regenerate = !$idle && !$ephemeral && ($body['regenerate'] ?? false) === true;
    $invite = isset($body['invite']) && in_array($body['invite'], TRIP_TOOLS, true) ? (string)$body['invite'] : '';

    return [
        'body' => $body, 'dropped_oldest' => $droppedOldest, 'audio' => $audioB64, 'spoken' => $spoken,
        'model' => $model, 'reasoning' => $reasoning, 'outfit_context' => $outfitContext,
        'mod_items' => $modItems, 'client_time' => $clientTime, 'tz' => $tz, 'idle' => $idle,
        'ephemeral' => $ephemeral, 'invite' => $invite, 'regenerate' => $regenerate,
        'watch' => $watch, 'frames' => $frames,
    ];
}

function chat_clean_text(mixed $value, int $max): string {
    if (!is_string($value)) return '';
    return trim(mb_substr(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value), 0, $max));
}

function chat_parse_watch(array $body): ?array {
    if (!isset($body['watch'])) return null;
    $w = $body['watch'];
    if (!is_array($w)
        || !in_array($w['turn'] ?? '', ['start', 'tick', 'talk', 'end'], true)
        || !in_array($w['source'] ?? '', ['file', 'tab', 'screen'], true)) {
        sse_fail('invalid_request');
    }
    return [
        'turn' => $w['turn'],
        'source' => $w['source'],
        'title' => chat_clean_text($w['title'] ?? '', 120),
        'at' => max(0, min(86400, (int)($w['at'] ?? 0))),
        'length' => max(0, min(86400, (int)($w['length'] ?? 0))),
        'paused' => !empty($w['paused']),
        'heard' => chat_clean_text($w['heard'] ?? '', 2000),
        'earlier' => chat_clean_text($w['earlier'] ?? '', 2400),
        'frames_at' => chat_parse_frame_times($w['frames_at'] ?? null),
    ];
}

function chat_parse_frame_times(mixed $times): array {
    if (!is_array($times) || count($times) > WATCH_MAX_FRAMES) return [];
    foreach ($times as $t) if (!is_int($t) || $t < 0 || $t > 86400) return [];
    return array_values($times);
}

// only ever base64 jpeg. the data: url goes together in
// payload.php, nothing the client sends becomes a url
function chat_parse_frames(array $body, bool $watching): array {
    if (!isset($body['frames'])) return [];
    if (!$watching || !is_array($body['frames']) || count($body['frames']) > WATCH_MAX_FRAMES) sse_fail('invalid_request');
    $frames = [];
    foreach ($body['frames'] as $b64) {
        $jpeg = is_string($b64) ? base64_decode($b64, true) : false;
        if ($jpeg === false || strlen($jpeg) > WATCH_FRAME_MAX_BYTES || !str_starts_with($jpeg, "\xFF\xD8\xFF")) {
            sse_fail('invalid_request');
        }
        $size = @getimagesizefromstring($jpeg);
        if (!$size || ($size[2] ?? 0) !== IMAGETYPE_JPEG || max($size[0], $size[1]) > WATCH_FRAME_MAX_PX) {
            sse_fail('invalid_request');
        }
        $frames[] = $b64;
    }
    return $frames;
}

function chat_require_conversation(array $user, array $body): int {
    $convId = isset($body['conversation_id']) ? (int)$body['conversation_id'] : 0;
    if (!$convId) sse_fail('invalid_request');
    if (!conversation_owned($convId, (int)$user['id'])) sse_fail('forbidden');
    return $convId;
}

function chat_last_user_message(array $req): string {
    $lastUserMsg = '';
    for ($i = count($req['body']['messages']) - 1; $i >= 0; $i--) {
        if (($req['body']['messages'][$i]['role'] ?? '') === 'user') {
            $lastUserMsg = trim((string)($req['body']['messages'][$i]['content'] ?? ''));
            break;
        }
    }
    // a spoken turn has no text AT ALL, so anything reading the last
    // message gets nothing. keyword lore lookup dies with it, which
    // is fine, she's got search_lore and can just ask for what she
    // needs.
    if ($req['audio'] !== '' && $req['watch'] === null) $lastUserMsg = '';
    return $lastUserMsg;
}

function chat_last_reply(array $req): string {
    $messages = $req['body']['messages'];
    for ($i = count($messages) - 1; $i >= 0; $i--) {
        if (($messages[$i]['role'] ?? '') === 'assistant') return (string)($messages[$i]['content'] ?? '');
    }
    return '';
}

function chat_approved_search(string $lastUserMsg): ?string {
    $approvedWebSearchQuery = null;
    if (preg_match('/^\/search\s+(.+)$/us', $lastUserMsg, $searchMatch)) {
        $approvedWebSearchQuery = trim($searchMatch[1]);
        if ($approvedWebSearchQuery === '') $approvedWebSearchQuery = null;
        elseif (mb_strlen($approvedWebSearchQuery) > 400) {
            $approvedWebSearchQuery = mb_substr($approvedWebSearchQuery, 0, 400);
        }
    }
    return $approvedWebSearchQuery;
}
