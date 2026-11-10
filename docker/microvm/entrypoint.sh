#!/bin/sh
# Starts as root only to prepare the volume mounted at /home/omai, then runs the server as `omai`.
set -e
home=/home/omai
# A fresh Northflank volume is owned by root and holds lost+found.
rm -rf "$home/lost+found"
[ -f "$home/.bashrc" ] || cp -a /etc/skel/. "$home/"
[ "$(stat -c %U "$home")" = omai ] || chown -R omai:omai "$home"
# The terminal's prompt names the sandbox, not the pod Northflank gave the container (`omai-vm-<id>-<hash>-<pod>`).
# A container can't rename its own host, so the prompt says it instead. Added once: the home is the project volume.
grep -q "omai-prompt" "$home/.bashrc" 2>/dev/null || cat >> "$home/.bashrc" <<'PROMPT'

# omai-prompt: the sandbox's name in place of the container's hostname.
PS1='\[\e[01;32m\]\u@omai-sandbox\[\e[00m\]:\[\e[01;34m\]\w\[\e[00m\]\$ '
PROMPT
chown omai:omai "$home/.bashrc"
# The server's temp folder (archives for downloads, generated images) must be the server's own: anything run as root
# first, such as the image build's version check, leaves it owned by root and every write in it fails.
mkdir -p /tmp/omai
chown -R omai:omai /tmp/omai
# setpriv replaces this shell, so the server is the container's main process and gets its stop signal.
exec setpriv --reuid=omai --regid=omai --init-groups env HOME="$home" USER=omai LOGNAME=omai \
  omai serve --hostname 0.0.0.0 --port 4096 --cors "${OMAI_APP_ORIGIN:?OMAI_APP_ORIGIN is required}"
