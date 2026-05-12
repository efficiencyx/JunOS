FROM php:8.2-cli

# curl extension is already enabled in php:8.2-cli; nothing to install.

WORKDIR /app
COPY webapp/ /app/webapp/

EXPOSE 8000
CMD ["php", "-S", "0.0.0.0:8000", "-t", "webapp"]
