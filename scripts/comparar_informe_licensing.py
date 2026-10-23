"""Compara /api/report/licensing con el cálculo de informes_mensuales.

El generador de informes (informes_mensuales/informes/license_manager.py) calcula
los KPIs de licenciamiento en Python con `calcular_kpis` y `alertas`. El endpoint
/api/report/licensing (services/licensingReport.js) debe devolver exactamente lo
mismo para que el generador pueda dejar de duplicar las reglas. Este script lo
comprueba de dos formas:

  --offline   Sin red. Pasa los mismos datos de entrada (casos sintéticos con los
              bordes conocidos: cantidades como texto, storage subutilizado, BYOC
              dentro y fuera del fair use, empates de redondeo...) a
              `calcular_kpis`/`alertas` de Python y a `calcularKpis`/`alertas` de
              Node, y además contrasta los redondeos con `round`/`format` de Python.

  --org ORG   En vivo. Inicia sesión en la API (por defecto la local,
              http://localhost:4000) con LM_USER/LM_PASSWORD del .env de
              informes_mensuales, calcula los KPIs como el generador
              (subscriptionoverview + outbound-attempts + calcular_kpis) y los
              compara con lo que devuelve /api/report/licensing para la misma sesión.

Se ejecuta con el Python del entorno de informes_mensuales (necesita requests y
python-dotenv), desde la raíz de api-license-manager:

  ../../informes_mensuales/.venv/bin/python scripts/comparar_informe_licensing.py --offline
  ../../informes_mensuales/.venv/bin/python scripts/comparar_informe_licensing.py --org steren

El modo en vivo necesita la API local levantada sin crons; scripts/comparar_en_vivo.sh
lo hace todo (arranca la API en el puerto 4100, compara y la apaga):

  scripts/comparar_en_vivo.sh steren

Sale con código 0 si todo coincide y 1 si hay diferencias.
"""
import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent
INFORMES_DIR = Path(os.getenv("INFORMES_MENSUALES_DIR") or API_DIR.parent.parent / "informes_mensuales")
sys.path.insert(0, str(INFORMES_DIR))

from informes.license_manager import LicenseManager, alertas, calcular_kpis  # noqa: E402

# Ejecuta el módulo de Node con los mismos datos. Entrada por stdin:
# {"casos": [{"customer"|"billing": ..., "intentos": ...}], "numeros": [...]}.
NODE_SNIPPET = r"""
const fs = require("fs");
const { calcularKpis, alertas, pyFixed, pyRound, fmt } = require("./services/licensingReport");
const { formatTrusteeBilling } = require("./utils/formatTrusteeBilling");
const entrada = JSON.parse(fs.readFileSync(0, "utf8"));
const casos = entrada.casos.map(({ customer, billing, intentos }) => {
  const c = customer || formatTrusteeBilling(billing);
  const kpis = calcularKpis(c, intentos ?? null);
  return { customer: c, kpis, alertas: alertas(kpis) };
});
const numeros = entrada.numeros.map((x) => ({
  f0: pyFixed(x, 0), f1: pyFixed(x, 1), g0: fmt(x, 0), g1: fmt(x, 1), r1: pyRound(x, 1),
}));
process.stdout.write(JSON.stringify({ casos, numeros }));
"""


def ejecutar_node(entrada):
    r = subprocess.run(["node", "-e", NODE_SNIPPET], cwd=API_DIR, input=json.dumps(entrada),
                       capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise SystemExit(f"Node falló:\n{r.stderr}")
    return json.loads(r.stdout)


def diferencias(py, js, ruta="$"):
    """Lista de diferencias entre la salida de Python y la de Node (números por valor)."""
    if isinstance(py, bool) or isinstance(js, bool):
        return [] if py is js else [f"{ruta}: python={py!r} node={js!r}"]
    if isinstance(py, (int, float)) and isinstance(js, (int, float)):
        return [] if float(py) == float(js) else [f"{ruta}: python={py!r} node={js!r}"]
    if isinstance(py, dict) and isinstance(js, dict):
        salida = []
        if list(py) != list(js):
            salida.append(f"{ruta}: claves python={list(py)} node={list(js)}")
        for k in py:
            if k in js:
                salida += diferencias(py[k], js[k], f"{ruta}.{k}")
        return salida
    if isinstance(py, list) and isinstance(js, list):
        if len(py) != len(js):
            return [f"{ruta}: {len(py)} elementos en python, {len(js)} en node"]
        salida = []
        for i, (a, b) in enumerate(zip(py, js)):
            salida += diferencias(a, b, f"{ruta}[{i}]")
        return salida
    return [] if py == js else [f"{ruta}: python={py!r} node={js!r}"]


# ---------------------------------------------------------------------------
# Modo offline
# ---------------------------------------------------------------------------

def _uso(nombre, prepago, uso, grouping=None):
    u = {"name": nombre, "prepayQuantity": prepago, "usageQuantity": uso}
    if grouping:
        u["grouping"] = grouping
    return u


def casos_sinteticos():
    org = {"organization": {"name": "Org de prueba", "id": "org-1"},
           "billingPeriodStartDate": "2026-09-01T00:00:00.000Z",
           "billingPeriodEndDate": "2026-09-30T23:59:59.999Z"}
    return [
        # Cantidades como texto, igual que las devuelve Genesys. Storage
        # subutilizado (el caso de steren: 98 en uso de 1,475), BYOC dentro del
        # fair use, IVR con fair use, recursos a cero que no deben salir.
        {"billing": {**org, "usages": [
            _uso("Genesys Cloud CX 3", "50", "48"),
            _uso("Genesys Cloud CX 3 Concurrent", "10", "12"),
            _uso("Genesys Cloud for Wallboard Device Charge", "2", "2"),
            _uso("Genesys Cloud Collaborate User", "100", "20"),
            _uso("Genesys Cloud CX 3 Digital Add-On I", "30", "28"),
            _uso("Genesys Cloud BYOC Cloud", "0", "123456.25", "resource"),
            _uso("Genesys Cloud IVR Basic Per Minute Charge", "1000", "4500.5", "resource"),
            _uso("Genesys Cloud IVR Basic Per Minute Charge", "0", "3000", "fair-use"),
            _uso("Genesys Cloud API Resource", "0", "180000", "resource"),
            _uso("Genesys Cloud API Resource", "0", "200000", "fair-use"),
            _uso("Genesys Cloud Voice Transcription", "0", "0", "resource"),
            _uso("Genesys Cloud Data Storage", "1475", "98"),
            _uso("AI Experience Tokens", "1000", "1200"),
            _uso("AI Experience Tokens - GC1", "0", "0"),
            _uso("Genesys Speech and Text Analytics", "0", "35"),
            _uso("AI Summary", "0", "0"),
            _uso("Genesys Cloud Static WebRTC TURN Charge", "0", "4"),
            _uso("Genesys Cloud Communicate Stand-alone Phone", "0", "0"),
        ]}, "intentos": {"totalAttempts": 812345, "campaigns": [{"id": "a"}, {"id": "b"}]}},
        # BYOC por encima del fair use con empate de redondeo (x.25 → .1f),
        # storage con sobreuso, licencia al 90 %, outbound por encima.
        {"billing": {**org, "usages": [
            _uso("Genesys Cloud CX 1", "20", "18"),
            _uso("Genesys Cloud BYOC Cloud", "0", "150000.25", "resource"),
            _uso("Genesys Cloud Data Storage", "98", "1475"),
            _uso("Genesys Cloud API Resource", "100000", "95000", "resource"),
        ]}, "intentos": {"totalAttempts": 400000, "campaigns": []}},
        # Sin licencias: fair use 0, BYOC con consumo → 100 %. Sin outbound.
        {"billing": {**org, "usages": [
            _uso("Genesys Cloud BYOC Cloud", "0", "10.5", "resource"),
        ]}, "intentos": None},
        # Cliente ya formateado con números (no texto), decimales y tokens con
        # incluidos; licencia con cantidades fraccionarias (se truncan).
        {"customer": {
            "name": "Formateado", "orgId": "org-2",
            "facturacion": {"inicio": "2026-08-01T00:00:00.000Z", "final": "2026-08-31T23:59:59.999Z"},
            "licencias": [{"name": "Genesys Cloud CX 2", "prepayQuantity": "12.7", "usageQuantity": 13, "overageQuantity": 0.3},
                          {"name": "Genesys Cloud CX 2 Digital Concurrent User", "prepayQuantity": 0, "usageQuantity": "5"}],
            "addons": [],
            "resources": [{"name": "Genesys Cloud BYOC Cloud", "prepayQuantity": 0, "usageQuantity": 92499.5, "overageQuantity": 92499.5, "incluido": 0},
                          {"name": "Genesys Cloud IVR Basic Per Minute Charge", "prepayQuantity": 0, "usageQuantity": 0, "overageQuantity": 0, "incluido": 0}],
            "storage": {"comprometido": "0", "enUso": "12.345", "overageQuantity": -3},
            "iaTokens": {"name": "", "prepayQuantity": 0, "overageQuantity": 0, "usageQuantity": 7, "incluido": 8},
            "aiExperience": [{"name": "AI Guide", "usageQuantity": "0.5"}],
            "devices": [],
        }, "intentos": {"totalAttempts": "1", "campaigns": None}},
        # Datos vacíos.
        {"customer": {}, "intentos": {}},
    ]


def numeros_de_prueba():
    rnd = random.Random(20261017)
    xs = [0.0, 0.5, 1.5, 2.5, 0.05, 0.15, 0.25, 0.35, 1234.5, 1234.25, 1234.75, 99.95, 89.95,
          12.25, 1e6 + 0.5, 92499.5, 150000.25, 123456.25, 2.675, 1.005]
    xs += [k / 8 for k in range(0, 400)]
    xs += [rnd.uniform(0, 2_000_000) for _ in range(500)]
    xs += [round(rnd.uniform(0, 100_000), rnd.randint(0, 3)) for _ in range(500)]
    xs += [a / b * 100 for a, b in ((rnd.randint(0, 5000), rnd.randint(1, 5000)) for _ in range(500))]
    return xs


def modo_offline():
    casos, numeros = casos_sinteticos(), numeros_de_prueba()
    node = ejecutar_node({"casos": casos, "numeros": numeros})
    fallos = []

    for i, (caso, js) in enumerate(zip(casos, node["casos"])):
        # Python recibe el mismo cliente que Node (formateado por formatTrusteeBilling).
        kpis_py = calcular_kpis(js["customer"], caso["intentos"])
        fallos += diferencias(kpis_py, js["kpis"], f"caso{i}.kpis")
        fallos += diferencias(alertas(kpis_py), js["alertas"], f"caso{i}.alertas")
        sobreuso_storage = (js["customer"].get("storage") or {}).get("overageQuantity", 0)
        if "billing" in caso and sobreuso_storage < 0:
            fallos.append(f"caso{i}: formatTrusteeBilling devolvió storage.overageQuantity={sobreuso_storage}")

    for x, js in zip(numeros, node["numeros"]):
        esperado = {"f0": f"{x:.0f}", "f1": f"{x:.1f}", "g0": f"{x:,.0f}", "g1": f"{x:,.1f}", "r1": round(x, 1)}
        for k, v in esperado.items():
            if (v != js[k]) if isinstance(v, str) else (float(v) != float(js[k])):
                fallos.append(f"número {x!r} [{k}]: python={v!r} node={js[k]!r}")

    print(f"Casos comparados: {len(casos)} · números: {len(numeros)}")
    return fallos


# ---------------------------------------------------------------------------
# Modo en vivo
# ---------------------------------------------------------------------------

def modo_vivo(org, api_url, fin, zona):
    import requests
    from informes.config import cargar_config

    cfg = cargar_config()
    if not (cfg.lm_user and cfg.lm_password):
        raise SystemExit(f"Faltan LM_USER/LM_PASSWORD en {INFORMES_DIR / '.env'}")

    lm = LicenseManager(api_url, cfg.lm_user, cfg.lm_password, timeout=120)
    lm.login(org)

    # Lo que hace hoy el generador (extraer_licenciamiento, sin el histórico).
    actual = lm.resumen(fin)
    fact = actual.get("facturacion") or {}
    inicio, final = fact.get("inicio"), fact.get("final")
    intentos = lm.intentos_outbound(inicio[:10], final[:10], zona) if inicio and final else None
    kpis_py = calcular_kpis(actual, intentos)
    alertas_py = alertas(kpis_py)

    r = requests.get(f"{api_url}/api/report/licensing", headers=lm._headers(), timeout=120,
                     params={"endDate": fin, "timezone": zona})
    datos = r.json()
    if r.status_code != 200 or not datos.get("success"):
        raise SystemExit(f"/api/report/licensing respondió {r.status_code}: {datos}")

    fallos = diferencias(kpis_py, datos["kpis"], "kpis") + diferencias(alertas_py, datos["alertas"], "alertas")

    k = datos["kpis"]
    print(f"Organización: {k['organizacion']} ({org}) · región {datos['region']}")
    print(f"Periodo: {k['periodo']['inicio']} → {k['periodo']['fin']}")
    print(f"Licencias: {len(k['licencias'])} · addons: {len(k['addons'])} · recursos: {len(k['recursos'])}")
    b = k["byoc"]
    print(f"BYOC: {b['usado']:,.1f} min de {b['limite_fair_use']:,.0f} de fair use "
          f"({b['nominales']} nominales, {b['concurrentes']} concurrentes) · excedente {b['excedente']:,.1f}")
    o = k["outbound"]
    print(f"Outbound: {o['intentos']:,.0f} intentos de {o['limite_fair_use']:,.0f}" if o else
          f"Outbound: sin datos ({datos.get('outboundError')})")
    s = k["storage"]
    print(f"Storage: {s['en_uso']:,.2f} de {s['comprometido']:,.2f} · sobreuso {s['sobreuso']:,.2f}")
    print(f"Alertas: {len(datos['alertas'])}")
    for a in datos["alertas"]:
        print(f"  [{a['nivel']}] {a['tema']}: {a['detalle']}")
    return fallos


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modo = p.add_mutually_exclusive_group(required=True)
    modo.add_argument("--offline", action="store_true", help="comparar con datos sintéticos, sin red")
    modo.add_argument("--org", help="orgname de LicenseManager para la comparación en vivo")
    p.add_argument("--api", default=os.getenv("LM_LOCAL_API_URL", "http://localhost:4000"),
                   help="URL de la API con /api/report/licensing (por defecto la local)")
    p.add_argument("--end", default="previous", help="endDate: previous (por defecto), current o timestamp")
    p.add_argument("--timezone", default="America/Mexico_City", help="zona para los intentos outbound")
    args = p.parse_args()

    fallos = modo_offline() if args.offline else modo_vivo(args.org, args.api.rstrip("/"), args.end, args.timezone)
    if fallos:
        print(f"\n✗ {len(fallos)} diferencias:")
        for f in fallos[:100]:
            print(f"  {f}")
        sys.exit(1)
    print("\n✓ Python (informes_mensuales) y /api/report/licensing coinciden.")


if __name__ == "__main__":
    main()
