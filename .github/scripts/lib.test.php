<?php
// usage: php .github/scripts/lib.test.php
$lib = __DIR__ . '/../../webapp/api/lib';
require "$lib/text.php";
require "$lib/memory.php";
require "$lib/providers/context.php";
require "$lib/providers/stream.php";
require "$lib/chat/request.php";
require "$lib/chat/websearch.php";
require "$lib/chat/tags.php";
require "$lib/providers/config.php";
require "$lib/providers/payload.php";

$applied = [];
function relationship_apply(int $userId, array $rel, array $deltas): void { $GLOBALS['applied'][] = $deltas; }
function sse_fail(string $err): never { throw new RuntimeException($err); }

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

$eq('ctx: roomy card', ctx_tier_for_headroom(8192), 16384);
$eq('ctx: 12 GB card with the 12B', ctx_tier_for_headroom(3201), 12288);
$eq('ctx: just short of 8192', ctx_tier_for_headroom(1638), 6144);
$eq('ctx: crowded card keeps the floor', ctx_tier_for_headroom(200), 6144);
$eq('ctx: weights bigger than the card', ctx_tier_for_headroom(-3000), 6144);

$monday = mktime(12, 0, 0, 8, 10, 2026);
$tuesday = mktime(12, 0, 0, 8, 11, 2026);
$eq('dates: created anchors', memory_note_anchor(['created' => $monday]), $monday);
$eq('dates: dated wins', memory_note_anchor(['created' => $monday, 'dated' => $tuesday]), $tuesday);
$eq('dates: tomorrow from the edit', str_contains(memory_note_render(['text' => 'dentist tomorrow', 'created' => $monday, 'dated' => $tuesday]), 'Wednesday 12 August 2026'), true);
$eq('dates: new wording moves the anchor', memory_note_dated('dentist at nine', 'dentist tomorrow at nine', 0) > 0, true);
$eq('dates: same wording keeps it', memory_note_dated('dentist tomorrow', 'the Dentist tomorrow', 300), 300);
$eq('dates: a typo fix stays on created', memory_note_dated('dentist tomorow tomorrow', 'dentist tomorrow', 0), 0);
$eq('dates: absolute date drops it', memory_note_dated('dentist tomorrow', 'dentist on 3 November', 300), 0);

$eq('recall: phrase', recall_match('we threw a party for her birthday', 'her birthday', ['birthday']), 21);
$eq('recall: words any order', recall_match('threw a party for her birthday', 'birthday party', ['birthday', 'party']), 8);
$eq('recall: one word missing', recall_match('threw a party', 'birthday party', ['birthday', 'party']), null);
$eq('recall: word start only', recall_match('she said so', 'ai', ['ai']), null);
$eq('recall: offset in chars', recall_match('caffè con Luca', 'luca', ['luca']), 10);
$eq('recall: excerpt keeps the hit', str_contains(recall_excerpt(str_repeat('x ', 400) . 'needle', 800), 'needle'), true);

$eq('loop: one word over and over', stream_looping('Hi. ' . str_repeat('ha ', 80)), true);
$eq('loop: long chunk three times', stream_looping(str_repeat('I keep thinking about the rain and the window. ', 5)), true);
$eq('loop: normal prose', stream_looping('She looked out at the rain. Then she laughed, and the room felt smaller somehow. "Again?" she asked.'), false);
$eq('loop: short repeat is fine', stream_looping('no no no'), false);
$frames = [];
[$track, $stuck] = stream_loop_guard(function ($f) use (&$frames) { $frames[] = $f; });
foreach (range(1, 60) as $_) $track(['token' => 'la la ']);
$eq('loop guard trips', $stuck(), 'looping');
$eq('loop guard passes frames on', count($frames), 60);
[$track, $stuck] = stream_loop_guard(fn($f) => null);
$track(['token' => 'a normal reply']);
$eq('loop guard quiet otherwise', $stuck(), '');

$eq('search: command', chat_approved_search('/search best ramen in Bologna'), 'best ramen in Bologna');
$eq('search: no command', chat_approved_search('search for ramen'), null);
$eq('search: empty', chat_approved_search('/search    '), null);
$eq('search: capped', mb_strlen(chat_approved_search('/search ' . str_repeat('a', 500))), 400);
$eq('search: url', web_is_url('https://example.com/a?b=c'), true);
$eq('search: not a url', web_is_url('example.com and more'), false);

$private = ['Anon lives on Via Roma 12 with Marta, his email is anon@example.com, phone 3331234567.'];
$eq('leak: plain topic', web_query_leak('ramen recipes', 'ramen', $private), null);
$eq('leak: email', web_query_leak('anon@example.com', 'ramen', $private), '@');
$eq('leak: long number', web_query_leak('who owns 3331234567', 'ramen', $private), '3331234567');
$eq('leak: name from his notes', web_query_leak('marta ramen', 'ramen', $private), 'marta');
$eq('leak: street from his notes', web_query_leak('ramen near roma', 'ramen', $private), 'roma');
$eq('leak: he typed it himself', web_query_leak('ramen near roma', 'ramen roma', $private), null);
$eq('leak: lookups capped', web_lookup('ramen', 'more ramen', WEB_LOOKUPS_PER_TURN, $private)['error'], 'lookup_limit');
$eq('leak: her query refused', web_lookup('ramen', 'marta ramen', 1, $private)['error'], 'query_refused');

$eq('ip: public v4', ip_is_public('93.184.216.34'), true);
$eq('ip: lan', ip_is_public('192.168.1.10'), false);
$eq('ip: loopback', ip_is_public('127.0.0.1'), false);
$eq('ip: tailscale cgnat', ip_is_public('100.100.1.1'), false);
$eq('ip: benchmark range', ip_is_public('198.18.0.5'), false);
$eq('ip: multicast', ip_is_public('239.1.1.1'), false);
$eq('ip: nat64 to private', ip_is_public('64:ff9b::c0a8:10a'), false);
$eq('ip: 6to4', ip_is_public('2002:c0a8:010a::1'), false);
$eq('ip: public v6', ip_is_public('2606:4700:4700::1111'), true);

$out = chat_apply_bookkeeping_tags('[A:smile] Sure! [A:mood_shift|affection=+3|trust=-1] See you.', 1, []);
$eq('tags: mood_shift stripped', $out, '[A:smile] Sure!  See you.');
$eq('tags: deltas applied', $applied, [['affection' => 3, 'trust' => -1]]);
$applied = [];
chat_apply_bookkeeping_tags('[ACTION: mood_shift tension=5]', 1, []);
$eq('tags: legacy form', $applied, [['tension' => 5]]);
$applied = [];
chat_apply_bookkeeping_tags('[A:mood_shift|nothing=1]', 1, []);
$eq('tags: no deltas no call', $applied, []);

$applied = [];
$out = chat_apply_bookkeeping_tags('Ha. [A:mood_shift|affection=+2]', 1, [], false);
$eq('tags: tick strips without applying', [$out, $applied], ['Ha.', []]);

// SOI + a baseline SOF0 header is all getimagesizefromstring reads
$fakeJpeg = fn(int $w, int $h) => base64_encode("\xFF\xD8\xFF\xC0\x00\x11\x08" . pack('nn', $h, $w)
    . "\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xFF\xD9");
$jpeg = $fakeJpeg(64, 36);
$turn = ['role' => 'user', 'content' => 'hi', 'media' => ['images' => [$jpeg], 'audio' => ['UklGRg==']]];
$llama = provider_messages('llamacpp', [$turn])[0];
$eq('media: openai order is image, audio, text', array_column($llama['content'], 'type'), ['image_url', 'input_audio', 'text']);
$eq('media: data url built here', str_starts_with($llama['content'][0]['image_url']['url'], 'data:image/jpeg;base64,'), true);
$eq('media: key never leaves', array_key_exists('media', $llama), false);
$ollama = provider_messages('ollama', [$turn])[0];
$eq('media: ollama gets one images list', [$ollama['content'], $ollama['images']], ['hi', [$jpeg, 'UklGRg==']]);
$eq('media: plain turn untouched', provider_messages('llamacpp', [['role' => 'user', 'content' => 'x']])[0], ['role' => 'user', 'content' => 'x']);

$wav20s = base64_encode(str_repeat("\0", 44 + 20 * 32000));
$eq('media: tokens', message_media_tokens(['media' => ['images' => [$jpeg, $jpeg], 'audio' => [$wav20s]]]), 2 * MEDIA_IMAGE_TOKENS + 500);

$refused = function (array $body, bool $watching) {
    try { chat_parse_frames($body, $watching); return false; } catch (RuntimeException $e) { return true; }
};
$eq('frames: one jpeg ok', chat_parse_frames(['frames' => [$jpeg]], true), [$jpeg]);
$eq('frames: none without watch', $refused(['frames' => [$jpeg]], false), true);
$eq('frames: five is too many', $refused(['frames' => array_fill(0, 5, $jpeg)], true), true);
$eq('frames: png refused', $refused(['frames' => [base64_encode("\x89PNG\r\n\x1a\n")]], true), true);
$eq('frames: over 768 px refused', $refused(['frames' => [$fakeJpeg(1024, 576)]], true), true);
$eq('watch: absent', chat_parse_watch([]), null);
$w = chat_parse_watch(['watch' => ['turn' => 'tick', 'source' => 'file', 'title' => "a\x07b", 'at' => -5]]);
$eq('watch: cleaned', [$w['title'], $w['at']], ['a b', 0]);
$eq('watch: bad turn refused', (function () {
    try { chat_parse_watch(['watch' => ['turn' => 'rewind', 'source' => 'file']]); return false; } catch (RuntimeException $e) { return true; }
})(), true);

exit($fails ? 1 : 0);
