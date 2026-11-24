<?php

// every play lands as it's made. her call stands on limits and on
// anything he never said, the rest of his sorting is real

const CABINET_DRAWERS = [
    'likes' => 'preferences',
    'work' => 'work',
    'health' => 'health',
    'family' => 'family',
    'plans' => 'plans',
    'limits' => 'boundaries',
    'happened' => 'events',
    'shred' => null,
];
const CABINET_AGREED_PER_TRUST = 5;
const CABINET_TRUST_PER_PASS = 3;
const CABINET_TRUST_PER_DAY = 6;
const CABINET_MAX_PLAYS = 500;
const CABINET_DECK_NOTES = 30;
// "waited" only counts if the pass he waited for really finished
const CABINET_WAIT_WINDOW = 300;
// she keeps these out of his reach in the game: a limit stays a
// limit, and a health note only goes away when she says so
const CABINET_UNMOVABLE = ['boundaries'];
const CABINET_UNSHREDDABLE = ['boundaries', 'health'];

function cabinet_game_path(int $userId): string {
    return dirname(consolidation_lock_path($userId)) . '/user-' . $userId . '.game';
}

function cabinet_game_load(int $userId): array {
    $raw = @file_get_contents(cabinet_game_path($userId));
    $state = $raw === false ? null : json_decode((string)dec($raw), true);
    return is_array($state) ? $state : ['agreed' => 0, 'total' => 0, 'streak' => 0, 'best' => 0, 'filed' => 0, 'shredded' => 0, 'played' => []];
}

function cabinet_game_save(int $userId, array $state): void {
    $path = cabinet_game_path($userId);
    @file_put_contents($path, enc(json_encode($state, JSON_UNESCAPED_UNICODE)), LOCK_EX);
    @chmod($path, 0600);
}

// a dropped or changed card is a feed event of THIS pass, found by its cursor
function cabinet_feed_event(int $userId, string $ref): ?array {
    [$events] = consolidation_feed_read($userId, '');
    foreach ($events as $event) if (($event['cursor'] ?? '') === $ref) return $event;
    return null;
}

function cabinet_note(int $userId, string $id): ?array {
    foreach (memory_notes_load($userId) as $category => $data) {
        foreach ($data['notes'] as $note) if ($note['id'] === $id) return $note + ['category' => $category];
    }
    return null;
}

function cabinet_file_note(int $userId, array $note, string $drawer, array &$state): ?string {
    $target = CABINET_DRAWERS[$drawer];
    if ($target === null) {
        if (in_array($note['category'], CABINET_UNSHREDDABLE, true)) return $note['category'] === 'boundaries' ? 'limit' : 'health';
        memory_note_flag($userId, $note['id'], 'doubted', time());
        return 'doubted';
    }
    $state['filed']++;
    if ($target === $note['category']) return null;
    if (in_array($note['category'], CABINET_UNMOVABLE, true)) return 'limit';
    memory_note_move($userId, $note['id'], $target);
    return 'moved';
}

function cabinet_undo(int $userId, array $event): string {
    $note = cabinet_note($userId, (string)$event['id']);
    if (!$note || $note['text'] !== $event['text']) return 'already_changed';
    $before = (string)($event['before'] ?? $event['was'] ?? '');
    if ($before === '' || empty(memory_note_edit($userId, $note['id'], $before, ['kind' => 'cabinet'])['ok'])) return 'already_changed';
    foreach ((array)($event['gone'] ?? []) as $gone) memory_note_add($userId, $note['category'], (string)$gone, ['kind' => 'cabinet']);
    return 'undone';
}

function cabinet_play(int $userId, array $body): array {
    $kind = (string)($body['kind'] ?? '');
    $drawer = (string)($body['drawer'] ?? '');
    if (!array_key_exists($drawer, CABINET_DRAWERS)) return ['error' => 'bad_drawer'];
    $state = cabinet_game_load($userId);
    if (count($state['played']) >= CABINET_MAX_PLAYS) return ['error' => 'too_many'];
    $key = $kind . ':' . (string)($body['id'] ?? $body['ref'] ?? '');
    if ($kind !== 'junk' && in_array($key, $state['played'], true)) return ['error' => 'already_played'];

    $reaction = null;
    $agreed = false;
    if ($kind === 'junk') {
        if ($drawer === 'shred') $state['shredded']++;
        else $reaction = 'junk';
    } elseif ($kind === 'note') {
        $note = cabinet_note($userId, (string)($body['id'] ?? ''));
        if (!$note) return ['error' => 'gone'];
        $reaction = cabinet_file_note($userId, $note, $drawer, $state);
        $agreed = $reaction === null;
        memory_note_flag($userId, $note['id'], 'game_seen', time());
    } elseif ($kind === 'dropped' || $kind === 'changed') {
        $event = cabinet_feed_event($userId, (string)($body['ref'] ?? ''));
        $want = $kind === 'dropped' ? ['dropped'] : ['updated', 'merged'];
        if (!$event || ($event['type'] ?? '') !== 'note' || !in_array($event['action'] ?? '', $want, true) || !empty($event['dry'])) return ['error' => 'gone'];
        if ($kind === 'dropped' && $drawer === 'shred') {
            $agreed = true;
        } elseif ($kind === 'dropped') {
            // true but passing is his call. made up is not
            $reaction = ($event['why'] ?? '') === 'passing' ? 'rescued' : 'never_said';
            if ($reaction === 'rescued') memory_note_add($userId, CABINET_DRAWERS[$drawer], (string)$event['text'], ['kind' => 'cabinet']);
        } elseif ($drawer === 'shred') {
            $reaction = cabinet_undo($userId, $event);
        } else {
            $note = cabinet_note($userId, (string)$event['id']);
            if (!$note) return ['error' => 'gone'];
            $reaction = cabinet_file_note($userId, $note, $drawer, $state);
            $agreed = $reaction === null;
        }
    } else {
        return ['error' => 'bad_kind'];
    }

    if ($kind !== 'junk') {
        $state['played'][] = $key;
        $state['total']++;
        if ($agreed) {
            $state['agreed']++;
            $state['best'] = max($state['best'], ++$state['streak']);
        } else {
            $state['streak'] = 0;
        }
    }
    cabinet_game_save($userId, $state);
    return ['reaction' => $reaction, 'agreed' => $agreed];
}

// this pass's dropped and changed cards, then notes he hasn't sorted yet
function cabinet_deck(int $userId): array {
    [$events] = consolidation_feed_read($userId, '');
    $dropped = $changed = [];
    foreach ($events as $e) {
        if (($e['type'] ?? '') !== 'note' || !empty($e['dry'])) continue;
        if (($e['action'] ?? '') === 'dropped' && in_array($e['why'] ?? '', ['passing', 'not_said'], true)) {
            $dropped[] = ['ref' => $e['cursor'], 'text' => $e['text']];
        } elseif (in_array($e['action'] ?? '', ['updated', 'merged'], true)) {
            $changed[] = ['ref' => $e['cursor'], 'id' => $e['id'], 'category' => $e['category'], 'text' => $e['text'], 'was' => $e['before'] ?? $e['was'] ?? ''];
        }
    }
    $meta = memory_meta_load($userId)['notes'] ?? [];
    $notes = [];
    foreach (memory_notes_load($userId) as $category => $data) {
        if (!in_array($category, CABINET_DRAWERS, true)) continue;
        foreach ($data['notes'] as $note) {
            $m = $meta[$note['id']] ?? [];
            if ((int)($m['game_seen'] ?? 0) >= (int)($m['updated'] ?? $note['updated'])) continue;
            $notes[] = ['id' => $note['id'], 'category' => $category, 'text' => $note['text']];
        }
    }
    shuffle($notes);
    return ['dropped' => $dropped, 'changed' => $changed, 'notes' => array_slice($notes, 0, CABINET_DECK_NOTES)];
}

function cabinet_settle(int $userId, array $body): array {
    $state = cabinet_game_load($userId);
    @unlink(cabinet_game_path($userId));

    ach_add($userId, 'cab_filed', $state['filed']);
    ach_add($userId, 'cab_shredded', $state['shredded']);
    if ($state['best'] > 0) ach_max($userId, 'cab_streak', $state['best']);

    if (!empty($body['waited'])) {
        $stmt = db()->prepare('SELECT last_run, last_status FROM memory_consolidation WHERE user_id = ?');
        $stmt->execute([$userId]);
        $last = $stmt->fetch();
        $stmt->closeCursor();
        if ($last && $last['last_status'] === 'ok' && (int)$last['last_run'] >= time() - CABINET_WAIT_WINDOW) {
            ach_add($userId, 'cab_waited');
        }
    }

    $trust = min(CABINET_TRUST_PER_PASS, intdiv($state['agreed'], CABINET_AGREED_PER_TRUST));
    if ($trust > 0) {
        $day = intdiv(ach_local_time((int)($body['tz'] ?? 0)), 86400);
        $stmt = db()->prepare('SELECT game_day, game_trust FROM memory_consolidation WHERE user_id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch() ?: ['game_day' => 0, 'game_trust' => 0];
        $stmt->closeCursor();
        $given = (int)$row['game_day'] === $day ? (int)$row['game_trust'] : 0;
        $trust = min($trust, CABINET_TRUST_PER_DAY - $given);
        if ($trust > 0) {
            db()->prepare('UPDATE memory_consolidation SET game_day = ?, game_trust = ? WHERE user_id = ?')
                ->execute([$day, $given + $trust, $userId]);
            relationship_apply($userId, relationship_get($userId), ['trust' => $trust]);
        }
    }

    return ['agreed' => $state['agreed'], 'total' => $state['total']];
}
