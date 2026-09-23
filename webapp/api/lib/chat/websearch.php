<?php

function resolve_public_http_url(string $url): array {
    $parts = parse_url($url);
    if (!is_array($parts) || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) return ['error' => 'url_must_be_public_http_or_https'];
    if (($parts['user'] ?? '') !== '' || ($parts['pass'] ?? '') !== '') return ['error' => 'url_credentials_not_allowed'];
    $host = $parts['host'] ?? '';
    if ($host === '' || strlen($url) > 2048) return ['error' => 'url_invalid'];

    $ips = [];
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips[] = $host;
    } else {
        $records = @dns_get_record($host, DNS_A + DNS_AAAA);
        if (!$records) return ['error' => 'dns_lookup_failed'];
        foreach ($records as $r) {
            $ip = $r['ip'] ?? $r['ipv6'] ?? '';
            if ($ip !== '') $ips[] = $ip;
        }
    }
    $ips = array_values(array_unique($ips));
    if (!$ips) return ['error' => 'dns_lookup_failed'];
    foreach ($ips as $ip) {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return ['error' => 'url_must_resolve_to_public_ip'];
        }
    }

    $scheme = strtolower((string)$parts['scheme']);
    $port = (int)($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
    if (($scheme === 'http' && $port !== 80) || ($scheme === 'https' && $port !== 443)) return ['error' => 'non_standard_port_not_allowed'];
    return ['ok' => true, 'host' => $host, 'port' => $port, 'ip' => $ips[0]];
}

function make_absolute_url(string $base, string $location): string {
    $location = trim($location);
    if (preg_match('/^https?:\/\//i', $location)) return $location;
    $b = parse_url($base);
    if (!is_array($b) || empty($b['scheme']) || empty($b['host'])) return $location;
    if (substr($location, 0, 2) === '//') return $b['scheme'] . ':' . $location;
    if (substr($location, 0, 1) === '/') return $b['scheme'] . '://' . $b['host'] . $location;
    $path = $b['path'] ?? '/';
    $dir = preg_replace('#/[^/]*$#', '/', $path) ?: '/';
    return $b['scheme'] . '://' . $b['host'] . $dir . $location;
}

function web_search_public(string $query): array {
    if ($query === '') return ['error' => 'query_required'];
    if (mb_strlen($query) > 400) $query = mb_substr($query, 0, 400);
    $page = web_fetch_public('https://html.duckduckgo.com/html/?q=' . rawurlencode($query));
    if (!empty($page['error'])) return $page;
    $html = (string)($page['raw_html'] ?? '');
    $results = [];
    if (preg_match_all('#<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>#si', $html, $links, PREG_SET_ORDER)) {
        preg_match_all('#<a[^>]+class="result__snippet"[^>]*>(.*?)</a>#si', $html, $snips);
        foreach ($links as $i => $m) {
            $href = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
            // duckduckgo buries the real URL inside /l/?uddg=<encoded>
            if (preg_match('#[?&]uddg=([^&]+)#', $href, $u)) $href = urldecode($u[1]);
            $title = trim(html_entity_decode(strip_tags($m[2]), ENT_QUOTES | ENT_HTML5));
            $snippet = trim(html_entity_decode(strip_tags($snips[1][$i] ?? ''), ENT_QUOTES | ENT_HTML5));
            if ($title === '' || !preg_match('#^https?://#i', $href)) continue;
            $results[] = ['title' => $title, 'url' => $href, 'snippet' => mb_substr($snippet, 0, 300)];
            if (count($results) >= 6) break;
        }
    }
    if (!$results) return ['error' => 'no_results', 'query' => $query];
    return ['query' => $query, 'results' => $results];
}

function web_fetch_public(string $url): array {
    $maxBytes = 512 * 1024;
    $current = $url;
    for ($hop = 0; $hop <= 3; $hop++) {
        $resolved = resolve_public_http_url($current);
        if (empty($resolved['ok'])) return $resolved;
        $body = '';
        $tooLarge = false;
        $location = '';
        $ch = curl_init($current);
        $opts = [
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_USERAGENT => 'JunToolFetcher/1.0',
            CURLOPT_RESOLVE => [$resolved['host'] . ':' . $resolved['port'] . ':' . $resolved['ip']],
            CURLOPT_HEADERFUNCTION => function ($ch, string $header) use (&$location): int {
                if (stripos($header, 'Location:') === 0) $location = trim(substr($header, 9));
                return strlen($header);
            },
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, &$tooLarge, $maxBytes): int {
                if (strlen($body) + strlen($chunk) > $maxBytes) { $tooLarge = true; return 0; }
                $body .= $chunk;
                return strlen($chunk);
            },
        ];
        if (defined('CURLOPT_PROTOCOLS')) $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
        if (defined('CURLOPT_REDIR_PROTOCOLS')) $opts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
        curl_setopt_array($ch, $opts);
        $ok = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);
        if ($ok === false) return ['error' => $tooLarge ? 'response_too_large' : 'fetch_failed', 'detail' => $err];
        if (in_array($code, [301, 302, 303, 307, 308], true) && $location !== '') {
            if ($hop === 3) return ['error' => 'too_many_redirects'];
            $current = make_absolute_url($current, $location);
            continue;
        }
        return ['status' => $code, 'content_type' => $ctype, 'url' => $current, 'raw_html' => $body];
    }
    return ['error' => 'too_many_redirects'];
}
