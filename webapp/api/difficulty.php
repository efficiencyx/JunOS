<?php
require_once __DIR__ . '/lib/bootstrap.php';

$user = require_user();
rate_limit('difficulty', 60, 60);
$userId = (int)$user['id'];
$action = $_GET['action'] ?? '';

function difficulty_status(int $userId): array {
    $ban = ban_active($userId);
    return [
        'level' => difficulty_level($userId),
        'bans' => flee_bans_enabled(),
        'strikes' => ban_strikes($userId),
        'until' => $ban['until'] ?? 0,
        'blocked' => $ban['blocked'] ?? false,
    ];
}

function difficulty_farewell(int $userId): array {
    $db = db();
    $one = function (string $sql) use ($db, $userId) {
        $st = $db->prepare($sql);
        $st->execute([$userId]);
        $v = $st->fetchColumn();
        $st->closeCursor();
        return $v;
    };
    $first = (int)($one('SELECT MIN(created_at) FROM conversations WHERE user_id=?') ?: $one('SELECT created_at FROM users WHERE id=?'));
    try {
        $memories = array_column(memory_list($userId), 'memory');
    } catch (Throwable $e) {
        $memories = [];
    }
    return [
        'reason' => ban_active($userId)['reason'] ?? '',
        'days' => $first > 0 ? max(1, intdiv(time() - $first, 86400)) : 1,
        'messages' => (int)$one('SELECT COUNT(*) FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)'),
        'walkouts' => (int)$one("SELECT COUNT(*) FROM relationship_history WHERE user_id=? AND event='walkout'"),
        'peak' => (int)($one('SELECT MAX(affection) FROM relationship_history WHERE user_id=?') ?: RELATIONSHIP_DEFAULTS['affection']),
        'affection' => relationship_get($userId)['affection'],
        'memories' => $memories,
    ];
}

function ban_patch(int $userId, array $set): void {
    $row = ban_row($userId) ?? ['until' => 0, 'strikes' => 0, 'last_ban' => time(), 'reason' => null, 'blocked' => 0];
    $row = array_merge($row, $set);
    db()->prepare(
        'INSERT INTO user_bans (user_id, until, strikes, last_ban, reason, blocked) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET until=excluded.until, strikes=excluded.strikes,
                                            last_ban=excluded.last_ban, blocked=excluded.blocked'
    )->execute([$userId, (int)$row['until'], (int)$row['strikes'], (int)$row['last_ban'], $row['reason'], (int)$row['blocked']]);
}

if (require_method('GET', 'POST') === 'GET') {
    if ($action !== 'farewell') json_out(difficulty_status($userId));
    if (!ban_blocked($userId) && !is_admin($user)) fail(403, 'forbidden');
    json_out(difficulty_farewell($userId));
}

$body = read_json_body(1024);
$level = (string)($body['level'] ?? '');

if ($action === 'pick') {
    if (!isset(DIFFICULTY[$level])) fail(400, 'invalid_request');
    if (!difficulty_pick($userId, $level)) fail(409, 'already_picked');
    json_out(difficulty_status($userId));
}

require_admin();
$blocked = (int)(ban_row($userId)['blocked'] ?? 0) === 1;
switch ($action) {
    case 'level':
        if (!difficulty_pick($userId, $level, true)) fail(400, 'invalid_request');
        break;
    case 'strike':
        ban_patch($userId, ['strikes' => max(0, ban_strikes($userId) + ((int)($body['delta'] ?? 0) < 0 ? -1 : 1)), 'last_ban' => time()]);
        break;
    case 'lift':
    case 'skip':
        if ($blocked) ban_patch($userId, ['blocked' => 0, 'until' => 0, 'strikes' => 2, 'last_ban' => time()]);
        elseif ($action === 'lift') ban_patch($userId, ['until' => 0]);
        else ban_patch($userId, ['until' => min((int)(ban_row($userId)['until'] ?? 0), time() + 3)]);
        break;
    default:
        fail(400, 'invalid_request');
}
json_out(difficulty_status($userId));
