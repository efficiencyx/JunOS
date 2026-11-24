<?php
// usage: php .github/scripts/lib.test.php
$lib = __DIR__ . '/../../webapp/api/lib';
require "$lib/env.php";
require "$lib/text.php";
require "$lib/memory.php";
require "$lib/providers/context.php";
require "$lib/providers/stream.php";
require "$lib/chat/request.php";
require "$lib/chat/prompt.php";
require "$lib/chat/websearch.php";
require "$lib/chat/tags.php";
require "$lib/providers/config.php";
require "$lib/providers/llamacpp.php";
require "$lib/providers/payload.php";
require "$lib/difficulty.php";
require "$lib/wardrobe.php";
require "$lib/chat/tools.php";
require "$lib/i18n.php";

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

$eq('note days: tomorrow from the day it was written', array_map(fn($d) => date('Y-m-d', $d), memory_note_days(['text' => 'dentist tomorrow', 'created' => $monday])), ['2026-08-11']);
$eq('note days: a plain date', array_map(fn($d) => date('Y-m-d', $d), memory_note_days(['text' => 'exam on 3 November 2026', 'created' => $monday])), ['2026-11-03']);
$eq('note days: none', memory_note_days(['text' => 'likes ramen', 'created' => $monday]), []);

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
$eq('tags: client strip matches stream-filters', chat_strip_client_tags("hey. [A:smile] there you are.\n[A:memory_write|category=likes|memory=tea]\n[A:mood_shift|affection=-3]"), "hey.  there you are.\n\n");
$eq('tags: client strip ignores ] inside tool JSON strings', chat_strip_client_tags('[TOOL:call{"q":"a]b"}] hi [ACTION: wave]'), ' hi ');

$warmMsgs = chat_build_warm_messages(
    ['body' => ['messages' => [['role' => 'user', 'content' => 'old'], ['role' => 'assistant', 'content' => 'ok'], ['role' => 'user', 'content' => 'new']]], 'dropped_oldest' => 0, 'idle' => false],
    'sys', 0, 'new', 'clean reply'
);
$eq('warm: clean history + reply without live context', $warmMsgs, [
    ['role' => 'system', 'content' => 'sys'],
    ['role' => 'user', 'content' => 'old'],
    ['role' => 'assistant', 'content' => 'ok'],
    ['role' => 'user', 'content' => 'new'],
    ['role' => 'assistant', 'content' => 'clean reply'],
]);
$cueMsgs = chat_build_messages(['body' => ['messages' => []], 'dropped_oldest' => 0, 'idle' => true, 'cue' => 'outing', 'watch' => null, 'audio' => ''], 'sys', 'LIVE', 0);
$eq('idle: a cue words the stage direction and still takes the live context', [
    str_contains($cueMsgs[1]['content'], CHAT_IDLE_CUES['outing']), str_contains($cueMsgs[1]['content'], 'gone quiet'), str_contains($cueMsgs[1]['content'], 'LIVE'),
], [true, false, true]);
$plainIdle = chat_build_messages(['body' => ['messages' => []], 'dropped_oldest' => 0, 'idle' => true, 'cue' => '', 'watch' => null, 'audio' => ''], 'sys', 'LIVE', 0);
$eq('idle: no cue keeps the trained silence nudge', str_contains($plainIdle[1]['content'], 'gone quiet'), true);
$open = ' Open with what you notice about him or what is on your mind, not a greeting.';
$eq('cue: a shift says no hours', chat_cue_text('outing_work', 535), CHAT_IDLE_CUES['outing_work'] . ' You missed him.' . $open);
$eq('cue: out together, no span', chat_cue_text('outing_together', 300), CHAT_IDLE_CUES['outing_together'] . $open);
$eq('cue: out alone gets a span in words', chat_cue_text('outing', 150), CHAT_IDLE_CUES['outing'] . ' He was gone a few hours.' . $open);
$eq('cue: a short trip says nothing more', chat_cue_text('outing', 20), CHAT_IDLE_CUES['outing'] . $open);
$eq('cue: not an outing stays as is', chat_cue_text('played', 600), CHAT_IDLE_CUES['played']);
$st = fn(array $o) => $o + ['stamina' => null, 'satiation' => null, 'mental' => null, 'longing' => null, 'horniness' => null, 'hour' => null];
$eq('state: nothing standing out says nothing', game_state_lines($st(['stamina' => 0.8, 'satiation' => 0.6, 'longing' => 5, 'hour' => 14])), []);
$eq('state: tired and starving', game_state_lines($st(['stamina' => 0.2, 'satiation' => 0.1])), ['Anon looks tired.', 'Anon is starving.']);
$eq('state: horny names the bed', game_state_lines($st(['horniness' => 0.69, 'hour' => 15])), ['You want him. If the moment fits, you can invite him to bed (invite_to_bed).']);
$eq('state: longing at night names the bed', count(array_filter(game_state_lines($st(['longing' => 7.5, 'hour' => 23])), fn($l) => str_contains($l, 'invite_to_bed'))), 1);
$eq('state: longing by day no bed', game_state_lines($st(['longing' => 7.5, 'hour' => 13])), []);
$eq('state: an old mod sends none', game_state_lines(null), []);
$eq('bed: come back to bed', game_reply_invites_to_bed('[A:blush|0.4]Do you want to come back to bed with me?'), true);
$eq('bed: lie down with me', game_reply_invites_to_bed('...Do you want to come lie down with me?'), true);
$eq('bed: just wanting him is not an invite', game_reply_invites_to_bed('I want you.'), false);
$eq('bed: the bed as a thing is not an invite', game_reply_invites_to_bed('I made the bed this morning.'), false);
$eq('bed: not offered by day', game_bed_offered($st(['longing' => 8, 'hour' => 14])), false);
$eq('bed: no state, no bed', game_bed_offered(null), false);

$closet = [
    ['name' => 'T-shirt', 'slot' => 'UpperBody', 'worn' => true],
    ['name' => 'Skirt', 'slot' => 'LowerBody', 'worn' => true],
    ['name' => 'T-shirt', 'slot' => 'UpperBody', 'worn' => false],
    ['name' => 'Maid dress', 'slot' => 'UpperBody', 'worn' => false],
    ['name' => '', 'slot' => '', 'worn' => false],
];
$dress = wardrobe_game_change(['put_on' => ['maid dress']], $closet);
$eq('game outfit: put on by name, same slot comes off in wearing', [$dress['apply'], $dress['reply']['wearing']],
    [['on' => [3], 'off' => []], ['Skirt', 'Maid dress']]);
$eq('game outfit: a twin name picks the one that changes', wardrobe_game_change(['put_on' => ['t-shirt']], $closet)['apply'], ['on' => [2], 'off' => []]);
$eq('game outfit: worn twin is the one taken off', wardrobe_game_change(['take_off' => ['T-shirt']], $closet)['apply'], ['on' => [], 'off' => [0]]);
$eq('game outfit: nude takes off what is worn and skips blanks', wardrobe_game_change(['take_off' => ['nude']], $closet)['apply'], ['on' => [], 'off' => [0, 1]]);
$unknown = wardrobe_game_change(['put_on' => ['bikini']], $closet);
$eq('game outfit: unknown lists the bag and changes nothing', [$unknown['apply'], $unknown['reply']['you_can_put_on']], [null, ['T-shirt', 'Maid dress']]);
$items = wardrobe_default_state()['items'];
$pink = wardrobe_tool_recolor(['parts' => ['hair', 'eyes', 'shoes'], 'color' => 'F6C'], $items);
$eq('recolor: aliases resolve, short hex expands', $pink['apply'],
    ['hair' => '#ff66cc', 'eye_iris' => '#ff66cc', 'shoe_l' => '#ff66cc', 'shoe_r' => '#ff66cc']);
$eq('recolor: a hidden item says so', wardrobe_tool_recolor(['parts' => ['hoodie'], 'color' => '#32a852'], $items)['reply']['not_wearing'], ['hoodie']);
$eq('recolor: a hair style label dyes the hair', wardrobe_tool_recolor(['parts' => ['ponytail', 'default hair'], 'color' => '#fff'], $items)['apply'], ['hair' => '#ffffff']);
$eq('recolor: default resets to null', wardrobe_tool_recolor(['parts' => ['skin'], 'color' => 'default'], $items)['apply'], ['skin' => null]);
$eq('recolor: a color name is refused', wardrobe_tool_recolor(['parts' => ['hair'], 'color' => 'pink'], $items)['apply'], null);
$wings = wardrobe_tool_recolor(['parts' => ['wings'], 'color' => '#000000'], $items);
$eq('recolor: unknown part changes nothing', [$wings['apply'], $wings['reply']['unknown']], [null, ['wings']]);
$eq('recolor: every valid part resolves back', array_filter($wings['reply']['valid_parts'], fn($p) => !wardrobe_resolve_color($p)), []);
$eq('retry: a bad hex forces another call', tool_result_retryable(json_encode(wardrobe_tool_recolor(['parts' => ['hair'], 'color' => 'white'], $items)['reply'])), true);
$eq('retry: a refusal she cannot fix does not', tool_result_retryable('{"error":"not_possible_here"}'), false);
$free = ['out' => true, 'date' => 'ok', 'shop' => 'ok'];
$eq('game trip: dinner is the restaurant date', game_trip('date', $free)['going'], 'restaurant');
$eq('game trip: watch is the cinema', game_trip('watch', $free)['going'], 'cinema');
$eq('game trip: cards has no game side', game_trip('cards', $free)['going'], false);
$eq('game trip: an old mod sends no outing state', game_trip('shop', null)['going'], false);
$eq('game trip: she can not go out at all', game_trip('shop', ['out' => false] + $free)['going'], false);
$eq('game trip: the shop keeps its own hours', [
    game_trip('shop', ['shop' => 'hours'] + $free)['going'], game_trip('date', ['shop' => 'hours'] + $free)['going'],
], [false, 'restaurant']);
$eq('game trip: a recent date says why', str_contains(game_trip('karaoke', ['date' => 'recent'] + $free)['note'], '14 hours'), true);
$eq('game outfit: no saved looks in the game', wardrobe_game_change(['look' => 'date night'], $closet)['reply']['error'], 'no_saved_looks_here');
$llamaWarm = provider_chat_warm_payload('llamacpp', 'jun', $warmMsgs, 'low', false, [['type' => 'function']]);
$eq('warm: llamacpp closes assistant with empty user turn and n_predict 0', [
    $llamaWarm['stream'], $llamaWarm['max_tokens'], $llamaWarm['n_predict'], $llamaWarm['cache_prompt'],
    end($llamaWarm['messages']), isset($llamaWarm['stream_options']),
], [false, 0, 0, true, ['role' => 'user', 'content' => ''], false]);
$ollamaWarm = provider_chat_warm_payload('ollama', 'jun', $warmMsgs, 'low', false);
$eq('warm: ollama sets num_predict 0 and stream false', [
    $ollamaWarm['stream'], $ollamaWarm['options']['num_predict'], end($ollamaWarm['messages']),
], [false, 0, ['role' => 'user', 'content' => '']]);
$vllmWarm = provider_chat_warm_payload('vllm', 'jun', $warmMsgs, 'low', false);
$eq('warm: vllm keeps max_tokens at 1', [$vllmWarm['stream'], $vllmWarm['max_tokens']], [false, 1]);

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
$eq('frames: over WATCH_MAX_FRAMES refused', $refused(['frames' => array_fill(0, WATCH_MAX_FRAMES + 1, $jpeg)], true), true);
$eq('frames: png refused', $refused(['frames' => [base64_encode("\x89PNG\r\n\x1a\n")]], true), true);
$eq('frames: over 768 px refused', $refused(['frames' => [$fakeJpeg(1024, 576)]], true), true);
$eq('watch: absent', chat_parse_watch([]), null);
$w = chat_parse_watch(['watch' => ['turn' => 'tick', 'source' => 'file', 'title' => "a\x07b", 'at' => -5]]);
$eq('watch: cleaned', [$w['title'], $w['at']], ['a b', 0]);
$eq('watch: bad turn refused', (function () {
    try { chat_parse_watch(['watch' => ['turn' => 'rewind', 'source' => 'file']]); return false; } catch (RuntimeException $e) { return true; }
})(), true);

$hc = DIFFICULTY['hardcore'];
$carry = [];
$sum = 0;
foreach (range(1, 5) as $_) { [$a, $carry] = difficulty_scale($hc, ['affection' => 1], $carry); $sum += $a['affection']; }
$eq('difficulty: five +1 at x0.2 pay out one', $sum, 1);
$eq('difficulty: losses double', difficulty_scale($hc, ['trust' => -3, 'tension' => 3], [])[0], ['trust' => -6, 'tension' => 6]);
$eq('difficulty: tension down is a gain', difficulty_scale(DIFFICULTY['hard'], ['tension' => -4], [])[0], ['tension' => -2]);
$eq('difficulty: normal is untouched', difficulty_scale(DIFFICULTY['normal'], ['affection' => 3, 'trust' => -2], [])[0], ['affection' => 3, 'trust' => -2]);
$eq('difficulty: hardcore ladder', array_map(fn($s) => difficulty_ban_minutes($hc, $s), [1, 2, 3, 4]), [240, 1440, 2880, null]);
$eq('difficulty: hard caps at a day', difficulty_ban_minutes(DIFFICULTY['hard'], 9), 1440);
$eq('difficulty: hard drops one per 14 days', difficulty_strikes(DIFFICULTY['hard'], 3, 0, 29 * 86400), 1);
$eq('difficulty: hardcore never forgets', difficulty_strikes($hc, 3, 0, 999 * 86400), 3);
$eq('difficulty: normal resets after a day', difficulty_strikes(DIFFICULTY['normal'], 4, 0, 86400), 0);

$said = ['[A:emote|happy] Physics! It explains how everything moves, even me~', 'You work at the vet clinic, right?'];
$guard = function (array $chunks) use ($said): array {
    $shown = '';
    [$emit, $stop, $hit, $flush] = stream_copy_guard(function ($o) use (&$shown) { $shown .= $o['thinking'] ?? ''; }, $said);
    foreach ($chunks as $chunk) {
        $emit(['thinking' => $chunk]);
        if ($stop() !== '') break;
    }
    $flush();
    return [$stop(), $hit()['thinking'] ?? null, $shown];
};
$eq('copy: a copied draft split over chunks stops', $guard(["intro\n- [A:nod]Physics! It ", "explains how everything moves, even me~\n- more"]),
    ['copying', "intro\n- [A:nod]Physics! It explains how everything moves, even me~\n", "intro\n- [A:nod]Physics! It explains how everything moves, even me~\n"]);
$eq('copy: new wording passes', $guard(["- [A:nod]Physics, the laws of motion are neat\nTool check: none\n"])[0], '');
$eq('copy: short drafts are never copies', $guard(["- vet clinic, right?\n"])[0], '');
$eq('copy: a half draft is held back', $guard(["ok\n- [A:nod]Physics! It"])[2], "ok\n- [A:nod]Physics! It");
$eq('copy: the old line plus a new sentence stops', $guard(["- [A:nod]Physics. It explains how everything moves, even me. Come sit down, you look tired~\n"])[0], 'copying');
$eq('copy: a short old line inside a long draft passes', copy_closest('I will remember that, you told me earlier and it matters to me a lot', ['You told me earlier~'])[0] < COPY_GUARD_SHARE, true);
$eq('copy: plain trace lines pass', $guard(["Physics! It explains how everything moves, even me~\n"])[0], '');
$eq('copy: second line drops the idea', str_starts_with(copy_guard_line(2, 'x'), 'Still the same line'), true);
$eq('copy: first line quotes it without tags', copy_guard_line(1, $said[0]),
    "Wait, I already said \"Physics! It explains how everything moves, even me~\" earlier. Not repeating myself, I will answer with new words and a new angle.\n");

foreach (['zh-TW' => 'zh-TW', 'zh-hk' => 'zh-TW', 'zh-MO' => 'zh-TW', 'zh-Hant' => 'zh-TW', 'zh-Hant-TW' => 'zh-TW',
          'zh' => 'zh', 'zh-CN' => 'zh', 'zh-Hans-TW' => 'zh', 'pl' => 'pl', 'en-GB' => 'en'] as $code => $want) {
    $eq("i18n: $code", i18n_lang($code), $want);
}
$_GET['lang'] = 'zh-Hant-HK';
$eq('i18n: traditional loads zh-TW.json', tr('ach.group.all', 'All'), json_decode(file_get_contents(__DIR__ . '/../../webapp/i18n/zh-TW.json'), true)['ach.group.all']);

exit($fails ? 1 : 0);
