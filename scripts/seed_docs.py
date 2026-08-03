"""Add placeholder site documents (real PDFs) to a slice of the seeded reports,
so the media mix reflects more than one file type. Demo data — purge with
scripts/purge-test-data.sql.
"""
import io, json, random, urllib.request, urllib.error
from PIL import Image, ImageDraw

URL = "https://odsofzzjniafttbdhtye.supabase.co"
ANON = "sb_publishable_SSXeRx2cQrhSH9QX3JrLbg_pkVvu_rC"
EMAIL, PASSWORD = "admin@clautomation.local", "vos2h1O2dVAIpHcK"

random.seed(11)

TITLES = [
    ("Delivery order", "DO"),
    ("Inspection checklist", "IR"),
    ("Method statement", "MS"),
    ("Permit to work", "PTW"),
    ("Concrete pour record", "CPR"),
    ("Toolbox meeting record", "TBM"),
]


def api(path, data=None, token=None, method=None, raw=None, ctype=None):
    headers = {"apikey": ANON}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if raw is not None:
        body, headers["Content-Type"] = raw, ctype
    elif data is not None:
        body, headers["Content-Type"] = json.dumps(data).encode(), "application/json"
    else:
        body = None
    req = urllib.request.Request(URL + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip().startswith(("{", "[")) else txt
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:300])
        raise


def make_pdf(title: str, ref: str, date: str, project: str) -> bytes:
    """A plain A4-ish form page, saved as a real PDF."""
    W, H = 1240, 1754
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 150], fill=(28, 25, 23))
    d.text((60, 60), f"{title.upper()}", fill=(255, 255, 255))
    d.text((60, 95), f"{ref} · {project} · {date}", fill=(210, 205, 198))

    y = 230
    for field in ("Contractor", "Location", "Prepared by", "Checked by",
                  "Weather", "Crew size", "Remarks"):
        d.text((70, y), field, fill=(90, 86, 82))
        d.line([(340, y + 22), (W - 70, y + 22)], fill=(200, 196, 190), width=2)
        y += 78

    d.rectangle([70, y + 40, W - 70, y + 420], outline=(200, 196, 190), width=2)
    d.text((90, y + 70), "Notes / sketch", fill=(150, 146, 142))
    for i in range(6):
        d.line([(90, y + 130 + i * 45), (W - 90, y + 130 + i * 45)], fill=(226, 223, 218))

    d.text((70, H - 140), "Signature", fill=(90, 86, 82))
    d.line([(240, H - 118), (640, H - 118)], fill=(200, 196, 190), width=2)
    d.text((W - 420, H - 140), "Date", fill=(90, 86, 82))
    d.line([(W - 330, H - 118), (W - 70, H - 118)], fill=(200, 196, 190), width=2)

    buf = io.BytesIO()
    img.save(buf, "PDF", resolution=150)
    return buf.getvalue()


def main():
    tok = api("/auth/v1/token?grant_type=password",
              {"email": EMAIL, "password": PASSWORD})["access_token"]
    reports = api(
        "/rest/v1/reports?select=id,project_id,report_date,created_at,projects(code)"
        "&order=report_date.desc", token=tok)

    picked = [r for r in reports if random.random() < 0.28]
    rows = []
    for rep in picked:
        title, prefix = random.choice(TITLES)
        ref = f"{prefix}-{rep['id']:04d}"
        code = (rep.get("projects") or {}).get("code", "SITE")
        data = make_pdf(title, ref, rep["report_date"], code)
        name = f"{ref} {title}.pdf"
        path = f"project_{rep['project_id']}/{rep['report_date']}/{rep['id']}/{ref}.pdf"
        api(f"/storage/v1/object/site-media/{path}", token=tok,
            raw=data, ctype="application/pdf", method="POST")
        rows.append({
            "report_id": rep["id"], "storage_path": path, "media_type": "document",
            "mime_type": "application/pdf", "file_size": len(data),
            "file_name": name, "created_at": rep["created_at"],
        })
    for i in range(0, len(rows), 25):
        api("/rest/v1/report_media", rows[i:i + 25], token=tok)
    print(f"done: {len(rows)} documents")


if __name__ == "__main__":
    main()
