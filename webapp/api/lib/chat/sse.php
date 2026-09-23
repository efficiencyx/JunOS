<?php

function sse_open(): void {
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) { ob_end_flush(); }
    ob_implicit_flush(true);

    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache, no-transform');
    header('X-Accel-Buffering: no');
    header('Connection: keep-alive');
}

function sse_send(array $obj): void {
    echo 'data: ' . json_encode($obj, JSON_UNESCAPED_UNICODE) . "\n\n";
    @flush();
}

function sse_done(): void {
    echo "data: [DONE]\n\n";
    @flush();
}

// bail out mid stream. errors go over SSE, the event stream that's
// already open in the browser, NOT through HTTP status codes.
function sse_fail(string $err): never {
    sse_send(['error' => $err]);
    sse_done();
    exit;
}
