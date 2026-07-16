<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');

switch ($_GET['action'] ?? '') {

case 'me':
    $user = current_user();
    if (!$user) fail(401, 'unauthorized');
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email']]]);
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
    $st = $db->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $st->execute([$email]);
    if ($st->fetchColumn() !== false) fail(409, 'email_taken');

    $now = time();
    $db->prepare('INSERT INTO users (email, password_hash, role, adult_consent_at, created_at) VALUES (?, ?, ?, ?, ?)')
       ->execute([$email, password_hash($password, PASSWORD_DEFAULT), 'user', $now, $now]);
    $userId = (int)$db->lastInsertId();

    start_session($userId);
    echo json_encode(['user' => ['id' => $userId, 'email' => $email]]);
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
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email']]]);
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
