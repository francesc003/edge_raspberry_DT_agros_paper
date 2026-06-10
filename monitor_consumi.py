#!/usr/bin/env python3
"""
Monitor dei consumi del container Digital Twin (AGROS edge stack).

Misura CPU e memoria del SOLO container `agros-digital-twin` via `docker stats`,
con due modalita' pensate per le esigenze del paper.

============================================================================
NOTA TECNICA IMPORTANTE (leggere prima di interpretare i numeri)
============================================================================
Il calcolo del DT dura pochi millisecondi (~4 ms, vedi latency.log), mentre
`docker stats` aggiorna i suoi valori circa una volta al secondo. Con burst
ogni 10 minuti, il campionamento esterno NON riesce a "vedere" il picco di
calcolo quasi mai: cattura bene l'IDLE (99.99% del tempo) ma manca l'istante
del calcolo.

Per questo il consumo va raccontato con DUE fonti complementari:
  1. Questo script  -> consumo in IDLE e a regime (preciso)
  2. latency.log    -> durata reale del calcolo (~4 ms), il vero "costo
                       computazionale" del picco

La modalita' --mode stress etichetta i campioni come carico sostenuto: utile
se forzi il DT a calcolare di continuo per vedere il picco con docker stats
(limite superiore teorico).
============================================================================

Uso tipico:
    python3 monitor_consumi.py                          # idle/regime, Ctrl+C per fermare
    python3 monitor_consumi.py --interval 0.5
    python3 monitor_consumi.py --duration 1800 --out consumi_idle.csv
    python3 monitor_consumi.py --mode stress --out consumi_picco.csv

Prerequisiti: stack in esecuzione. Python 3.7+, nessuna libreria esterna.
"""

import argparse
import csv
import json
import signal
import subprocess
import time
from datetime import datetime, timezone


DEFAULT_CONTAINER = "agros-digital-twin"
DEFAULT_CPU_THRESHOLD = 5.0


def parse_args():
    p = argparse.ArgumentParser(
        description="Monitor consumi container Digital Twin (AGROS edge).",
    )
    p.add_argument("--container", default=DEFAULT_CONTAINER,
                   help=f"Nome container (default: {DEFAULT_CONTAINER})")
    p.add_argument("--interval", type=float, default=1.0,
                   help="Intervallo di campionamento in secondi (default: 1.0)")
    p.add_argument("--duration", type=float, default=None,
                   help="Durata totale in secondi (default: infinito)")
    p.add_argument("--out", default="consumi.csv",
                   help="File CSV di output (default: consumi.csv)")
    p.add_argument("--cpu-threshold", type=float, default=DEFAULT_CPU_THRESHOLD,
                   help=f"Soglia CPU%% calcolo/idle (default: {DEFAULT_CPU_THRESHOLD})")
    p.add_argument("--mode", choices=["monitor", "stress"], default="monitor",
                   help="monitor: consumo reale; stress: carico sostenuto")
    p.add_argument("--quiet", action="store_true",
                   help="Non stampare ogni campione")
    return p.parse_args()


def get_sample(container):
    try:
        out = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}", container],
            capture_output=True, text=True, timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return {"error": str(e)}

    if out.returncode != 0:
        return {"error": out.stderr.strip() or "docker stats fallito"}

    line = out.stdout.strip()
    if not line:
        return None

    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        return {"error": f"output non JSON: {line[:80]}"}

    cpu_str = d.get("CPUPerc", "0%").replace("%", "").strip()
    try:
        cpu = float(cpu_str)
    except ValueError:
        cpu = 0.0

    mem_mb = 0.0
    mem_usage = d.get("MemUsage", "")
    if "/" in mem_usage:
        mem_mb = parse_mem_to_mb(mem_usage.split("/")[0].strip())

    mem_pct_str = d.get("MemPerc", "0%").replace("%", "").strip()
    try:
        mem_pct = float(mem_pct_str)
    except ValueError:
        mem_pct = 0.0

    return {"cpu_pct": cpu, "mem_mb": mem_mb, "mem_pct": mem_pct}


def parse_mem_to_mb(s):
    s = s.strip()
    units = {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "B": 1 / (1024 * 1024),
             "kB": 1 / 1000, "MB": 1, "GB": 1000}
    for u, factor in units.items():
        if s.endswith(u):
            try:
                return float(s[:-len(u)]) * factor
            except ValueError:
                return 0.0
    return 0.0


def main():
    args = parse_args()

    print("=" * 64)
    print("Monitor consumi — container Digital Twin (AGROS edge)")
    print("=" * 64)
    print(f"Container:   {args.container}")
    print(f"Intervallo:  {args.interval}s")
    print(f"Modalita':   {args.mode}")
    print(f"Output:      {args.out}")
    print(f"Durata:      {args.duration}s" if args.duration else "Durata:      infinita (Ctrl+C per fermare)")
    print("")
    print("NB: docker stats campiona ~1/s; il calcolo del DT dura pochi ms.")
    print("    L'idle e' misurato bene; per il picco vedi anche latency.log.")
    print("")

    samples = []
    csv_file = open(args.out, "w", newline="")
    writer = csv.writer(csv_file)
    writer.writerow(["timestamp", "elapsed_s", "cpu_pct", "mem_mb", "mem_pct", "stato"])

    start = time.time()
    running = {"v": True}

    def stop(signum, frame):
        running["v"] = False
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    first_error = True
    while running["v"]:
        loop_t = time.time()
        elapsed = loop_t - start
        if args.duration and elapsed >= args.duration:
            break

        s = get_sample(args.container)
        if s is None:
            if first_error:
                print(f"[attesa] container '{args.container}' non ancora pronto...")
                first_error = False
            time.sleep(args.interval)
            continue
        if "error" in s:
            print(f"[errore] {s['error']}")
            time.sleep(args.interval)
            continue

        if args.mode == "stress":
            stato = "CARICO"
        else:
            stato = "CALCOLO" if s["cpu_pct"] >= args.cpu_threshold else "idle"

        ts = datetime.now(timezone.utc).isoformat()
        writer.writerow([ts, f"{elapsed:.1f}", f"{s['cpu_pct']:.2f}",
                         f"{s['mem_mb']:.1f}", f"{s['mem_pct']:.2f}", stato])
        csv_file.flush()
        samples.append({"cpu_pct": s["cpu_pct"], "mem_mb": s["mem_mb"], "stato": stato})

        if not args.quiet:
            marker = " <-- calcolo" if s["cpu_pct"] >= args.cpu_threshold else ""
            print(f"  [{elapsed:7.1f}s] CPU {s['cpu_pct']:6.2f}%  RAM {s['mem_mb']:7.1f} MB  ({stato}){marker}")

        sleep_left = args.interval - (time.time() - loop_t)
        if sleep_left > 0:
            time.sleep(sleep_left)

    csv_file.close()
    print_summary(samples, args)


def print_summary(samples, args):
    if not samples:
        print("\nNessun campione raccolto.")
        return

    def avg(lst, key):
        return sum(x[key] for x in lst) / len(lst) if lst else 0.0

    def mx(lst, key):
        return max((x[key] for x in lst), default=0.0)

    idle = [s for s in samples if s["stato"] == "idle"]
    calcolo = [s for s in samples if s["stato"] in ("CALCOLO", "CARICO")]

    print("\n" + "=" * 64)
    print("RIEPILOGO CONSUMI")
    print("=" * 64)
    print(f"Campioni totali:   {len(samples)}")
    print(f"  idle:            {len(idle)}")
    print(f"  calcolo/carico:  {len(calcolo)}")
    print("")

    if idle:
        print("IDLE (container in attesa tra i burst):")
        print(f"  CPU media:       {avg(idle, 'cpu_pct'):.2f}%")
        print(f"  CPU max:         {mx(idle, 'cpu_pct'):.2f}%")
        print(f"  RAM media:       {avg(idle, 'mem_mb'):.1f} MB")
        print(f"  RAM max:         {mx(idle, 'mem_mb'):.1f} MB")
        print("")

    if calcolo:
        print("CALCOLO / CARICO (CPU sopra soglia):")
        print(f"  campioni:        {len(calcolo)}")
        print(f"  CPU media:       {avg(calcolo, 'cpu_pct'):.2f}%")
        print(f"  CPU max:         {mx(calcolo, 'cpu_pct'):.2f}%")
        print(f"  RAM media:       {avg(calcolo, 'mem_mb'):.1f} MB")
        print(f"  RAM max:         {mx(calcolo, 'mem_mb'):.1f} MB")
        print("")
    else:
        print("Nessun campione di calcolo catturato (atteso in modalita' monitor:")
        print("il calcolo dura pochi ms e sfugge al campionamento al secondo).")
        print("Per il costo del calcolo usa latency.log (campo dt_core_ms).")
        print("")

    print(f"Dati grezzi: {args.out}")
    print("Per il paper: usa il CSV per il grafico CPU/RAM nel tempo.")


if __name__ == "__main__":
    main()