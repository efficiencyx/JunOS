<?php

// per-user data key. 32 random bytes minted at signup and stored
// ONLY wrapped, once under Argon2id(password, kdf_salt) and once
// under the recovery code. the open key rides in the omega_key
// cookie next to the session and never touches disk, so the
// volume, a backup tarball, or .env on their own read as noise.
// the flip side: lose the password AND the recovery code and the
// chats are gone, there is nothing on the server to reset them
// with. that is the whole point, not a bug.
const CRYPT_PREFIX = 'v1:';

function crypt_kdf(string $password, string $salt): string {
    return sodium_crypto_pwhash(
        SODIUM_CRYPTO_SECRETBOX_KEYBYTES, $password, $salt,
        SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE,
        SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE,
        SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13
    );
}

// 20 chars from 31 symbols, grouped by 5, ~99 bits of entropy.
// the code is already random, so one generichash is enough to
// turn it into a key. the slow Argon2id is for the password.
function crypt_recovery_code_new(): string {
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    $code = '';
    for ($i = 0; $i < 20; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return implode('-', str_split($code, 5));
}

function crypt_recovery_key(string $code): string {
    $clean = strtolower(preg_replace('/[^a-z0-9]/i', '', $code));
    return sodium_crypto_generichash($clean, '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
}

function crypt_seal(string $plain, string $key): string {
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return CRYPT_PREFIX . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $key));
}

function crypt_open(string $stored, string $key): ?string {
    if (!str_starts_with($stored, CRYPT_PREFIX)) return null;
    $raw = base64_decode(substr($stored, strlen(CRYPT_PREFIX)), true);
    $n = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
    if ($raw === false || strlen($raw) < $n + SODIUM_CRYPTO_SECRETBOX_MACBYTES) return null;
    $plain = sodium_crypto_secretbox_open(substr($raw, $n), substr($raw, 0, $n), $key);
    return $plain === false ? null : $plain;
}

// the key for whoever we're working for right now. php-fpm reads
// it off the cookie, one user per request so a static is fine.
// the consolidation worker has no cookie, it binds the key it got
// pushed (key_push below) before each user's run and unbinds after.
function crypt_bind(?string $dek): void {
    crypt_key($dek, true);
}

function crypt_key(?string $dek = null, bool $bind = false): ?string {
    static $key = null;
    if ($bind) {
        if ($key !== null) sodium_memzero($key);
        $key = $dek;
        return null;
    }
    if ($key === null && isset($_COOKIE['omega_key'])) {
        $raw = base64_decode((string)$_COOKIE['omega_key'], true);
        if ($raw !== false && strlen($raw) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) $key = $raw;
    }
    return $key;
}

// enc/dec for anything with his words in it: message content,
// titles, summaries, prefs, the welcome queue, every memory file.
// dec passes a value without the v1: prefix straight through, that
// is how rows from before migration 016 keep reading until
// crypt_encrypt_backlog rewrites them, and how the <audio>
// placeholder chat.php stores unencrypted stays matchable by
// conversations.php set_audio_text. a v1: value that won't open
// under the bound key throws instead of coming back as garbage, a
// wrong key must never turn into a blank prompt.
function enc(?string $plain): ?string {
    if ($plain === null) return null;
    $key = crypt_key();
    if ($key === null) throw new RuntimeException('no_data_key');
    return crypt_seal($plain, $key);
}

function dec(?string $stored): ?string {
    if ($stored === null || !str_starts_with($stored, CRYPT_PREFIX)) return $stored;
    $key = crypt_key();
    if ($key === null) throw new RuntimeException('no_data_key');
    $plain = crypt_open($stored, $key);
    if ($plain === null) throw new RuntimeException('data_key_mismatch');
    return $plain;
}

// the consolidation worker is a separate process with no cookie,
// so every activity touch hands it this user's key over localhost.
// it keeps the key in RAM until the idle run for that user is
// done, then drops it. no worker listening = nothing happens, he
// gets consolidated after the next touch that finds one. any
// local process can connect and push junk, which only makes that
// user's next run fail to open his rows until a real touch
// overwrites it seconds later. nothing can be read back out.
function key_push_port(): int {
    return (int)env_str('OMEGA_KEY_PORT', '9099');
}

function key_push(int $userId): void {
    if (PHP_SAPI === 'cli') return;
    $key = crypt_key();
    if ($key === null) return;
    $sock = @stream_socket_client('tcp://127.0.0.1:' . key_push_port(), $errno, $errstr, 0.2);
    if ($sock === false) return;
    fwrite($sock, json_encode(['user_id' => $userId, 'dek' => base64_encode($key)]) . "\n");
    fclose($sock);
}

// every login retries the backlog pass in case migration 016's
// first sign-in failed after saving the key. values with the v1:
// prefix stay as they are.
function crypt_encrypt_backlog(int $userId): void {
    $db = db();
    $db->beginTransaction();
    try {
        $rows = $db->prepare(
            'SELECT m.id, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ?'
        );
        $rows->execute([$userId]);
        $up = $db->prepare('UPDATE messages SET content = ? WHERE id = ?');
        foreach ($rows->fetchAll() as $r) {
            if ($r['content'] === '<audio>' || str_starts_with((string)$r['content'], CRYPT_PREFIX)) continue;
            $up->execute([enc((string)$r['content']), (int)$r['id']]);
        }

        $rows = $db->prepare('SELECT id, title, summary FROM conversations WHERE user_id = ?');
        $rows->execute([$userId]);
        $up = $db->prepare('UPDATE conversations SET title = ?, summary = ? WHERE id = ?');
        foreach ($rows->fetchAll() as $r) {
            $seal = fn(?string $v) => ($v === null || str_starts_with($v, CRYPT_PREFIX)) ? $v : enc($v);
            $up->execute([$seal($r['title']), $seal($r['summary']), (int)$r['id']]);
        }

        foreach (['preferences' => 'data', 'welcome_queue' => 'messages'] as $table => $col) {
            $row = $db->prepare("SELECT $col FROM $table WHERE user_id = ?");
            $row->execute([$userId]);
            $v = $row->fetchColumn();
            if ($v === false || $v === null || str_starts_with((string)$v, CRYPT_PREFIX)) continue;
            $db->prepare("UPDATE $table SET $col = ? WHERE user_id = ?")->execute([enc((string)$v), $userId]);
        }
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    $res = memory_with_user_lock($userId, function () use ($userId): void {
        memory_migrate_legacy($userId);
        $root = memory_dir();
        $files = array_merge(glob($root . '/user-' . $userId . '/*') ?: [], glob($root . '/user-' . $userId . '.*') ?: []);
        foreach ($files as $path) {
            if (!is_file($path)) continue;
            $raw = (string)@file_get_contents($path);
            if ($raw === '' || str_starts_with($raw, CRYPT_PREFIX)) continue;
            if (@file_put_contents($path, enc($raw), LOCK_EX) === false) {
                throw new RuntimeException('memory_backlog_write_failed');
            }
        }
    });
    if (isset($res['error'])) throw new RuntimeException((string)$res['error']);
}
