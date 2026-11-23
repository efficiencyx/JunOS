<?php

const I18N_LANGS = ['de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'pl', 'pt', 'zh'];

function i18n_dict(): array {
    static $dict;
    if ($dict !== null) return $dict;
    $dict = [];
    $lang = strtolower(substr((string)($_GET['lang'] ?? ''), 0, 2));
    if (in_array($lang, I18N_LANGS, true)) {
        $raw = @file_get_contents(__DIR__ . '/../../i18n/' . $lang . '.json');
        $decoded = is_string($raw) ? json_decode($raw, true) : null;
        if (is_array($decoded)) $dict = $decoded;
    }
    return $dict;
}

function tr(string $key, string $english, array $vars = []): string {
    $line = i18n_dict()[$key] ?? $english;
    foreach ($vars as $name => $value) $line = str_replace('{' . $name . '}', (string)$value, $line);
    return $line;
}
