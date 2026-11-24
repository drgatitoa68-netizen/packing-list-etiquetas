#!/usr/bin/env bash
# Login de clasp pensado para el celular: deja clasp esperando y lee la URL
# de retorno desde un FIFO, para poder pegarla en el chat con Claude.
# Uso:  bin/clasp-login.sh start   -> imprime la URL de autorización
#       bin/clasp-login.sh finish '<url http://localhost:8888/?code=...>'
set -euo pipefail
DIR="${TMPDIR:-/tmp}/clasp-login"; FIFO="$DIR/in"; LOG="$DIR/log"
case "${1:-}" in
  start)
    rm -rf "$DIR"; mkdir -p "$DIR"; mkfifo "$FIFO"
    nohup bash -c "clasp login --no-localhost < <(cat '$FIFO') > '$LOG' 2>&1" >/dev/null 2>&1 &
    for _ in $(seq 20); do grep -q 'https://accounts' "$LOG" 2>/dev/null && break; sleep 0.5; done
    grep -o 'https://accounts[^ ]*' "$LOG" ;;
  finish)
    [[ -n "${2:-}" ]] || { echo "Falta la URL"; exit 1; }
    printf '%s\n' "$2" > "$FIFO"; sleep 4
    sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$LOG" | grep -Ei 'logged|error|saved' || tail -3 "$LOG"
    test -f ~/.clasprc.json && echo "OK: credenciales en ~/.clasprc.json" ;;
  *) echo "Uso: $0 start | finish '<url>'"; exit 1 ;;
esac
