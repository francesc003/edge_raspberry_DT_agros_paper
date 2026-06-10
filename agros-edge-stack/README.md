# AGROS Edge Stack — Digital Twin a container per Raspberry Pi 5

Stack a tre container che gira interamente in locale sul Raspberry, senza
servizi cloud. Simula la ricezione dati da 10 nodi LoRa, li archivia in un
MongoDB locale, e fa girare il Digital Twin che decide quando irrigare.

## Architettura

```
┌──────────────────┐     scrive      ┌──────────────┐     legge      ┌──────────────────┐
│  node-simulator  │ ──────────────► │   mongo      │ ◄───────────── │  digital-twin    │
│  (10 nodi LoRa)  │  sensor_readings│  (database)  │  sensor_readings│  (DT + advisor)  │
└──────────────────┘                 └──────────────┘                 └──────────────────┘
                                            ▲                                  │
                                            │      dt_snapshots, dt_history,   │
                                            └──────  irrigation_log  ──────────┘
                                                                               │
                                                                               ▼
                                                                    log irrigazione
                                                                    (stdout + file)
```

- **node-simulator**: simula 10 nodi che trasmettono a burst. Ogni burst avanza
  un orologio simulato (default 1 ora simulata per burst) e scrive le letture
  in MongoDB. Modello climatico stagionale, deterministico (seed).
- **mongo**: database locale (immagine ufficiale `mongo:7`).
- **digital-twin**: in polling sul DB; a ogni nuovo burst esegue la pipeline
  (indici ET0, GDD, SWD, stress termico), valuta il trigger di irrigazione e
  persiste i risultati. La decisione di irrigazione va su stdout e su file.

## Prerequisiti sul Raspberry

- Raspberry Pi OS (64-bit)
- Docker e Docker Compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  # poi disconnetti/riconnetti la sessione SSH per applicare il gruppo
  ```

## Avvio

Dalla cartella `agros-edge-stack`:

```bash
docker compose up --build
```

Vedrai i log intrecciati dei tre container. Il simulatore stampa i burst, il
digital-twin stampa le decisioni di irrigazione man mano che lo scenario evolve.

Per vedere **solo** le decisioni del Digital Twin:

```bash
docker compose logs -f digital-twin
```

Per fermare tutto:

```bash
docker compose down
```

Per fermare e azzerare anche il database:

```bash
docker compose down -v
```

## Cosa vedrai

All'inizio il suolo è umido e il DT decide `NON_IRRIGARE`. Col passare dei
burst il deficit idrico (SWD) cresce. Quando supera la soglia di allerta, il
DT decide:
- `IRRIGA` se l'ora simulata è nella fascia efficiente (notte/prima mattina)
- `RIMANDA` se è in fascia diurna inefficiente o se è prevista pioggia
- `IRRIGA_SUBITO` se il deficit raggiunge la soglia critica (l'urgenza prevale)

Il file `logs/irrigation.log` (sull'host) conserva lo storico delle decisioni.

## Logica del trigger di irrigazione

Euristica rule-based (Livello 2, nessuna simulazione predittiva):

| Condizione | Decisione |
|---|---|
| SWD sotto soglia di allerta | NON_IRRIGARE |
| SWD in fascia allerta + ora efficiente + niente pioggia | IRRIGA |
| SWD in fascia allerta + ora inefficiente o pioggia in arrivo | RIMANDA |
| SWD oltre soglia critica | IRRIGA_SUBITO |

Parametri (in `digital-twin/irrigation/advisor.js`):
- fascia oraria efficiente: 22:00–08:00
- soglia pioggia per rimandare: ≥ 5 mm nelle 24h

## Configurazione (variabili in docker-compose.yml)

**node-simulator:**
- `BURST_INTERVAL_SEC` (10): secondi reali tra burst
- `SIM_STEP_MIN` (60): minuti simulati per burst
- `SIM_START_DATE` (2026-05-20): inizio del tempo simulato
- `N_NODI` (10): numero di nodi
- `RESET_ON_START` (true): azzera le collezioni all'avvio

**digital-twin:**
- `POLL_INTERVAL_MS` (3000): frequenza di controllo nuovi burst

Per una demo più rapida o più lenta, agisci su `BURST_INTERVAL_SEC` (ritmo
reale) e `SIM_STEP_MIN` (quanto "tempo agronomico" passa per burst).

## Ispezionare il database (opzionale)

Scommenta le righe `ports` del servizio `mongo` nel docker-compose per
esporre la porta 27017, poi connettiti con un client Mongo dall'host.

## Test della logica senza Docker

Nella cartella `digital-twin` c'è un test end-to-end che usa un mock del
database e verifica l'intera pipeline (richiede solo Node 18+):

```bash
cd digital-twin
npm install
node test_e2e.mjs
```

Mostra l'evoluzione di SWD e le decisioni di irrigazione su una sequenza
simulata di burst.
```

## Modalità tempo reale e misura dei consumi

Di default lo stack ora gira in **tempo reale**: il simulatore invia un burst
(tutti e 10 i nodi insieme) ogni 10 minuti, con timestamp reale. Il Digital
Twin valuta a ogni burst ricevuto.

Configurazione (in docker-compose.yml, servizio node-simulator):
- `REAL_TIME: "true"` usa l'ora corrente per ogni burst
- `BURST_INTERVAL_SEC: "600"` un burst ogni 10 minuti

Per tornare alla demo accelerata (vedere il trigger evolvere in fretta):
imposta `REAL_TIME: "false"`, `BURST_INTERVAL_SEC: "10"`, `SIM_STEP_MIN: "60"`.

### Meteo da API e resilienza offline

Il DT recupera il meteo da Open-Meteo (API gratuita, nessuna chiave). Se la
connessione manca (es. 4G assente sul campo), il fetch fallisce in modo
controllato: il DT prosegue usando solo i dati dei sensori, senza meteo. Lo
stato (online/offline) è visibile nel log e salvato nello snapshot
(`metadata.weather_online`).

### Misurare i consumi del solo container Digital Twin

Con lo stack in esecuzione, da un altro terminale:

```bash
python3 monitor_consumi.py --interval 2 --out consumi_dt.csv
```

Campiona CPU e RAM del solo container `agros-digital-twin` e distingue le fasi
IDLE (attesa tra i burst) da quelle di CALCOLO (picco all'arrivo di un burst).
A fine sessione (Ctrl+C) stampa medie e massimi per ciascuna fase e salva un
CSV per i grafici. Non misura Watt (per quello serve un wattmetro): misura
l'impronta CPU/RAM, proxy software dei consumi, utile per confronti.

---

# Modalità tempo reale e misurazione dei consumi

Lo stack supporta due modalità, selezionabili dalle variabili del simulatore
nel `docker-compose.yml`.

## Modalità DEMO (accelerata)

Per *vedere* il comportamento del trigger in fretta:
```yaml
REAL_TIME: "false"
BURST_INTERVAL_SEC: "10"    # un burst ogni 10s reali
SIM_STEP_MIN: "60"          # ogni burst = 1 ora simulata
```
In pochi minuti il SWD evolve e si vedono le transizioni NON_IRRIGARE → IRRIGA → RIMANDA.

## Modalità TEMPO REALE (per misurare i consumi)

Per riprodurre il ritmo vero del campo:
```yaml
REAL_TIME: "true"           # ogni burst usa l'ora corrente (new Date())
BURST_INTERVAL_SEC: "600"   # un burst ogni 10 minuti reali
```
Ogni 10 minuti tutti i 10 nodi trasmettono insieme; il DT valuta una volta e
torna in attesa. Questa è la modalità giusta per misurare il consumo,
perché alterna lunghe fasi di IDLE a brevi picchi di CALCOLO.

Nota: in tempo reale i burst cadono tutti nello stesso giorno, quindi gli
indici stagionali (SWD, GDD) restano ~costanti tra un burst e l'altro (è il
comportamento corretto: il deficit idrico non cambia in 10 minuti). La
decisione di irrigazione resta perciò stabile. Per vedere il trigger
*cambiare*, usa la modalità demo; per misurare i *consumi*, usa il tempo reale.

# Meteo da API (Open-Meteo) e resilienza offline

Il DT recupera il meteo da Open-Meteo (gratuito, nessuna chiave) usando le
coordinate del campo dal profilo. Una cache (default 30 min) evita chiamate
a ogni burst.

Se la rete non è disponibile (es. 4G assente sul campo), la chiamata fallisce
in modo controllato: il DT prosegue usando **solo i dati contestuali dei
sensori**, senza meteo. Nello snapshot, `metadata.weather_online` indica se il
meteo era disponibile. Gli indici che non dipendono dal meteo (GDD, ET0,
stress termico) restano sempre calcolabili.

# Misurare i consumi del solo container Digital Twin

Lo script `monitor_consumi.py` campiona CPU e RAM del solo container
`agros-digital-twin` via `docker stats`, distinguendo automaticamente le fasi
di IDLE da quelle di CALCOLO.

Con lo stack in esecuzione (in tempo reale), in un secondo terminale:

```bash
# campiona ogni 2 secondi finché non premi Ctrl+C
python3 monitor_consumi.py

# oppure ogni secondo per un'ora, salvando su file
python3 monitor_consumi.py --interval 1 --duration 3600 --out consumi.csv
```

Alla fine (o con Ctrl+C) stampa un riepilogo con CPU e RAM medie in idle vs
calcolo, e salva un CSV con tutti i campioni per i grafici del paper.

Lo script misura l'impronta computazionale (CPU%, RAM), che è il proxy
software dei consumi. Per i Watt reali servirebbe un wattmetro hardware tra
alimentatore e Raspberry.
