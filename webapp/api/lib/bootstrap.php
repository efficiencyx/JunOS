<?php

require_once __DIR__ . '/http.php';
require_once __DIR__ . '/text.php';
require_once __DIR__ . '/env.php';
require_once __DIR__ . '/sidecar.php';
require_once __DIR__ . '/guards.php';
require_once __DIR__ . '/ratelimit.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/session.php';
require_once __DIR__ . '/memory.php';
require_once __DIR__ . '/journal.php';
require_once __DIR__ . '/consolidation/state.php';
require_once __DIR__ . '/crypto.php';
require_once __DIR__ . '/trips.php';
require_once __DIR__ . '/relationship.php';
require_once __DIR__ . '/providers/config.php';
require_once __DIR__ . '/providers/ollama.php';
require_once __DIR__ . '/providers/context.php';
require_once __DIR__ . '/providers/payload.php';
require_once __DIR__ . '/providers/complete.php';
require_once __DIR__ . '/providers/think.php';
require_once __DIR__ . '/providers/stream.php';

// every endpoint pulls in this file, so the CSRF check lives HERE
// and not in each one, where the next endpoint somebody writes
// would just forget it. the consolidation worker runs on the CLI,
// there's no request to check there.
if (PHP_SAPI !== 'cli') {
    require_allowed_host();
    require_same_origin();
}
