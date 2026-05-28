<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');

$action = $_GET['action'] ?? '';

switch ($action) {

    case 'me':
        $user = omega_current_user();
        if (!$user) omega_json_error(401, 'unauthorized');
        echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => $user['role']]]);
        break;

    case 'signup':
        omega_require_post();
        omega_require_content_type('application/json');
        omega_rate_limit('auth_signup', 5, 60);

        $raw  = omega_read_body(4 * 1024);
        $body = json_decode($raw, true);
        if (!is_array($body)) omega_json_error(400, 'invalid_request');

        $email        = trim((string)($body['email'] ?? ''));
        $password     = (string)($body['password'] ?? '');
        $adultConsent = $body['adult_consent'] ?? false;

        if (!preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) {
            omega_json_error(400, 'invalid_email');
        }
        if (strlen($password) < 8) {
            omega_json_error(400, 'password_too_short');
        }
        if ($adultConsent !== true) {
            omega_json_error(400, 'adult_consent_required');
        }

        $db = omega_db();
        $st = $db->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
        $st->execute([$email]);
        if ($st->fetchColumn() !== false) {
            omega_json_error(409, 'email_taken');
        }

        $hash = password_hash($password, PASSWORD_DEFAULT);
        $now  = time();
        $st   = $db->prepare('INSERT INTO users (email, password_hash, role, adult_consent_at, created_at) VALUES (?, ?, ?, ?, ?)');
        $st->execute([$email, $hash, 'user', $now, $now]);
        $userId = (int)$db->lastInsertId();

        omega_new_session($userId);
        echo json_encode(['user' => ['id' => $userId, 'email' => $email, 'role' => 'user']]);
        break;

    case 'login':
        omega_require_post();
        omega_require_content_type('application/json');
        omega_rate_limit('auth_login', 10, 60);

        $raw  = omega_read_body(4 * 1024);
        $body = json_decode($raw, true);
        if (!is_array($body)) omega_json_error(400, 'invalid_request');

        $email    = trim((string)($body['email'] ?? ''));
        $password = (string)($body['password'] ?? '');

        $db = omega_db();
        $st = $db->prepare('SELECT * FROM users WHERE email = ? LIMIT 1');
        $st->execute([$email]);
        $user = $st->fetch();

        if (!$user || !password_verify($password, $user['password_hash'])) {
            omega_json_error(401, 'invalid_credentials');
        }

        // Prune sessions older than 30 days for this user.
        $db->prepare('DELETE FROM sessions WHERE user_id = ? AND created_at < ?')
           ->execute([$user['id'], time() - 30 * 86400]);

        omega_new_session((int)$user['id']);
        echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => $user['role']]]);
        break;

    case 'logout':
        omega_require_post();
        $token = $_COOKIE['omega_session'] ?? '';
        if ($token !== '') {
            omega_db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([$token]);
        }
        $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        setcookie('omega_session', '', [
            'expires'  => 1,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => $secure,
        ]);
        echo json_encode(['ok' => true]);
        break;

    default:
        omega_json_error(400, 'unknown_action');
}
