<?php

function current_user(): ?array {
    // false until we've looked. null once we know there's no session.
    static $user = false;
    if ($user !== false) return $user;

    $token = $_COOKIE['omega_session'] ?? '';
    if ($token === '') return $user = null;

    // store sha256(cookie) so a stolen omega.sqlite cannot
    // authenticate. NEVER also accept raw stored tokens: both are 64
    // hex chars, making that fallback accept the hash as a cookie.
    // migration 014 deletes old sessions and requires one sign-in.
    $stmt = db()->prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
    );
    $stmt->execute([session_token_hash($token), time()]);
    $user = $stmt->fetch() ?: null;
    // a session without its omega_key cookie can't read a single
    // row, so it counts as signed out. re-login mints the cookie.
    if ($user !== null && crypt_key() === null) $user = null;
    return $user;
}

function require_user(): array {
    $user = current_user();
    if ($user === null) fail(401, 'unauthorized');
    // default for anything behind a session: chats, memory, prefs,
    // her voice. the few endpoints that want caching (models,
    // voices, assets) set their own header after this and win.
    header('Cache-Control: no-store');
    return $user;
}

function require_admin(): array {
    $user = require_user();
    if (($user['role'] ?? '') !== 'admin') fail(403, 'forbidden');
    return $user;
}

function start_session(int $userId, string $dek): string {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $expires = $now + 30 * 86400;
    db()->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        ->execute([session_token_hash($token), $userId, $now, $expires]);

    $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    // Strict, NOT Lax. nothing links into this app from outside so
    // there's no cross-site navigation that needs the cookie, and Lax
    // would still send it on a top level GET some other page shoved
    // us into.
    $attrs = [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => $secure,
    ];
    setcookie('omega_session', $token, $attrs);
    setcookie('omega_key', base64_encode($dek), $attrs);
    return $token;
}

function session_token_hash(string $token): string {
    return hash('sha256', $token);
}
