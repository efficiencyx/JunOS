<?php

function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $base = state_dir();
    if (!is_dir($base)) @mkdir($base, 0700, true);
    if (is_dir($base)) @chmod($base, 0700);
    // no /tmp fallback. a db that lands there looks like it works
    // and then every account is gone on the next restart.
    if (!is_writable($base)) {
        log_event(['msg' => 'state_dir_unwritable', 'dir' => $base]);
        fail(503, 'state_unavailable');
    }
    $path = $base . '/omega.sqlite';
    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    @chmod($path, 0600);
    // busy_timeout is NOT optional here. the consolidation worker
    // writes the same file as php-fpm, and the default of 0 turns any
    // overlap into an instant "database is locked" instead of a short
    // wait.
    $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    foreach ([$path . '-wal', $path . '-shm'] as $sidecar) {
        if (file_exists($sidecar)) @chmod($sidecar, 0600);
    }

    // run any migrations/NNN_*.sql newer than the schema version
    // we're on. a fresh DB reads 0 (there's no schema_version table
    // yet) so it gets every file in order. each migration does its
    // own INSERT INTO schema_version.
    $current = 0;
    try {
        $v = $pdo->query('SELECT MAX(v) FROM schema_version')->fetchColumn();
        if ($v !== false && $v !== null) $current = (int)$v;
    } catch (PDOException $e) {
    }
    $files = glob(__DIR__ . '/../migrations/*.sql');
    sort($files);
    foreach ($files as $file) {
        if (!preg_match('/(\d+)_[^\/]*\.sql$/', basename($file), $m)) continue;
        if ((int)$m[1] <= $current) continue;
        $pdo->exec(file_get_contents($file));
    }

    return $pdo;
}

function conversation_owned(int $convId, int $userId): bool {
    $st = db()->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
    $st->execute([$convId, $userId]);
    $owned = (bool)$st->fetchColumn();
    $st->closeCursor();
    return $owned;
}

function no_users_yet(): bool {
    return db()->query('SELECT id FROM users LIMIT 1')->fetchColumn() === false;
}
