<?php

function provider_strip_think(string $text): string {
    $text = preg_replace('/<think>.*?<\/think>/is', '', $text);
    $text = preg_replace('/^\s*<think>.*$/is', '', $text);
    return trim($text);
}

function provider_route_think_token(string $token, array &$state, callable $emit): void {
    $buf = $state['think_hold'] . $token;
    $state['think_hold'] = '';

    while ($buf !== '') {
        $tag = $state['think_open'] ? '</think>' : '<think>';
        $pos = stripos($buf, $tag);
        if ($pos === false) break;
        $head = substr($buf, 0, $pos);
        if ($head !== '') {
            if ($state['think_open']) {
                $emit(['thinking' => $head]);
            } else {
                $emit(['token' => $head]);
                $state['content'] .= $head;
            }
        }
        $buf = substr($buf, $pos + strlen($tag));
        $state['think_open'] = !$state['think_open'];
    }

    if ($buf === '') return;

    // a tag can get split across two stream chunks, so hold back
    // the tail if it could be the start of one
    $tag = $state['think_open'] ? '</think>' : '<think>';
    $hold = 0;
    for ($n = min(strlen($tag) - 1, strlen($buf)); $n > 0; $n--) {
        if (strcasecmp(substr($buf, -$n), substr($tag, 0, $n)) === 0) {
            $hold = $n;
            break;
        }
    }
    if ($hold > 0) {
        $state['think_hold'] = substr($buf, -$hold);
        $buf = substr($buf, 0, strlen($buf) - $hold);
    }
    if ($buf === '') return;

    if ($state['think_open']) {
        $emit(['thinking' => $buf]);
    } else {
        $emit(['token' => $buf]);
        $state['content'] .= $buf;
    }
}

function provider_flush_think_hold(array &$state, callable $emit): void {
    $rest = $state['think_hold'];
    $state['think_hold'] = '';
    if ($rest === '') return;
    if ($state['think_open']) {
        $emit(['thinking' => $rest]);
    } else {
        $emit(['token' => $rest]);
        $state['content'] .= $rest;
    }
}
