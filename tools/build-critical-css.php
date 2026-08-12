<?php
// Inlines webapp/boot.css into the <style id="critical"> block of index.html.
//
// The screens before the app have to carry their own styling. styles.css loads
// in the background, see js/boot-gate.js, so nothing in it exists yet when the
// first pixels go up. boot.css is where those rules live and this script copies
// them across. the <style> block is generated, NEVER edit it by hand.
// sync-webapp.sh runs this before it pushes anything to the containers.
//
// Pass --check to verify the block is current without writing (exit 1 if stale).

$webappDir = is_dir(__DIR__ . '/../webapp') ? __DIR__ . '/../webapp' : __DIR__ . '/..';
$cssPath  = $webappDir . '/boot.css';
$htmlPath = $webappDir . '/index.html';

foreach ([$cssPath, $htmlPath] as $p) {
    if (!is_readable($p)) {
        fprintf(STDERR, "Cannot read: %s\n", $p);
        exit(1);
    }
}

$css  = rtrim(file_get_contents($cssPath), "\n");
$html = file_get_contents($htmlPath);

$open  = '<style id="critical">';
$close = '</style>';
$start = strpos($html, $open);
if ($start === false) {
    fprintf(STDERR, "No %s block in %s\n", $open, $htmlPath);
    exit(1);
}
$bodyAt = $start + strlen($open);
$end    = strpos($html, $close, $bodyAt);
if ($end === false) {
    fprintf(STDERR, "Unterminated %s block in %s\n", $open, $htmlPath);
    exit(1);
}

$banner  = "\n/* Generated from boot.css by tools/build-critical-css.php - do not edit. */\n";
$updated = substr($html, 0, $bodyAt) . $banner . $css . "\n" . substr($html, $end);

if (in_array('--check', $argv, true)) {
    if ($updated !== $html) {
        fprintf(STDERR, "index.html critical CSS is stale - run: php tools/build-critical-css.php\n");
        exit(1);
    }
    echo "critical CSS up to date\n";
    exit(0);
}

if ($updated === $html) {
    echo "critical CSS unchanged\n";
    exit(0);
}

file_put_contents($htmlPath, $updated);
printf("inlined %s (%d bytes) into %s\n", basename($cssPath), strlen($css), basename($htmlPath));
