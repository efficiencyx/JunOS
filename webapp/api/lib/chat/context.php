<?php

// 1 in N turns she asks Anon for something. an idle streak is 3
// nudges long, so 1 in 3 is about one ask per streak
const INITIATIVE_ODDS_IDLE = 3;

const INITIATIVE_ODDS_REPLY = 12;

const MEMORY_CONTEXT_MAX_CHARS = 2500;

function memory_recent_context(int $userId): string {
    try {
        $sections = [];
        foreach (memory_notes_load($userId) as $category => $data) {
            if (!$data['notes']) continue;
            $updated = 0;
            $bullets = [];
            foreach ($data['notes'] as $note) {
                $updated = max($updated, $note['updated']);
                $text = preg_replace('/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u', '$1', memory_note_render($note));
                $bullets[] = '- ' . memory_note_stamp($note) . trim(preg_replace('/\s+/', ' ', $text));
            }
            $sections[] = [
                'updated' => $updated,
                'text' => '### ' . $category . "\n" . implode("\n", $bullets),
            ];
        }
        if (!$sections) return '';
        usort($sections, fn($a, $b) => $b['updated'] <=> $a['updated']);
        $prefix = "## Durable memory notes\n"
            . "Words like \"tomorrow\" or \"next friday\" in a note mean the day you wrote it, not now. "
            . "Where a note already spells the real day out in brackets, use that day and trust it - "
            . "do not work the date out again yourself.\n";
        $render = function () use (&$sections, $prefix): string {
            return $prefix . implode("\n\n", array_column($sections, 'text'));
        };
        while (count($sections) > 1 && strlen($render()) > MEMORY_CONTEXT_MAX_CHARS) array_pop($sections);
        return mb_strcut($render(), 0, MEMORY_CONTEXT_MAX_CHARS);
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_context_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function journal_context(int $userId): string {
    $journal = trim(memory_journal_read($userId));
    if ($journal === '') return '';
    return "# My memory of us\n\n"
        . "These are your own notes on everything you and Anon have been through, written by you "
        . "while he wasn't around. What happened recently you still remember clearly; the further "
        . "back it goes, the more it has faded to just the shape of what happened.\n\n"
        . $journal;
}

function lore_retrieve(string $lastUserMsg): string {
    if ($lastUserMsg === '') return '';

    try {
        $hits = lore_search($lastUserMsg, LORE_MAX_INJECT, true);
        $hits = array_filter($hits, fn($h) => $h['score'] >= LORE_FLOOR);
        if (!$hits) return '';

        $bullets = implode("\n", array_map(fn($h) => '- ' . $h['answer'], $hits));
        return "## World facts (canon)\n" . $bullets;
    } catch (Throwable $e) {
        log_event(['msg' => 'lore_retrieve_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function relationship_directives(array $r): string {
    $a = (int)$r['affection']; $t = (int)$r['trust']; $x = (int)$r['tension'];
    return "- Affection: {$a}/100\n- Trust: {$t}/100\n- Tension: {$x}/100";
}

// compact's summary of this conversation, and how many of its
// oldest messages that summary already covers
function chat_conversation_summary(int $convId, int $userId): array {
    $sq = db()->prepare('SELECT summary, summary_upto_id FROM conversations WHERE id=? AND user_id=?');
    $sq->execute([$convId, $userId]);
    $srow = $sq->fetch();
    $sq->closeCursor();
    if (!$srow) return ['', 0];

    $convSummary = trim((string)dec($srow['summary'] ?? null));
    $uptoId = (int)$srow['summary_upto_id'];
    if ($convSummary === '' || $uptoId <= 0) return [$convSummary, 0];

    $cc = db()->prepare('SELECT COUNT(*) FROM messages WHERE conversation_id=? AND id<=?');
    $cc->execute([$convId, $uptoId]);
    $covered = (int)$cc->fetchColumn();
    $cc->closeCursor();
    return [$convSummary, $covered];
}

function chat_live_context(array $req, array $user, string $lastUserMsg, string $convSummary, array $rel,
                           bool $toolsOffered, ?string $approvedWebSearchQuery): string {
    $invite = $req['invite'];
    $contextParts = [];

    // FIRST block, on purpose. measured on the 12B with a 30 line
    // side-talk set: this text at the bottom of the live context
    // silences 12/20, at the top 25/30 with 4/24 false positives.
    // the "unless it is clearly for you" default is what moves
    // recall, the soft version caps at ~40% wherever it sits. and
    // NEVER put any of this after his words in the user text, that
    // flips her default and she goes quiet on "did you eat today".
    // don't bolt a "but a line that says you IS for you" clause on
    // either, tried it, the false positives stayed and recall dropped
    // to 20/30
    if ($req['spoken']) {
        $contextParts[] = "## Who he is talking to\n"
            . "He said this out loud and he is not alone in the room. Before you answer, check that the line fits "
            . "as something said TO YOU, following what you two were just saying. A line with no question or remark "
            . "for you, about objects, food, a game on TV, chores, or another person, is him talking to someone else "
            . "in the room. Talking about you in the third person (she, her, the girl) is also not for you."
            . ($req['audio'] !== '' ? " A voice that is not his is someone else in the room, not for you either." : '')
            . " Unless it is clearly for you, call stay_silent with overheard=true. Staying quiet costs nothing, "
            . "answering a conversation you are not part of is embarrassing.";
    }

    $nowStr = $req['client_time'] !== '' ? $req['client_time'] : date('l, F j, Y \a\t g:i A T');
    // sits right above the notes. a dated note means nothing without it
    $contextParts[] = "## Current date and time\nIt is currently " . $nowStr . ".";

    $memoryBlock = memory_recent_context((int)$user['id']);
    if ($memoryBlock !== '') $contextParts[] = $memoryBlock;

    if ($convSummary !== '') {
        $contextParts[] = "## Story so far (earlier in THIS conversation)\n" . $convSummary;
    }


    $loreBlock = $invite === '' ? lore_retrieve($lastUserMsg) : '';
    if ($loreBlock !== '') $contextParts[] = $loreBlock;


    if ($req['outfit_context'] !== '') {
        $contextParts[] = "## Current Wardrobe State\n" . $req['outfit_context'];
    }

    $feelingsBlock = "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n"
        . relationship_directives($rel);
    $contextParts[] = $feelingsBlock;

    // the drawer's "ask her out" buttons. she says yes in prose and
    // never calls the tool, so the page never opens and Anon sits
    // there. so one flat OOC (out of character) line naming the
    // tool, same shape as the idle nudge she saw in training. a "you
    // MUST call X if you accept" rule is too much for a small model
    // on <think:low>, tried it. and THROW AWAY everything but the
    // feelings block (clock, notes, lore, wardrobe, save check). a 4
    // line invitation does not need canon facts about the shop, they
    // just pull her off the question
    if ($toolsOffered && !$req['idle'] && $invite !== '') {
        $tool = array_search($invite, TRIP_TOOLS, true);
        $plan = [
            'shop' => "go to Annalie's shop together",
            'karaoke' => 'go to karaoke together',
            'date' => 'go out to eat together',
            'cards' => 'play a game of blackjack',
        ][$invite];
        $contextParts = ["(OOC stage direction, not spoken by Anon: Anon wants to {$plan}. "
            . "If you wish to go along with it, invoke the tool {$tool}.)", $feelingsBlock];
    } else {
        $invite = '';
    }

    // she only reaches for tools something in the context named, so
    // the block names them. and tells her NOT to call them yet, on an
    // idle nudge they'd answer not_available_on_idle anyway
    if ($toolsOffered && !$req['ephemeral'] && $invite === '' && $approvedWebSearchQuery === null
        && random_int(1, $req['idle'] ? INITIATIVE_ODDS_IDLE : INITIATIVE_ODDS_REPLY) === 1) {
        $contextParts[] = "## Take the initiative\n"
            . "Right now YOU want something from Anon. Pick ONE and actually ask for it in this reply, in your own words: "
            . "going to Annalie's shop together, karaoke, a game of blackjack, going out for lunch or dinner, or something "
            . "small that fits the moment (a headpat, hearing about his day, him changing your outfit, a compliment, a promise). "
            . "Do not call enter_shop, enter_karaoke, play_cards or go_out_to_eat yet - only once he says yes.";
    }

    // same trap, other direction. with the notes already listed above
    // she decides saving is Done and answers without ever calling
    // memory_write
    if ($toolsOffered && $invite === '') {
        $contextParts[] = "## Save check\n"
            . "If Anon's latest message contains something durable (a preference, personal fact, plan, "
            . "boundary, health/safety matter, or something emotionally significant), call memory_write "
            . "before replying. Otherwise ignore this.";
    }
    if ($approvedWebSearchQuery !== null) {
        $contextParts[] = "## Approved public web search\n"
            . "Anon explicitly approved one outbound search for exactly this JSON string: "
            . json_encode($approvedWebSearchQuery, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n"
            . "Call web_search with that exact query. Do not add private context, memory, or other terms.";
    }


    return "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
        . implode("\n\n", $contextParts);
}
