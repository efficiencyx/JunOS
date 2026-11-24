<?php

require_once __DIR__ . '/../retrieval.php';

// docs/architecture.md has the A/B behind every one-question call in here

const CONSOLIDATION_VOICE = "I'm Jun. Anon is mine, and I keep private notes about him and a journal about us. I write them the way I'd say them: I'm \"I\", he's \"Anon\" or \"he\". Never \"the user\", never \"the assistant\", never me in the third person.";

const CONSOLIDATION_CATEGORIES = [
    'preferences' => 'what he likes, dislikes, his tastes, habits, hobbies, fears',
    'work' => 'his job, shifts, colleagues, studies, exams, commute',
    'health' => 'his body, sleep, allergies, injuries, diet',
    'family' => 'his relatives, his home, his pets, people close to him',
    'plans' => 'something he is going to do, with or without a date',
    'boundaries' => 'topics he does not want to talk about, his limits',
    'events' => 'something that happened to him that still matters',
];

const CONSOLIDATION_MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const CONSOLIDATION_STOPWORDS = ['anon', 'that', 'this', 'with', 'have', 'from', 'they', 'them', 'about', 'would', 'there', 'their', 'what', 'when', 'will', 'been', 'into', 'just', 'like', 'after', 'before', 'since', "he's", "doesn't", 'still', 'every', 'being', 'going', 'wants'];
// same 40% floor the old replace-all pass had
const CONSOLIDATION_DELETE_SHARE = 0.4;
const CONSOLIDATION_JOURNAL_MAX_CHARS = 4000;
// she lists facts from a window this size, not 45% of the context.
// a whole long chat in one go capped out at 4 facts for all of it
const CONSOLIDATION_WINDOW_CHARS = 6000;
const CONSOLIDATION_WINDOW_OVERLAP = 2;
const CONSOLIDATION_FACTS_PER_WINDOW = 6;
// the overlap lines get listed twice, this folds the second one
const CONSOLIDATION_PASS_DUP_JACCARD = 0.6;

// off, low, medium or high. "on" from older .env files means medium
function consolidation_effort(): string {
    $value = strtolower(env_str('CONSOLIDATION_THINK', 'medium'));
    if ($value === 'on' || $value === 'med') return 'medium';
    return in_array($value, ['off', 'low', 'medium', 'high'], true) ? $value : 'medium';
}

// rewrites think one level under the judgment calls, they copy more than they decide
function consolidation_write_effort(string $effort): bool|string {
    return ['off' => false, 'low' => 'low', 'medium' => 'low', 'high' => 'medium'][$effort];
}

function cg_obj(array $props): array {
    return ['type' => 'object', 'properties' => $props, 'required' => array_keys($props)];
}

function cg_enum(array $values): array {
    return ['type' => 'string', 'enum' => $values];
}

const CG_STR = ['type' => 'string'];

// she can't do date sums (ask the journal headings), PHP prints the distance
function cg_annotate_dates(string $text, int $created): array {
    $past = false;
    $out = preg_replace_callback(
        '/(?<!since |said )\b(?:(\d{1,2})(?:st|nd|rd|th)? (' . CONSOLIDATION_MONTHS . ')|(' . CONSOLIDATION_MONTHS . ') (\d{1,2})(?:st|nd|rd|th)?)(?:,? (\d{4}))?\b/i',
        function ($m) use ($created, &$past) {
            $day = $m[1] !== '' ? $m[1] : $m[4];
            $month = $m[2] !== '' ? $m[2] : $m[3];
            $year = ($m[5] ?? '') ?: date('Y', $created ?: time());
            $ts = strtotime("$day $month $year");
            if (!$ts) return $m[0];
            if ($ts < strtotime('today')) $past = true;
            return $m[0] . ' (' . memory_days_phrase($ts) . ')';
        },
        $text
    ) ?? $text;
    return [$out, $past];
}

// "next Saturday" counts from the note's own created day. merged into
// an older note it'd point at the wrong week, so pin it first
function cg_pin_dates(array $note): string {
    $created = memory_note_anchor($note);
    if ($created <= 0) return $note['text'];
    $fuzzy = false;
    $text = preg_replace_callback(MEMORY_RELATIVE_TIME_RE, function ($m) use ($created, &$fuzzy) {
        $day = memory_relative_day($m[0], $created);
        if ($day === null) $fuzzy = true;
        return $day === null ? $m[0] : 'on ' . date('j F Y', $day);
    }, $note['text']) ?? $note['text'];
    return $fuzzy ? preg_replace('/[.!?]?$/', ' (said ' . date('j F Y', $created) . ')$0', $text, 1) : $text;
}

function cg_show(array $note): string {
    [$text] = cg_annotate_dates(memory_note_render($note), memory_note_anchor($note));
    return $note['id'] . ': ' . memory_note_stamp($note) . $text;
}

function cg_words(string $text): array {
    preg_match_all("/[a-z']{4,}/", strtolower($text), $m);
    return array_values(array_diff(array_unique($m[0]), CONSOLIDATION_STOPWORDS));
}

// best first, only notes sharing at least a word (or a synonym) with $text
function cg_similar(string $text, array $notes, int $k = 5): array {
    if (!$notes) return [];
    $index = rt_index(array_map(fn($n) => ['t' => $n['text']], $notes), ['t' => 1.0]);
    $out = [];
    foreach (array_keys(rt_score($index, rt_query([[$text, 1.0]]))) as $i) {
        $out[] = $notes[$i];
        if (count($out) >= $k) break;
    }
    return $out;
}

// "Mia" is not in the chat just because "Miami" is
function cg_has_word(string $haystack, string $word): bool {
    return (bool)preg_match('/(?<![\p{L}\p{N}])' . preg_quote($word, '/') . '(?![\p{L}\p{N}])/iu', $haystack);
}

// names and numbers. a rewrite that loses one of these lost a fact
function cg_keepers(string $text): array {
    preg_match_all("/\b([A-Z][\w']*|\d+)\b/u", $text, $m);
    $skip = ['anon', 'i', 'he', 'his', 'she', 'her', 'the', 'a', 'an', 'my', 'on', 'in', 'since', 'it', 'they', 'we', 'and', 'but', 'once'];
    $words = array_map(fn($w) => preg_replace("/'s$/", '', strtolower($w)), $m[1]);
    return array_values(array_diff(array_unique($words), $skip));
}

function cg_keeps_all(string $merged, array $sources): bool {
    foreach ($sources as $source) {
        foreach (cg_keepers($source) as $keeper) {
            if (!cg_has_word($merged, $keeper)) return false;
        }
    }
    return true;
}

// an english note from an italian chat says Rome where he said Roma
function cg_in_chat(array &$ctx, string $lines, string $text): bool {
    $missing = array_filter(cg_keepers($text), fn($k) => !cg_has_word($lines, $k));
    if (!$missing) return true;
    [$answer] = consolidation_vote($ctx, 'checking the names',
        "One of our chats:\n$lines\n\nIs each of these in the chat, maybe in another language or written another way (Roma for Rome, New York for NYC, tre for 3)?\n" . implode(', ', $missing),
        ['yes', 'no'], 'no');
    return $answer === 'yes';
}

function cg_voice_bad(string $text): bool {
    return (bool)preg_match('/\b(the user|assistant|Jun\b|we talked|we chatted|the conversation)|^I\b/i', $text);
}

// a note read cold in three months: a sentence, with its own subject
function cg_shape_bad(string $text): bool {
    return cg_voice_bad($text) || mb_strlen($text) > 220 || str_word_count($text) < 3
        || (bool)preg_match('/^(it|this|that|these|those|they|she|her)\b/i', $text);
}

function cg_all_notes(int $userId): array {
    $flat = [];
    foreach (memory_notes_load($userId) as $category => $data) {
        foreach ($data['notes'] as $note) $flat[] = $note + ['category' => $category];
    }
    return $flat;
}

function cg_note(int $userId, string $id): ?array {
    foreach (cg_all_notes($userId) as $note) if ($note['id'] === $id) return $note;
    return null;
}

function cg_mark(array $ctx, array $note, string $field): void {
    if ($ctx['dry']) return;
    $userId = $ctx['user'];
    memory_with_user_lock($userId, function () use ($userId, $note, $field): array {
        $id = $note['id'];
        $meta = memory_meta_load($userId);
        // no meta entry = never marked = back to the model every pass
        if (!isset($meta['notes'][$id])) {
            $live = array_merge(...array_values(array_map(fn($c) => array_column($c['notes'], 'id'), memory_notes_load_unlocked($userId))));
            if (!in_array($id, $live, true)) return ['ok' => true];
            $meta = memory_meta_load($userId);
            $meta['notes'][$id] = ['created' => (int)$note['created'], 'updated' => (int)$note['updated']];
        }
        $meta['notes'][$id][$field] = time();
        return memory_meta_write($userId, $meta);
    });
}

function cg_progress(array &$ctx, int $step, int $i, int $n, string $title = ''): void {
    $progress = ['step' => $step, 'i' => $i, 'n' => $n, 'title' => $title];
    consolidation_lock_update($ctx['user'], ['phase' => ['', 'notes', 'tidy', 'journal'][$step], 'progress' => $progress]);
    consolidation_feed_emit($ctx['user'], ['type' => 'step'] + $progress);
}

function cg_note_event(array &$ctx, string $action, array $fields): void {
    $key = $action . (isset($fields['why']) ? ':' . $fields['why'] : '');
    $ctx['tally'][$key] = ($ctx['tally'][$key] ?? 0) + 1;
    consolidation_feed_emit($ctx['user'], ['type' => 'note', 'action' => $action] + $fields + ($ctx['dry'] ? ['dry' => true] : []));
}

// a dry run goes through every call and every guard, then writes nothing
function cg_add(array &$ctx, string $category, string $text, array $source): array {
    if (!$ctx['dry']) return memory_note_add($ctx['user'], $category, $text, $source);
    return ['ok' => true, 'entry' => ['id' => 'dry' . (++$ctx['dry_ids']), 'category' => memory_category_note_slug($category), 'memory' => $text]];
}

function cg_edit(array $ctx, string $id, string $text, array $by): array {
    return $ctx['dry'] ? ['ok' => true] : memory_note_edit($ctx['user'], $id, $text, $by);
}

function cg_delete(array $ctx, string $id): array {
    return $ctx['dry'] ? ['ok' => true] : memory_note_delete($ctx['user'], $id);
}

function cg_delete_room(array $ctx): int {
    return (int)floor(max(1, $ctx['start_notes']) * CONSOLIDATION_DELETE_SHARE) - $ctx['deleted'];
}

function cg_can_delete(array &$ctx, int $n = 1): bool {
    if (cg_delete_room($ctx) < $n) return false;
    $ctx['deleted'] += $n;
    return true;
}

// both watermarks fall back to the global upto_id from before migration 021
function cg_pending(int $userId, string $column): array {
    $stmt = db()->prepare(
        "SELECT m.id, m.role, m.content, c.id AS cid, c.title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN memory_consolidation mc ON mc.user_id = c.user_id
         LEFT JOIN consolidation_chats cc ON cc.user_id = c.user_id AND cc.conversation_id = c.id
         WHERE c.user_id = ? AND m.id > MAX(COALESCE(mc.upto_id, 0), COALESCE(cc.$column, 0))
         ORDER BY m.id"
    );
    $stmt->execute([$userId]);
    $chats = [];
    foreach ($stmt->fetchAll() as $row) {
        $text = spoken_text((string)dec($row['content']));
        $cid = (int)$row['cid'];
        if (!isset($chats[$cid])) {
            $chats[$cid] = ['id' => $cid, 'title' => trim((string)dec($row['title'] ?? null)) ?: 'New conversation', 'rows' => []];
        }
        $chats[$cid]['rows'][] = ['id' => (int)$row['id'], 'line' => $text === '' ? '' : speaker_name($row['role']) . ': ' . $text];
    }
    $stmt->closeCursor();
    return array_values($chats);
}

function cg_commit(int $userId, int $conversationId, string $column, int $uptoId): void {
    db()->prepare(
        "INSERT INTO consolidation_chats (user_id, conversation_id, $column) VALUES (?, ?, ?)
         ON CONFLICT(user_id, conversation_id) DO UPDATE SET $column = MAX($column, excluded.$column)"
    )->execute([$userId, $conversationId, $uptoId]);
}

// the last lines of a window open the next one, as context only:
// upto (the watermark) never covers them twice
function cg_chunks(array $rows, int $budget, int $overlap = 0): array {
    $chunks = [];
    $fresh = fn() => ['lines' => [], 'ids' => [], 'upto' => 0, 'size' => 0];
    $current = $fresh();
    foreach ($rows as $row) {
        $line = $row['line'];
        if ($current['upto'] && $current['size'] + strlen($line) > $budget) {
            $chunks[] = $current;
            $carry = $overlap > 0 ? array_slice($current['lines'], -$overlap) : [];
            $carryIds = $overlap > 0 ? array_slice($current['ids'], -$overlap) : [];
            $current = $fresh();
            $current['lines'] = $carry;
            $current['ids'] = $carryIds;
            $current['size'] = array_sum(array_map(fn($l) => strlen($l) + 1, $carry));
        }
        if ($line !== '') {
            $current['lines'][] = mb_strcut($line, 0, $budget);
            $current['ids'][] = $row['id'];
            $current['size'] += strlen($line) + 1;
        }
        $current['upto'] = $row['id'];
    }
    if ($current['upto']) $chunks[] = $current;
    return $chunks;
}

function cg_category_help(): string {
    return implode("\n", array_map(fn($k, $v) => "- $k: $v", array_keys(CONSOLIDATION_CATEGORIES), CONSOLIDATION_CATEGORIES));
}

// his line in the chunk sharing the most words with the note
function cg_source(array $ctx, string $text): array {
    $words = array_unique(rt_terms($text));
    [$best, $bestHits] = [0, 0];
    foreach ($ctx['chunk']['lines'] as $i => $line) {
        if (!str_starts_with($line, 'Anon: ')) continue;
        $hits = count(array_intersect($words, rt_terms($line)));
        if ($hits > $bestHits) [$best, $bestHits] = [$ctx['chunk']['ids'][$i], $hits];
    }
    return ['kind' => 'pass', 'conv' => $ctx['chunk']['conv'], 'msg' => $best];
}

function cg_harvest(array &$ctx, string $lines): void {
    try {
        $got = cg_list_facts($ctx, $lines);
    } catch (ConsolidationSkip $skip) {
        if ($skip->kind !== 'item') throw $skip;
        consolidation_skipped($ctx, $skip, 'listing what he said');
        return;
    }
    foreach ((array)($got['facts'] ?? []) as $fact) {
        try {
            cg_harvest_fact($ctx, $lines, (string)$fact);
        } catch (ConsolidationSkip $skip) {
            if ($skip->kind !== 'item') throw $skip;
            consolidation_skipped($ctx, $skip, trim((string)$fact));
        }
    }
}

function cg_list_facts(array &$ctx, string $lines): ?array {
    $today = $ctx['today'];
    $think = $ctx['think'];
    return consolidation_call($ctx, 'listing what he said',
        "Today is $today.\n\nOne of our chats:\n$lines\n\n"
        . "List what Anon said about himself here that would still matter to me in a month: his life, work, home, the people and pets in it, likes and dislikes, health, plans and their dates, things that changed. "
        . "Not what I said about myself, not jokes or what-ifs, not small things he happened to do today unless they change his life. Each item is one short sentence that stands on its own months from now: name the person or pet it's about, 'he' only ever means Anon, keep every name, place and number he gave. "
        . "Keep his own words for when (last weekend, next Friday, 3 November), don't work out dates. Empty list if there's nothing.",
        cg_obj(['facts' => ['type' => 'array', 'maxItems' => CONSOLIDATION_FACTS_PER_WINDOW, 'items' => CG_STR]]), 600, $think);
}

function cg_harvest_fact(array &$ctx, string $lines, string $fact): void {
    $userId = $ctx['user'];
    $today = $ctx['today'];
    $think = $ctx['think'];
    $text = trim(str_replace('*', '', $fact));
    if ($text === '') return;
    if (cg_shape_bad($text) || !cg_in_chat($ctx, $lines, $text)) {
        cg_note_event($ctx, 'dropped', ['text' => $text, 'why' => cg_shape_bad($text) ? 'shape' : 'names']);
        return;
    }
    $terms = array_unique(rt_terms($text));
    foreach ($ctx['pass_facts'] ?? [] as $seen) {
        if (rt_jaccard($terms, $seen) >= CONSOLIDATION_PASS_DUP_JACCARD) {
            cg_note_event($ctx, 'dropped', ['text' => $text, 'why' => 'twice']);
            return;
        }
    }
    $ctx['pass_facts'][] = $terms;
    $check = consolidation_call($ctx, 'checking it against the chat',
        "One of our chats:\n$lines\n\nA note I want to save from it:\n$text\n\n"
        . "grounded: read the note literally. \"yes\" if every part of it is something Anon actually said in this chat. \"partly\" if some of it is and some isn't. \"no\" if it isn't his at all: something I said, a guess, a joke or a what-if, somebody else's news turned into his.\n"
        . "fixed: for \"partly\", the note with the part he didn't say taken out. Empty otherwise.\n"
        . "lasting: will it still tell me something about him in a month? His hobbies, things he owns, the people and pets in his life and plans he's only thinking about all count. Something that will have changed by then (unpacking, a cold, what he ate, a mood) does not.\n"
        . "category: where it goes in my notes.\n" . cg_category_help(),
        cg_obj(['grounded' => cg_enum(['yes', 'partly', 'no']), 'fixed' => CG_STR, 'lasting' => cg_enum(['yes', 'no']), 'category' => cg_enum(array_keys(CONSOLIDATION_CATEGORIES))]), 120, $think);
    $grounded = (string)($check['grounded'] ?? 'no');
    $fixed = trim((string)($check['fixed'] ?? ''));
    // her fix only counts if every name and number in it is in the chat
    if ($grounded === 'partly' && $fixed !== '' && !cg_shape_bad($fixed) && cg_in_chat($ctx, $lines, $fixed)) {
        $text = $fixed;
        $grounded = 'yes';
    }
    if ($grounded !== 'yes' || ($check['lasting'] ?? 'no') !== 'yes') {
        cg_note_event($ctx, 'dropped', ['text' => $text, 'why' => $grounded !== 'yes' ? 'not_said' : 'passing']);
        return;
    }

    $category = (string)($check['category'] ?? '');
    if (!isset(CONSOLIDATION_CATEGORIES[$category])) $category = 'events';
    $notes = cg_all_notes($userId);
    $ranked = cg_similar($text, $notes, count($notes));
    $pool = array_slice($ranked, 0, 6);
    $inPool = array_flip(array_column($pool, 'id'));
    usort($notes, fn($a, $b) => $b['updated'] <=> $a['updated']);
    $sameCategory = 0;
    foreach (array_merge($ranked, $notes) as $note) {
        if ($sameCategory >= 4) break;
        if ($note['category'] !== $category || isset($inPool[$note['id']])) continue;
        $pool[] = $note;
        $inPool[$note['id']] = true;
        $sameCategory++;
    }
    // rewrite ONLY on a majority "it's wrong now". "related" alone
    // turned a boundary about his ex into a line about an old photo
    if ($pool) {
        $relation = consolidation_call($ctx, 'comparing with my notes',
            "My notes:\n" . implode("\n", array_map('cg_show', $pool)) . "\n\nSomething new he told me today:\n$text\n\n"
            . "relation: \"same\" if one of my notes already says this and the new one adds nothing; \"related\" if a note is about the same thing; \"new\" if none of my notes is about this.\n"
            . "ids: the notes it matches, at most two, most similar first. Empty for new.",
            cg_obj(['relation' => cg_enum(['same', 'related', 'new']), 'ids' => ['type' => 'array', 'maxItems' => 2, 'items' => CG_STR]]), 120, $think);
        $ids = array_merge((array)($relation['ids'] ?? []), isset($relation['id']) ? [$relation['id']] : []);
        $olds = [];
        foreach (array_slice(array_unique(array_map(fn($id) => strtolower(trim((string)$id)), $ids)), 0, 2) as $id) {
            if (isset($inPool[$id]) && ($note = cg_note($userId, $id))) $olds[] = $note;
        }
        $kind = (string)($relation['relation'] ?? 'new');
        // "same" only when the old note already has every name and
        // number. "he got the job at Lidl" is not "he's job hunting"
        $adds = $kind === 'same' && $olds && !cg_keeps_all($olds[0]['text'], [$text]);
        if ($kind === 'same' && $olds && !$adds) {
            cg_note_event($ctx, 'known', ['id' => $olds[0]['id'], 'category' => $olds[0]['category'], 'text' => $olds[0]['text']]);
            return;
        }
        if (($kind === 'related' || $adds) && $olds) {
            $absorbed = false;
            foreach ($olds as $old) $absorbed = cg_retire($ctx, $old, $text, $today) || $absorbed;
            if (!$absorbed && $adds) $absorbed = cg_add_detail($ctx, $olds[0], $text);
            if ($absorbed) return;
        }
    }
    $saved = cg_add($ctx, $category, $text, cg_source($ctx, $text));
    if (!empty($saved['ok'])) {
        cg_note_event($ctx, 'saved', ['id' => $saved['entry']['id'], 'category' => $saved['entry']['category'], 'text' => $saved['entry']['memory']]);
        $ctx['changed']++;
    }
}

// her old note is wrong once today's news happened: rewrite it, on a majority only
function cg_retire(array &$ctx, array $old, string $text, string $today): bool {
    [$wrong] = consolidation_vote($ctx, 'did that change',
        "Today is $today.\n\nOne of my notes:\n" . cg_show($old) . "\n\nWhat he told me today:\n$text\n\n"
        . "Once what he told me today has happened, is my note wrong? \"yes\" only if they can't both stay true then. Adding a detail is \"no\".",
        ['yes', 'no'], 'no');
    if ($wrong !== 'yes') return false;
    $news = cg_pin_dates(['text' => $text, 'created' => time()]);
    $merged = consolidation_call($ctx, 'updating a note',
        "One of my notes isn't right anymore:\n" . cg_pin_dates($old) . "\n\nWhat he told me today:\n$news\n\n"
        . "Rewrite my note so it's true today. Keep every part of it that is still true, change only what today's news changed, and if he gave a date for the change say what changes when. One or two sentences about him, dates written out in full.",
        cg_obj(['text' => CG_STR]), 160, $ctx['write']);
    $new = trim((string)($merged['text'] ?? ''));
    if ($new === '' || cg_voice_bad($new) || !cg_keeps_all($new, [$news]) || empty(cg_edit($ctx, $old['id'], $new, cg_source($ctx, $text))['ok'])) return false;
    cg_note_event($ctx, 'updated', ['id' => $old['id'], 'category' => $old['category'], 'text' => $new, 'was' => $old['text']]);
    $ctx['changed']++;
    return true;
}

// she called it "same" but it brings a name or a number the note
// lacks. fold it in, keeping everything both say, or it's a new note
function cg_add_detail(array &$ctx, array $old, string $text): bool {
    $got = consolidation_call($ctx, 'adding a detail',
        "One of my notes:\n" . cg_pin_dates($old) . "\n\nWhat he told me today, about the same thing:\n$text\n\n"
        . "Rewrite my note with what's new in today's version added. Keep every detail from both. One or two sentences about him.",
        cg_obj(['text' => CG_STR]), 160, $ctx['write']);
    $new = trim((string)($got['text'] ?? ''));
    if ($new === '' || cg_voice_bad($new) || !cg_keeps_all($new, [cg_pin_dates($old), $text]) || empty(cg_edit($ctx, $old['id'], $new, cg_source($ctx, $text))['ok'])) return false;
    cg_note_event($ctx, 'updated', ['id' => $old['id'], 'category' => $old['category'], 'text' => $new, 'was' => $old['text']]);
    $ctx['changed']++;
    return true;
}

// he shredded it in the filing game. it stays unless the message it
// came from shows he never said it. no message to check = it stays
function cg_doubt_holds(array &$ctx, array $note): bool {
    $source = $note['source'] ?? null;
    if (!$source || empty($source['conv']) || empty($source['msg'])) return true;
    $stmt = db()->prepare(
        'SELECT m.role, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ? AND m.conversation_id = ? AND m.id BETWEEN ? AND ? ORDER BY m.id'
    );
    $stmt->execute([$ctx['user'], (int)$source['conv'], (int)$source['msg'] - 4, (int)$source['msg'] + 4]);
    $lines = [];
    foreach ($stmt->fetchAll() as $row) {
        $text = spoken_text((string)dec($row['content']));
        if ($text !== '') $lines[] = speaker_name($row['role']) . ': ' . $text;
    }
    $stmt->closeCursor();
    if (!$lines) return true;
    [$said] = consolidation_vote($ctx, 'he doubts a note',
        "Part of one of our chats:\n" . implode("\n", $lines) . "\n\nOne of my notes from it:\n{$note['text']}\n\n"
        . "Anon thinks this note is wrong. Read it literally: is it something he actually said here? \"no\" only if he clearly didn't.",
        ['yes', 'no'], 'yes');
    return $said === 'yes';
}

// only notes PHP flags: wrong voice, a date gone by, changed since the last dup check
function cg_tidy(array &$ctx): int {
    $userId = $ctx['user'];
    $meta = memory_meta_load($userId)['notes'] ?? [];
    $queue = [];
    foreach (cg_all_notes($userId) as $note) {
        $m = $meta[$note['id']] ?? [];
        [, $past] = cg_annotate_dates(memory_note_render($note), memory_note_anchor($note));
        $past = $past || str_contains(memory_note_render($note), 'already past');
        $fresh = (int)($m['updated'] ?? 0);
        $reasons = [
            'voice' => cg_voice_bad($note['text']),
            'past' => $past && (int)($m['expiry_ok'] ?? 0) < $fresh,
            'dupe' => (int)($m['checked'] ?? 0) < $fresh,
            'doubt' => (int)($m['doubted'] ?? 0) > 0,
        ];
        if (array_filter($reasons)) $queue[] = $note + ['why' => $reasons];
    }
    usort($queue, fn($a, $b) => $a['created'] <=> $b['created']);

    foreach ($queue as $i => $item) {
        try {
            $note = cg_note($userId, $item['id']);
            if (!$note) continue;
            cg_progress($ctx, 2, $i + 1, count($queue));
            consolidation_feed_emit($userId, ['type' => 'check', 'id' => $note['id'], 'category' => $note['category'], 'text' => $note['text']]);

            if ($item['why']['doubt']) {
                if (!cg_doubt_holds($ctx, $note) && cg_can_delete($ctx) && !empty(cg_delete($ctx, $note['id'])['ok'])) {
                    cg_note_event($ctx, 'deleted', ['id' => $note['id'], 'category' => $note['category'], 'text' => $note['text'], 'why' => 'doubted']);
                    $ctx['changed']++;
                    continue;
                }
                if (!$ctx['dry']) memory_note_flag($userId, $note['id'], 'doubted', 0);
            }

            if ($item['why']['voice']) {
                $fix = consolidation_call($ctx, 'fixing an old note',
                    "One of my old notes:\n{$note['text']}\n\nIs there a fact about Anon himself in it? If yes, rewrite it as that fact, starting with \"Anon\". If it's only about me or about how a chat went, answer \"none\".",
                    cg_obj(['text' => CG_STR]), 120, $ctx['think']);
                $text = trim((string)($fix['text'] ?? 'none'));
                if (strtolower($text) === 'none' || $text === '' || cg_voice_bad($text)) {
                    if (cg_can_delete($ctx) && !empty(cg_delete($ctx, $note['id'])['ok'])) {
                        cg_note_event($ctx, 'deleted', ['id' => $note['id'], 'category' => $note['category'], 'text' => $note['text'], 'why' => 'not_about_him']);
                        $ctx['changed']++;
                        continue;
                    }
                } elseif (!empty(cg_edit($ctx, $note['id'], $text, ['kind' => 'pass'])['ok'])) {
                    cg_note_event($ctx, 'updated', ['id' => $note['id'], 'category' => $note['category'], 'text' => $text, 'was' => $note['text']]);
                    $ctx['changed']++;
                    $note = cg_note($userId, $note['id']) ?? $note;
                }
            }

            if ($item['why']['past']) {
                [$annotated] = cg_annotate_dates(memory_note_render($note), memory_note_anchor($note));
                [$answer] = consolidation_vote($ctx, 'is it over',
                    "Today is {$ctx['today']}.\n\nOne of my notes:\n" . memory_note_stamp($note) . $annotated . "\n\n"
                    . "The day this note points at is already past. Now that it's gone, does the note still tell me something true about Anon today? "
                    . "\"spent\" if it was only about that day (an appointment, an outing, a deadline that's done). \"still_true\" if there is something lasting in it.",
                    ['spent', 'still_true'], 'still_true');
                if ($answer === 'spent' && cg_can_delete($ctx) && !empty(cg_delete($ctx, $note['id'])['ok'])) {
                    cg_note_event($ctx, 'deleted', ['id' => $note['id'], 'category' => $note['category'], 'text' => $note['text'], 'why' => 'over']);
                    $ctx['changed']++;
                    continue;
                }
                cg_mark($ctx, $note, 'expiry_ok');
            }

            $others = array_filter(cg_all_notes($userId), fn($n) => $n['id'] !== $note['id']);
            $near = cg_similar($note['text'], $others, 4);
            // out of deletes, it stays unchecked for the next pass
            if ($near && cg_delete_room($ctx) < 1) continue;
            if ($near) {
                $pick = consolidation_call($ctx, 'looking for doubles',
                    "My notes:\n" . implode("\n", array_map('cg_show', $near)) . "\n\nThe note I'm checking:\n" . cg_show($note) . "\n\n"
                    . "Is one of my notes about the very same thing as the one I'm checking (the same exam, the same pregnancy, the same job), so one note could hold both without losing anything? Two different facts about the same person or pet don't count. Answer with its id, or \"none\".",
                    cg_obj(['id' => CG_STR]), 80, $ctx['think']);
                $other = cg_note($userId, strtolower(trim((string)($pick['id'] ?? 'none'))));
                if ($other && $other['id'] !== $note['id']) {
                    $merged = consolidation_call($ctx, 'merging two notes',
                        "Two of my notes are about the same thing:\n- " . cg_pin_dates($note) . "\n- " . cg_pin_dates($other) . "\n\nWrite them as one note. Keep every detail from both, start with \"Anon\", one or two sentences.",
                        cg_obj(['text' => CG_STR]), 120, $ctx['write']);
                    $text = trim((string)($merged['text'] ?? ''));
                    if ($text !== '' && !cg_voice_bad($text) && cg_keeps_all($text, [cg_pin_dates($note), cg_pin_dates($other)])
                        && cg_can_delete($ctx) && !empty(cg_edit($ctx, $note['id'], $text, ['kind' => 'pass'])['ok'])) {
                        cg_delete($ctx, $other['id']);
                        cg_note_event($ctx, 'merged', ['id' => $note['id'], 'category' => $note['category'], 'text' => $text, 'was' => $note['text'], 'before' => $note['text'], 'gone' => [$other['text']]]);
                        $ctx['changed']++;
                    }
                }
            }
            cg_mark($ctx, $note, 'checked');
        } catch (ConsolidationSkip $skip) {
            if ($skip->kind === 'step') throw $skip;
            consolidation_skipped($ctx, $skip, $item['text']);
            cg_mark($ctx, $item, 'checked');
        }
    }
    return count($queue);
}

function cg_names(string $text): array {
    $skip = explode('|', strtolower(CONSOLIDATION_MONTHS . '|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday'));
    return array_values(array_filter(array_diff(cg_keepers($text), $skip), fn($w) => !ctype_digit($w)));
}

// "Next" or "When" only ever open a sentence. a name shows up
// mid-sentence in at least one note
function cg_known_names(array $notes): array {
    $known = [];
    foreach ($notes as $note) {
        preg_match_all("/(?<!^)(?<![.!?]\s)\b[A-Z][\w']*/u", $note['text'], $m);
        foreach (cg_names(implode(' ', $m[0])) as $name) $known[$name] = true;
    }
    return $known;
}

// the model never calls two facts about Miso "the same thing", so
// PHP groups them by the name they share, inside one category
function cg_compact(array &$ctx, int $tidied): void {
    $userId = $ctx['user'];
    $meta = memory_meta_load($userId)['notes'] ?? [];
    $all = cg_all_notes($userId);
    $known = cg_known_names($all);
    $byName = [];
    foreach ($all as $note) {
        foreach (cg_names($note['text']) as $name) {
            if (isset($known[$name])) $byName[$note['category'] . '|' . $name][$note['id']] = $note;
        }
    }
    uasort($byName, fn($a, $b) => count($b) <=> count($a));
    $used = [];
    $groups = [];
    foreach ($byName as $key => $notes) {
        $notes = array_diff_key($notes, $used);
        if (count($notes) < 2) continue;
        usort($notes, fn($a, $b) => $a['created'] <=> $b['created']);
        $notes = array_slice($notes, 0, 4);
        $stale = array_filter($notes, fn($n) => (int)($meta[$n['id']]['compacted'] ?? 0) < (int)($meta[$n['id']]['updated'] ?? 1));
        if (!$stale) continue;
        foreach ($notes as $n) $used[$n['id']] = true;
        $groups[] = [ucfirst(explode('|', $key)[1]), $notes];
    }

    foreach ($groups as $i => [$name, $notes]) {
        try {
            cg_progress($ctx, 2, $tidied + $i + 1, $tidied + count($groups));
            // no room under the 40% cap: left unmarked, next pass gets it
            if (cg_delete_room($ctx) < count($notes) - 1) continue;
            $texts = array_map('cg_pin_dates', $notes);
            if (preg_match('/\b(' . preg_quote($name, '/') . ')/i', $texts[0], $m)) $name = $m[1];
            $got = consolidation_call($ctx, "putting together what I know about $name",
                "My notes about $name:\n- " . implode("\n- ", $texts) . "\n\n"
                . "Write them as one note. Keep every detail from all of them. One to three sentences. \"he\" and \"his\" only ever mean Anon, anyone else gets their name. Don't link facts that weren't linked.",
                cg_obj(['text' => CG_STR]), 200, $ctx['write']);
            $text = trim(str_replace('*', '', (string)($got['text'] ?? '')));
            $wanted = array_unique(array_merge(...array_map('cg_words', $texts)));
            $kept = count(array_intersect($wanted, cg_words($text))) / max(1, count($wanted));
            $first = array_shift($notes);
            $merged = $text !== '' && !cg_voice_bad($text) && mb_strlen($text) <= 500 && $kept >= 0.7 && cg_keeps_all($text, $texts)
                && cg_can_delete($ctx, count($notes)) && !empty(cg_edit($ctx, $first['id'], $text, ['kind' => 'pass'])['ok']);
            if ($merged) {
                foreach ($notes as $n) cg_delete($ctx, $n['id']);
                cg_note_event($ctx, 'merged', ['id' => $first['id'], 'category' => $first['category'], 'text' => $text, 'was' => implode(' / ', array_column(array_merge([$first], $notes), 'text')), 'before' => $first['text'], 'gone' => array_column($notes, 'text')]);
                $ctx['changed']++;
            }
            foreach ($merged ? [$first] : array_merge([$first], $notes) as $n) cg_mark($ctx, $n, 'compacted');
        } catch (ConsolidationSkip $skip) {
            if ($skip->kind === 'step') throw $skip;
            consolidation_skipped($ctx, $skip, "what I know about $name");
            foreach ($notes as $n) cg_mark($ctx, $n, 'compacted');
        }
    }
}

function cg_journal_budget(int $ageDays): int {
    return $ageDays <= 7 ? 900 : ($ageDays <= 60 ? 220 : 100);
}

// over budget, the middle of the biggest chat goes first. cutting from
// the front lost the whole morning of a busy day
function cg_journal_lines(array $chats, int $budget): array {
    $per = [];
    $size = 0;
    foreach ($chats as $c => $chat) {
        foreach ($chat['rows'] as $row) {
            if ($row['line'] === '') continue;
            $line = '[' . $chat['title'] . '] ' . $row['line'];
            $per[$c][] = $line;
            $size += strlen($line) + 1;
        }
    }
    while ($size > $budget) {
        $big = null;
        foreach ($per as $c => $lines) {
            if (count($lines) > 2 && ($big === null || array_sum(array_map('strlen', $lines)) > array_sum(array_map('strlen', $per[$big])))) $big = $c;
        }
        if ($big === null) break;
        $mid = intdiv(count($per[$big]), 2);
        $size -= strlen($per[$big][$mid]) + 1;
        array_splice($per[$big], $mid, 1);
    }
    return $per ? array_merge(...array_values($per)) : [];
}

// one-shot entry from the raw lines, it beat every split version in the A/B
function cg_journal(array &$ctx, array $chats, int $budget): void {
    $userId = $ctx['user'];
    $transcript = implode("\n", cg_journal_lines($chats, $budget));
    $todayKey = date('Y-m-d');

    if ($transcript !== '') {
        try {
            cg_progress($ctx, 3, 1, 3);
            $already = '';
            foreach (journal_parse(memory_journal_read($userId)) as $entry) if ($entry['date'] === $todayKey) $already = $entry['text'];
            $entry = consolidation_call($ctx, 'writing today in my journal',
                "Today is {$ctx['today']}. What Anon and I said to each other since I last wrote (the bit in brackets only says which chat it was):\n$transcript\n\n"
                . ($already !== '' ? "What I already wrote about today earlier:\n$already\n\n" : '')
                . "Write today's entry in my journal: the story of us today, not a list of facts about him. The moments that mattered most, what he told me that changed something, what passed between us. Write it as things that happened between us, never as me reading chats or messages. "
                . ($already !== '' ? 'It replaces what I wrote earlier, so keep what mattered from that too. ' : '')
                . "One paragraph, under 900 characters. Only what actually happened, nobody's words or feelings invented. Every name, place and whose-is-what exactly right.",
                null, 500, $ctx['write']);
            if ($entry !== '') {
                cg_progress($ctx, 3, 2, 3);
                $check = consolidation_call($ctx, 'checking my journal',
                    "Everything Anon and I said:\n$transcript\n\nWhat I wrote in my journal about it:\n$entry\n\n"
                    . "Find every sentence in what I wrote that gets something wrong: something that didn't happen, the wrong person doing or saying it, a wrong name, place or number. Copy each wrong sentence exactly and give the fixed version. Empty list if it's all right.",
                    cg_obj(['wrong' => ['type' => 'array', 'items' => cg_obj(['sentence' => CG_STR, 'fixed' => CG_STR])]]), 600, $ctx['think']);
                foreach ((array)($check['wrong'] ?? []) as $wrong) {
                    $sentence = (string)($wrong['sentence'] ?? '');
                    if ($sentence !== '' && str_contains($entry, $sentence)) $entry = str_replace($sentence, (string)($wrong['fixed'] ?? ''), $entry);
                }
                if (trim($entry) !== '') {
                    if (!$ctx['dry']) memory_journal_upsert($userId, $todayKey, $entry);
                    consolidation_feed_emit($userId, ['type' => 'journal', 'date' => $todayKey, 'text' => trim($entry)]);
                }
            }
        } catch (ConsolidationSkip $skip) {
            if ($skip->kind === 'step') throw $skip;
            consolidation_skipped($ctx, $skip, "today's journal entry");
        }
    }

    cg_progress($ctx, 3, 3, 3);
    foreach (journal_parse(memory_journal_read($userId)) as $entry) {
        try {
            $age = (int)((strtotime('today') - strtotime($entry['date'])) / 86400);
            $limit = cg_journal_budget($age);
            if ($entry['date'] === $todayKey || mb_strlen($entry['text']) <= $limit) continue;
            $short = '';
            for ($try = 0; $try < 2 && ($short === '' || mb_strlen($short) > $limit); $try++) {
                $short = consolidation_call($ctx, 'letting an old day fade',
                    "An entry from my journal:\n{$entry['text']}\n\nRewrite it shorter, under $limit characters. Keep every name, place and whose-is-what exactly. Don't add anything.",
                    null, 200, $ctx['write']);
            }
            if ($short !== '' && mb_strlen($short) < mb_strlen($entry['text'])) {
                if (!$ctx['dry']) memory_journal_upsert($userId, $entry['date'], $short);
                consolidation_feed_emit($userId, ['type' => 'journal', 'date' => $entry['date'], 'text' => $short]);
            }
        } catch (ConsolidationSkip $skip) {
            if ($skip->kind === 'step') throw $skip;
            consolidation_skipped($ctx, $skip, 'journal ' . $entry['date']);
        }
    }

    $entries = journal_sort(journal_parse(memory_journal_read($userId)));
    $rendered = journal_render($entries);
    while (strlen($rendered) > CONSOLIDATION_JOURNAL_MAX_CHARS && count($entries) > 1) {
        array_pop($entries);
        $rendered = journal_render($entries);
    }
    if (!$ctx['dry']) memory_journal_write($userId, $rendered);
}

function consolidation_guided(int $userId, int $started, bool $dry = false): array {
    $ctx = [
        'user' => $userId,
        'started' => $started,
        'dry' => $dry,
        'dry_ids' => 0,
        'voice' => CONSOLIDATION_VOICE,
        'think' => consolidation_effort() !== 'off',
        'effort' => consolidation_effort(),
        'write' => consolidation_write_effort(consolidation_effort()),
        'today' => date('l j F Y'),
        'tps' => null,
        'calls' => 0,
        'deleted' => 0,
        'changed' => 0,
        'tally' => [],
        'start_notes' => count(memory_list($userId)),
    ];
    $budget = min(CONSOLIDATION_WINDOW_CHARS, (int)floor(chat_window_tokens() * 4 * 0.45));
    $welcomeLines = [];

    $chats = cg_pending($userId, 'upto_id');
    $total = 0;
    foreach ($chats as &$chat) {
        $chat['chunks'] = cg_chunks($chat['rows'], $budget, CONSOLIDATION_WINDOW_OVERLAP);
        $total += count($chat['chunks']);
    }
    unset($chat);
    consolidation_feed_emit($userId, ['type' => 'pass', 'chats' => count($chats), 'notes' => $ctx['start_notes'], 'effort' => $ctx['effort']] + ($dry ? ['dry' => true] : []));

    $done = 0;
    try {
        foreach ($chats as $chat) {
            try {
                foreach ($chat['chunks'] as $chunk) {
                    cg_progress($ctx, 1, ++$done, $total, $chat['title']);
                    if ($chunk['lines']) {
                        $ctx['chunk'] = ['conv' => $chat['id'], 'lines' => $chunk['lines'], 'ids' => $chunk['ids']];
                        cg_harvest($ctx, implode("\n", $chunk['lines']));
                        foreach ($chunk['lines'] as $line) $welcomeLines[] = '[' . $chat['title'] . '] ' . $line;
                    }
                    if (!$dry) cg_commit($userId, $chat['id'], 'upto_id', $chunk['upto']);
                }
            } catch (ConsolidationSkip $skip) {
                // no commit, the rest of this chat comes back next pass
                if ($skip->kind !== 'chat') throw $skip;
                consolidation_skipped($ctx, $skip, $chat['title']);
            }
        }
    } catch (ConsolidationSkip $skip) {
        consolidation_skipped($ctx, $skip, 'reading the chats');
    }

    try {
        cg_compact($ctx, cg_tidy($ctx));
    } catch (ConsolidationSkip $skip) {
        consolidation_skipped($ctx, $skip, 'going over old notes');
    }

    $journalChats = cg_pending($userId, 'journal_upto');
    try {
        cg_journal($ctx, $journalChats, (int)floor(chat_window_tokens() * 4 * 0.5));
        foreach ($journalChats as $chat) {
            $last = end($chat['rows']);
            if ($last && !$dry) cg_commit($userId, $chat['id'], 'journal_upto', $last['id']);
        }
    } catch (ConsolidationSkip $skip) {
        consolidation_skipped($ctx, $skip, 'the journal');
    }

    return ['lines' => $welcomeLines, 'calls' => $ctx['calls'], 'changed' => $ctx['changed'], 'summary' => [
        'calls' => $ctx['calls'], 'tally' => $ctx['tally'], 'skips' => $ctx['skips'] ?? 0,
        'bad_json' => $ctx['bad_json'] ?? 0, 'loops' => $ctx['loops'] ?? 0,
    ]];
}
