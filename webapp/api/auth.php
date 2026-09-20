<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');

function user_keys_mint(string $password): array {
    $dek = random_bytes(SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
    $salt = random_bytes(SODIUM_CRYPTO_PWHASH_SALTBYTES);
    $code = crypt_recovery_code_new();
    return [
        'dek' => $dek,
        'kdf_salt' => base64_encode($salt),
        'wrapped_dek' => crypt_seal($dek, crypt_kdf($password, $salt)),
        'recovery_wrapped_dek' => crypt_seal($dek, crypt_recovery_key($code)),
        'recovery_code' => $code,
    ];
}

switch ($_GET['action'] ?? '') {

case 'me':
    $user = current_user();
    if (!$user) fail(401, 'unauthorized');
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => (string)($user['role'] ?? 'user')]]);
    break;

case 'signup_info':
    echo json_encode([
        'registration_key_required' => env_str('OMEGA_REGISTRATION_KEY') !== '' && !no_users_yet(),
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
    $keys = user_keys_mint($password);

    // empty users table = fresh install, so the very first signup
    // skips the key. otherwise whoever just ran install.sh has to go
    // dig the generated key out of .env to make their own account, on
    // their own box. no.
    // BEGIN IMMEDIATE takes the write lock before the check, so two
    // signups racing on a fresh box can't both see an empty table
    // and both walk past the key. fail() exits, sqlite rolls back.
    $db->exec('BEGIN IMMEDIATE');
    $regKey = env_str('OMEGA_REGISTRATION_KEY');
    if ($regKey !== '' && !no_users_yet()) {
        $given = (string)($body['registration_key'] ?? '');
        if ($given === '') fail(403, 'registration_closed');
        if (!hash_equals($regKey, $given)) fail(403, 'invalid_registration_key');
    }

    $st = $db->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $st->execute([$email]);
    if ($st->fetchColumn() !== false) fail(409, 'email_taken');

    $now = time();
    $db->prepare(
        'INSERT INTO users (email, password_hash, role, adult_consent_at, created_at, kdf_salt, wrapped_dek, recovery_wrapped_dek)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([$email, password_hash($password, PASSWORD_DEFAULT), 'user', $now, $now,
                $keys['kdf_salt'], $keys['wrapped_dek'], $keys['recovery_wrapped_dek']]);
    $userId = (int)$db->lastInsertId();
    $db->exec('COMMIT');

    start_session($userId, $keys['dek']);
    echo json_encode(['user' => ['id' => $userId, 'email' => $email, 'role' => 'user'], 'recovery_code' => $keys['recovery_code']]);
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

    $out = ['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => (string)($user['role'] ?? 'user')]];
    if ($user['wrapped_dek'] === null) {
        // account from before migration 016. mint its key now and
        // seal what it already has, the recovery code goes back in
        // this one response like it does on signup.
        $keys = user_keys_mint($password);
        $db->prepare('UPDATE users SET kdf_salt = ?, wrapped_dek = ?, recovery_wrapped_dek = ? WHERE id = ?')
           ->execute([$keys['kdf_salt'], $keys['wrapped_dek'], $keys['recovery_wrapped_dek'], $user['id']]);
        $dek = $keys['dek'];
        $out['recovery_code'] = $keys['recovery_code'];
    } else {
        $dek = crypt_open((string)$user['wrapped_dek'], crypt_kdf($password, base64_decode((string)$user['kdf_salt'])));
        if ($dek === null) {
            log_event(['msg' => 'data_key_unwrap_failed', 'user_id' => $user['id']]);
            fail(500, 'data_key_unavailable');
        }
    }

    crypt_bind($dek);
    crypt_encrypt_backlog((int)$user['id']);
    start_session((int)$user['id'], $dek);
    echo json_encode($out);
    break;

// forgot the password: the recovery code opens the same data key,
// so we rewrap it under the new password and nothing on disk has
// to be re-encrypted. the code itself stays valid.
case 'recover':
    require_post();
    require_content_type('application/json');
    rate_limit('auth_recover', 5, 3600);

    $body = json_decode(read_body(4 * 1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $email = trim((string)($body['email'] ?? ''));
    $code = (string)($body['recovery_code'] ?? '');
    $password = (string)($body['password'] ?? '');
    if (strlen($password) < 8) fail(400, 'password_too_short');

    $db = db();
    $st = $db->prepare('SELECT * FROM users WHERE email = ? LIMIT 1');
    $st->execute([$email]);
    $user = $st->fetch();
    $dek = $user && $user['recovery_wrapped_dek'] !== null
        ? crypt_open((string)$user['recovery_wrapped_dek'], crypt_recovery_key($code))
        : null;
    if ($dek === null) {
        log_event(['msg' => 'recover_failed', 'email' => $email]);
        fail(401, 'invalid_recovery_code');
    }

    $salt = random_bytes(SODIUM_CRYPTO_PWHASH_SALTBYTES);
    $db->prepare('UPDATE users SET password_hash = ?, kdf_salt = ?, wrapped_dek = ? WHERE id = ?')
       ->execute([password_hash($password, PASSWORD_DEFAULT), base64_encode($salt),
                  crypt_seal($dek, crypt_kdf($password, $salt)), $user['id']]);
    $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$user['id']]);
    log_event(['msg' => 'password_recovered', 'user_id' => $user['id']]);

    start_session((int)$user['id'], $dek);
    echo json_encode(['user' => ['id' => $user['id'], 'email' => $user['email'], 'role' => (string)($user['role'] ?? 'user')]]);
    break;

case 'promote':
    require_post();
    require_content_type('application/json');
    rate_limit('auth_promote', 5, 3600);

    $user = require_user();
    $body = json_decode(read_body(4 * 1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $key = env_str('OMEGA_DEV_KEY');
    if ($key === '') fail(403, 'dev_promotion_disabled');
    if (!hash_equals($key, (string)($body['key'] ?? ''))) {
        log_event(['msg' => 'admin_promote_failed', 'user_id' => $user['id']]);
        fail(403, 'invalid_dev_key');
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
                  'user_bans', 'wardrobe_presets', 'wardrobe_state', 'welcome_queue'] as $table) {
            $db->prepare('DELETE FROM ' . $table . ' WHERE user_id = ?')->execute([$userId]);
        }
        $token = (string)($_COOKIE['omega_session'] ?? '');
        $db->prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
           ->execute([$userId, session_token_hash($token)]);
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
        db()->prepare('DELETE FROM sessions WHERE token = ?')
            ->execute([session_token_hash($token)]);
    }
    $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    foreach (['omega_session', 'omega_key'] as $cookie) {
        setcookie($cookie, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => $secure]);
    }
    echo json_encode(['ok' => true]);
    break;

default:
    fail(400, 'unknown_action');
}
