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
    $conn = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    @chmod($path, 0600);
    // busy_timeout is NOT optional here. the consolidation worker
    // writes the same file as php-fpm, and the default of 0 turns any
    // overlap into an instant "database is locked" instead of a short
    // wait.
    $conn->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    foreach ([$path . '-wal', $path . '-shm'] as $sidecar) {
        if (file_exists($sidecar)) @chmod($sidecar, 0600);
    }

    // a migration is several statements in one exec. outside a
    // transaction a failure halfway leaves the first half applied
    // and the version never bumped, so every boot after re-runs the
    // file and dies on "duplicate column". the php entrypoint is
    // set -e, that's a crash loop. IMMEDIATE takes the write lock
    // BEFORE the version gets read again, so two processes on a
    // fresh db can't both decide to run 001.
    if (db_pending_migrations($conn)) {
        $conn->exec('BEGIN IMMEDIATE');
        try {
            foreach (db_pending_migrations($conn) as $file) $conn->exec(file_get_contents($file));
            $conn->exec('COMMIT');
        } catch (Throwable $e) {
            // sqlite already rolled back on its own for some errors
            // (disk full), then ROLLBACK throws and buries the real one
            try { $conn->exec('ROLLBACK'); } catch (PDOException) {}
            throw $e;
        }
    }

    // only now. a worker that kept the handle from a failed run
    // would skip migrating on every request it serves after that.
    return $pdo = $conn;
}

// migrations/NNN_*.sql newer than the schema version we're on. a
// fresh DB reads 0 (there's no schema_version table yet) so it
// gets every file in order. each migration does its own INSERT
// INTO schema_version.
function db_pending_migrations(PDO $conn): array {
    $current = 0;
    try {
        $v = $conn->query('SELECT MAX(v) FROM schema_version')->fetchColumn();
        if ($v !== false && $v !== null) $current = (int)$v;
    } catch (PDOException $e) {
    }
    $files = glob(__DIR__ . '/../migrations/*.sql');
    sort($files);
    return array_values(array_filter($files, fn($f) =>
        preg_match('/(\d+)_[^\/]*\.sql$/', basename($f), $m) && (int)$m[1] > $current));
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

// the first account skips the registration key, but only while
// BIND_ADDR is loopback. off loopback the first signup needs the
// key too, or whoever finds the LAN address before the owner does
// gets the box. TRUST_PROXY can't be part of this, start.ps1 sets
// it for its own caddy on every Windows install.
function first_signup_keyless(): bool {
    $bind = env_str('BIND_ADDR', '127.0.0.1');
    $local = $bind === 'localhost' || $bind === '::1' || str_starts_with($bind, '127.');
    return $local && no_users_yet();
}
