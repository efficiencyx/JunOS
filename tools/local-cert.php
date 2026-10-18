<?php
// the cert start.ps1 hands caddy on bare metal windows, and the
// local CA that signs it. same pair docker/nginx/10-pick-config.sh
// mints for nginx, that file has the why for 825 days, serverAuth,
// CA:FALSE and the nameConstraints.
// php and not openssl.exe because windows doesn't ship openssl and
// the portable php already has the extension.
//
// usage: php local-cert.php <dir> <host> [<host> ...]
// the leaf stays while the host list matches, it has 30+ days left
// and the CA still vouches for it. the CA stays until it has 30
// days left or a host falls outside its names. only a new CA undoes
// the trust start.ps1 put in the windows store.

if ($argc < 3) {
    fwrite(STDERR, "usage: php local-cert.php <dir> <host> [<host> ...]\n");
    exit(2);
}
$dir = $argv[1];
$hosts = array_values(array_unique(array_slice($argv, 2)));
$san = implode(',', array_map(
    fn($h) => (filter_var($h, FILTER_VALIDATE_IP) ? 'IP:' : 'DNS:') . $h,
    $hosts
));
$caFile = "$dir/ca.pem";
$caKeyFile = "$dir/ca.key";
$certFile = "$dir/fullchain.pem";
$keyFile = "$dir/privkey.pem";
$sanFile = "$dir/san";
const MONTH = 30 * 86400;

function fresh(string $file): bool
{
    $cert = is_file($file) ? openssl_x509_parse((string)file_get_contents($file)) : false;
    return $cert && $cert['validTo_time_t'] > time() + MONTH;
}

function ca_vouches(string $caFile, string $certFile): bool
{
    return is_file($certFile)
        && openssl_x509_checkpurpose((string)file_get_contents($certFile), X509_PURPOSE_SSL_SERVER, [$caFile]) === true;
}

function ca_constraints(array $hosts): string
{
    $v6 = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff';
    $names = ['DNS:localhost', 'DNS:local', 'DNS:lan', 'DNS:internal', 'DNS:home.arpa',
        'IP:127.0.0.0/255.0.0.0', 'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0',
        'IP:192.168.0.0/255.255.0.0', 'IP:169.254.0.0/255.255.0.0', 'IP:100.64.0.0/255.192.0.0',
        "IP:::1/$v6", 'IP:fc00::/fe00::', 'IP:fe80::/ffc0::'];
    foreach ($hosts as $h) {
        if (filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) $names[] = "IP:$h/$v6";
        elseif (filter_var($h, FILTER_VALIDATE_IP)) $names[] = "IP:$h/255.255.255.255";
        else $names[] = "DNS:$h";
    }
    return 'critical,' . implode(',', array_map(fn($n) => "permitted;$n", array_unique($names)));
}

// windows php has no openssl.cnf it can find on its own, and the
// extensions can only go in through one anyway
function sign(array $subject, string $ext, int $days, $caCert = null, $caKey = null): array
{
    $cnf = tempnam(sys_get_temp_dir(), 'jun');
    file_put_contents($cnf, "[req]\ndistinguished_name = dn\n[dn]\n[ext]\n$ext");
    $opts = [
        'config' => $cnf,
        'x509_extensions' => 'ext',
        'digest_alg' => 'sha256',
        'private_key_type' => OPENSSL_KEYTYPE_RSA,
        'private_key_bits' => 2048,
    ];
    try {
        $key = openssl_pkey_new($opts);
        $csr = $key ? openssl_csr_new($subject, $key, $opts) : false;
        $cert = $csr ? openssl_csr_sign($csr, $caCert, $caKey ?? $key, $days, $opts, random_int(1, PHP_INT_MAX)) : false;
        if (!$cert || !openssl_x509_export($cert, $certPem) || !openssl_pkey_export($key, $keyPem, null, $opts)) {
            fwrite(STDERR, 'openssl: ' . (openssl_error_string() ?: 'failed') . "\n");
            exit(1);
        }
    } finally {
        unlink($cnf);
    }
    return [$certPem, $keyPem];
}

function make_ca(string $caFile, string $caKeyFile, array $hosts): void
{
    [$cert, $key] = sign(
        ['organizationName' => 'Jun OS', 'commonName' => 'Jun OS local CA ' . bin2hex(random_bytes(4))],
        "basicConstraints = critical,CA:TRUE,pathlen:0\nsubjectKeyIdentifier = hash\nkeyUsage = critical,keyCertSign,cRLSign\n"
            . 'nameConstraints = ' . ca_constraints($hosts) . "\n",
        3650
    );
    file_put_contents($caKeyFile, $key);
    file_put_contents($caFile, $cert);
    echo "new local CA\n";
}

function make_leaf(string $caFile, string $caKeyFile, string $certFile, string $keyFile, string $cn, string $san): void
{
    [$cert, $key] = sign(
        ['commonName' => $cn],
        "subjectAltName = $san\nbasicConstraints = critical,CA:FALSE\n"
            . "subjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid\n"
            . "keyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\n",
        825,
        (string)file_get_contents($caFile),
        [(string)file_get_contents($caKeyFile), '']
    );
    file_put_contents($keyFile, $key);
    file_put_contents($certFile, $cert);
}

if (!is_dir($dir)) mkdir($dir, 0700, true);
if (!is_file($caKeyFile) || !fresh($caFile)) make_ca($caFile, $caKeyFile, $hosts);
if (fresh($certFile) && is_file($keyFile) && @file_get_contents($sanFile) === $san && ca_vouches($caFile, $certFile)) {
    exit(0);
}
make_leaf($caFile, $caKeyFile, $certFile, $keyFile, $hosts[0], $san);
if (!ca_vouches($caFile, $certFile)) {
    make_ca($caFile, $caKeyFile, $hosts);
    make_leaf($caFile, $caKeyFile, $certFile, $keyFile, $hosts[0], $san);
}
file_put_contents($sanFile, $san);
echo "new cert for $san\n";
