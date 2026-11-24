<?php

const TRIP_TOOLS = ['enter_shop' => 'shop', 'enter_karaoke' => 'karaoke', 'go_out_to_eat' => 'date', 'play_cards' => 'cards',
    'watch_together' => 'watch'];

// same two every tick so the KV cache holds, and neither can walk
// her out of the film
const WATCH_TOOLS = ['stay_silent', 'memory_write'];

// errors from a call she got wrong herself, so the next round forces a call
const TOOL_RETRY_ERRORS = ['not_a_hex_color', 'query_required', 'memory_required', 'message_required', 'query_refused', 'no_match'];

function tool_result_retryable(string $result): bool {
    return in_array(json_decode($result, true)['error'] ?? null, TOOL_RETRY_ERRORS, true);
}

const TRIP_WORDS = [
    'shop' => "annalie|shop|shopping|boutique|clothes store|buy (?:you )?(?:some )?clothes",
    'karaoke' => 'karaoke|sing together|sing with me|sing a song|go singing',
    'date' => 'dinner|lunch|restaurant|eat out|go out to eat|grab (?:a bite|food|something to eat)|on a date|date night',
    'cards' => 'blackjack|cards|card game',
    'watch' => 'watch (?:a |some |an? )?(?:movies?|films?|videos?|shows?|episodes?|anime|youtube|something)|movie night|netflix'
        . '|cinema|go to the movies|see a (?:movie|film)',
];

const TRIP_APOS = "['\x{2019}]?";

function trip_words_in(string $text): array {
    $text = mb_strtolower(preg_replace('/\[[^\]]*\]/', ' ', $text));
    return array_keys(array_filter(TRIP_WORDS, fn($re) => preg_match("/\b(?:$re)\b/u", $text)));
}

// "why not" and "can't wait" are a yes. everything else with a
// not in it is a no, or close enough that we keep our hands off
function trip_has_no(string $text): bool {
    $a = TRIP_APOS;
    $text = preg_replace("/why (?:not|don{$a}t we)|can{$a}t wait|not gonna say no/u", '', mb_strtolower($text));
    return (bool)preg_match("/\b(?:no|nope|not|never|don{$a}t|do not|can{$a}t|won{$a}t|rather not|later|another time|tomorrow)\b/u", $text);
}

// the typed version of the drawer's ask-her-out buttons. she only
// calls a trip tool reliably when the OOC line names it, and that
// line only went out for the buttons, so "wanna go to karaoke?"
// typed got a yes in prose and no tool. two shapes count: he
// names one trip with an invite word, or he says yes right after
// she offered exactly one. ponytail: english keyword match, a
// false hit costs one turn of dropped live context and she can
// still say no
function trip_guess_invite(string $his, string $herLast): string {
    $a = TRIP_APOS;
    $his = mb_strtolower(trim($his));
    if ($his === '' || trip_has_no($his)) return '';
    $named = trip_words_in($his);
    if (count($named) === 1 && preg_match("/\b(?:wanna|want to|let{$a}s|shall we|should we|how about|what about|why don{$a}t we|come with me|take you|feel like|up for|go (?:to|for|out))\b/u", $his)) {
        return $named[0];
    }
    if (mb_strlen($his) <= 80 && str_contains($herLast, '?')
        && preg_match("/^\W*(?:yes|yeah|yea|yep|yup|sure|ok|okay|alright|of course|let{$a}s go|let{$a}s do it|sounds good|deal|why not|i{$a}d love|absolutely|definitely|gladly)\b/u", $his)) {
        $offered = trip_words_in($herLast);
        if (count($offered) === 1) return $offered[0];
        if (count($named) === 1 && in_array($named[0], $offered, true)) return $named[0];
    }
    return '';
}

// the other half. she got the OOC line, said yes in prose and
// STILL didn't call the tool. a plain yes with no no anywhere
// in it is enough to send the trip for her
function trip_reply_accepts(string $reply): bool {
    $a = TRIP_APOS;
    $reply = mb_strtolower(preg_replace('/\[[^\]]*\]/', ' ', $reply));
    return !trip_has_no($reply)
        && (bool)preg_match("/\b(?:yes|yeah|yay|sure|okay|ok|alright|of course|let{$a}s go|let{$a}s do it|lead the way|grab my (?:coat|bag|jacket)|i{$a}d love (?:to|that)|i{$a}m in|count me in|deal|gladly|absolutely|definitely|can{$a}t wait|you{$a}re on|i{$a}ll (?:go|come)|i{$a}m (?:going|coming)(?! to\b))\b/u", $reply);
}

function tool_catalog(?string $approvedWebSearchQuery, bool $watching = false): array {
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
                'description' => 'Look up canon world facts - people, places, jobs, events from your own world - when you are unsure of a detail. Write the query in English.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Name or topic to look up, in English.'],
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
                'name' => 'plan_message',
                'description' => 'Plan a text to send Anon later, like asking tomorrow how his exam went. It goes out after the hours you pick, even if he is away. At most 3 can wait at once.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'message' => ['type' => 'string', 'description' => 'The text, the way you would type it to him. Max 240 characters.'],
                        'after_hours' => ['type' => 'integer', 'description' => 'Hours from now, 1-72.'],
                    ],
                    'required' => ['message', 'after_hours'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'write_journal',
                'description' => 'Write in your own journal about something between you and Anon that you want to keep. It is added to today\'s entry.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'entry' => ['type' => 'string', 'description' => 'A few sentences in your own words. Max 400 characters.'],
                    ],
                    'required' => ['entry'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'web_search',
                'description' => 'Look something up on the web. The first call runs exactly what Anon typed (a search, or the page if he gave a link). Up to two more calls run your own related queries.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Search query. Never include anything private about Anon.'],
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
                'name' => 'recolor',
                'description' => 'Change the color of your hair, eyes, skin, ears, tail or any piece of clothing. Calling this is the ONLY thing that actually recolors you - saying it in your reply changes nothing.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'parts' => [
                            'type' => 'array',
                            'items' => ['type' => 'string'],
                            'description' => 'What to recolor: hair, eyes, skin, ears, tail, or an item name from your wardrobe state.',
                        ],
                        'color' => [
                            'type' => 'string',
                            'description' => 'Hex code like #ff69b4, or "default" for the original color.',
                        ],
                    ],
                    'required' => ['parts', 'color'],
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
                'name' => 'watch_together',
                'description' => 'Sit down with Anon and watch a video together, a file from his computer or something he shares from his browser. Call it once the two of you agree to watch something, then say your line - you sit down together when you finish talking.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you want to watch something (private).'],
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
        [
            'type' => 'function',
            'function' => [
                'name' => 'invite_to_bed',
                'description' => 'Invite Anon to bed with you, when you want him or want him close tonight. Only works in the game: call it, then say your line, and the bed is ready when you finish talking.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you want him in bed now (private).'],
                    ],
                ],
            ],
        ],
    ];
    if ($watching) {
        return array_values(array_filter($tools, fn($tool) => in_array($tool['function']['name'] ?? '', WATCH_TOOLS, true)));
    }
    if ($approvedWebSearchQuery === null) {
        $tools = array_values(array_filter(
            $tools,
            fn($tool) => ($tool['function']['name'] ?? '') !== 'web_search'
        ));
    }
    return $tools;
}

// the game's own outings, same rules as its CheckDate block and Annalie's
// door, so she hears no before she promises anything
const GAME_TRIPS = ['shop' => 'shop', 'date' => 'restaurant', 'karaoke' => 'karaoke', 'watch' => 'cinema'];

function game_trip(string $where, ?array $outing): array {
    $no = fn(string $why) => ['going' => false, 'note' => $why . ' Do not say you are leaving.'];
    $game = GAME_TRIPS[$where] ?? null;
    if ($game === null || $outing === null) return $no('Nothing happens if you call this here. If you two go out, Anon takes you himself.');
    if (!$outing['out']) return $no('You two cannot go out together right now.');
    $why = $game === 'shop' ? $outing['shop'] : $outing['date'];
    if ($why !== 'ok') {
        return $no(match ($why) {
            'hours' => $game === 'shop' ? "Annalie's shop is closed now, it is open from 8:00 to 18:00."
                : 'Not at this hour, dates happen between 9:00 and 19:00.',
            'money' => 'There is not enough money for a date right now.',
            'recent' => 'You two already had a date in the last 14 hours.',
            default => 'That cannot happen right now.',
        });
    }
    return ['going' => $game, 'note' => 'Say one short line about heading out together. You both leave when you finish talking.'];
}

// words, never the numbers, or she reads "stamina 0.33" back to him
function game_state_lines(?array $s): array {
    if ($s === null) return [];
    $lines = [];
    if ($s['stamina'] !== null && $s['stamina'] < 0.35) {
        $lines[] = $s['stamina'] < 0.15 ? 'Anon is exhausted, barely on his feet.' : 'Anon looks tired.';
    }
    if ($s['satiation'] !== null && $s['satiation'] < 0.35) {
        $lines[] = $s['satiation'] < 0.15 ? 'Anon is starving.' : 'Anon is hungry.';
    }
    if ($s['mental'] !== null && $s['mental'] < 0.6) $lines[] = 'Anon has been feeling down lately.';
    if (($s['horniness'] ?? 0) >= 0.4) {
        $lines[] = 'You want him. If the moment fits, you can invite him to bed (invite_to_bed).';
    } elseif (game_bed_offered($s)) {
        $lines[] = 'It is late and you have been longing for him. You could invite him to bed (invite_to_bed).';
    } elseif (($s['longing'] ?? 0) >= 9) {
        $lines[] = 'You have been longing for some closeness with him.';
    }
    return $lines;
}

// horniness sits at 0 and only jumps now and then (0.41, 0.69 in the saves), longing is 7-10 most of the time
function game_bed_offered(?array $s): bool {
    if ($s === null) return false;
    $late = $s['hour'] !== null && ($s['hour'] >= 21 || $s['hour'] < 3);
    return ($s['horniness'] ?? 0) >= 0.4 || (($s['longing'] ?? 0) >= 7 && $late);
}

// idle turns skip the tool check. bench: asked in words 4/8, called it 0/8
function game_reply_invites_to_bed(string $reply): bool {
    $a = TRIP_APOS;
    $reply = mb_strtolower(preg_replace('/\[[^\]]*\]/', ' ', $reply));
    return (bool)preg_match("/\b(?:(?:come|get|go) (?:back )?(?:to|into|in) bed|(?:lie|lay) down with me|(?:to|in|into) bed with me|"
        . "join me in bed|take me to bed|let{$a}s go to bed)\b/u", $reply);
}

// the tools that change how the rest of the turn goes. $state is
// the turn's: silenced, silence_reason, overheard, flee_decided,
// fled, journaled (one write_journal a turn), and approved_search,
// which the one web_search it allows uses up. everything else
// falls through to run_tool_call().
function chat_run_tool(string $name, array $args, array $ctx, array &$state): string {
    $idle = $ctx['req']['idle'];
    if ($ctx['req']['watch'] !== null && !in_array($name, WATCH_TOOLS, true)) {
        return json_encode(['error' => 'not_available_while_watching']);
    }
    // the game owns the doors there. the list stays the web's, another
    // list is another prompt prefix and a full re-read
    if ($ctx['req']['game'] && $name === 'flee') {
        return json_encode(['error' => 'not_possible_here',
            'note' => 'You cannot leave right now. Stay in the scene and respond to what is actually happening.']);
    }
    if ($ctx['req']['game'] && isset(TRIP_TOOLS[$name])) {
        $trip = game_trip(TRIP_TOOLS[$name], $ctx['req']['game_outing']);
        if ($trip['going'] !== false) {
            sse_send(['game_go' => $trip['going']]);
            relationship_history_add((int)$ctx['user']['id'], null, 'outing:' . TRIP_TOOLS[$name]);
            $state['went'] = TRIP_TOOLS[$name];
        }
        return json_encode($trip);
    }
    if ($name === 'invite_to_bed') {
        if (!$ctx['req']['game']) return json_encode(['error' => 'not_possible_here', 'note' => 'Nothing happens if you call this here.']);
        sse_send(['game_go' => 'bed']);
        $state['went'] = 'bed';
        return json_encode(['going' => 'bed', 'note' => 'Say one short line inviting him to bed. The bed is ready when you finish talking.']);
    }
    if ($name === 'change_outfit' && $ctx['req']['game']) {
        $outfit = wardrobe_game_change($args, $ctx['req']['game_items']);
        if ($outfit['apply'] !== null) {
            sse_send(['game_outfit' => $outfit['apply']]);
            ach_add((int)$ctx['user']['id'], 'outfits');
        }
        return json_encode($outfit['reply'], JSON_UNESCAPED_UNICODE);
    }

    if ($name === 'stay_silent') {
        // an idle turn is unprompted anyway, so staying quiet does nothing
        if ($idle) return json_encode(['error' => 'not_available_on_idle']);
        $state['silenced'] = true;
        $state['silence_reason'] = trim((string)($args['reason'] ?? ''));
        $state['overheard'] = $ctx['req']['spoken'] && !empty($args['overheard']);
        return json_encode(['silent' => true]);
    }

    if ($name === 'change_outfit') {
        $userId = (int)$ctx['user']['id'];
        $before = wardrobe_state($userId) ?? wardrobe_default_state();
        $outfit = wardrobe_tool_change($args, $userId, $ctx['req']['mod_items']);
        // the browser owns what's on screen. so it gets the change
        // as its own frame, instead of digging it back out of the
        // tool result that's meant for her
        if ($outfit['apply'] !== null) sse_send(['outfit' => $outfit['apply']]);
        // a saved look comes back changed:true even when she's already
        // in it, so that one only counts if the stored state moved. mod
        // items never touch the stored state, they count off changed
        $lookChanged = isset($outfit['apply']['look']) && ach_worn_changed($before, wardrobe_state($userId));
        $itemsChanged = !isset($outfit['apply']['look']) && !empty($outfit['reply']['changed']);
        if ($lookChanged || $itemsChanged) ach_add($userId, 'outfits');
        return json_encode($outfit['reply'], JSON_UNESCAPED_UNICODE);
    }

    if ($name === 'recolor') {
        // the mod can't set game item colors, she'd announce a dye job that never happened
        if ($ctx['req']['game']) return json_encode(['error' => 'not_possible_here',
            'note' => 'Colors cannot be changed here. Say so plainly rather than pretending.']);
        $recolor = wardrobe_tool_recolor($args, wardrobe_tool_state((int)$ctx['user']['id'])['items']);
        if ($recolor['apply'] !== null) sse_send(['recolor' => $recolor['apply']]);
        return json_encode($recolor['reply'], JSON_UNESCAPED_UNICODE);
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
        else ach_add((int)$ctx['user']['id'], 'cards');
        relationship_history_add((int)$ctx['user']['id'], null, 'outing:' . $where);
        sse_send(['go' => $where]);
        $state['went'] = $where;
        return json_encode([
            'going' => $where,
            'note' => $where === 'cards'
                ? 'Say one short line. The table opens the moment you finish talking.'
                : ($where === 'watch'
                    ? 'Say one short line about sitting down together. The video starts the moment you finish talking.'
                    : 'Say one short line about heading out together. The trip starts the moment you finish talking.'),
        ]);
    }

    if ($name === 'write_journal') {
        if (!empty($state['journaled'])) return json_encode(['written' => false, 'note' => 'You already wrote in your journal this turn.']);
        $res = memory_journal_append((int)$ctx['user']['id'], (string)($args['entry'] ?? ''));
        if (isset($res['error'])) return json_encode($res['error'] === 'journal_day_full'
            ? ['written' => false, 'note' => 'Today\'s page in your journal is full.']
            : ['error' => $res['error']]);
        $state['journaled'] = true;
        return json_encode(['written' => true]);
    }

    if ($name === 'web_search') {
        $approved = $state['approved_search'];
        if ($approved === null) return json_encode(['error' => 'user_confirmation_required']);
        $userId = (int)$ctx['user']['id'];
        $used = $state['lookups']++;
        if ($used === 0) ach_add($userId, 'searches');
        $res = web_lookup($approved, (string)($args['query'] ?? ''), $used, web_private_texts($ctx['user'], $ctx['req']));
        return json_encode($res, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    return run_tool_call($name, $args, $ctx['user'], $ctx['conv_id']);
}

function web_private_texts(array $user, array $req): array {
    $userId = (int)$user['id'];
    $texts = [(string)($user['email'] ?? ''), memory_journal_read($userId)];
    foreach (memory_notes_load($userId) as $data) {
        foreach ($data['notes'] as $note) $texts[] = (string)$note['text'];
    }
    foreach ($req['body']['messages'] ?? [] as $m) {
        if (($m['role'] ?? '') === 'user' && is_string($m['content'] ?? null)) $texts[] = $m['content'];
    }
    return $texts;
}

function run_tool_call(string $name, array $args, array $user, int $convId): string {
    try {
        if ($name === 'search_recent_chats') {
            $query = trim((string)($args['query'] ?? ''));
            $limit = max(1, min(8, (int)($args['limit'] ?? 5)));
            if ($query === '') return json_encode(['error' => 'query_required']);
            $found = recall_search((int)$user['id'], $convId, $query, $limit);
            $rows = $found['results'] ?? [];
            if (!$found) {
                // the fine-tune only ever saw THIS tool name, so a lore
                // question lands here first. hand it the right tool instead
                // of an empty result.
                $note = lore_gate($query)
                    ? 'No earlier conversation mentions this, but it is something from your world, not something Anon told you. Call search_lore with the query in English before answering.'
                    : 'No earlier conversation mentions this. You do not remember it. Say so instead of describing one.';
                $try = recall_try((int)$user['id'], $query);
                return json_encode(['results' => [], 'found' => false, 'note' => $note] + ($try ? ['try' => $try] : []), JSON_UNESCAPED_UNICODE);
            }
            return json_encode(['results' => $rows] + $found, JSON_UNESCAPED_UNICODE);
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
            $facts = array_map(fn($h) => $h['answer'], lore_search($query, $limit, true, $matched));
            ach_add((int)$user['id'], 'lore');
            if (!$facts) {
                $near = lore_did_you_mean($query);
                if ($near) {
                    return json_encode(['facts' => [], 'found' => false, 'error' => 'no_match', 'did_you_mean' => $near,
                        'note' => 'Nothing matches that spelling. If you meant one of these, search again with it.'], JSON_UNESCAPED_UNICODE);
                }
                return json_encode(['facts' => [], 'found' => false, 'note' => 'Nothing in your world matches this. You do not know it. Say so instead of inventing a detail.'], JSON_UNESCAPED_UNICODE);
            }
            $understood = lore_understood($query, $matched ?? []);
            return json_encode($understood ? ['facts' => $facts, 'read_as' => $understood] : ['facts' => $facts], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'memory_write') {
            $memory = (string)($args['memory'] ?? '');
            $category = (string)($args['category'] ?? 'general');
            $res = memory_note_add((int)$user['id'], $category, $memory);
            if (!empty($res['ok'])) ach_add((int)$user['id'], 'notes');
            return json_encode($res, JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'plan_message') {
            $res = planned_add((int)$user['id'], (string)($args['message'] ?? ''), (int)($args['after_hours'] ?? 0));
            return json_encode($res, JSON_UNESCAPED_UNICODE);
        }
        return json_encode(['error' => 'unknown_tool']);
    } catch (Throwable $e) {
        log_event(['msg' => 'tool_call_error', 'tool' => $name, 'err' => $e->getMessage()]);
        return json_encode(['error' => 'tool_failed']);
    }
}
