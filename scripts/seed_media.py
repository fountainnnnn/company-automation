"""Generate placeholder site photos and upload them to the private site-media bucket,
then record report_media rows. Everything here is fake data for demo/testing —
remove it with scripts/purge-test-data.sql.
"""
import io, json, math, random, urllib.request, urllib.error

URL = "https://odsofzzjniafttbdhtye.supabase.co"
ANON = "sb_publishable_SSXeRx2cQrhSH9QX3JrLbg_pkVvu_rC"
EMAIL, PASSWORD = "admin@clautomation.local", "vos2h1O2dVAIpHcK"

from PIL import Image, ImageDraw, ImageFilter

random.seed(7)


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


def site_photo(seed: int, label: str) -> bytes:
    """A plausible construction-site frame: sky gradient, ground, structure, haze."""
    rnd = random.Random(seed)
    W, H = 1280, 960
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)

    # sky: warm-to-cool vertical gradient
    top = (rnd.randint(150, 190), rnd.randint(175, 205), rnd.randint(205, 230))
    bot = (rnd.randint(225, 245), rnd.randint(220, 238), rnd.randint(210, 228))
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))

    # ground
    gy = int(H * rnd.uniform(0.62, 0.72))
    ground = (rnd.randint(120, 150), rnd.randint(112, 138), rnd.randint(100, 122))
    d.rectangle([0, gy, W, H], fill=ground)
    for _ in range(260):  # aggregate/rubble texture
        x, y = rnd.randint(0, W), rnd.randint(gy, H)
        r = rnd.randint(2, 7)
        sh = rnd.randint(-22, 22)
        d.ellipse([x, y, x + r, y + r],
                  fill=tuple(max(0, min(255, ground[i] + sh)) for i in range(3)))

    # concrete structure blocks
    for i in range(rnd.randint(2, 4)):
        bw = rnd.randint(180, 380)
        bx = rnd.randint(-60, W - 120)
        bh = rnd.randint(200, 460)
        tone = rnd.randint(178, 214)
        d.rectangle([bx, gy - bh, bx + bw, gy], fill=(tone, tone - 4, tone - 12))
        # floor slabs
        for f in range(1, rnd.randint(2, 5)):
            fy = gy - int(bh * f / 5)
            d.rectangle([bx, fy - 8, bx + bw, fy], fill=(tone - 26, tone - 30, tone - 36))
        # window openings
        for r_ in range(rnd.randint(2, 4)):
            for c in range(rnd.randint(2, 5)):
                wx = bx + 24 + c * 62
                wy = gy - bh + 40 + r_ * 74
                if wx + 44 < bx + bw and wy + 52 < gy:
                    d.rectangle([wx, wy, wx + 44, wy + 52], fill=(88, 92, 98))

    # scaffold poles
    for _ in range(rnd.randint(3, 7)):
        x = rnd.randint(0, W)
        d.line([(x, gy), (x, gy - rnd.randint(140, 420))], fill=(196, 168, 96), width=5)
    for i in range(rnd.randint(2, 4)):
        y = gy - 90 - i * 95
        d.line([(0, y), (W, y)], fill=(196, 168, 96), width=4)

    # a crane
    if rnd.random() < 0.6:
        cx = rnd.randint(120, W - 120)
        d.line([(cx, gy), (cx, 90)], fill=(226, 148, 40), width=9)
        d.line([(cx - 260, 120), (cx + 180, 120)], fill=(226, 148, 40), width=7)
        d.line([(cx + 90, 120), (cx + 90, 300)], fill=(120, 120, 124), width=3)

    # safety barrier
    for x in range(0, W, 90):
        d.rectangle([x, gy + 40, x + 54, gy + 96], fill=(224, 108, 40))

    img = img.filter(ImageFilter.GaussianBlur(0.6))

    # timestamp burn-in, like a real site photo
    d = ImageDraw.Draw(img)
    d.rectangle([16, H - 54, 16 + 8 * len(label) + 22, H - 16], fill=(0, 0, 0))
    d.text((28, H - 44), label, fill=(240, 240, 240))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=78)
    return buf.getvalue()


def main():
    tok = api("/auth/v1/token?grant_type=password",
              {"email": EMAIL, "password": PASSWORD})["access_token"]

    reports = api("/rest/v1/reports?select=id,project_id,report_date,note&order=report_date.desc",
                  token=tok)
    print(f"{len(reports)} reports")

    made = 0
    rows = []
    for rep in reports:
        n = random.choices([1, 2, 3, 4, 5], weights=[34, 28, 20, 12, 6])[0]
        for i in range(n):
            label = f"{rep['report_date']}  SITE CAM"
            data = site_photo(rep["id"] * 17 + i, label)
            path = f"project_{rep['project_id']}/{rep['report_date']}/{rep['id']}/seed-{rep['id']}-{i}.jpg"
            api(f"/storage/v1/object/{'site-media'}/{path}", token=tok,
                raw=data, ctype="image/jpeg", method="POST")
            rows.append({
                "report_id": rep["id"], "storage_path": path, "media_type": "photo",
                "mime_type": "image/jpeg", "file_size": len(data),
                "width": 1280, "height": 960,
            })
            made += 1
        if len(rows) >= 25:
            api("/rest/v1/report_media", rows, token=tok)
            rows = []
            print(f"  uploaded {made}")
    if rows:
        api("/rest/v1/report_media", rows, token=tok)
    print(f"done: {made} images")


if __name__ == "__main__":
    main()
