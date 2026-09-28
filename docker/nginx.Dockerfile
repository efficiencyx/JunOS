FROM nginx:1.30.4-alpine

# curl for the healthcheck. openssl makes the self signed
# localhost cert
RUN apk add --no-cache curl openssl

RUN rm -f /etc/nginx/conf.d/default.conf

COPY webapp/ /var/www/omega/

# the nginx image runs envsubst on *.template files at boot
COPY docker/nginx/templates/ /etc/nginx/templates/

# these get included by both templates. keeping them out of a
# .template stops envsubst mangling the header values.
COPY docker/nginx/snippets/ /etc/nginx/snippets/

COPY docker/nginx/tls-link.sh /usr/local/lib/omega-tls-link.sh
COPY docker/nginx/10-pick-config.sh /docker-entrypoint.d/10-pick-config.sh
COPY docker/nginx/30-cert-watch.sh /docker-entrypoint.d/30-cert-watch.sh
RUN chmod +x /docker-entrypoint.d/10-pick-config.sh /docker-entrypoint.d/30-cert-watch.sh

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1/health || exit 1
