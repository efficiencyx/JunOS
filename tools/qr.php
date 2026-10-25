<?php
// QR code for the phone pairing link. start.sh pipes this into the
// php container, start.ps1, JunOS.exe and the notebook run it with
// their own php. no library ON PURPOSE, there's no composer anywhere
//
//   php tools/qr.php TEXT ansi|rows|svg
//
// byte mode, EC level M (reads with ~15% of it smudged), versions
// 1-20 so up to 666 bytes. the link is ~200

const QR_EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const QR_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

function qr_raw_modules(int $ver): int {
    $n = (16 * $ver + 128) * $ver + 64;
    if ($ver >= 2) {
        $align = intdiv($ver, 7) + 2;
        $n -= (25 * $align - 10) * $align - 55;
        if ($ver >= 7) $n -= 36;
    }
    return $n;
}

function qr_data_codewords(int $ver): int {
    return intdiv(qr_raw_modules($ver), 8) - QR_EC_PER_BLOCK[$ver - 1] * QR_BLOCKS[$ver - 1];
}

function qr_gf_mul(int $x, int $y): int {
    $z = 0;
    for ($i = 7; $i >= 0; $i--) {
        $z = (($z << 1) ^ (($z >> 7) * 0x11D)) & 0xFF;
        $z ^= (($y >> $i) & 1) * $x;
    }
    return $z;
}

function qr_rs_divisor(int $degree): array {
    $result = array_fill(0, $degree, 0);
    $result[$degree - 1] = 1;
    $root = 1;
    for ($i = 0; $i < $degree; $i++) {
        for ($j = 0; $j < $degree; $j++) {
            $result[$j] = qr_gf_mul($result[$j], $root);
            if ($j + 1 < $degree) $result[$j] ^= $result[$j + 1];
        }
        $root = qr_gf_mul($root, 0x02);
    }
    return $result;
}

function qr_rs_remainder(array $data, array $divisor): array {
    $result = array_fill(0, count($divisor), 0);
    foreach ($data as $b) {
        $factor = $b ^ array_shift($result);
        $result[] = 0;
        foreach ($divisor as $i => $coef) $result[$i] ^= qr_gf_mul($coef, $factor);
    }
    return $result;
}

function qr_codewords(string $text, int $ver): array {
    $bits = [];
    $push = function (int $value, int $len) use (&$bits) {
        for ($i = $len - 1; $i >= 0; $i--) $bits[] = ($value >> $i) & 1;
    };
    $push(0b0100, 4);
    $push(strlen($text), $ver <= 9 ? 8 : 16);
    foreach (str_split($text) as $ch) $push(ord($ch), 8);

    $capacity = qr_data_codewords($ver) * 8;
    $push(0, min(4, $capacity - count($bits)));
    $push(0, (8 - count($bits) % 8) % 8);
    $data = [];
    foreach (array_chunk($bits, 8) as $byte) $data[] = bindec(implode('', $byte));
    for ($pad = 0xEC; count($data) < $capacity / 8; $pad ^= 0xEC ^ 0x11) $data[] = $pad;

    $blocks = QR_BLOCKS[$ver - 1];
    $ecLen = QR_EC_PER_BLOCK[$ver - 1];
    $raw = intdiv(qr_raw_modules($ver), 8);
    $short = $blocks - $raw % $blocks;
    $shortLen = intdiv($raw, $blocks);
    $divisor = qr_rs_divisor($ecLen);
    $all = [];
    for ($i = 0, $k = 0; $i < $blocks; $i++) {
        $chunk = array_slice($data, $k, $shortLen - $ecLen + ($i < $short ? 0 : 1));
        $k += count($chunk);
        $ec = qr_rs_remainder($chunk, $divisor);
        if ($i < $short) $chunk[] = 0;
        $all[] = array_merge($chunk, $ec);
    }
    $out = [];
    for ($i = 0; $i < count($all[0]); $i++) {
        foreach ($all as $j => $block) {
            // the short blocks carry a placeholder byte at this index, skip it
            if ($i !== $shortLen - $ecLen || $j >= $short) $out[] = $block[$i];
        }
    }
    return $out;
}

function qr_matrix(string $text): array {
    for ($ver = 1; $ver <= 20; $ver++) {
        $countBits = $ver <= 9 ? 8 : 16;
        if (4 + $countBits + 8 * strlen($text) <= qr_data_codewords($ver) * 8) break;
    }
    if ($ver > 20) throw new RuntimeException('too long for a QR code');
    $size = $ver * 4 + 17;
    $m = array_fill(0, $size, array_fill(0, $size, false));
    $fixed = $m;
    $set = function (int $x, int $y, bool $dark) use (&$m, &$fixed) {
        $m[$y][$x] = $dark;
        $fixed[$y][$x] = true;
    };

    for ($i = 0; $i < $size; $i++) {
        $set(6, $i, $i % 2 === 0);
        $set($i, 6, $i % 2 === 0);
    }
    foreach ([[3, 3], [$size - 4, 3], [3, $size - 4]] as [$cx, $cy]) {
        for ($dy = -4; $dy <= 4; $dy++) {
            for ($dx = -4; $dx <= 4; $dx++) {
                $x = $cx + $dx;
                $y = $cy + $dy;
                if ($x < 0 || $y < 0 || $x >= $size || $y >= $size) continue;
                $d = max(abs($dx), abs($dy));
                $set($x, $y, $d !== 2 && $d !== 4);
            }
        }
    }
    if ($ver > 1) {
        $count = intdiv($ver, 7) + 2;
        $step = intdiv($ver * 8 + $count * 3 + 5, $count * 4 - 4) * 2;
        $pos = [6];
        for ($p = $size - 7; count($pos) < $count; $p -= $step) array_splice($pos, 1, 0, [$p]);
        $last = $count - 1;
        foreach ($pos as $i => $ax) {
            foreach ($pos as $j => $ay) {
                if (($i === 0 && $j === 0) || ($i === 0 && $j === $last) || ($i === $last && $j === 0)) continue;
                for ($dy = -2; $dy <= 2; $dy++) {
                    for ($dx = -2; $dx <= 2; $dx++) $set($ax + $dx, $ay + $dy, max(abs($dx), abs($dy)) !== 1);
                }
            }
        }
    }
    $drawFormat = function (int $mask) use ($set, $size) {
        $data = $mask;
        $rem = $data;
        for ($i = 0; $i < 10; $i++) $rem = ($rem << 1) ^ (($rem >> 9) * 0x537);
        $bits = (($data << 10) | $rem) ^ 0x5412;
        $bit = fn(int $i) => (($bits >> $i) & 1) === 1;
        for ($i = 0; $i <= 5; $i++) $set(8, $i, $bit($i));
        $set(8, 7, $bit(6));
        $set(8, 8, $bit(7));
        $set(7, 8, $bit(8));
        for ($i = 9; $i < 15; $i++) $set(14 - $i, 8, $bit($i));
        for ($i = 0; $i < 8; $i++) $set($size - 1 - $i, 8, $bit($i));
        for ($i = 8; $i < 15; $i++) $set(8, $size - 15 + $i, $bit($i));
        $set(8, $size - 8, true);
    };
    $drawFormat(0);
    if ($ver >= 7) {
        $rem = $ver;
        for ($i = 0; $i < 12; $i++) $rem = ($rem << 1) ^ (($rem >> 11) * 0x1F25);
        $bits = ($ver << 12) | $rem;
        for ($i = 0; $i < 18; $i++) {
            $dark = (($bits >> $i) & 1) === 1;
            $a = $size - 11 + $i % 3;
            $b = intdiv($i, 3);
            $set($a, $b, $dark);
            $set($b, $a, $dark);
        }
    }

    $words = qr_codewords($text, $ver);
    $total = count($words) * 8;
    $i = 0;
    for ($right = $size - 1; $right >= 1; $right -= 2) {
        if ($right === 6) $right = 5;
        for ($vert = 0; $vert < $size; $vert++) {
            for ($j = 0; $j < 2; $j++) {
                $x = $right - $j;
                $y = (($right + 1) & 2) === 0 ? $size - 1 - $vert : $vert;
                if ($fixed[$y][$x] || $i >= $total) continue;
                $m[$y][$x] = (($words[$i >> 3] >> (7 - ($i & 7))) & 1) === 1;
                $i++;
            }
        }
    }

    $best = null;
    $bestScore = PHP_INT_MAX;
    for ($mask = 0; $mask < 8; $mask++) {
        $try = $m;
        for ($y = 0; $y < $size; $y++) {
            for ($x = 0; $x < $size; $x++) {
                if ($fixed[$y][$x]) continue;
                $flip = match ($mask) {
                    0 => ($x + $y) % 2 === 0,
                    1 => $y % 2 === 0,
                    2 => $x % 3 === 0,
                    3 => ($x + $y) % 3 === 0,
                    4 => (intdiv($x, 3) + intdiv($y, 2)) % 2 === 0,
                    5 => $x * $y % 2 + $x * $y % 3 === 0,
                    6 => ($x * $y % 2 + $x * $y % 3) % 2 === 0,
                    7 => (($x + $y) % 2 + $x * $y % 3) % 2 === 0,
                };
                if ($flip) $try[$y][$x] = !$try[$y][$x];
            }
        }
        $m2 = $m;
        $m = $try;
        $drawFormat($mask);
        $try = $m;
        $m = $m2;
        $score = qr_penalty($try);
        if ($score < $bestScore) {
            $bestScore = $score;
            $best = $try;
        }
    }
    return $best;
}

function qr_penalty(array $m): int {
    $size = count($m);
    $score = 0;
    $dark = 0;
    $lines = [];
    for ($y = 0; $y < $size; $y++) {
        $row = '';
        $col = '';
        for ($x = 0; $x < $size; $x++) {
            $row .= $m[$y][$x] ? '1' : '0';
            $col .= $m[$x][$y] ? '1' : '0';
            if ($m[$y][$x]) $dark++;
            if ($x < $size - 1 && $y < $size - 1) {
                $c = $m[$y][$x];
                if ($m[$y][$x + 1] === $c && $m[$y + 1][$x] === $c && $m[$y + 1][$x + 1] === $c) $score += 3;
            }
        }
        $lines[] = $row;
        $lines[] = $col;
    }
    foreach ($lines as $line) {
        preg_match_all('/0{5,}|1{5,}/', $line, $runs);
        foreach ($runs[0] as $run) $score += strlen($run) - 2;
        $score += 40 * (substr_count($line, '10111010000') + substr_count($line, '00001011101'));
    }
    $score += intdiv(abs($dark * 20 - $size * $size * 10), $size * $size) * 10;
    return $score;
}

function qr_render(array $m, string $format): string {
    $size = count($m);
    $quiet = 4;
    $at = fn(int $x, int $y) => $x >= 0 && $y >= 0 && $x < $size && $y < $size && $m[$y][$x];
    switch ($format) {
        case 'rows':
            return implode("\n", array_map(fn($row) => implode('', array_map(fn($d) => $d ? '1' : '0', $row)), $m)) . "\n";
        case 'svg':
            $full = $size + 2 * $quiet;
            $path = '';
            for ($y = 0; $y < $size; $y++) {
                for ($x = 0; $x < $size; $x++) {
                    if ($m[$y][$x]) $path .= 'M' . ($x + $quiet) . ',' . ($y + $quiet) . 'h1v1h-1z';
                }
            }
            return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 $full $full\" width=\"" . ($full * 6)
                . "\" height=\"" . ($full * 6) . "\" shape-rendering=\"crispEdges\">"
                . "<rect width=\"$full\" height=\"$full\" fill=\"#fff\"/><path d=\"$path\" fill=\"#000\"/></svg>\n";
        default:
            // black on white set explicitly, a dark terminal would invert
            // it and plenty of scanners can't read an inverted code
            $out = '';
            for ($y = -$quiet; $y < $size + $quiet; $y += 2) {
                $out .= "\e[38;5;16;48;5;231m";
                for ($x = -$quiet; $x < $size + $quiet; $x++) {
                    $top = $at($x, $y);
                    $bottom = $at($x, $y + 1);
                    $out .= $top ? ($bottom ? "\u{2588}" : "\u{2580}") : ($bottom ? "\u{2584}" : ' ');
                }
                $out .= "\e[0m\n";
            }
            return $out;
    }
}

// piped in on stdin there's no included file at all
if (PHP_SAPI === 'cli' && (get_included_files()[0] ?? __FILE__) === __FILE__ && count($argv) >= 2) {
    try {
        echo qr_render(qr_matrix($argv[1]), $argv[2] ?? 'ansi');
    } catch (RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
}
