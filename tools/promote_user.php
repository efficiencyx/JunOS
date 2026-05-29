<?php
require __DIR__ . '/../webapp/api/_lib.php';
$email = $argv[1] ?? exit("usage: promote_user.php <email> [role]\n");
$role = $argv[2] ?? 'admin';
$st = db()->prepare('UPDATE users SET role=? WHERE email=?');
$st->execute([$role, $email]);
echo $st->rowCount() ? "ok\n" : "no such user\n";
