FROM php:8.2-fpm-alpine

# What we need at runtime: curl for the health probe, fcgi for the cgi-fcgi
# healthcheck binary. autoconf and build-base are only for `pecl install apcu`
# and come back off after.
RUN apk add --no-cache curl fcgi sqlite-libs su-exec \
 && apk add --no-cache --virtual .build-deps autoconf build-base sqlite-dev \
 && pecl install apcu \
 && docker-php-ext-enable apcu \
 && docker-php-ext-install opcache pdo_sqlite \
 && apk del .build-deps \
 && rm -rf /tmp/pear

# PHP settings, security and speed
# post_max_size has to cover the biggest upload we take, the audio body on
# /api/karaoke.php. the STT WAV sits well under it. this is global, but nginx
# caps every other location at 16k/256k so they never get near it.
RUN { \
      echo 'post_max_size=30M'; \
      echo 'upload_max_filesize=30M'; \
      echo 'max_execution_time=300'; \
      echo 'memory_limit=128M'; \
      echo 'expose_php=Off'; \
      echo 'display_errors=Off'; \
      echo 'log_errors=On'; \
      echo 'error_log=/proc/self/fd/2'; \
      echo 'opcache.enable=1'; \
      echo 'opcache.validate_timestamps=0'; \
    } > /usr/local/etc/php/conf.d/omega.ini

WORKDIR /var/www/omega

COPY webapp/ /var/www/omega/
COPY docker/php-entrypoint.sh /usr/local/bin/omega-php-entrypoint

# Where the rate limiter files and the SQLite DB live, mounted as omega_state
RUN mkdir -p /var/lib/omega/rl \
 && chown -R www-data:www-data /var/lib/omega /var/www/omega \
 && chmod +x /usr/local/bin/omega-php-entrypoint

EXPOSE 9000

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD cgi-fcgi -bind -connect 127.0.0.1:9000 || exit 1

ENTRYPOINT ["/usr/local/bin/omega-php-entrypoint"]
CMD ["php-fpm"]
