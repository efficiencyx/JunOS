<?php

const I18N_LANGS = ['it', 'de', 'ja', 'fr', 'es', 'pt', 'hi', 'zh', 'zh-TW', 'pl'];

function i18n_lang(string $code): string {
    $parts = explode('-', strtolower($code));
    if ($parts[0] === 'zh' && in_array($parts[1] ?? '', ['hant', 'tw', 'hk', 'mo'], true)) return 'zh-TW';
    return $parts[0];
}

function i18n_dict(): array {
    static $dict;
    if ($dict !== null) return $dict;
    $dict = [];
    $lang = i18n_lang((string)($_GET['lang'] ?? ''));
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
