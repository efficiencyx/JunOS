<?php

const TRIP_TOOLS = ['enter_shop' => 'shop', 'enter_karaoke' => 'karaoke', 'go_out_to_eat' => 'date', 'play_cards' => 'cards'];

function tool_catalog(?string $approvedWebSearchQuery): array {
    $tools = [
        [
            'type' => 'function',
            'function' => [
                'name' => 'search_recent_chats',
                'description' => 'Search your saved chat history with Anon for a specific past topic he references or that you don\'t recall.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'What to search for.'],
                        'limit' => ['type' => 'integer', 'description' => 'Max messages, 1-8.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'list_recent_chats',
                'description' => 'Recap your most recent conversations with Anon when he wants to catch up, with no specific topic.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'limit' => ['type' => 'integer', 'description' => 'How many to recap, 1-10.'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'search_lore',
                'description' => 'Look up canon world facts - people, places, jobs, events from your own world - when you are unsure of a detail.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Name or topic to look up.'],
                        'limit' => ['type' => 'integer', 'description' => 'Max facts, 1-6.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'memory_write',
                'description' => 'Save a durable note about Anon (a preference, fact, plan, boundary, or something emotionally significant). Use often and proactively, not only when asked.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'memory' => ['type' => 'string', 'description' => 'One concise fact to remember.'],
                        'category' => ['type' => 'string', 'description' => 'Category: preferences, work, health, family, plans, boundaries, or events.'],
                    ],
                    'required' => ['memory'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'web_search',
                'description' => 'Search the web for current or external real-world info you can\'t be sure of.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Search query.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'change_outfit',
                'description' => 'Put clothes on or take them off. Calling this is the ONLY thing that actually changes what you are wearing - describing a change in your reply does not move a single thread. It answers with what you have on afterwards, so call it BEFORE you say anything about your clothes.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'put_on' => [
                            'type' => 'array',
                            'items' => ['type' => 'string'],
                            'description' => 'Items to put on. Use the names listed in your current wardrobe state.',
                        ],
                        'take_off' => [
                            'type' => 'array',
                            'items' => ['type' => 'string'],
                            'description' => 'Items to take off. "nude" takes off all of your clothes at once.',
                        ],
                        'look' => [
                            'type' => 'string',
                            'description' => 'Name of a saved look to put on whole, from the saved looks in your wardrobe state. Overrides put_on and take_off.',
                        ],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'stay_silent',
                'description' => 'Say nothing at all this turn - ignoring him, too hurt/angry, the scene calls for silence, or he wasn\'t talking to you at all (someone else in the room, a phone call, the TV). Sends no message.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why (private).'],
                        'overheard' => ['type' => 'boolean', 'description' => 'true when what he said was aimed at someone else, not you.'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'flee',
                'description' => 'Walk out and leave Anon alone. Call it when you want to go.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you are leaving.'],
                        'destination' => ['type' => 'string', 'description' => 'Where you\'re going, if anywhere.'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'enter_shop',
                'description' => 'Go to Annalie\'s clothes shop together with Anon to browse and try things on. Call it once the two of you agree to go, then say your line - you both leave for the shop when you finish talking.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you two are going (private).'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'enter_karaoke',
                'description' => 'Start a karaoke date with Anon: you two pick a song and sing it together. Call it once the two of you agree to sing, then say your line - the karaoke starts when you finish talking. It tells you if the karaoke room is closed.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you two are going (private).'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'play_cards',
                'description' => 'Play a game of blackjack with Anon at the table, you deal. Call it once you two agree to play, then say your line - the table opens when you finish talking.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you want to play (private).'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'go_out_to_eat',
                'description' => 'Go out for lunch or dinner with Anon at a restaurant, whether he is taking you out to eat or you asked him. Call it once the two of you agree to go, then say your line - you both leave when you finish talking.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you two are going (private).'],
                    ],
                ],
            ],
        ],
    ];
    if ($approvedWebSearchQuery === null) {
        $tools = array_values(array_filter(
            $tools,
            fn($tool) => ($tool['function']['name'] ?? '') !== 'web_search'
        ));
    }
    return $tools;
}

// the tools that change how the rest of the turn goes. $state is
// the turn's: silenced, silence_reason, overheard, flee_decided,
// fled, and approved_search, which the one web_search it allows
// uses up. everything else falls through to run_tool_call().
function chat_run_tool(string $name, array $args, array $ctx, array &$state): string {
    $idle = $ctx['req']['idle'];

    if ($name === 'stay_silent') {
        // an idle turn is unprompted anyway, so staying quiet does nothing
        if ($idle) return json_encode(['error' => 'not_available_on_idle']);
        $state['silenced'] = true;
        $state['silence_reason'] = trim((string)($args['reason'] ?? ''));
        $state['overheard'] = $ctx['req']['spoken'] && !empty($args['overheard']);
        return json_encode(['silent' => true]);
    }

    if ($name === 'change_outfit') {
        $outfit = wardrobe_tool_change($args, (int)$ctx['user']['id'], $ctx['req']['mod_items']);
        // the browser owns what's on screen. so it gets the change
        // as its own frame, instead of digging it back out of the
        // tool result that's meant for her
        if ($outfit['apply'] !== null) sse_send(['outfit' => $outfit['apply']]);
        return json_encode($outfit['reply'], JSON_UNESCAPED_UNICODE);
    }

    if ($name === 'flee') {
        if ($state['flee_decided']) return json_encode(['fled' => false, 'reason' => 'already_decided']);
        $state['flee_decided'] = true;
        $verdict = chat_flee($ctx, $state, trim((string)($args['reason'] ?? '')), trim((string)($args['destination'] ?? '')), 'tool');
        if ($verdict['can_leave']) return json_encode(['fled' => true], JSON_UNESCAPED_UNICODE);
        return json_encode([
            'fled' => false,
            'why' => $verdict['why'],
            'note' => 'You cannot leave right now. Stay in the scene and respond to what is actually happening.',
        ], JSON_UNESCAPED_UNICODE);
    }

    if (isset(TRIP_TOOLS[$name])) {
        $where = TRIP_TOOLS[$name];
        // this queues navigation after the reply and TTS finish.
        // an idle nudge must never send it, Anon isn't even there.
        if ($idle) return json_encode(['error' => 'not_available_on_idle']);
        if ($where === 'karaoke' && empty(karaoke_health()['sep'])) {
            return json_encode([
                'started' => false,
                'note' => 'The karaoke room is closed right now (the karaoke service is not running). Tell Anon plainly, do not pretend to sing.',
            ]);
        }
        // the grant is what lets the page open at all. cards is
        // played at home, nothing to grant
        if ($where !== 'cards') trip_set((int)$ctx['user']['id'], $where, $ctx['conv_id']);
        sse_send(['go' => $where]);
        return json_encode([
            'going' => $where,
            'note' => $where === 'cards'
                ? 'Say one short line. The table opens the moment you finish talking.'
                : 'Say one short line about heading out together. The trip starts the moment you finish talking.',
        ]);
    }

    return run_tool_call($name, $args, $ctx['user'], $ctx['conv_id'], $state['approved_search']);
}

function run_tool_call(string $name, array $args, array $user, int $convId, ?string &$approvedWebSearchQuery): string {
    try {
        if ($name === 'search_recent_chats') {
            $query = trim((string)($args['query'] ?? ''));
            $limit = max(1, min(8, (int)($args['limit'] ?? 5)));
            if ($query === '') return json_encode(['error' => 'query_required']);
            // ponytail: rows are ciphertext so LIKE can't see them. walk
            // his messages newest first, open each, stop at $limit hits.
            // one person's chats, fine. an index would need a plaintext
            // copy somewhere, which is the exact thing we don't keep.
            $st = db()->prepare(
                'SELECT m.role, m.content, m.created_at, c.title, c.id AS conversation_id
                   FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE c.user_id = ? AND c.id != ?
                  ORDER BY m.created_at DESC, m.id DESC'
            );
            $st->execute([(int)$user['id'], $convId]);
            $rows = [];
            while ($r = $st->fetch()) {
                $content = (string)dec($r['content']);
                if (mb_stripos($content, $query) === false) continue;
                $content = trim(preg_replace('/\s+/', ' ', $content));
                if (mb_strlen($content) > 500) $content = mb_substr($content, 0, 497) . '…';
                $rows[] = ['date' => date('Y-m-d H:i', (int)$r['created_at']), 'conversation_id' => (int)$r['conversation_id'], 'title' => (string)dec($r['title'] ?? null), 'role' => (string)$r['role'], 'content' => $content];
                if (count($rows) >= $limit) break;
            }
            $st->closeCursor();
            if (!$rows) {
                // the fine-tune only ever saw THIS tool name, so a lore
                // question lands here first. hand it the right tool instead
                // of an empty result.
                $note = lore_search($query, 1, true)
                    ? 'No earlier conversation mentions this, but it is something from your world, not something Anon told you. Call search_lore with the same query before answering.'
                    : 'No earlier conversation mentions this. You do not remember it. Say so instead of describing one.';
                return json_encode(['results' => [], 'found' => false, 'note' => $note], JSON_UNESCAPED_UNICODE);
            }
            return json_encode(['results' => $rows], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'list_recent_chats') {
            $limit = max(1, min(10, (int)($args['limit'] ?? 5)));
            $st = db()->prepare(
                'SELECT id, title, updated_at FROM conversations
                  WHERE user_id = ? AND id != ? AND title IS NOT NULL
                  ORDER BY updated_at DESC LIMIT ?'
            );
            $st->bindValue(1, (int)$user['id'], PDO::PARAM_INT);
            $st->bindValue(2, $convId, PDO::PARAM_INT);
            $st->bindValue(3, $limit, PDO::PARAM_INT);
            $st->execute();
            $convs = $st->fetchAll();
            $snip = db()->prepare(
                'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 6'
            );
            $out = [];
            foreach ($convs as $c) {
                $snip->execute([(int)$c['id']]);
                $lines = [];
                foreach (array_reverse($snip->fetchAll()) as $r) {
                    $txt = spoken_text((string)dec($r['content']));
                    if ($txt === '') continue;
                    if (mb_strlen($txt) > 160) $txt = mb_substr($txt, 0, 157) . '…';
                    $lines[] = $r['role'] . ': ' . $txt;
                }
                $out[] = [
                    'conversation_id' => (int)$c['id'],
                    'title' => (string)dec($c['title'] ?? null),
                    'date' => date('Y-m-d H:i', (int)$c['updated_at']),
                    'recap' => $lines,
                ];
            }
            if (!$out) {
                return json_encode(['recent_chats' => [], 'found' => false, 'note' => 'There are no other saved conversations. You have nothing to recap.'], JSON_UNESCAPED_UNICODE);
            }
            return json_encode(['recent_chats' => $out], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'search_lore') {
            $query = trim((string)($args['query'] ?? ''));
            $limit = max(1, min(6, (int)($args['limit'] ?? 4)));
            if ($query === '') return json_encode(['error' => 'query_required']);
            $facts = array_map(fn($h) => $h['answer'], lore_search($query, $limit, true));
            if (!$facts) {
                return json_encode(['facts' => [], 'found' => false, 'note' => 'Nothing in your world matches this. You do not know it. Say so instead of inventing a detail.'], JSON_UNESCAPED_UNICODE);
            }
            return json_encode(['facts' => $facts], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'memory_write') {
            $memory = (string)($args['memory'] ?? '');
            $category = (string)($args['category'] ?? 'general');
            return json_encode(memory_note_add((int)$user['id'], $category, $memory), JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'web_search') {
            if ($approvedWebSearchQuery === null) {
                return json_encode(['error' => 'user_confirmation_required']);
            }
            $query = $approvedWebSearchQuery;
            $approvedWebSearchQuery = null;
            return json_encode(web_search_public($query), JSON_UNESCAPED_UNICODE);
        }
        return json_encode(['error' => 'unknown_tool']);
    } catch (Throwable $e) {
        log_event(['msg' => 'tool_call_error', 'tool' => $name, 'err' => $e->getMessage()]);
        return json_encode(['error' => 'tool_failed']);
    }
}
