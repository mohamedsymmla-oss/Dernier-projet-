#!/bin/sh
# Si REDIS_URL n'est pas fourni (ex : offre Railway gratuite limitée à 2 services),
# un Redis local est démarré dans le conteneur. Aucune perte d'historique possible :
# PostgreSQL reste la source de vérité et l'état des files est reconstruit au démarrage.
set -e
if [ -z "$REDIS_URL" ]; then
  echo "REDIS_URL absent : démarrage d'un Redis local dans le conteneur"
  redis-server --port 6379 --bind 127.0.0.1 --save "" --appendonly no --daemonize yes
  i=0
  until redis-cli -p 6379 ping >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 50 ] && echo "Redis local ne démarre pas" && exit 1
    sleep 0.1
  done
  export REDIS_URL="redis://127.0.0.1:6379"
fi
exec node dist/main.js
