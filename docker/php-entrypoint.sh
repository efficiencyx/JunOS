#!/bin/sh
set -eu

php -r 'require "/var/www/omega/api/lib/bootstrap.php"; db();'
php /var/www/omega/api/consolidation-worker.php &
php /var/www/omega/api/prewarm.php &
exec docker-php-entrypoint "$@"
