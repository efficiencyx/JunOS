<?php

function memory_dir(): string {
    // sits under state_dir() by default so memories land in the
    // omega_state volume that actually survives. builds before
    // 2026-07 wrote to /var/lib/jun/memory, which docker never
    // mounted, so they died with the container. RIP. set MEMORY_DIR
    // if you want it somewhere else.
    $dir = rtrim(env_str('MEMORY_DIR', state_dir() . '/memory'), '/');
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new RuntimeException('memory_dir_unwritable');
    }
    return $dir;
}

function memory_file_path(int $userId): string {
    return memory_dir() . '/user-' . $userId . '.jsonl';
}

// a note saying "tomorrow" means nothing without the day it was
// written, but stamping EVERY note costs us a whole category off
// the end of the context budget. so only the notes whose wording
// leans on their own date get one.
const MEMORY_RELATIVE_TIME_RE = '/\b(today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|month|weekend)|last (?:night|week|month|weekend)|next (?:week|month|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (?:a few|a couple of|\d{1,2}) (?:days?|weeks?|months?)|days? from now|weeks? from now)\b/i';

// phrases we can pin to one exact day, given the day the note was
// written. everything else in the regex above ("next week", "in a
// few days") stays fuzzy and only gets the anchor stamp.
const MEMORY_RELATIVE_TIME_OFFSETS = [
    'today' => 0, 'tonight' => 0, 'this morning' => 0, 'this afternoon' => 0,
    'this evening' => 0, 'tomorrow' => 1, 'yesterday' => -1, 'last night' => -1,
];

function memory_note_stamp(array $note): string {
    if (!preg_match(MEMORY_RELATIVE_TIME_RE, (string)$note['text'])) return '';
    $created = (int)($note['created'] ?? 0);
    if ($created <= 0) return '';
    return '(noted ' . date('l j F Y', $created) . ', ' . memory_days_phrase($created) . ') ';
}

function memory_days_phrase(int $when): string {
    $days = (int)floor((strtotime('today', $when) - strtotime('today')) / 86400);
    if ($days === 0) return 'that is today';
    if ($days === 1) return 'that is tomorrow';
    if ($days === -1) return 'that was yesterday, already past';
    if ($days > 1) return 'that is in ' . $days . ' days';
    return 'that was ' . abs($days) . ' days ago, already past';
}

// Jun absolutely will NOT do the date arithmetic herself. give
// her "(noted Monday 10 August)" next to "tomorrow" and she repeats
// "tomorrow", four days late. so we do the sum and paste the real
// day right after the phrase, leaving her nothing to work out.
function memory_note_render(array $note): string {
    $text = (string)$note['text'];
    $created = (int)($note['created'] ?? 0);
    if ($created <= 0) return $text;

    return preg_replace_callback(MEMORY_RELATIVE_TIME_RE, function (array $m) use ($created): string {
        $phrase = strtolower($m[0]);
        $day = null;
        if (isset(MEMORY_RELATIVE_TIME_OFFSETS[$phrase])) {
            $day = strtotime(MEMORY_RELATIVE_TIME_OFFSETS[$phrase] . ' days', $created);
        } elseif (preg_match('/^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/', $phrase, $d)) {
            $day = strtotime('next ' . $d[1], $created);
        } elseif (preg_match('/^(?:in (\d{1,2})|(\d{1,2})) (day|week|month)s? ?(?:from now)?$/', $phrase, $d)) {
            $day = strtotime('+' . ($d[1] !== '' ? $d[1] : $d[2]) . ' ' . $d[3] . 's', $created);
        }
        if (!$day) return $m[0];
        return $m[0] . ' (= ' . date('l j F Y', $day) . ', ' . memory_days_phrase($day) . ')';
    }, $text) ?? $text;
}

function memory_normalize_entry(string $memory, string $category): array {
    $memory = trim(preg_replace('/\s+/', ' ', $memory));
    $category = memory_category_note_slug($category);
    if ($memory === '') return ['error' => 'memory_required'];
    if (mb_strlen($memory) > 800) $memory = mb_substr($memory, 0, 797) . '…';
    return ['category' => $category, 'memory' => $memory];
}

function memory_user_dir(int $userId): string {
    $dir = memory_dir() . '/user-' . $userId;
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new RuntimeException('memory_user_dir_unwritable');
    }
    return $dir;
}

function memory_with_user_lock(int $userId, callable $operation): array {
    $path = memory_dir() . '/.user-' . $userId . '.write.lock';
    $fp = fopen($path, 'c+b');
    if ($fp === false) return ['error' => 'memory_lock_failed'];
    @chmod($path, 0600);
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        return ['error' => 'memory_lock_failed'];
    }
    try {
        $result = $operation();
        return is_array($result) ? $result : ['ok' => true];
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function memory_category_slug(string $category): string {
    $category = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '_', $category), '_'));
    if ($category === '') $category = 'general';
    if (mb_strlen($category) > 40) $category = mb_substr($category, 0, 40);
    return $category;
}

function memory_category_note_slug(string $category): string {
    $slug = memory_category_slug($category);
    return $slug === 'journal' ? 'journal_notes' : $slug;
}

function memory_atomic_write(string $path, string $text, string $prefix = '.memory-'): array {
    try {
        $text = enc($text);
        if (is_file($path) && !copy($path, $path . '.bak')) {
            return ['error' => 'memory_backup_failed'];
        }
        $tmp = tempnam(dirname($path), $prefix);
        if ($tmp === false) return ['error' => 'memory_temp_failed'];
        $fp = fopen($tmp, 'wb');
        if ($fp === false) {
            @unlink($tmp);
            return ['error' => 'memory_open_failed'];
        }
        $written = fwrite($fp, $text);
        if ($written === false || $written !== strlen($text)) {
            fclose($fp);
            @unlink($tmp);
            return ['error' => 'memory_write_failed'];
        }
        if (!fclose($fp) || !rename($tmp, $path)) {
            @unlink($tmp);
            return ['error' => 'memory_replace_failed'];
        }
        @chmod($path, 0600);
        return ['ok' => true];
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_atomic_write_error', 'path' => basename($path), 'err' => $e->getMessage()]);
        return ['error' => 'memory_replace_failed'];
    }
}

function memory_meta_load(int $userId): array {
    $path = memory_user_dir($userId) . '/meta.json';
    $raw = is_readable($path) ? @file_get_contents($path) : false;
    $data = $raw === false ? null : json_decode((string)dec($raw), true);
    return is_array($data) && is_array($data['notes'] ?? null) ? $data : ['notes' => []];
}

function memory_meta_write(int $userId, array $meta): array {
    $meta['notes'] = is_array($meta['notes'] ?? null) ? $meta['notes'] : [];
    $encoded = $meta;
    if (!$encoded['notes']) $encoded['notes'] = (object)[];
    $json = json_encode($encoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) return ['error' => 'memory_encode_failed'];
    return memory_atomic_write(memory_user_dir($userId) . '/meta.json', $json . "\n", '.meta-');
}

function memory_mint_id(array $used): string {
    do {
        $id = str_pad(base_convert((string)random_int(0, 60466175), 10, 36), 5, '0', STR_PAD_LEFT);
    } while (isset($used[$id]));
    return $id;
}

function memory_note_links(string $text): array {
    if (!preg_match_all('/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u', $text, $matches)) return [];
    $links = [];
    foreach ($matches[1] as $category) $links[] = memory_category_slug($category);
    return array_values(array_unique($links));
}

function memory_migrate_legacy(int $userId): void {
    $root = memory_dir();
    $legacy = $root . '/user-' . $userId . '.jsonl';
    $legacyJournal = $root . '/user-' . $userId . '.journal.md';
    if (is_dir($root . '/user-' . $userId) || (!is_file($legacy) && !is_file($legacyJournal))) return;
    $path = $root . '/.user-' . $userId . '.migration.lock';
    $fp = fopen($path, 'c+b');
    if ($fp === false) throw new RuntimeException('memory_migration_lock_failed');
    @chmod($path, 0600);
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        throw new RuntimeException('memory_migration_lock_failed');
    }
    try {
        memory_migrate_legacy_unlocked($userId);
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function memory_migrate_legacy_unlocked(int $userId): void {
    $root = memory_dir();
    $legacy = memory_file_path($userId);
    $legacyJournal = $root . '/user-' . $userId . '.journal.md';
    $target = $root . '/user-' . $userId;
    if ((!is_file($legacy) && !is_file($legacyJournal)) || is_dir($target)) return;

    $groups = [];
    $meta = ['notes' => []];
    $used = [];
    $lines = is_file($legacy) ? (file($legacy, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []) : [];
    foreach ($lines as $line) {
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;
        $entry = memory_normalize_entry((string)($obj['memory'] ?? ''), (string)($obj['category'] ?? 'general'));
        if (isset($entry['error'])) continue;
        $id = memory_mint_id($used);
        $used[$id] = true;
        $created = max(0, (int)($obj['created_at'] ?? time()));
        $groups[$entry['category']][] = ['id' => $id, 'text' => $entry['memory']];
        $meta['notes'][$id] = ['created' => $created, 'updated' => $created];
    }

    $tmpDir = $root . '/.user-' . $userId . '-migration-' . bin2hex(random_bytes(4));
    if (!mkdir($tmpDir, 0700)) throw new RuntimeException('memory_migration_dir_failed');
    try {
        foreach ($groups as $category => $notes) {
            $bullets = array_map(fn($note) => '- ' . $note['text'] . ' ^' . $note['id'], $notes);
            $text = '# ' . $category . "\n\n" . implode("\n", $bullets) . "\n";
            if (@file_put_contents($tmpDir . '/' . $category . '.md', $text, LOCK_EX) === false) {
                throw new RuntimeException('memory_migration_write_failed');
            }
            @chmod($tmpDir . '/' . $category . '.md', 0600);
        }
        $encodedMeta = $meta;
        if (!$encodedMeta['notes']) $encodedMeta['notes'] = (object)[];
        $metaJson = json_encode($encodedMeta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($metaJson === false || @file_put_contents($tmpDir . '/meta.json', $metaJson . "\n", LOCK_EX) === false) {
            throw new RuntimeException('memory_migration_meta_failed');
        }
        @chmod($tmpDir . '/meta.json', 0600);

        if (is_file($legacyJournal) && !copy($legacyJournal, $tmpDir . '/journal.md')) {
            throw new RuntimeException('memory_migration_journal_failed');
        }
        if (is_file($tmpDir . '/journal.md')) @chmod($tmpDir . '/journal.md', 0600);
        if (!rename($tmpDir, $target)) throw new RuntimeException('memory_migration_replace_failed');
        if (is_file($legacy) && !rename($legacy, $legacy . '.migrated')) {
            throw new RuntimeException('memory_migration_archive_failed');
        }
        if (is_file($legacyJournal) && !rename($legacyJournal, $legacyJournal . '.migrated')) {
            throw new RuntimeException('memory_migration_journal_archive_failed');
        }
    } finally {
        if (is_dir($tmpDir)) {
            foreach (glob($tmpDir . '/*') ?: [] as $path) @unlink($path);
            @rmdir($tmpDir);
        }
    }
}

function memory_notes_write_file(int $userId, string $category, array $notes): array {
    $category = memory_category_note_slug($category);
    $path = memory_user_dir($userId) . '/' . $category . '.md';
    if (!$notes) {
        if (!is_file($path)) return ['ok' => true];
        if (!copy($path, $path . '.bak')) return ['error' => 'memory_backup_failed'];
        return @unlink($path) ? ['ok' => true] : ['error' => 'memory_replace_failed'];
    }
    $bullets = [];
    foreach ($notes as $note) {
        $id = strtolower((string)($note['id'] ?? ''));
        if (!preg_match('/^[a-z0-9]{5}$/', $id)) return ['error' => 'memory_id_invalid'];
        $entry = memory_normalize_entry((string)($note['text'] ?? $note['memory'] ?? ''), $category);
        if (isset($entry['error'])) return $entry;
        $bullets[] = '- ' . $entry['memory'] . ' ^' . $id;
    }
    return memory_atomic_write($path, '# ' . $category . "\n\n" . implode("\n", $bullets) . "\n");
}

function memory_notes_load_unlocked(int $userId): array {
    memory_migrate_legacy($userId);
    $dir = memory_user_dir($userId);
    $metaMissing = !is_file($dir . '/meta.json');
    $meta = memory_meta_load($userId);
    $used = [];
    $out = [];
    $metaChanged = false;
    $paths = glob($dir . '/*.md') ?: [];
    sort($paths, SORT_STRING);

    foreach ($paths as $path) {
        if (basename($path) === 'journal.md') continue;
        $slug = memory_category_slug(pathinfo($path, PATHINFO_FILENAME));
        $name = $slug;
        $notes = [];
        $rewrite = false;
        $mtime = (int)(filemtime($path) ?: time());
        foreach (preg_split('/\R/', (string)dec((string)@file_get_contents($path))) as $line) {
            if (preg_match('/^\s*#\s+(.+?)\s*$/u', $line, $heading)) {
                $name = trim($heading[1]);
                continue;
            }
            if (!preg_match('/^-\s+(.*?)(?:\s+\^([a-z0-9]{5}))?$/u', $line, $match)) continue;
            $text = trim($match[1]);
            if ($text === '') continue;
            $id = strtolower((string)($match[2] ?? ''));
            if ($id === '' || isset($used[$id])) {
                $id = memory_mint_id($used);
                $rewrite = true;
                $meta['notes'][$id] = ['created' => $mtime, 'updated' => $mtime];
                $metaChanged = true;
            }
            $used[$id] = true;
            $times = is_array($meta['notes'][$id] ?? null) ? $meta['notes'][$id] : [];
            $notes[] = [
                'id' => $id,
                'text' => $text,
                'links' => memory_note_links($text),
                'created' => (int)($times['created'] ?? $mtime),
                'updated' => (int)($times['updated'] ?? $mtime),
            ];
        }
        if ($rewrite) memory_notes_write_file($userId, $slug, $notes);
        $out[$slug] = ['name' => $name, 'notes' => $notes];
    }
    if ($metaChanged || $metaMissing) memory_meta_write($userId, $meta);
    return $out;
}

function memory_notes_load(int $userId): array {
    $result = memory_with_user_lock($userId, fn() => memory_notes_load_unlocked($userId));
    if (isset($result['error']) && is_string($result['error'])) {
        throw new RuntimeException($result['error']);
    }
    return $result;
}

function memory_note_add_unlocked(int $userId, string $category, string $text): array {
    $entry = memory_normalize_entry($text, $category);
    if (isset($entry['error'])) return $entry;
    $categories = memory_notes_load_unlocked($userId);
    $used = [];
    foreach ($categories as $data) {
        foreach ($data['notes'] as $note) $used[$note['id']] = true;
    }
    $id = memory_mint_id($used);
    $now = time();
    $notes = $categories[$entry['category']]['notes'] ?? [];
    $notes[] = ['id' => $id, 'text' => $entry['memory']];
    $result = memory_notes_write_file($userId, $entry['category'], $notes);
    if (empty($result['ok'])) return $result;
    $meta = memory_meta_load($userId);
    $meta['notes'][$id] = ['created' => $now, 'updated' => $now];
    $result = memory_meta_write($userId, $meta);
    if (empty($result['ok'])) return $result;
    return ['ok' => true, 'entry' => [
        'id' => $id,
        'created_at' => $now,
        'category' => $entry['category'],
        'memory' => $entry['memory'],
    ]];
}

function memory_note_edit_unlocked(int $userId, string $id, string $text): array {
    $categories = memory_notes_load_unlocked($userId);
    foreach ($categories as $category => $data) {
        foreach ($data['notes'] as $index => $note) {
            if ($note['id'] !== $id) continue;
            $entry = memory_normalize_entry($text, $category);
            if (isset($entry['error'])) return $entry;
            $data['notes'][$index]['text'] = $entry['memory'];
            $result = memory_notes_write_file($userId, $category, $data['notes']);
            if (empty($result['ok'])) return $result;
            $meta = memory_meta_load($userId);
            $meta['notes'][$id] = [
                'created' => (int)($meta['notes'][$id]['created'] ?? $note['created']),
                'updated' => time(),
            ];
            $result = memory_meta_write($userId, $meta);
            return empty($result['ok']) ? $result : ['ok' => true];
        }
    }
    return ['error' => 'memory_not_found'];
}

function memory_note_delete_unlocked(int $userId, string $id): array {
    $categories = memory_notes_load_unlocked($userId);
    foreach ($categories as $category => $data) {
        foreach ($data['notes'] as $index => $note) {
            if ($note['id'] !== $id) continue;
            array_splice($data['notes'], $index, 1);
            $result = memory_notes_write_file($userId, $category, $data['notes']);
            if (empty($result['ok'])) return $result;
            $meta = memory_meta_load($userId);
            unset($meta['notes'][$id]);
            $result = memory_meta_write($userId, $meta);
            return empty($result['ok']) ? $result : ['ok' => true];
        }
    }
    return ['error' => 'memory_not_found'];
}

function memory_note_move_unlocked(int $userId, string $id, string $category): array {
    $target = memory_category_note_slug($category);
    $categories = memory_notes_load_unlocked($userId);
    foreach ($categories as $source => $data) {
        foreach ($data['notes'] as $index => $note) {
            if ($note['id'] !== $id) continue;
            if ($source === $target) return ['ok' => true];
            array_splice($data['notes'], $index, 1);
            $targetNotes = $categories[$target]['notes'] ?? [];
            $originalTargetNotes = $targetNotes;
            $targetNotes[] = $note;
            $result = memory_notes_write_file($userId, $target, $targetNotes);
            if (empty($result['ok'])) return $result;
            $result = memory_notes_write_file($userId, $source, $data['notes']);
            if (empty($result['ok'])) {
                $rollback = memory_notes_write_file($userId, $target, $originalTargetNotes);
                if (empty($rollback['ok'])) {
                    log_event([
                        'msg' => 'memory_move_rollback_failed',
                        'user_id' => $userId,
                        'id' => $id,
                        'source' => $source,
                        'target' => $target,
                    ]);
                }
                return $result;
            }
            $meta = memory_meta_load($userId);
            $meta['notes'][$id] = [
                'created' => (int)($meta['notes'][$id]['created'] ?? $note['created']),
                'updated' => time(),
            ];
            $result = memory_meta_write($userId, $meta);
            return empty($result['ok']) ? $result : ['ok' => true];
        }
    }
    return ['error' => 'memory_not_found'];
}

function memory_note_add(int $userId, string $category, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_add_unlocked($userId, $category, $text)
    );
}

function memory_note_edit(int $userId, string $id, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_edit_unlocked($userId, $id, $text)
    );
}

function memory_note_delete(int $userId, string $id): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_delete_unlocked($userId, $id)
    );
}

function memory_note_move(int $userId, string $id, string $category): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_move_unlocked($userId, $id, $category)
    );
}

// migrate FIRST, then delete. an un-migrated account still has
// its notes in the old flat files, and wiping only the directory
// leaves those sitting there to get picked up and restored next
// time anything reads her memory.
function memory_wipe_user(int $userId): array {
    return memory_with_user_lock($userId, function () use ($userId): array {
        memory_migrate_legacy($userId);
        $dir = memory_dir() . '/user-' . $userId;
        if (is_dir($dir)) {
            foreach (new DirectoryIterator($dir) as $item) {
                if ($item->isDot()) continue;
                if ((!$item->isFile() && !$item->isLink()) || !@unlink($item->getPathname())) {
                    return ['error' => 'memory_delete_failed'];
                }
            }
            if (!@rmdir($dir)) return ['error' => 'memory_delete_failed'];
        }
        $legacy = [
            memory_file_path($userId),
            memory_dir() . '/user-' . $userId . '.journal.md',
        ];
        foreach ($legacy as $path) {
            if (is_file($path) && !@unlink($path)) return ['error' => 'memory_delete_failed'];
            if (is_file($path . '.migrated') && !@unlink($path . '.migrated')) {
                return ['error' => 'memory_delete_failed'];
            }
        }
        return ['ok' => true];
    });
}

function memory_list(int $userId): array {
    $out = [];
    foreach (memory_notes_load($userId) as $category => $data) {
        foreach ($data['notes'] as $note) {
            $out[] = [
                'id' => $note['id'],
                'created_at' => $note['created'],
                'updated_at' => $note['updated'],
                'category' => $category,
                'memory' => $note['text'],
                'links' => $note['links'],
            ];
        }
    }
    return $out;
}
