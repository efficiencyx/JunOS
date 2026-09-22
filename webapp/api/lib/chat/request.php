<?php

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
    // a whisper turn arrives as plain text and looks typed. the flag
    // is what earns it the "who is he talking to" block below, an
    // audio turn gets it for free
    $spoken = $audioB64 !== '' || !empty($body['voice']);
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
    $model = ollama_resolve_chat_model($model);

    // llama.cpp runs with no mmproj here (the multimodal projector,
    // the file that lets her hear), and OpenRouter + the Android
    // build can't take audio at all. client hears this and falls
    // back to stt.php
    if ($audioB64 !== '' && ($provider !== 'ollama' || !ollama_model_supports_audio($model))) {
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

    $clientTime = '';
    if (isset($body['client_time']) && is_string($body['client_time'])) {
        $clientTime = trim(mb_substr(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $body['client_time']), 0, 80));
    }

    $idle = isset($body['idle']) && $body['idle'] === true;
    $ephemeral = !empty($body['ephemeral']);
    $invite = isset($body['invite']) && in_array($body['invite'], TRIP_TOOLS, true) ? (string)$body['invite'] : '';

    return [
        'body' => $body, 'dropped_oldest' => $droppedOldest, 'audio' => $audioB64, 'spoken' => $spoken,
        'model' => $model, 'reasoning' => $reasoning, 'outfit_context' => $outfitContext,
        'mod_items' => $modItems, 'client_time' => $clientTime, 'idle' => $idle,
        'ephemeral' => $ephemeral, 'invite' => $invite,
    ];
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
    if ($req['audio'] !== '') $lastUserMsg = '';
    return $lastUserMsg;
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
