FROM nginx:1.27-alpine

# curl for the healthcheck probe, openssl for the self-signed localhost cert
RUN apk add --no-cache curl openssl

# Drop the stock welcome-page config so only our template-generated config loads
RUN rm -f /etc/nginx/conf.d/default.conf

# Static assets served directly by nginx
COPY webapp/ /var/www/omega/

# nginx 1.27 built-in envsubst expands *.template files at container boot
COPY docker/nginx/templates/ /etc/nginx/templates/

# Header set shared by both templates; not a .template, so it is not expanded
COPY docker/nginx/snippets/ /etc/nginx/snippets/

# Hook that selects the right config template before nginx loads them
COPY docker/nginx/10-pick-config.sh /docker-entrypoint.d/10-pick-config.sh
RUN chmod +x /docker-entrypoint.d/10-pick-config.sh

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1/health || exit 1
