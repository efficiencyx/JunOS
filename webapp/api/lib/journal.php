<?php

function memory_journal_path(int $userId): string {
    memory_migrate_legacy($userId);
    $dir = memory_user_dir($userId);
    if (!is_file($dir . '/meta.json')) memory_meta_write($userId, ['notes' => []]);
    return $dir . '/journal.md';
}

function memory_journal_read(int $userId): string {
    try {
        $path = memory_journal_path($userId);
    } catch (Throwable $e) {
        return '';
    }
    if (!is_readable($path)) return '';
    return (string)dec((string)@file_get_contents($path));
}

function memory_journal_write_unlocked(int $userId, string $text): array {
    return memory_atomic_write(memory_journal_path($userId), $text, '.journal-');
}

function memory_journal_write(int $userId, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_journal_write_unlocked($userId, $text)
    );
}

function journal_parse(string $doc): array {
    $entries = [];
    foreach (preg_split('/\R/', $doc) as $line) {
        if (!preg_match('/^\s*[*-]\s+(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/', $line, $m)) continue;
        $text = trim(preg_replace('/\s+/', ' ', $m[2]));
        if ($text === '') continue;
        $entries[] = ['date' => $m[1], 'text' => $text];
    }
    return $entries;
}

function journal_sort(array $entries): array {
    $keyed = [];
    foreach ($entries as $i => $entry) $keyed[] = [$entry['date'], $i, $entry];
    usort($keyed, fn($a, $b) => ($b[0] <=> $a[0]) ?: ($a[1] <=> $b[1]));
    return array_column($keyed, 2);
}

function journal_render(array $entries): string {
    $today = DateTimeImmutable::createFromFormat('!Y-m-d', date('Y-m-d'));
    $buckets = ['## Lately' => [], '## The past few weeks' => [], '## Further back' => []];
    foreach (journal_sort($entries) as $entry) {
        $when = DateTimeImmutable::createFromFormat('!Y-m-d', $entry['date']);
        $age = $when === false ? 0 : (int)$when->diff($today)->format('%r%a');
        $heading = $age <= 7 ? '## Lately' : ($age <= 60 ? '## The past few weeks' : '## Further back');
        $buckets[$heading][] = '* ' . $entry['date'] . ': ' . $entry['text'];
    }

    $sections = [];
    foreach ($buckets as $heading => $bullets) {
        $sections[] = rtrim($heading . "\n" . implode("\n", $bullets));
    }
    return implode("\n\n", $sections);
}

function memory_journal_upsert_unlocked(int $userId, string $date, string $text): array {
    $when = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    if ($when === false || $when->format('Y-m-d') !== $date) return ['error' => 'journal_date_invalid'];
    $text = trim(preg_replace('/\s+/', ' ', $text));
    if ($text === '') return ['error' => 'journal_text_required'];
    if (mb_strlen($text) > 1600) $text = mb_substr($text, 0, 1597) . '…';
    $entries = journal_parse(memory_journal_read($userId));
    $next = [];
    $found = false;
    foreach ($entries as $entry) {
        if ($entry['date'] === $date) {
            if (!$found) $next[] = ['date' => $date, 'text' => $text];
            $found = true;
            continue;
        }
        $next[] = $entry;
    }
    if (!$found) $next[] = ['date' => $date, 'text' => $text];
    return memory_journal_write_unlocked($userId, journal_render($next));
}

function memory_journal_delete_unlocked(int $userId, string $date): array {
    $entries = journal_parse(memory_journal_read($userId));
    $filtered = array_values(array_filter($entries, fn($entry) => $entry['date'] !== $date));
    if (count($filtered) === count($entries)) return ['error' => 'journal_not_found'];
    return memory_journal_write_unlocked($userId, journal_render($filtered));
}

function memory_journal_upsert(int $userId, string $date, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_journal_upsert_unlocked($userId, $date, $text)
    );
}

function memory_journal_delete(int $userId, string $date): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_journal_delete_unlocked($userId, $date)
    );
}
