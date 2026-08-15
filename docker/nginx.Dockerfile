FROM nginx:1.30.4-alpine

# curl for the healthcheck, openssl for the self signed localhost cert
RUN apk add --no-cache curl openssl

# bin the stock welcome page config so only ours gets loaded
RUN rm -f /etc/nginx/conf.d/default.conf

COPY webapp/ /var/www/omega/

# nginx has envsubst built in, it fills in *.template files at boot
COPY docker/nginx/templates/ /etc/nginx/templates/

# these get included by both templates. keeping them out of a
# .template stops envsubst mangling the header values.
COPY docker/nginx/snippets/ /etc/nginx/snippets/

COPY docker/nginx/10-pick-config.sh /docker-entrypoint.d/10-pick-config.sh
RUN chmod +x /docker-entrypoint.d/10-pick-config.sh

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1/health || exit 1
