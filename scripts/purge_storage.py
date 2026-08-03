"""Delete every uploaded object in the site-media bucket.

Companion to purge-test-data.sql — that clears database rows, this clears the
actual files. Requires the admin dashboard login.

    python purge_storage.py --yes
"""
import json, sys, urllib.request, urllib.error

URL = "https://odsofzzjniafttbdhtye.supabase.co"
ANON = "sb_publishable_SSXeRx2cQrhSH9QX3JrLbg_pkVvu_rC"
EMAIL, PASSWORD = "admin@clautomation.local", "vos2h1O2dVAIpHcK"
BUCKET = "site-media"


def api(path, data=None, token=None, method=None):
    headers = {"apikey": ANON, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(URL + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip().startswith(("{", "[")) else txt
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:300])
        raise


def walk(token, prefix=""):
    """Storage list is per-folder; recurse to collect every object path."""
    out = []
    page = 0
    while True:
        items = api(f"/storage/v1/object/list/{BUCKET}", {
            "prefix": prefix, "limit": 100, "offset": page * 100,
            "sortBy": {"column": "name", "order": "asc"},
        }, token=token, method="POST")
        if not items:
            break
        for it in items:
            path = f"{prefix}{it['name']}"
            # folders come back with a null id
            if it.get("id") is None:
                out += walk(token, path + "/")
            else:
                out.append(path)
        if len(items) < 100:
            break
        page += 1
    return out


def main():
    if "--yes" not in sys.argv:
        sys.exit("Refusing to delete without --yes")
    tok = api("/auth/v1/token?grant_type=password",
              {"email": EMAIL, "password": PASSWORD})["access_token"]
    paths = walk(tok)
    print(f"{len(paths)} objects to delete")
    for i in range(0, len(paths), 100):
        api(f"/storage/v1/object/{BUCKET}", {"prefixes": paths[i:i + 100]},
            token=tok, method="DELETE")
        print(f"  deleted {min(i + 100, len(paths))}/{len(paths)}")
    print("bucket empty")


if __name__ == "__main__":
    main()
