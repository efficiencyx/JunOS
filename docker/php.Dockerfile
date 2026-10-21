FROM php:8.2.35-fpm-alpine

ARG APCU_VERSION=5.1.28
ARG APCU_SHA256=0e60ba9d0fa4021c57a70c071f3d8f71de236275d084e560d5959fec4edd8c32

# what we need at runtime: curl for the health probe, fcgi for
# the cgi-fcgi healthcheck binary. autoconf and build-base are
# ONLY for building apcu and get ripped back out after.
# apcu comes from its github tag, not `pecl install`. pecl.php.net
# 504'd for hours the day a php RCE dropped (2026-10-21), and
# every update runs `up --build`, so a dead pecl = nobody can
# update. pinned + sha256 checked like everything else.
RUN apk add --no-cache curl fcgi sqlite-libs \
 && apk add --no-cache --virtual .build-deps autoconf build-base sqlite-dev \
 && curl -fsSL -o /tmp/apcu.tgz "https://github.com/krakjoe/apcu/archive/refs/tags/v${APCU_VERSION}.tar.gz" \
 && echo "${APCU_SHA256}  /tmp/apcu.tgz" | sha256sum -c - \
 && docker-php-source extract \
 && mkdir -p /usr/src/php/ext/apcu \
 && tar xzf /tmp/apcu.tgz -C /usr/src/php/ext/apcu --strip-components=1 \
 && docker-php-ext-install apcu opcache pdo_sqlite \
 && docker-php-source delete \
 && apk del .build-deps \
 && rm -f /tmp/apcu.tgz

# post_max_size has to cover the biggest upload we take, the
# audio body on /api/karaoke.php. the STT WAV sits well under it.
# yes this is global, but nginx caps every other location at
# 16k or 4m so they never get near it.
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

# the stock pool is 5 workers. a chat stream, a karaoke split and
# every tts call each hold one for as long as they run (up to
# 900s), and nginx lets a single IP keep 9 of those open. 5 means
# karaoke + voice mode eats the whole pool and every other api
# call queues behind them. ondemand, NOT dynamic: dynamic only
# adds ~1 worker per second when a burst lands, so 8 streams
# starting together still stalled everything for ~3s. ondemand
# forks the moment a request comes in. a worker is ~20MB (source:
# trust me bro, measured on the dev box), 16 fit the 1g container
# fine. zz- so it loads after www.conf.
RUN printf '[www]\npm = ondemand\npm.max_children = 16\n' > /usr/local/etc/php-fpm.d/zz-omega.conf

WORKDIR /var/www/omega

COPY webapp/ /var/www/omega/
COPY docker/php-entrypoint.sh /usr/local/bin/omega-php-entrypoint

# the app tree stays root owned. php only ever reads it (state,
# memory, the rate limit files all live under /var/lib/omega), so
# a php bug can't rewrite its own code either.
RUN mkdir -p /var/lib/omega/rl \
 && chown -R www-data:www-data /var/lib/omega \
 && chmod -R a+rX /var/www/omega \
 && chmod +x /usr/local/bin/omega-php-entrypoint

EXPOSE 9000

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD cgi-fcgi -bind -connect 127.0.0.1:9000 || exit 1

USER www-data

ENTRYPOINT ["/usr/local/bin/omega-php-entrypoint"]
CMD ["php-fpm"]
