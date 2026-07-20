#!/bin/sh
set -eu

su-exec www-data php -r 'require "/var/www/omega/api/_lib.php"; db();'
su-exec www-data php /var/www/omega/api/consolidation-worker.php &
exec docker-php-entrypoint "$@"
