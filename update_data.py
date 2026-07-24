#!/usr/bin/env python3
# Aggiorna data.json per il dipartimento Nuumipet Support (Zoho Desk):
#  - ticket CHIUSI OGGI per agente (Mavreen, Nicole) e non assegnati
#  - backlog APERTO ORA (stato Open + On Hold) per agente e non assegnati
# Eseguito da GitHub Actions. Secret richiesti: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN.
import json, os, urllib.request, urllib.parse, urllib.error
from datetime import datetime
from zoneinfo import ZoneInfo

ORG_ID  = "20116101567"
DEPT_ID = "266671000000007061"
MAVREEN = "266671000000533350"
NICOLE  = "266671000000092001"
TZ      = ZoneInfo("Europe/Brussels")
UTC     = ZoneInfo("UTC")
ACCOUNTS= "https://accounts.zoho.eu"
DESK    = "https://desk.zoho.eu/api/v1"

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
    for _ in range(80):
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

def closed_today(token, today):
    start = datetime(today.year, today.month, today.day, 0, 0, 0, tzinfo=TZ)
    rng = iso(start) + "," + iso(datetime.now(TZ))
    tickets = paged_search({"departmentId": DEPT_ID, "status": "Closed",
                            "modifiedTimeRange": rng, "sortBy": "-modifiedTime"}, token)
    mc = nc = uc = 0
    for t in tickets.values():
        ct = t.get("closedTime")
        if not ct:
            continue
        cdt = datetime.strptime(ct[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC).astimezone(TZ)
        if cdt.date() != today:
            continue
        a = t.get("assigneeId")
        if a == MAVREEN:  mc += 1
        elif a == NICOLE: nc += 1
        elif a is None:   uc += 1
        else:             uc += 1
    return mc, nc, uc

def open_backlog(token):
    tickets = {}
    for st in ("Open", "On Hold"):
        tickets.update(paged_search({"departmentId": DEPT_ID, "status": st}, token))
    m = n = u = 0
    for t in tickets.values():
        a = t.get("assigneeId")
        if a == MAVREEN:  m += 1
        elif a == NICOLE: n += 1
        elif a is None:   u += 1
    return {"m": m, "n": n, "u": u}

def main():
    token = get_token()
    now   = datetime.now(TZ)
    today = now.date()

    mc, nc, uc = closed_today(token, today)
    tc = mc + nc + uc
    op = open_backlog(token)

    dstr = today.strftime("%d/%m")
    with open("data.json", "r", encoding="utf-8") as f:
        doc = json.load(f)
    days = doc.get("days", [])
    for d in days:
        d.pop("partial", None)
    entry = {"d": dstr, "mc": mc, "nc": nc, "uc": uc, "tc": tc}
    for i, d in enumerate(days):
        if d.get("d") == dstr:
            days[i] = entry
            break
    else:
        days.append(entry)
    doc["days"]    = days
    doc["open"]    = op
    doc["updated"] = now.strftime("%d/%m/%Y %H:%M")
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"OK {dstr}: chiusi M={mc} N={nc} NonAss={uc} Tot={tc} | aperti M={op['m']} N={op['n']} NonAss={op['u']}")

if __name__ == "__main__":
    main()
