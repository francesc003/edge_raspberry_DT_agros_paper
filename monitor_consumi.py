#!/usr/bin/env python3
"""
Monitor dei consumi del container Digital Twin (AGROS edge stack).

Campiona a intervalli regolari l'uso di CPU e memoria del SOLO container
`agros-digital-twin`, usando `docker stats`. Distingue automaticamente le fasi
di IDLE (attesa tra un burst e l'altro) dalle fasi di CALCOLO (picco di CPU
quando arriva un nuovo burst e il DT esegue la pipeline).

Produce:
  - log a schermo in tempo reale
  - un file CSV con tutti i campioni (per grafici nel paper)
  - un riepilogo statistico a fine sessione (CPU/RAM medie in idle vs calcolo)

NON misura il consumo energetico in Watt (per quello serve un wattmetro
hardware). Misura l'impronta computazionale, che è il proxy software dei
consumi ed è sufficiente per confrontare idle vs calcolo e laptop vs Pi.

Uso:
    python3 monitor_consumi.py                      # campiona ogni 2s, all'infinito
    python3 monitor_consumi.py --interval 1         # ogni 1 secondo
    python3 monitor_consumi.py --duration 3600      # per 1 ora poi termina
    python3 monitor_consumi.py --container agros-digital-twin --out consumi.csv

Interrompi con Ctrl+C: stampa comunque il riepilogo finale.

Prerequisiti: lo stack deve essere in esecuzione (docker compose up).
"""

import argparse
import csv
import json
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

# Soglia di CPU% sopra la quale consideriamo il container "in calcolo".
# Sotto questa soglia è considerato "idle". Regolabile via --cpu-threshold.
DEFAULT_CPU_THRESHOLD = 5.0


def parse_args():
    p = argparse.ArgumentParser(description="Monitor consumi container Digital Twin")
    p.add_argument("--container", default="agros-digital-twin",
                   help="Nome del container da monitorare (default: agros-digital-twin)")
    p.add_argument("--interval", type=float, default=2.0,
                   help="Intervallo di campionamento in secondi (default: 2)")
    p.add_argument("--duration", type=float, default=None,
                   help="Durata totale in secondi (default: infinito, fino a Ctrl+C)")
    p.add_argument("--out", default="consumi_dt.csv",
                   help="File CSV di output (default: consumi_dt.csv)")
    p.add_argument("--cpu-threshold", type=float, default=DEFAULT_CPU_THRESHOLD,
                   help=f"Soglia CPU%% idle/calcolo (default: {DEFAULT_CPU_THRESHOLD})")
    return p.parse_args()


def get_stats(container):
    """
    Legge una singola riga di statistiche dal container via `docker stats`.
    Ritorna un dict con cpu_pct, mem_mb, mem_pct, oppure None se il container
    non è raggiungibile.
    """
    try:
        out = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}", container],
            capture_output=True, text=True, timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"[errore] docker stats non disponibile: {e}", file=sys.stderr)
        return None

    if out.returncode != 0 or not out.stdout.strip():
        return None

    try:
        d = json.loads(out.stdout.strip().splitlines()[0])
    except (json.JSONDecodeError, IndexError):
        return None

    # CPU: stringa tipo "0.15%"
    cpu_pct = float(d.get("CPUPerc", "0%").replace("%", "").strip() or 0)

    # MemUsage: stringa tipo "45.2MiB / 7.75GiB"
    mem_raw = d.get("MemUsage", "0MiB / 0MiB").split("/")[0].strip()
    mem_mb = to_mb(mem_raw)
    mem_pct = float(d.get("MemPerc", "0%").replace("%", "").strip() or 0)

    return {"cpu_pct": cpu_pct, "mem_mb": mem_mb, "mem_pct": mem_pct}


def to_mb(s):
    """Converte una stringa tipo '45.2MiB' / '1.2GiB' / '512KiB' in MB."""
    s = s.strip()
    try:
        if s.endswith("GiB"):
            return float(s[:-3]) * 1024
        if s.endswith("MiB"):
            return float(s[:-3])
        if s.endswith("KiB"):
            return float(s[:-3]) / 1024
        if s.endswith("B"):
            return float(s[:-1]) / (1024 * 1024)
    except ValueError:
        pass
    return 0.0


def main():
    args = parse_args()

    samples = []
    running = {"flag": True}

    def stop(signum, frame):
        running["flag"] = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    print(f"Monitoraggio consumi container '{args.container}'")
    print(f"Intervallo: {args.interval}s | Soglia idle/calcolo: {args.cpu_threshold}% CPU")
    print(f"Output CSV: {args.out}")
    if args.duration:
        print(f"Durata: {args.duration}s")
    print("Premi Ctrl+C per terminare e vedere il riepilogo.\n")
    print(f"{'timestamp':<20} {'CPU%':>8} {'MEM(MB)':>10} {'MEM%':>7}  stato")
    print("-" * 60)

    # Apri il CSV e scrivi l'header
    csv_file = open(args.out, "w", newline="")
    writer = csv.writer(csv_file)
    writer.writerow(["timestamp", "cpu_pct", "mem_mb", "mem_pct", "stato"])

    t_start = time.time()
    while running["flag"]:
        if args.duration and (time.time() - t_start) >= args.duration:
            break

        stats = get_stats(args.container)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        if stats is None:
            print(f"{ts:<20} {'--':>8} {'--':>10} {'--':>7}  container non raggiungibile")
            time.sleep(args.interval)
            continue

        stato = "CALCOLO" if stats["cpu_pct"] >= args.cpu_threshold else "idle"
        samples.append({**stats, "stato": stato})
        writer.writerow([ts, stats["cpu_pct"], round(stats["mem_mb"], 2),
                         stats["mem_pct"], stato])
        csv_file.flush()

        print(f"{ts:<20} {stats['cpu_pct']:>7.2f}% {stats['mem_mb']:>9.1f} "
              f"{stats['mem_pct']:>6.2f}%  {stato}")

        time.sleep(args.interval)

    csv_file.close()
    print_summary(samples, args)


def print_summary(samples, args):
    if not samples:
        print("\nNessun campione raccolto.")
        return

    idle = [s for s in samples if s["stato"] == "idle"]
    calcolo = [s for s in samples if s["stato"] == "CALCOLO"]

    def avg(lst, key):
        return sum(x[key] for x in lst) / len(lst) if lst else 0.0

    def mx(lst, key):
        return max((x[key] for x in lst), default=0.0)

    print("\n" + "=" * 60)
    print("RIEPILOGO CONSUMI")
    print("=" * 60)
    print(f"Campioni totali:   {len(samples)}")
    print(f"  in idle:         {len(idle)}")
    print(f"  in calcolo:      {len(calcolo)}")
    print("")
    print("Fase IDLE (container in attesa tra i burst):")
    print(f"  CPU media:       {avg(idle, 'cpu_pct'):.2f}%")
    print(f"  CPU max:         {mx(idle, 'cpu_pct'):.2f}%")
    print(f"  RAM media:       {avg(idle, 'mem_mb'):.1f} MB")
    print("")
    print("Fase CALCOLO (container che elabora un burst):")
    print(f"  CPU media:       {avg(calcolo, 'cpu_pct'):.2f}%")
    print(f"  CPU max:         {mx(calcolo, 'cpu_pct'):.2f}%")
    print(f"  RAM media:       {avg(calcolo, 'mem_mb'):.1f} MB")
    print(f"  RAM max:         {mx(calcolo, 'mem_mb'):.1f} MB")
    print("")
    print(f"Dati grezzi salvati in: {args.out}")
    print("Per il paper: usa il CSV per il grafico CPU nel tempo (picchi = calcoli).")


if __name__ == "__main__":
    main()
