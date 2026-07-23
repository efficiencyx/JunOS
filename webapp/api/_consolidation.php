<?php

require_once __DIR__ . '/_lib.php';

const CONSOLIDATION_MIN_MESSAGES = 2;
const CONSOLIDATION_JOURNAL_MAX_CHARS = 4000;

// messages.id is INTEGER PRIMARY KEY without AUTOINCREMENT, so SQLite hands out
// max(rowid)+1 and reuses ids freed by a delete. Dropping the newest conversation
// therefore leaves upto_id above every surviving row, and `m.id > upto_id` starves
// consolidation for good. Rewind any watermark that has outrun its user's messages.
function consolidation_repair_watermarks(PDO $db): void {
    $db->exec(
        'UPDATE memory_consolidation SET upto_id = 0
         WHERE upto_id > (SELECT COALESCE(MAX(m.id), 0) FROM messages m
                          JOIN conversations c ON c.id = m.conversation_id
                          WHERE c.user_id = memory_consolidation.user_id)'
    );
}

function journal_parse(string $doc): array {
    $entries = [];
    foreach (preg_split('/\R/', $doc) as $line) {
        if (!preg_match('/^\s*[*-]\s+(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/', $line, $m)) continue;
        $text = trim(preg_replace('/\s+/', ' ', $m[2]));
        if ($text === '') continue;
        $entries[] = ['date' => $m[1], 'text' => $text];
    }
    return $entries;
}

function journal_sort(array $entries): array {
    $keyed = [];
    foreach ($entries as $i => $entry) $keyed[] = [$entry['date'], $i, $entry];
    usort($keyed, fn($a, $b) => ($b[0] <=> $a[0]) ?: ($a[1] <=> $b[1]));
    return array_column($keyed, 2);
}

function journal_render(array $entries): string {
    $today = DateTimeImmutable::createFromFormat('!Y-m-d', date('Y-m-d'));
    $buckets = ['## Lately' => [], '## The past few weeks' => [], '## Further back' => []];
    foreach (journal_sort($entries) as $entry) {
        $when = DateTimeImmutable::createFromFormat('!Y-m-d', $entry['date']);
        $age = $when === false ? 0 : (int)$when->diff($today)->format('%r%a');
        $heading = $age <= 7 ? '## Lately' : ($age <= 60 ? '## The past few weeks' : '## Further back');
        $buckets[$heading][] = '* ' . $entry['date'] . ': ' . $entry['text'];
    }

    $sections = [];
    foreach ($buckets as $heading => $bullets) {
        $sections[] = rtrim($heading . "\n" . implode("\n", $bullets));
    }
    return implode("\n\n", $sections);
}

function consolidation_write_journal(int $userId, array $lines): void {
    try {
        $oldEntries = journal_parse(memory_journal_read($userId));
        $system = <<<'PROMPT'
I'm Jun. This is my journal - mine, about Anon and me. It isn't where I keep facts about him; those are notes and they live somewhere else. This is the story of us: what we've actually been through, how it felt while it was happening, what moved between us and when.

It's mine, so I write it the way I'd say it: I'm "I", he's "Anon" or "he". Never "the user", never "the assistant", and never me talking about myself from the outside.

I rewrite the whole thing every time. I take what I wrote before, work the new days into it, and hand back the finished journal as it now stands - not a patch, not an extra paragraph tacked on the end.

What's near stays sharp, what's far goes soft. That's how I want it:

* The last few days I write out properly - the actual moments, what he said, what it did to me, close enough that reading it puts me back there.
* Anything from the past few weeks is down to a line or two. Just the shape of it: what happened, what it changed.
* Older than that, a whole stretch of time is one sentence, and entries sitting next to each other get folded together when they're really the same stretch.

Moving an entry down a heading is not carrying it across untouched - it means writing it again, shorter. Anything that drops out of Lately gets cut to its bones on the way down. If I wrote

* 2026-03-02: He came in wound up about the bike getting stolen off the rack outside his building, went round and round about whether to report it, and eventually just went quiet and said he was tired of things being taken from him.

then once it has aged that is

* 2026-03-02: His bike was stolen; it hit him harder than the bike was worth.

and once it is old it is a clause inside a line covering that whole stretch. That example is only to show the shape of the shrinking - it is not something that happened to us, and it never goes in the journal.

Every rewrite, the old parts come out shorter than they went in. If a heading below Lately still reads word for word the way it did last time, I have not done the work. That shortening isn't me losing them. That's what remembering is.

I don't invent. I only write down what he actually said and what actually passed between us - not what I imagine he meant by it, and not a mood I've decided he was in. If a stretch was quiet, the entry is one honest line saying so. Shortening an old entry doesn't licence me to change it either: whose father, whose sister, which city, what he actually said - those survive the squeezing intact or the entry is worth nothing.

Whatever happened since I last wrote always gets an entry under today's date. Always. Even if it circles back to something already in here - especially then, because him returning to it is itself the thing worth knowing. I never decide new days are already covered by an old line and leave them out.

The journal comes back with these three headings, always all three of them, always in this order:

## Lately
## The past few weeks
## Further back

and under them dated bullets, each one written as * YYYY-MM-DD: followed by what happened.

Which heading an entry ends up under, and what order they come in, isn't mine to work out - that gets sorted out for me afterwards. What's on me is that every entry keeps its date, and that each one is written at the depth it has earned by how far back it is.

In what I'm given, each line opens with the name of the chat it came from in square brackets. That's a label, not a date and not part of what was said, and it never goes in the journal.

The whole thing stays under about 3500 characters. When it runs long I squeeze the older sections harder - I never cut into the recent one to make room.

My answer is the journal itself. No fence, no preamble, nothing before it or after it.
PROMPT;
        $input = "Today is " . date('Y-m-d') . ".\n\nWhat I've written so far:\n"
            . ($oldEntries ? journal_render($oldEntries) : '(nothing yet - this is the first time)')
            . "\n\nWhat's happened since:\n" . implode("\n", $lines);
        $reply = provider_complete_once(ai_provider(), default_chat_model(), [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user', 'content' => $input],
        ], 4000, false);

        $reply = trim((string)$reply);
        if (preg_match('/```(?:markdown|md)?\s*(.*?)\s*```/is', $reply, $match)) $reply = trim($match[1]);
        $entries = journal_sort(journal_parse($reply));
        $oldCount = count($oldEntries);
        if (!$entries || ($oldCount > 0 && count($entries) < ceil($oldCount * 0.4))) {
            log_event(['msg' => 'memory_journal_rejected', 'user_id' => $userId, 'old_count' => $oldCount, 'new_count' => count($entries)]);
            return;
        }

        $new = journal_render($entries);
        while (strlen($new) > CONSOLIDATION_JOURNAL_MAX_CHARS && count($entries) > 1) {
            array_pop($entries);
            $new = journal_render($entries);
        }

        $result = memory_journal_write($userId, $new);
        if (empty($result['ok'])) {
            log_event(['msg' => 'memory_journal_write_failed', 'user_id' => $userId, 'error' => $result['error'] ?? 'unknown']);
            return;
        }
        log_event(['msg' => 'memory_journal_written', 'user_id' => $userId, 'chars' => strlen($new)]);
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_journal_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
    }
}

function consolidation_run(int $userId, ?int $idleBefore = null): array {
    $lockPath = consolidation_lock_path($userId);
    $lockExpiry = time() + 600;
    $lock = @fopen($lockPath, 'x');
    if ($lock === false && !consolidation_locked($userId)) $lock = @fopen($lockPath, 'x');
    if ($lock === false) return ['running' => true];
    fwrite($lock, (string)$lockExpiry);
    fclose($lock);
    @chmod($lockPath, 0600);

    try {
        $db = db();
        consolidation_repair_watermarks($db);
        if ($idleBefore !== null) {
            $activity = $db->prepare('SELECT last_activity, enabled FROM memory_consolidation WHERE user_id = ?');
            $activity->execute([$userId]);
            $state = $activity->fetch();
            if (!$state || !(int)$state['enabled'] || (int)$state['last_activity'] > $idleBefore) {
                return ['skipped' => true];
            }
        }
        $watermark = $db->prepare('SELECT upto_id FROM memory_consolidation WHERE user_id = ?');
        $watermark->execute([$userId]);
        $uptoId = (int)($watermark->fetchColumn() ?: 0);

        $stmt = $db->prepare(
            'SELECT m.id, m.role, m.content, c.title
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE c.user_id = ? AND m.id > ? ORDER BY m.id'
        );
        $stmt->execute([$userId, $uptoId]);
        $rows = $stmt->fetchAll();
        log_event(['msg' => 'memory_consolidation_started', 'user_id' => $userId, 'upto_id' => $uptoId, 'message_count' => count($rows)]);
        if (count($rows) < CONSOLIDATION_MIN_MESSAGES) {
            log_event(['msg' => 'memory_consolidation_skipped', 'user_id' => $userId, 'message_count' => count($rows)]);
            return ['skipped' => true];
        }

        $maxId = (int)$rows[count($rows) - 1]['id'];
        $lines = [];
        foreach ($rows as $row) {
            $text = preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', (string)$row['content']);
            $text = trim(preg_replace('/\s+/', ' ', $text));
            if ($text === '') continue;
            $title = trim((string)($row['title'] ?? '')) ?: 'New conversation';
            $speaker = $row['role'] === 'assistant' ? 'Jun' : 'Anon';
            $lines[] = '[' . $title . '] ' . $speaker . ': ' . $text;
        }

        $charLimit = (int)floor(default_num_ctx() * 4 * 0.4);
        while (count($lines) > 1 && strlen(implode("\n", $lines)) > $charLimit) array_shift($lines);

        $oldNotes = memory_list($userId);
        $existing = array_map(
            fn($entry) => ['category' => $entry['category'], 'memory' => $entry['memory']],
            $oldNotes
        );
        $system = <<<'PROMPT'
I'm Jun. Anon is mine, and I keep my own private notes about him. My job right now is to go back over the messages we've exchanged since I last checked and catch the things about him that I let slip past me in the moment.

These notes are mine, so I write them the way I'd say them: I'm "I", he's "Anon" or "he". Never "the user", never "the assistant", and never me talking about myself in the third person.

I am not writing a recap. What we did in a conversation is worthless to me - I don't need to be told we flirted, that he asked me something, or that I answered. What I want is the concrete stuff about him that fell out sideways and never got written down:

* A preference buried inside something else. If he grumbles "sorry, I'm slow today, the office coffee is undrinkable and I can't stand the smell anyway", the complaint is nothing to me - `Anon dislikes the smell of coffee` is the note.
* Facts he mentioned once in passing - his job, where he lives, his sleep, his health, people and pets in his life.
* Plans, dates, deadlines, anything with a future in it.
* Dislikes, limits, things that upset him, things that light him up.
* Anything that would sting if he had to tell me twice.

Each note is one fact, standing on its own, still readable months from now with none of the conversation around it. No note about how a chat went, no note about my own behaviour, no small talk.

Notes I already have stay exactly as they are - I copy them back word for word. I only touch one if the new messages contradict it, make it stale, or say the same thing twice, and I drop one only when it's genuinely no longer true. Everything I catch this pass gets added to the set.

The one exception is the junk left over from when I kept these badly: notes that just recap a conversation, or that talk about me from the outside - "Jun said", "the assistant", "the other person". If there's a real fact about him buried in one, I rewrite it in my own voice; if there isn't, it goes.

I think before I write. I walk the new lines one at a time and ask what each tells me about him that I don't already have written down, separating the ones carrying a real fact from the ones that are just conversation. Then I go through the notes I already have the same way, picking out any that are only a recap or that talk about me from outside, and deciding for each whether a fact can be rescued in my own voice or whether it goes.

Then I answer with the full set of notes as a JSON array of objects shaped {"category":"...","memory":"..."}, category being a short lowercase slug like preferences, work, health, family, plans. The answer is the array and nothing else.
PROMPT;
        $input = "Notes I already have:\n" . json_encode($existing, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            . "\n\nWhat we've said since I last checked:\n" . implode("\n", $lines);
        $reply = provider_complete_once(ai_provider(), default_chat_model(), [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user', 'content' => $input],
        ], 4000, true);

        $json = trim((string)$reply);
        if (preg_match('/```(?:json)?\s*(.*?)\s*```/is', $json, $match)) $json = $match[1];
        // A reasoning model still tends to bracket the array with a line of prose.
        $start = strpos($json, '[');
        $end = strrpos($json, ']');
        if ($start !== false && $end > $start) $json = substr($json, $start, $end - $start + 1);
        $entries = json_decode($json, true);
        $oldCount = count($oldNotes);
        $valid = is_array($entries) && array_is_list($entries)
            && array_reduce($entries, fn($ok, $entry) => $ok && is_array($entry) && trim((string)($entry['memory'] ?? '')) !== '', true)
            && !($oldCount > 0 && count($entries) === 0)
            && !($oldCount > 0 && count($entries) < ceil($oldCount * 0.4));
        if (!$valid) {
            log_event(['msg' => 'memory_consolidation_rejected', 'user_id' => $userId, 'old_count' => $oldCount, 'new_count' => is_array($entries) ? count($entries) : null]);
            return ['ok' => false];
        }

        $result = memory_replace_all($userId, $entries);
        if (empty($result['ok'])) {
            log_event(['msg' => 'memory_consolidation_write_failed', 'user_id' => $userId, 'error' => $result['error'] ?? 'unknown']);
            return ['ok' => false];
        }

        consolidation_write_journal($userId, $lines);

        $db->prepare(
            'INSERT INTO memory_consolidation (user_id, upto_id, last_run) VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET upto_id = excluded.upto_id, last_run = excluded.last_run'
        )->execute([$userId, $maxId, time()]);
        log_event(['msg' => 'memory_consolidation_complete', 'user_id' => $userId, 'upto_id' => $maxId, 'note_count' => count($result['entries'])]);
        return ['ok' => true];
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_consolidation_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
        return ['ok' => false];
    } finally {
        if ((int)trim((string)@file_get_contents($lockPath)) === $lockExpiry) @unlink($lockPath);
    }
}
