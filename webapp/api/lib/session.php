<?php

function current_user(): ?array {
    // false until we've looked. null once we know there's no session.
    static $user = false;
    if ($user !== false) return $user;

    $token = $_COOKIE['omega_session'] ?? '';
    if ($token === '') return $user = null;

    // we store sha256(cookie) so a stolen omega.sqlite can't sign
    // anyone in. NEVER also accept a raw stored token. both are 64
    // hex chars, so that fallback would take the stored hash itself
    // as a valid cookie. migration 014 deleted the old sessions,
    // everyone had to sign in once.
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

function is_admin(array $user): bool {
    return ($user['role'] ?? '') === 'admin';
}

function require_admin(): array {
    $user = require_user();
    if (!is_admin($user)) fail(403, 'forbidden');
    return $user;
}

// what the browser gets to see of an account
function user_public(array $user): array {
    return ['id' => $user['id'], 'email' => $user['email'], 'role' => (string)($user['role'] ?? 'user')];
}

function start_session(int $userId, string $dek): string {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $expires = $now + 30 * 86400;
    db()->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        ->execute([session_token_hash($token), $userId, $now, $expires]);

    session_cookies($token, base64_encode($dek), $expires);
    return $token;
}

// Strict, NOT Lax. nothing links into this app from outside so
// there's no cross-site navigation that needs the cookie, and Lax
// would still send it on a top level GET some other page shoved
// us into. logout clears them through here too, so the two sets
// of attributes can't drift apart again (they did, Lax vs Strict).
function session_cookies(string $session, string $key, int $expires): void {
    $attrs = [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => request_is_https(),
    ];
    setcookie('omega_session', $session, $attrs);
    setcookie('omega_key', $key, $attrs);
}

function session_token_hash(string $token): string {
    return hash('sha256', $token);
}
