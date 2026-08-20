# A version, not :latest. this one holds the key to the cert it renews, so what
# it runs shouldn't change under us on a rebuild we did for some other reason.
FROM certbot/certbot:v5.7.0

COPY docker/certbot-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
