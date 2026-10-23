#!/usr/bin/env bash
# Prueba en vivo de /api/report/licensing contra el cálculo de informes_mensuales.
#
#   scripts/comparar_en_vivo.sh steren
#
# Levanta la API local en el puerto 4100 con los crons desactivados (con
# ENTORNO=DEV el monitor NO bloquea correos, así que sin esto podría enviar
# alertas reales), espera a que responda, ejecuta
# scripts/comparar_informe_licensing.py --org <org> y apaga la API al terminar.
#
# Ojo: la API local usa el Firestore real y las credenciales LM_USER/LM_PASSWORD
# de informes_mensuales/.env; el login deja un registro en accessLogs.
set -euo pipefail

ORG="${1:?Uso: scripts/comparar_en_vivo.sh <orgname> [endDate]}"
END="${2:-previous}"
PORT="${PORT:-4100}"
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${INFORMES_PYTHON:-$API_DIR/../../informes_mensuales/.venv/bin/python}"
LOG="$(mktemp "${TMPDIR:-/tmp}/api-report-licensing.XXXXXX")"

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "El puerto $PORT ya está en uso; usa otro con PORT=<n> $0 $ORG" >&2
  exit 1
fi

cd "$API_DIR"
PORT="$PORT" MONITOR_CRON="0 0 1 1 *" LOG_PURGE_CRON="0 0 1 1 *" node index.js >"$LOG" 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/health" >/dev/null || { echo "La API no arrancó; log en $LOG" >&2; exit 1; }

"$PYTHON" scripts/comparar_informe_licensing.py --org "$ORG" --end "$END" --api "http://localhost:$PORT"
echo "Log de la API: $LOG"
