<?php
// the self-signed cert start.ps1 hands caddy on bare metal windows.
// same cert docker/nginx/10-pick-config.sh mints for nginx, that
// file has the why for 825 days, serverAuth and CA:FALSE.
// php and not openssl.exe because windows doesn't ship openssl and
// the portable php already has the extension.
//
// usage: php selfsigned-cert.php <dir> <host> [<host> ...]
// keeps what's there while the host list matches and it has 30+
// days left. anything else gets a new cert, and the browser
// warning comes back once.

if ($argc < 3) {
    fwrite(STDERR, "usage: php selfsigned-cert.php <dir> <host> [<host> ...]\n");
    exit(2);
}
$dir = $argv[1];
$hosts = array_values(array_unique(array_slice($argv, 2)));
$san = implode(',', array_map(
    fn($h) => (filter_var($h, FILTER_VALIDATE_IP) ? 'IP:' : 'DNS:') . $h,
    $hosts
));
$certFile = "$dir/fullchain.pem";
$keyFile = "$dir/privkey.pem";
$sanFile = "$dir/san";

$old = is_file($certFile) ? openssl_x509_parse((string)file_get_contents($certFile)) : false;
if ($old && is_file($keyFile) && @file_get_contents($sanFile) === $san
    && $old['validTo_time_t'] > time() + 30 * 86400) {
    exit(0);
}

// windows php has no openssl.cnf it can find on its own, and the
// SAN can only go in through one anyway
$cnf = tempnam(sys_get_temp_dir(), 'jun');
file_put_contents($cnf, "[req]\ndistinguished_name = dn\n[dn]\n[ext]\n"
    . "subjectAltName = $san\nbasicConstraints = critical,CA:FALSE\nextendedKeyUsage = serverAuth\n");
$opts = [
    'config' => $cnf,
    'x509_extensions' => 'ext',
    'digest_alg' => 'sha256',
    'private_key_type' => OPENSSL_KEYTYPE_RSA,
    'private_key_bits' => 2048,
];
try {
    $key = openssl_pkey_new($opts);
    $csr = $key ? openssl_csr_new(['commonName' => $hosts[0]], $key, $opts) : false;
    $cert = $csr ? openssl_csr_sign($csr, null, $key, 825, $opts, random_int(1, PHP_INT_MAX)) : false;
    if (!$cert || !openssl_x509_export($cert, $certPem) || !openssl_pkey_export($key, $keyPem, null, $opts)) {
        fwrite(STDERR, 'openssl: ' . (openssl_error_string() ?: 'failed') . "\n");
        exit(1);
    }
} finally {
    unlink($cnf);
}

if (!is_dir($dir)) mkdir($dir, 0700, true);
file_put_contents($keyFile, $keyPem);
file_put_contents($certFile, $certPem);
file_put_contents($sanFile, $san);
echo "new self-signed cert for $san\n";
