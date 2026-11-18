#!/bin/sh
set -eu
umask 077

# Values are inserted as single configuration fields, never shell commands.
case "$PAIR_DOMAIN" in ''|*[!A-Za-z0-9.-]*) echo "Invalid PAIR_DOMAIN" >&2; exit 1;; esac
case "$TURN_USERNAME" in ''|*[!A-Za-z0-9_-]*) echo "Invalid TURN_USERNAME" >&2; exit 1;; esac
for ip in "$TURN_PUBLIC_IP" "$TURN_LOCAL_IP"; do
    if ! awk -v ip="$ip" 'BEGIN { if (split(ip,a,".") != 4) exit 1; for (i=1;i<=4;i++) if (a[i] !~ /^[0-9]+$/ || length(a[i]) > 3 || a[i] > 255) exit 1 }'; then
        echo "Set TURN_PUBLIC_IP and TURN_LOCAL_IP to IPv4 addresses" >&2
        exit 1
    fi
done
password=$(cat /run/secrets/turn_password)
case "$password" in ''|*[!A-Za-z0-9_-]*) echo "Use a generated alphanumeric TURN password" >&2; exit 1;; esac
if [ "${#password}" -lt 24 ]; then echo "Use a TURN password of at least 24 characters" >&2; exit 1; fi

cat > /tmp/jianping-turn.conf <<CONFIG
listening-port=3478
listening-ip=$TURN_LOCAL_IP
relay-ip=$TURN_LOCAL_IP
external-ip=$TURN_PUBLIC_IP/$TURN_LOCAL_IP
min-port=49160
max-port=49200
realm=$PAIR_DOMAIN
lt-cred-mech
user=$TURN_USERNAME:$password
fingerprint
no-cli
no-tls
no-dtls
no-tcp-relay
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
user-quota=12
total-quota=32
pidfile=/tmp/jianping-turn.pid
simple-log
log-file=stdout
CONFIG
unset password
exec turnserver -c /tmp/jianping-turn.conf
