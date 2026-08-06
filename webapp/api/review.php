<?php
// Dev-only dataset triage UI: walk a chat-format JSONL, keep or scrap each
// sample. Lives under /api because nginx 404s .php anywhere else.
declare(strict_types=1);

const REVIEW_ROOT = '/var/www/omega/tools/dataset_v6';

function review_files(): array {
    $out = [];
    // GLOB_BRACE is missing on musl, so the two roots are globbed separately.
    $found = array_merge(glob(REVIEW_ROOT . '/*.jsonl') ?: [], glob(REVIEW_ROOT . '/out/*.jsonl') ?: []);
    foreach ($found as $p) {
        $rel = substr($p, strlen(REVIEW_ROOT) + 1);
        if (preg_match('/\.(kept|scrapped)\.jsonl$/', $rel)) continue;
        $out[] = $rel;
    }
    sort($out);
    return $out;
}

function review_path(string $rel): ?string {
    if (!in_array($rel, review_files(), true)) return null;
    return REVIEW_ROOT . '/' . $rel;
}

function sibling(string $path, string $kind): string {
    return preg_replace('/\.jsonl$/', '', $path) . '.' . $kind . '.jsonl';
}

function line_count(string $path): int {
    if (!is_file($path)) return 0;
    $n = 0;
    $fh = fopen($path, 'r');
    while (fgets($fh) !== false) $n++;
    fclose($fh);
    return $n;
}

function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }

const GAUGES = ['affection' => 'aff', 'trust' => 'trust', 'tension' => 'tens'];

function gauge_bar(array $values, array $deltas = []): string {
    $out = '';
    foreach (GAUGES as $key => $short) {
        $v = max(0, min(100, (int)($values[$key] ?? 0)));
        $d = (int)($deltas[$key] ?? 0);
        $out .= '<span class="g g-' . $key . '"><span class="gl">' . $short . '</span>'
            . '<span class="gbar"><i style="width:' . $v . '%"></i></span>'
            . '<span class="gv">' . $v . '</span>'
            . ($d ? '<span class="gd ' . ($d > 0 ? 'up' : 'down') . '">' . sprintf('%+d', $d) . '</span>' : '')
            . '</span>';
    }
    return '<div class="gauges">' . $out . '</div>';
}

function render_sample(array $obj): string {
    $msgs = $obj['messages'] ?? [];
    if (!$msgs) {
        return '<div class="msg role-raw"><div class="rh">RAW</div><pre>'
            . h(json_encode($obj, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) . '</pre></div>';
    }
    $meta = $obj['meta'] ?? [];
    $gauges = $meta['gauges'] ?? [];
    $html = '';
    if ($meta) {
        $tags = '';
        foreach (['id', 'family', 'category', 'regime'] as $k) {
            if (isset($meta[$k])) $tags .= '<span class="tag"><em>' . $k . '</em>' . h((string)$meta[$k]) . '</span>';
        }
        $html .= '<div class="meta">' . $tags . ($gauges ? gauge_bar($gauges) : '') . '</div>';
    }
    foreach ($msgs as $i => $m) {
        $role = (string)($m['role'] ?? '?');
        $content = (string)($m['content'] ?? '');
        $note = '';
        if ($role === 'assistant' && $gauges) {
            preg_match_all('/(affection|trust|tension)=([+-]?\d+)/', $content, $mm, PREG_SET_ORDER);
            $deltas = [];
            foreach ($mm as $one) {
                $deltas[$one[1]] = (int)$one[2];
                $gauges[$one[1]] = max(0, min(100, (int)($gauges[$one[1]] ?? 0) + (int)$one[2]));
            }
            $note = gauge_bar($gauges, $deltas);
        }
        $cls = preg_match('/^[a-z]+$/', $role) ? $role : 'raw';
        $html .= '<div class="msg role-' . h($cls) . '"><div class="rh">' . h(strtoupper($role)) . $note . '</div>'
            . '<div class="editor"><pre class="hl" aria-hidden="true"></pre>'
            . '<textarea name="msg[' . $i . ']" rows="1" spellcheck="false">' . h($content) . '</textarea></div></div>';
    }
    return $html;
}

$files = review_files();
$rel = (string)($_REQUEST['file'] ?? ($files[0] ?? ''));
$path = review_path($rel);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: text/plain; charset=utf-8');
    if (!$path) { http_response_code(404); exit("unknown file\n"); }
    $idx = (int)($_POST['index'] ?? -1);
    $keep = ($_POST['verdict'] ?? '') !== 'no';
    $lines = file($path, FILE_IGNORE_NEW_LINES);
    $done = line_count(sibling($path, 'kept')) + line_count(sibling($path, 'scrapped'));
    if ($idx !== $done || !isset($lines[$idx])) { http_response_code(409); exit("stale index\n"); }

    // Only re-encode when an edit actually changed something, so untouched
    // samples keep their original byte-for-byte formatting and key order.
    $out = $lines[$idx];
    $edits = (array)($_POST['msg'] ?? []);
    if ($keep && $edits) {
        $obj = json_decode($out, true);
        $dirty = false;
        foreach ($edits as $i => $text) {
            $text = str_replace("\r\n", "\n", (string)$text);
            if (!isset($obj['messages'][$i]) || $obj['messages'][$i]['content'] === $text) continue;
            $obj['messages'][$i]['content'] = $text;
            $dirty = true;
        }
        if ($dirty) $out = json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    $target = sibling($path, $keep ? 'kept' : 'scrapped');
    if (@file_put_contents($target, $out . "\n", FILE_APPEND | LOCK_EX) === false) {
        http_response_code(500);
        exit("cannot write " . basename($target) . " - is ./tools mounted read-only?\n");
    }
    header('Location: ?file=' . rawurlencode($rel), true, 303);
    exit;
}

$total = $kept = $scrapped = 0;
$sample = null;
$error = '';
if ($path) {
    $lines = file($path, FILE_IGNORE_NEW_LINES);
    $total = count($lines);
    $kept = line_count(sibling($path, 'kept'));
    $scrapped = line_count(sibling($path, 'scrapped'));
    $i = $kept + $scrapped;
    if (isset($lines[$i])) {
        $sample = json_decode($lines[$i], true);
        if ($sample === null) $error = 'unparseable JSON on line ' . ($i + 1);
    }
}
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>dataset review</title>
<style>
:root { color-scheme: dark; --bg:#101014; --fg:#d7d7de; --dim:#7c7c88; --line:#2a2a33;
  --system:#8a8a96; --user:#5aa9ff; --assistant:#ffb454; --tool:#57c98a; --raw:#9a9aa8; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
header { position:sticky; top:0; z-index:2; display:flex; gap:16px; align-items:center; flex-wrap:wrap;
  padding:10px 20px; background:#16161c; border-bottom:1px solid var(--line); }
select { background:#20202a; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:inherit; }
.counts { color:var(--dim); }
.counts b { color:var(--fg); }
.ok { color:var(--tool); } .no { color:#e46a6a; }
main { max-width:960px; margin:0 auto; padding:20px; }
.meta { display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:14px; color:var(--dim); }
.tag em { font-style:normal; color:var(--dim); margin-right:6px; }
.tag { color:var(--fg); }
.gauges { display:flex; gap:14px; flex-wrap:wrap; }
.g { display:inline-flex; align-items:center; gap:6px; font-size:12px; }
.gl { color:var(--dim); }
.gbar { width:70px; height:6px; background:#2a2a33; border-radius:3px; overflow:hidden; }
.gbar i { display:block; height:100%; background:currentColor; }
.g-affection { color:#e878b4; } .g-trust { color:var(--tool); } .g-tension { color:#e46a6a; }
.gv { color:var(--fg); }
.gd.up { color:var(--tool); } .gd.down { color:#e46a6a; }
.msg { border:1px solid currentColor; border-radius:8px; margin:0 0 14px; }
.rh { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;
  padding:6px 12px; border-bottom:1px solid currentColor; font-weight:700; letter-spacing:.08em; font-size:12px; }
/* The highlight layer and the textarea are stacked in one grid cell, so every
   box metric below must stay identical between them or the caret drifts off
   the glyphs it is supposed to sit next to. */
.editor { display:grid; }
.editor > * { grid-area:1/1; margin:0; padding:10px 14px; border:0; font:inherit;
  line-height:1.55; letter-spacing:normal; tab-size:4;
  white-space:pre-wrap; overflow-wrap:break-word; word-break:normal; }
.hl { color:var(--fg); pointer-events:none; }
/* Text hides behind the highlight layer only once the script has actually
   painted it, so a blocked or missing review.js degrades to a plain readable
   textarea instead of an empty box. caret-color cannot be currentColor here:
   it would resolve to the transparent text colour and swallow the cursor. */
.editor textarea { color:var(--fg); caret-color:var(--fg); background:transparent;
  resize:none; overflow:hidden; outline:none; }
.editor.painted textarea { color:transparent; }
.editor:not(.painted) .hl { display:none; }
.editor:not(.painted) textarea { min-height:8em; overflow:auto; resize:vertical; }
.editor.painted textarea::selection { background:#3a4a66; color:transparent; }
.msg:focus-within { box-shadow:0 0 0 2px currentColor; }
.hl .mk { color:var(--dim); }
.hl .em { font-style:italic; }
.hl .st { font-weight:700; }
.hl .del { text-decoration:line-through; color:var(--dim); }
.hl .code { color:#b5e08a; }
.hl .hd { color:#7fc4ff; font-weight:700; }
.hl .quote { color:var(--dim); }
.act { color:#e07ce0; }
.role-system { color:var(--system); } .role-user { color:var(--user); }
.role-assistant { color:var(--assistant); } .role-tool { color:var(--tool); } .role-raw { color:var(--raw); }
pre { margin:0; padding:10px 14px; white-space:pre-wrap; color:var(--fg); }
.msg.dirty .rh::after { content:"edited"; color:var(--assistant); font-size:11px; letter-spacing:0; }
.actions { position:sticky; bottom:0; display:flex; gap:10px; padding:14px 0 20px; background:linear-gradient(transparent,var(--bg) 30%); }
button { flex:1; padding:12px; font:inherit; font-weight:700; border:1px solid; border-radius:8px; cursor:pointer; background:#1b1b22; }
button.keep { color:var(--tool); border-color:var(--tool); }
button.scrap { color:#e46a6a; border-color:#e46a6a; }
button:hover { background:#24242e; }
.done, .err { padding:30px 0; color:var(--dim); }
.err { color:#e46a6a; }
</style>
</head>
<body>
<header>
  <form method="get"><select name="file" onchange="this.form.submit()">
    <?php foreach ($files as $f): ?>
      <option value="<?= h($f) ?>"<?= $f === $rel ? ' selected' : '' ?>><?= h($f) ?></option>
    <?php endforeach; ?>
    <?php if (!$files): ?><option>no .jsonl found</option><?php endif; ?>
  </select></form>
  <?php if ($path): ?>
    <span class="counts">sample <b><?= min($kept + $scrapped + 1, $total) ?></b>/<?= $total ?></span>
    <span class="counts"><span class="ok">&check; <?= $kept ?></span> &nbsp; <span class="no">&times; <?= $scrapped ?></span></span>
  <?php endif; ?>
</header>
<main>
<?php if (!$path): ?>
  <p class="err">Nothing to review under <?= h(REVIEW_ROOT) ?>.</p>
<?php elseif ($error): ?>
  <p class="err"><?= h($error) ?></p>
<?php elseif ($sample === null): ?>
  <p class="done">All <?= $total ?> samples reviewed &mdash; <?= $kept ?> kept, <?= $scrapped ?> scrapped.</p>
<?php else: ?>
  <form method="post" id="verdict">
    <?= render_sample($sample) ?>
    <input type="hidden" name="file" value="<?= h($rel) ?>">
    <input type="hidden" name="index" value="<?= $kept + $scrapped ?>">
    <div class="actions">
      <button class="keep" name="verdict" value="yes">keep &nbsp;<small>(y)</small></button>
      <button class="scrap" name="verdict" value="no">scrap &nbsp;<small>(n)</small></button>
    </div>
  </form>
  <script src="review.js?v=1"></script>
<?php endif; ?>
</main>
</body>
</html>
