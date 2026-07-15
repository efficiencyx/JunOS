FROM php:8.2-fpm-alpine

# Runtime deps: curl (health probe), fcgi (cgi-fcgi healthcheck binary).
# Build deps (autoconf, build-base) needed for `pecl install apcu`; removed after.
RUN apk add --no-cache curl fcgi sqlite-libs \
 && apk add --no-cache --virtual .build-deps autoconf build-base sqlite-dev \
 && pecl install apcu \
 && docker-php-ext-enable apcu \
 && docker-php-ext-install opcache pdo_sqlite \
 && apk del .build-deps \
 && rm -rf /tmp/pear

# PHP tuning: security + performance
# post_max_size covers the STT WAV upload (/api/stt.php). It's global, but nginx
# caps every other location at 16k/256k, so those never reach this limit.
RUN { \
      echo 'post_max_size=4M'; \
      echo 'upload_max_filesize=1M'; \
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

# State dir for rate-limiter flat files and SQLite DB (mounted as volume omega_state)
RUN mkdir -p /var/lib/omega/rl \
 && chown -R www-data:www-data /var/lib/omega /var/www/omega

EXPOSE 9000

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD cgi-fcgi -bind -connect 127.0.0.1:9000 || exit 1

# Use the base image's php-fpm entrypoint/cmd
CMD ["php-fpm"]
