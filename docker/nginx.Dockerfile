FROM nginx:1.27-alpine

# curl for the healthcheck, openssl for the self signed localhost cert
RUN apk add --no-cache curl openssl

# Throw out the stock welcome page config so only ours gets loaded
RUN rm -f /etc/nginx/conf.d/default.conf

# The static files nginx hands out itself
COPY webapp/ /var/www/omega/

# nginx 1.27 has envsubst built in, it fills in *.template files at boot
COPY docker/nginx/templates/ /etc/nginx/templates/

# The headers both templates share. not a .template, so nothing fills it in
COPY docker/nginx/snippets/ /etc/nginx/snippets/

# The hook that picks the right config template before nginx reads them
COPY docker/nginx/10-pick-config.sh /docker-entrypoint.d/10-pick-config.sh
RUN chmod +x /docker-entrypoint.d/10-pick-config.sh

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1/health || exit 1
