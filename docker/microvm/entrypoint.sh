#!/bin/sh
# Starts as root only to prepare the volume mounted at /home/omai, then runs the server as `omai`.
set -e
home=/home/omai
# A fresh Northflank volume is owned by root and holds lost+found.
rm -rf "$home/lost+found"
[ -f "$home/.bashrc" ] || cp -a /etc/skel/. "$home/"
[ "$(stat -c %U "$home")" = omai ] || chown -R omai:omai "$home"
# setpriv replaces this shell, so the server is the container's main process and gets its stop signal.
exec setpriv --reuid=omai --regid=omai --init-groups env HOME="$home" USER=omai LOGNAME=omai \
  omai serve --hostname 0.0.0.0 --port 4096 --cors "${OMAI_APP_ORIGIN:?OMAI_APP_ORIGIN is required}"
