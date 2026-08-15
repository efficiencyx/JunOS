#!/bin/sh
set -eu

marker=/home/omega/.cache/.omega-owned
if [ ! -e "$marker" ]; then
    chown -R omega:omega /home/omega/.cache
    touch "$marker"
    chown omega:omega "$marker"
fi

exec setpriv --reuid=10001 --regid=10001 --keep-groups --no-new-privs "$@"
