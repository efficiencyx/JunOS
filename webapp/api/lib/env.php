<?php

function env_str(string $key, string $default = ''): string {
    $v = getenv($key);
    return ($v !== false && $v !== '') ? $v : $default;
}

// somewhere we can actually write, for the SQLite DB and the rate
// limit files. docker keeps the default. a bare metal install on
// Windows points OMEGA_STATE_DIR at the install folder so the
// whole thing still uninstalls in one go.
function state_dir(): string {
    return rtrim(env_str('OMEGA_STATE_DIR', '/var/lib/omega'), '/\\');
}
