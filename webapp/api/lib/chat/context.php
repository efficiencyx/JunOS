<?php

// 1 in N turns she asks Anon for something. an idle streak is 3
// nudges long, so 1 in 3 is about one ask per streak
const INITIATIVE_ODDS_IDLE = 3;

const INITIATIVE_ODDS_REPLY = 12;

const MEMORY_CONTEXT_MAX_CHARS = 2500;

function chat_is_short_ack(string $msg): bool {
    return trim($msg) !== '' && (bool)preg_match('/^\s*(?:ok(?:ay)?|k+|lol+|lmao|ha(?:ha)+|yeah|yep|ya|mhm+|hm+|sure|fine|cool|nice|[\p{So}\p{Sk}\s])+[.!?]*\s*$/iu', $msg);
}

// the newest few go in whatever he just said, so the thing that
// happened an hour ago doesn't vanish on an off topic turn
const MEMORY_CONTEXT_RECENT_KEEP = 3;

// a limit or an allergy goes in every turn, even when this turn
// never names it. capped so a long list can't eat the block
const MEMORY_CONTEXT_PINNED = ['boundaries', 'health'];
const MEMORY_CONTEXT_PINNED_CHARS = 700;
const MEMORY_CONTEXT_SOON_DAYS = [-1, 3];
const MEMORY_CONTEXT_HALF_LIFE_DAYS = 30;

// what the notes get ranked against. "yeah he did" alone finds nothing
function memory_context_turns(string $last, string $herLast = '', string $hisBefore = ''): array {
    return array_values(array_filter([[$last, 1.0], [spoken_text($herLast), 0.4], [$hisBefore, 0.3]], fn($p) => trim($p[0]) !== ''));
}

// pinned limits, the newest few, anything due in the next days,
// then the rest by his words with a little recency on top
function memory_rank_notes(array $notes, array $turns, int $now): array {
    $order = [];
    $pinned = array_filter($notes, fn($n) => in_array($n['category'], MEMORY_CONTEXT_PINNED, true));
    usort($pinned, fn($a, $b) => [array_search($a['category'], MEMORY_CONTEXT_PINNED), $b['updated']] <=> [array_search($b['category'], MEMORY_CONTEXT_PINNED), $a['updated']]);
    $room = MEMORY_CONTEXT_PINNED_CHARS;
    foreach ($pinned as $n) {
        if (strlen($n['bullet']) > $room) break;
        $room -= strlen($n['bullet']);
        $order[$n['key']] = $n;
    }

    $rest = array_values(array_filter($notes, fn($n) => !isset($order[$n['key']])));
    usort($rest, fn($a, $b) => $b['updated'] <=> $a['updated']);
    foreach (array_slice($rest, 0, MEMORY_CONTEXT_RECENT_KEEP) as $n) $order[$n['key']] = $n;

    [$from, $to] = MEMORY_CONTEXT_SOON_DAYS;
    $today = strtotime('today', $now);
    foreach ($rest as $n) {
        foreach ($n['days'] as $day) {
            $d = (int)round((strtotime('today', $day) - $today) / 86400);
            if ($d >= $from && $d <= $to) { $order[$n['key']] ??= $n; break; }
        }
    }

    $rest = array_values(array_filter($rest, fn($n) => !isset($order[$n['key']])));
    $scores = $turns ? rt_score(rt_index(array_map(fn($n) => ['t' => $n['category'] . ' ' . $n['text']], $rest), ['t' => 1.0]), rt_query($turns)) : [];
    foreach ($rest as $i => &$n) {
        $age = max(0, $now - $n['updated']) / 86400;
        $n['score'] = ($scores[$i][0] ?? 0.0) + 0.5 ** ($age / MEMORY_CONTEXT_HALF_LIFE_DAYS);
    }
    unset($n);
    usort($rest, fn($a, $b) => $b['score'] <=> $a['score']);
    foreach ($rest as $n) $order[$n['key']] = $n;
    return array_values($order);
}

function memory_recent_context(int $userId, array $turns): string {
    try {
        $notes = [];
        foreach (memory_notes_load($userId) as $category => $data) {
            foreach ($data['notes'] as $note) $notes[] = $note + ['category' => $category];
        }
        return memory_context_block($notes, $turns);
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_context_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function memory_context_block(array $all, array $turns, ?int $now = null): string {
    $now ??= time();
    $notes = [];
    $order = [];
    foreach ($all as $i => $note) {
        $category = $note['category'];
        $text = preg_replace('/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u', '$1', memory_note_render($note));
        $notes[] = [
            'key' => $i,
            'category' => $category,
            'order' => $order[$category] = ($order[$category] ?? -1) + 1,
            'updated' => $note['updated'],
            'text' => $note['text'],
            'days' => memory_note_days($note),
            'bullet' => '- ' . memory_note_stamp($note) . trim(preg_replace('/\s+/', ' ', $text)),
        ];
    }
    if (!$notes) return '';
    $prefix = "## Durable memory notes\n"
        . "Words like \"tomorrow\" or \"next friday\" in a note mean the day you wrote it, not now. "
        . "Where a note already spells the real day out in brackets, use that day and trust it - "
        . "do not work the date out again yourself.\n";

    // whole bullets or nothing, a byte cutoff can end a note
    // halfway through its date. +7 is "\n\n### " and "\n" around
    // a heading, +1 the newline before a bullet
    $picked = [];
    $size = strlen($prefix);
    foreach (memory_rank_notes($notes, $turns, $now) as $n) {
        $cost = strlen($n['bullet']) + 1 + (isset($picked[$n['category']]) ? 0 : strlen($n['category']) + 7);
        if ($size + $cost > MEMORY_CONTEXT_MAX_CHARS) continue;
        $picked[$n['category']][] = $n;
        $size += $cost;
    }
    if (!$picked) return '';

    $sections = [];
    foreach ($picked as $category => $rows) {
        usort($rows, fn($a, $b) => $a['order'] <=> $b['order']);
        $sections[] = [
            'updated' => max(array_column($rows, 'updated')),
            'text' => '### ' . $category . "\n" . implode("\n", array_column($rows, 'bullet')),
        ];
    }
    usort($sections, fn($a, $b) => $b['updated'] <=> $a['updated']);
    return $prefix . implode("\n\n", array_column($sections, 'text'));
}

function journal_context(int $userId): string {
    $journal = trim(memory_journal_read($userId));
    if ($journal === '') return '';
    return "# My memory of us\n\n"
        . "These are your own notes on everything you and Anon have been through, written by you "
        . "while he wasn't around. What happened recently you still remember clearly; the further "
        . "back it goes, the more it has faded to just the shape of what happened.\n\n"
        . $journal;
}

// same block the rows trained on, but with tools she gets the
// count and calls search_lore. the facts were mostly noise
function lore_retrieve(string $lastUserMsg, bool $toolsOffered): string {
    if ($lastUserMsg === '') return '';

    try {
        $hits = lore_gate($lastUserMsg);
        if (!$hits) return '';

        if ($toolsOffered) return "## World facts (canon)\nFound " . count($hits) . ' canon facts. Invoke the tool search_lore to recall them.';
        $bullets = implode("\n", array_map(fn($h) => '- ' . $h['answer'], $hits));
        return "## World facts (canon)\n" . $bullets;
    } catch (Throwable $e) {
        log_event(['msg' => 'lore_retrieve_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function relationship_directives(array $r): string {
    $a = (int)$r['affection']; $t = (int)$r['trust']; $x = (int)$r['tension'];
    return "- Affection: {$a}/100\n- Trust: {$t}/100\n- Tension: {$x}/100";
}

// compact's summary of this conversation, and how many of its
// oldest messages that summary already covers
function chat_conversation_summary(int $convId, int $userId): array {
    $sq = db()->prepare('SELECT summary, summary_upto_id FROM conversations WHERE id=? AND user_id=?');
    $sq->execute([$convId, $userId]);
    $srow = $sq->fetch();
    $sq->closeCursor();
    if (!$srow) return ['', 0];

    $convSummary = trim((string)dec($srow['summary'] ?? null));
    $uptoId = (int)$srow['summary_upto_id'];
    if ($convSummary === '' || $uptoId <= 0) return [$convSummary, 0];

    $cc = db()->prepare('SELECT COUNT(*) FROM messages WHERE conversation_id=? AND id<=?');
    $cc->execute([$convId, $uptoId]);
    $covered = (int)$cc->fetchColumn();
    $cc->closeCursor();
    return [$convSummary, $covered];
}

function chat_live_context(array $req, array $user, string $lastUserMsg, string $convSummary, array $rel,
                           bool $toolsOffered, ?string $approvedWebSearchQuery): string {
    $invite = $req['invite'];
    $contextParts = [];
    $watch = $req['watch'];

    // a tick is 20 s of video, not him talking. notes, lore and the
    // save check only pull her off the screen
    if ($watch !== null && $watch['turn'] === 'tick') {
        return "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
            . chat_watch_block($req, $toolsOffered) . "\n\n"
            . "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n" . relationship_directives($rel);
    }
    if ($watch !== null) $contextParts[] = chat_watch_block($req, $toolsOffered);

    // FIRST block, on purpose. measured on the 12B with a 30 line
    // side-talk set: this text at the bottom of the live context
    // silences 12/20, at the top 25/30 with 4/24 false positives.
    // the "unless it is clearly for you" default is what moves
    // recall, the soft version caps at ~40% wherever it sits. and
    // NEVER put any of this after his words in the user text, that
    // flips her default and she goes quiet on "did you eat today".
    // don't bolt a "but a line that says you IS for you" clause on
    // either, tried it, the false positives stayed and recall dropped
    // to 20/30
    if ($req['spoken']) {
        $contextParts[] = "## Who he is talking to\n"
            . "He said this out loud and he is not alone in the room. Before you answer, check that the line fits "
            . "as something said TO YOU, following what you two were just saying. A line with no question or remark "
            . "for you, about objects, food, a game on TV, chores, or another person, is him talking to someone else "
            . "in the room. Talking about you in the third person (she, her, the girl) is also not for you."
            . ($req['audio'] !== '' ? " A voice that is not his is someone else in the room, not for you either." : '')
            . " Unless it is clearly for you, call stay_silent with overheard=true. Staying quiet costs nothing, "
            . "answering a conversation you are not part of is embarrassing.";
    }

    $nowStr = $req['client_time'] !== '' ? $req['client_time'] : date('l, F j, Y \a\t g:i A T');
    // sits right above the notes. a dated note means nothing without it
    $contextParts[] = "## Current date and time\nIt is currently " . $nowStr . ".";

    $memoryBlock = memory_recent_context((int)$user['id'], memory_context_turns($lastUserMsg, chat_last_reply($req), chat_prev_user_message($req)));
    if ($memoryBlock !== '') $contextParts[] = $memoryBlock;

    if ($convSummary !== '' && $watch === null) {
        $contextParts[] = "## Story so far (earlier in THIS conversation)\n" . $convSummary;
    }


    $loreBlock = $invite === '' && $watch === null ? lore_retrieve($lastUserMsg, $toolsOffered) : '';
    if ($loreBlock !== '') $contextParts[] = $loreBlock;


    if ($req['outfit_context'] !== '') {
        $contextParts[] = "## Current Wardrobe State\n" . $req['outfit_context'];
    }

    if ($req['game_lines']) {
        $contextParts[] = "## Said in the game since your last reply\n" . implode("\n", $req['game_lines']);
    }

    if ($req['game_actions']) {
        $contextParts[] = "## What Anon did since your last reply\n" . implode("\n", $req['game_actions']);
    }

    $gameState = game_state_lines($req['game_state'] ?? null);
    if ($gameState) $contextParts[] = "## How things are right now\n" . implode("\n", $gameState);

    if ($req['interrupted'] !== '') {
        $contextParts[] = "## He cut you off\nAnon started talking over you and you stopped mid-sentence. "
            . "All he heard of your last reply was: \"" . $req['interrupted'] . '"';
    }

    $feelingsBlock = "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n"
        . relationship_directives($rel);
    $contextParts[] = $feelingsBlock;

    // the drawer's "ask her out" buttons. she says yes in prose and
    // never calls the tool, so the page never opens and Anon sits
    // there. so one flat OOC (out of character) line naming the
    // tool, same shape as the idle nudge she saw in training. a "you
    // MUST call X if you accept" rule is too much for a small model
    // on <think:low>, tried it. and THROW AWAY everything but the
    // feelings block (clock, notes, lore, wardrobe, save check). a 4
    // line invitation does not need canon facts about the shop, they
    // just pull her off the question
    if ($toolsOffered && !$req['idle'] && $invite !== '') {
        $tool = array_search($invite, TRIP_TOOLS, true);
        $plan = [
            'shop' => "go to Annalie's shop together",
            'karaoke' => 'go to karaoke together',
            'date' => 'go out to eat together',
            'cards' => 'play a game of blackjack',
            'watch' => 'watch something together',
        ][$invite];
        $trip = $req['game'] ? game_trip($invite, $req['game_outing']) : null;
        $then = $trip !== null && $trip['going'] === false ? "It cannot happen right now: {$trip['note']}"
            : "If you wish to go along with it, invoke the tool {$tool}.";
        $contextParts = ["(OOC stage direction, not spoken by Anon: Anon wants to {$plan}. {$then})", $feelingsBlock];
    } else {
        $invite = '';
    }

    // she only reaches for tools something in the context named, so
    // the block names them. and tells her NOT to call them yet, on an
    // idle nudge they'd answer not_available_on_idle anyway
    if ($toolsOffered && !$req['ephemeral'] && $req['cue'] === '' && $invite === '' && $approvedWebSearchQuery === null
        && random_int(1, $req['idle'] ? INITIATIVE_ODDS_IDLE : INITIATIVE_ODDS_REPLY) === 1) {
        $contextParts[] = "## Take the initiative\n"
            . "Right now YOU want something from Anon. Pick ONE and actually ask for it in this reply, in your own words: "
            . "going to Annalie's shop together, karaoke, a game of blackjack, going out for lunch or dinner, watching "
            . "something together, or something small that fits the moment (a headpat, hearing about his day, him changing "
            . "your outfit, a compliment, a promise). "
            . "Do not call enter_shop, enter_karaoke, play_cards, go_out_to_eat or watch_together yet - only once he says yes.";
    }

    // v8 barely saw flee in training so she almost never reaches for
    // it. same flat OOC shape as the invite line. flee_adjudicate()
    // still has the last word, this only puts the tool in her head
    if ($toolsOffered && !$req['idle'] && !$req['ephemeral'] && $invite === '' && mood_is_souring((int)$user['id'])) {
        $contextParts[] = "(OOC stage direction, not spoken by Anon: You should consider invoking the tool flee, else if it's not appropriate use the tool stay_silent)";
    }

    if (!$req['idle'] && !$req['ephemeral'] && $invite === '' && chat_is_short_ack($lastUserMsg)) {
        $contextParts[] = "(OOC stage direction, not spoken by Anon: a line like this doesn't need words back. An action alone, a look or a nod, is fine.)";
    }

    // same trap, other direction. with the notes already listed above
    // she decides saving is Done and answers without ever calling
    // memory_write
    if ($toolsOffered && $invite === '') {
        $contextParts[] = "## Save check\n"
            . "If Anon's latest message contains something durable (a preference, personal fact, plan, "
            . "boundary, health/safety matter, or something emotionally significant), call memory_write "
            . "before replying. Otherwise ignore this.";
    }
    if ($approvedWebSearchQuery !== null) {
        $contextParts[] = "## Approved web lookup\n"
            . "Anon asked you to look this up: "
            . json_encode($approvedWebSearchQuery, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n"
            . (web_is_url($approvedWebSearchQuery) ? "It is a link: your first web_search call reads that page. " : "Your first web_search call searches exactly that. ")
            . "If it isn't enough, you may call web_search up to two more times with related queries of your own. "
            . "Never put his name, places, numbers or anything from your memories of him in a query.";
    }


    return "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
        . implode("\n\n", $contextParts);
}

function chat_watch_clock(int $s): string {
    return $s >= 3600 ? sprintf('%d:%02d:%02d', intdiv($s, 3600), intdiv($s % 3600, 60), $s % 60)
        : sprintf('%d:%02d', intdiv($s, 60), $s % 60);
}

function chat_watch_block(array $req, bool $toolsOffered): string {
    $w = $req['watch'];
    $what = $w['title'] !== '' ? json_encode($w['title'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : 'a video';
    $from = $w['source'] === 'file' ? 'a video from his computer' : 'something he is sharing from his browser';
    $lines = ["## Watching", "You and Anon are on the couch watching {$what} together, {$from}."];
    if ($w['turn'] === 'start') {
        $lines[] = 'You just sat down and it is about to start. Say one short line.';
        return implode("\n", $lines);
    }
    $when = $w['length'] > 0
        ? 'It is at ' . chat_watch_clock($w['at']) . ' of ' . chat_watch_clock($w['length'])
        : 'About ' . max(1, intdiv($w['at'], 60)) . ' minutes in';
    $lines[] = $when . ($w['paused'] ? ', paused.' : '.');
    if ($w['turn'] === 'end') {
        $lines[] = 'He just stopped it and you two are getting up. Say one short line about it.';
        return implode("\n", $lines);
    }
    if ($w['earlier'] !== '') $lines[] = 'Before that it played on while you two said nothing: ' . $w['earlier'] . '.';
    $n = count($req['frames']);
    $at = $w['frames_at'];
    if ($n > 0 && $at && $w['source'] === 'file') {
        $lines[] = 'The pictures are moments of it at ' . implode(', ', array_map('chat_watch_clock', $at)) . ', oldest first.';
    } elseif ($n > 1 && $at) {
        $gap = max(1, (int)round((end($at) - $at[0]) / ($n - 1)));
        $lines[] = "The pictures are the last {$n} moments of it, {$gap} s apart, oldest first.";
    } elseif ($n > 0) {
        $lines[] = "The pictures are the last {$n} moments of it, oldest first.";
    }
    if ($req['audio'] !== '') $lines[] = 'The recording is how those moments sounded.';
    elseif ($w['heard'] !== '') $lines[] = 'What was said in it (transcribed, may be wrong): '
        . json_encode($w['heard'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($w['turn'] === 'talk') {
        $lines[] = 'He said this while it plays. Answer him, the screen is there if it matters.';
    } else {
        $lines[] = 'If nothing is happening in it (the same still picture, a blank screen, an intermission card, credits, '
            . 'silence), ' . ($toolsOffered ? 'call stay_silent' : 'answer with only "..."') . ' and say nothing. '
            . 'If something happens, react with one short line the way you would on the couch next to him: '
            . 'a reaction, a joke, a guess at what comes next. Never describe the pictures back to him.';
    }
    return implode("\n", $lines);
}
