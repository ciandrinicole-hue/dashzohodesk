#!/usr/bin/env python3
# Aggiorna data.json per il dipartimento Nuumipet Support (Zoho Desk):
#  - ticket CHIUSI per giorno e per agente (Mavreen, Nicole) e non assegnati
#  - backlog APERTO ORA (stato Open + On Hold) per agente e non assegnati
#
# FUSO ORARIO PER OPERATORE (il "giorno" di un ticket = giorno di chiusura nel
# fuso di chi lo lavora):
#   - Mavreen  -> Asia/Manila (Filippine, UTC+8)
#   - Nicole / non assegnati / altri -> Europe/Rome (Italia)
#
# Ad ogni esecuzione ricalcola in modo "self-healing" gli ultimi LOOKBACK_DAYS
# giorni (default 4): i conteggi recenti si correggono da soli se un ticket
# viene riaperto/chiuso di nuovo. Per riempire un buco storico (backfill) basta
# lanciare il workflow a mano passando lookback_days piu' grande.
#
# Eseguito da GitHub Actions. Secret richiesti: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN.
import json, os, re, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ORG_ID   = "20116101567"
DEPT_ID  = "266671000000007061"
MAVREEN  = "266671000000533350"
NICOLE   = "266671000000092001"
TZ_LOCAL   = ZoneInfo("Europe/Rome")      # Nicole, non assegnati, "giorno operativo"
TZ_MAVREEN = ZoneInfo("Asia/Manila")      # Mavreen (Filippine, UTC+8)
UTC        = ZoneInfo("UTC")
ACCOUNTS   = "https://accounts.zoho.eu"
DESK       = "https://desk.zoho.eu/api/v1"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "4"))

# --- Nuovo vs Follow-up ---
# Follow-up = risposta (Re:/Fwd:) a una conversazione di ASSISTENZA gia' aperta.
# Le risposte alle mail automatiche (promemoria rinnovo, spedizione, newsletter,
# conferme, notifiche rimborso) NON sono follow-up: sono richieste nuove.
REPLY_RE = re.compile(r'^\s*(re|fwd|fw|aw|r)\s*[:\-]', re.I)
MKT_RE   = re.compile(r'reminder|shipment is coming|early signs|we received your request|'
                      r'refund notification|your next calmicollar', re.I)

def is_followup(subject):
    s = subject or ''
    if not REPLY_RE.match(s):
        return False          # non e' una risposta -> nuovo
    if MKT_RE.search(s):
        return False          # risposta a mail automatica/marketing -> nuovo
    return True               # risposta a conversazione di assistenza -> follow-up


def get_token():
    data = urllib.parse.urlencode({
        "refresh_token": os.environ["ZOHO_REFRESH_TOKEN"],
        "client_id":     os.environ["ZOHO_CLIENT_ID"],
        "client_secret": os.environ["ZOHO_CLIENT_SECRET"],
        "grant_type":    "refresh_token",
    }).encode()
    req = urllib.request.Request(ACCOUNTS + "/oauth/v2/token", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    if "access_token" not in j:
        raise SystemExit("Errore OAuth Zoho: " + json.dumps(j))
    return j["access_token"]


def zoho_get(path, params, token):
    url = DESK + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Zoho-oauthtoken " + token, "orgId": ORG_ID})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return {"data": []}
        raise
    return json.loads(raw) if raw.strip() else {"data": []}


def iso(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def paged_search(params, token):
    """Ritorna un dict id->ticket, paginando la search API."""
    out = {}
    frm = 0
    for _ in range(20):
        p = dict(params); p["limit"] = "100"; p["from"] = str(frm)
        j = zoho_get("/tickets/search", p, token)
        batch = j.get("data", []) if isinstance(j, dict) else []
        if not batch:
            break
        for t in batch:
            out[t.get("id")] = t
        if len(batch) < 100:
            break
        frm += 100
    return out


def fetch_closed(token, start_utc, end_utc):
    """Tutti i ticket Closed con modifiedTime in [start,end], a blocchi di 2 giorni
    (finestre piccole = niente limiti di paginazione, anche su backfill lunghi)."""
    out = {}
    step = timedelta(days=2)
    a = start_utc
    while a < end_utc:
        b = min(a + step, end_utc)
        rng = iso(a) + "," + iso(b)
        out.update(paged_search({"departmentId": DEPT_ID, "status": "Closed",
                                 "modifiedTimeRange": rng, "sortBy": "-modifiedTime"}, token))
        a = b
    return out


def agent_tz(assignee_id):
    return TZ_MAVREEN if assignee_id == MAVREEN else TZ_LOCAL


def bucket_tickets(tickets, target_dates):
    """tickets: iterable di dict ticket. Ritorna {date: [mc, nc, uc]} per le date in target_dates,
    assegnando ogni ticket al giorno di chiusura NEL FUSO del suo operatore."""
    tset = set(target_dates)
    # [mc, nc, uc, nw, fu]  (nw=nuovi, fu=follow-up ; nw+fu == mc+nc+uc)
    buckets = {d: [0, 0, 0, 0, 0] for d in target_dates}
    for t in tickets:
        ct = t.get("closedTime")
        if not ct:
            continue
        cutc = datetime.strptime(ct[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
        a = t.get("assigneeId")
        ld = cutc.astimezone(agent_tz(a)).date()
        if ld not in tset:
            continue
        if a == MAVREEN:
            buckets[ld][0] += 1
        elif a == NICOLE:
            buckets[ld][1] += 1
        else:
            buckets[ld][2] += 1
        if is_followup(t.get("subject")):
            buckets[ld][4] += 1
        else:
            buckets[ld][3] += 1
    return buckets


def compute_days(token, now_local):
    today = now_local.date()
    targets = [today - timedelta(days=i) for i in range(LOOKBACK_DAYS)]
    oldest = min(targets)
    # inizio finestra: mezzanotte locale del giorno precedente al piu' vecchio target
    # (copre con margine anche il giorno di Manila, che e' avanti rispetto a Roma)
    start_local = datetime(oldest.year, oldest.month, oldest.day, tzinfo=TZ_LOCAL) - timedelta(days=1)
    start_utc = start_local.astimezone(UTC)
    end_utc = datetime.now(UTC)
    tickets = fetch_closed(token, start_utc, end_utc)
    return bucket_tickets(tickets.values(), targets)


def open_backlog(token):
    tickets = {}
    for st in ("Open", "On Hold"):
        tickets.update(paged_search({"departmentId": DEPT_ID, "status": st}, token))
    m = n = u = 0
    for t in tickets.values():
        a = t.get("assigneeId")
        if a == MAVREEN:  m += 1
        elif a == NICOLE: n += 1
        else:             u += 1
    return {"m": m, "n": n, "u": u}


def main():
    token = get_token()
    now = datetime.now(TZ_LOCAL)

    buckets = compute_days(token, now)
    op = open_backlog(token)

    with open("data.json", "r", encoding="utf-8") as f:
        doc = json.load(f)
    days = doc.get("days", [])
    for d in days:
        d.pop("partial", None)
    by_label = {d.get("d"): d for d in days}

    for dt in sorted(buckets):
        mc, nc, uc, nw, fu = buckets[dt]
        label = dt.strftime("%d/%m")
        entry = {"d": label, "mc": mc, "nc": nc, "uc": uc, "tc": mc + nc + uc, "nw": nw, "fu": fu}
        if label in by_label:
            by_label[label].update(entry)          # aggiorna sul posto (ordine invariato)
        else:
            days.append(entry)                      # date nuove: sempre le piu' recenti
            by_label[label] = entry

    doc["days"]    = days
    doc["open"]    = op
    doc["updated"] = now.strftime("%d/%m/%Y %H:%M")
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")

    tot = sum(v[0] + v[1] + v[2] for v in buckets.values())
    tnw = sum(v[3] for v in buckets.values())
    tfu = sum(v[4] for v in buckets.values())
    print(f"OK lookback={LOOKBACK_DAYS} giorni={len(buckets)} chiusi={tot} nuovi={tnw} followup={tfu} "
          f"| aperti M={op['m']} N={op['n']} NonAss={op['u']}")


if __name__ == "__main__":
    main()
