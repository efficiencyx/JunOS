<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');

switch ($_GET['action'] ?? '') {

case 'me':
    $user = current_user();
    if (!$user) fail(401, 'unauthorized');
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => (string)($user['role'] ?? 'user')]]);
    break;

case 'signup_info':
    echo json_encode([
        'registration_key_required' => env_str('OMEGA_REGISTRATION_KEY') !== ''
            && (int)db()->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0,
    ]);
    break;

case 'signup':
    require_post();
    require_content_type('application/json');
    rate_limit('auth_signup', 5, 60);

    $body = json_decode(read_body(4 * 1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $email = trim((string)($body['email'] ?? ''));
    $password = (string)($body['password'] ?? '');

    if (!preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) fail(400, 'invalid_email');
    if (strlen($password) < 8) fail(400, 'password_too_short');
    if (($body['adult_consent'] ?? false) !== true) fail(400, 'adult_consent_required');

    $db = db();

    // The very first account is always let in, otherwise a fresh install with a
    // key already in .env locks its own owner out.
    $firstUser = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0;
    $regKey = env_str('OMEGA_REGISTRATION_KEY');
    if (!$firstUser && $regKey !== '') {
        $given = (string)($body['registration_key'] ?? '');
        if ($given === '') fail(403, 'registration_closed');
        if (!hash_equals($regKey, $given)) fail(403, 'invalid_registration_key');
    }

    $st = $db->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $st->execute([$email]);
    if ($st->fetchColumn() !== false) fail(409, 'email_taken');

    $now = time();
    $db->prepare('INSERT INTO users (email, password_hash, role, adult_consent_at, created_at) VALUES (?, ?, ?, ?, ?)')
       ->execute([$email, password_hash($password, PASSWORD_DEFAULT), 'user', $now, $now]);
    $userId = (int)$db->lastInsertId();

    start_session($userId);
    echo json_encode(['user' => ['id' => $userId, 'email' => $email, 'role' => 'user']]);
    break;

case 'login':
    require_post();
    require_content_type('application/json');
    rate_limit('auth_login', 10, 60);

    $body = json_decode(read_body(4 * 1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $email = trim((string)($body['email'] ?? ''));
    $password = (string)($body['password'] ?? '');

    $db = db();
    $st = $db->prepare('SELECT * FROM users WHERE email = ? LIMIT 1');
    $st->execute([$email]);
    $user = $st->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        fail(401, 'invalid_credentials');
    }

    $db->prepare('DELETE FROM sessions WHERE user_id = ? AND created_at < ?')
       ->execute([$user['id'], time() - 30 * 86400]);

    start_session((int)$user['id']);
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => (string)($user['role'] ?? 'user')]]);
    break;

case 'promote':
    require_post();
    require_content_type('application/json');
    rate_limit('auth_promote', 5, 3600);

    $user = require_user();
    $body = json_decode(read_body(4 * 1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $key = env_str('OMEGA_ADMIN_KEY');
    if ($key === '') fail(403, 'admin_promotion_disabled');
    if (!hash_equals($key, (string)($body['key'] ?? ''))) {
        log_event(['msg' => 'admin_promote_failed', 'user_id' => $user['id']]);
        fail(403, 'invalid_admin_key');
    }

    db()->prepare("UPDATE users SET role = 'admin' WHERE id = ?")->execute([$user['id']]);
    log_event(['msg' => 'admin_promoted', 'user_id' => $user['id']]);
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => 'admin']]);
    break;

case 'factory_reset':
    require_post();
    rate_limit('auth_factory_reset', 3, 3600);

    $user = require_user();
    $userId = (int)$user['id'];
    $db = db();

    $db->beginTransaction();
    try {
        $db->prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)')
           ->execute([$userId]);
        foreach (['conversations', 'preferences', 'relationship', 'memory_consolidation',
                  'user_bans', 'wardrobe_presets', 'welcome_queue'] as $table) {
            $db->prepare('DELETE FROM ' . $table . ' WHERE user_id = ?')->execute([$userId]);
        }
        $db->prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
           ->execute([$userId, $_COOKIE['omega_session'] ?? '']);
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        log_event(['msg' => 'factory_reset_db_failed', 'user_id' => $userId, 'err' => $e->getMessage()]);
        fail(500, 'factory_reset_incomplete');
    }

    try {
        $res = memory_wipe_user($userId);
    } catch (RuntimeException $e) {
        $res = ['error' => $e->getMessage()];
    }
    if (isset($res['error'])) {
        log_event(['msg' => 'factory_reset_memory_failed', 'user_id' => $userId, 'err' => $res['error']]);
        fail(500, 'factory_reset_incomplete');
    }
    log_event(['msg' => 'factory_reset', 'user_id' => $userId]);
    echo json_encode(['ok' => true]);
    break;

case 'logout':
    require_post();
    $token = $_COOKIE['omega_session'] ?? '';
    if ($token !== '') {
        db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([$token]);
    }
    $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    setcookie('omega_session', '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => $secure]);
    echo json_encode(['ok' => true]);
    break;

default:
    fail(400, 'unknown_action');
}
