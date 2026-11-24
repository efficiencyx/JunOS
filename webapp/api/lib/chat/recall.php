<?php

require_once __DIR__ . '/../retrieval.php';

// rows are ciphertext, so every search decrypts his history newest
// first. bounded, or a year of chats is a 10 s tool call
const RECALL_SCAN_MAX = 5000;
const RECALL_SCAN_SECONDS = 1.5;
const RECALL_NOTES_MAX = 4;
const RECALL_JOURNAL_MAX = 2;

// half his words, a synonym counts half. ALL of them meant one stray word found nothing
function recall_enough(array $docTerms, array $query): bool {
    $said = array_keys(array_filter($query['terms'], fn($w) => $w >= 1.0));
    if (!$said) return false;
    $have = array_flip($docTerms);
    $got = 0.0;
    foreach ($query['terms'] as $t => $w) if (isset($have[$t])) $got += $w >= 1.0 ? 1.0 : 0.5;
    return $got >= max(1, ceil(count($said) / 2));
}

function recall_first_hit(string $text, array $query): int {
    foreach (rt_tokens($text) as [$stem, , $off]) {
        if (($query['terms'][$stem] ?? 0) >= 1.0) return mb_strlen(substr($text, 0, $off));
    }
    return 0;
}

function recall_messages(int $userId, int $convId, string $text, array $query, int $limit): array {
    $st = db()->prepare(
        'SELECT m.role, m.content, m.created_at, c.title, c.id AS conversation_id
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ? AND c.id != ?
          ORDER BY m.created_at DESC, m.id DESC'
    );
    $st->execute([$userId, $convId]);
    $until = microtime(true) + RECALL_SCAN_SECONDS;
    $docs = [];
    $phrase = [];
    while (count($docs) < RECALL_SCAN_MAX && microtime(true) < $until && ($r = $st->fetch())) {
        $content = trim(preg_replace('/\s+/', ' ', (string)dec($r['content'])));
        if ($content === '') continue;
        $i = count($docs);
        $docs[] = ['t' => $content, 'row' => $r];
        if (recall_word_at($content, $text) !== null) $phrase[$i] = true;
    }
    $st->closeCursor();
    if (!$docs) return [];

    $scores = rt_score(rt_index($docs, ['t' => 1.0]), $query);
    $ranked = [];
    foreach ($docs as $i => $doc) {
        $whole = isset($phrase[$i]);
        if (!$whole && (!isset($scores[$i]) || !recall_enough($scores[$i][2], $query))) continue;
        $ranked[] = ['i' => $i, 'whole' => $whole, 'score' => $scores[$i][0] ?? 0.0];
    }
    // the whole phrase beats any word soup, then score, then newest
    usort($ranked, fn($a, $b) => [$b['whole'], $b['score'], -$a['i']] <=> [$a['whole'], $a['score'], -$b['i']]);

    $rows = [];
    foreach (array_slice($ranked, 0, $limit) as $hit) {
        ['t' => $content, 'row' => $r] = $docs[$hit['i']];
        $at = $hit['whole'] ? mb_strlen(substr($content, 0, recall_word_at($content, $text))) : recall_first_hit($content, $query);
        $rows[] = ['date' => date('Y-m-d H:i', (int)$r['created_at']), 'conversation_id' => (int)$r['conversation_id'],
            'title' => (string)dec($r['title'] ?? null), 'role' => (string)$r['role'], 'content' => recall_excerpt($content, $at)];
    }
    return $rows;
}

// the notes that didn't fit in the live context are still hers
function recall_notes(int $userId, array $query): array {
    $notes = [];
    foreach (memory_notes_load($userId) as $category => $data) {
        foreach ($data['notes'] as $note) $notes[] = $note + ['category' => $category];
    }
    if (!$notes) return [];
    $scores = rt_score(rt_index(array_map(fn($n) => ['t' => $n['text']], $notes), ['t' => 1.0]), $query);
    $out = [];
    foreach ($scores as $i => [, , $terms]) {
        if (!recall_enough($terms, $query)) continue;
        $out[] = ['category' => $notes[$i]['category'], 'note' => memory_note_stamp($notes[$i]) . memory_note_render($notes[$i])];
        if (count($out) >= RECALL_NOTES_MAX) break;
    }
    return $out;
}

function recall_journal(int $userId, array $query): array {
    $entries = journal_parse(memory_journal_read($userId));
    if (!$entries) return [];
    $scores = rt_score(rt_index(array_map(fn($e) => ['t' => $e['text']], $entries), ['t' => 1.0]), $query);
    $out = [];
    foreach ($scores as $i => [, , $terms]) {
        if (!recall_enough($terms, $query)) continue;
        $out[] = ['date' => $entries[$i]['date'], 'entry' => $entries[$i]['text']];
        if (count($out) >= RECALL_JOURNAL_MAX) break;
    }
    return $out;
}

// names from her notes one typo away from what she searched for
function recall_try(int $userId, string $text): array {
    $names = [];
    foreach (memory_notes_load($userId) as $data) {
        foreach ($data['notes'] as $note) {
            preg_match_all("/(?<![.!?]\s)(?<!^)\b\p{Lu}[\p{L}']{3,}/u", $note['text'], $m);
            foreach ($m[0] as $w) if ($w !== 'Anon') $names[mb_strtolower($w)] = $w;
        }
    }
    $out = [];
    foreach (rt_tokens($text) as [, $orig]) {
        $low = mb_strtolower($orig);
        if (mb_strlen($low) < 4 || isset($names[$low])) continue;
        foreach ($names as $k => $w) if (levenshtein($low, $k) <= (mb_strlen($low) <= 6 ? 1 : 2)) $out[$w] = true;
    }
    return array_slice(array_keys($out), 0, 3);
}

function recall_search(int $userId, int $convId, string $text, int $limit): array {
    $query = rt_query([[$text, 1.0]]);
    $out = [];
    $rows = recall_messages($userId, $convId, $text, $query, $limit);
    if ($rows) $out['results'] = $rows;
    $notes = recall_notes($userId, $query);
    if ($notes) $out['notes'] = $notes;
    $journal = recall_journal($userId, $query);
    if ($journal) $out['journal'] = $journal;
    return $out;
}
