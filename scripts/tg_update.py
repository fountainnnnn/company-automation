"""Drive the deployed telegram-webhook edge function with realistic Telegram updates.

Usage:
  python tg_update.py text <chat_id> "message"
  python tg_update.py cmd <chat_id> "/checkin"
  python tg_update.py loc <chat_id> <lat> <lng>
  python tg_update.py cb  <chat_id> <callback_data> [message_id]

Hits the REAL deployed function with the REAL webhook secret -> real DB writes.
"""
import json, sys, time, urllib.request

FN_URL = "https://odsofzzjniafttbdhtye.supabase.co/functions/v1/telegram-webhook"
SECRET = "PY4ohLP6xGPVd1fHVL68twANnRJqsIaN"

_uid = int(time.time())

def user(chat_id):
    return {"id": chat_id, "is_bot": False, "first_name": "TestWorker",
            "username": f"testworker{chat_id}", "language_code": "en"}

def base_msg(chat_id):
    global _uid
    _uid += 1
    return {"message_id": _uid,
            "from": user(chat_id),
            "chat": {"id": chat_id, "type": "private", "first_name": "TestWorker"},
            "date": int(time.time())}

def send(update):
    global _uid
    _uid += 1
    update["update_id"] = _uid
    req = urllib.request.Request(
        FN_URL, data=json.dumps(update).encode(),
        headers={"Content-Type": "application/json",
                 "X-Telegram-Bot-Api-Secret-Token": SECRET,
                 "X-Debug": "1"})
    try:
        with urllib.request.urlopen(req) as r:
            print(r.status, r.read().decode()[:800])
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode()[:800])

def main():
    kind, chat_id = sys.argv[1], int(sys.argv[2])
    if kind in ("text", "cmd"):
        m = base_msg(chat_id)
        m["text"] = sys.argv[3]
        if kind == "cmd" and not m["text"].startswith("/"):
            m["text"] = "/" + m["text"]  # dodge Git Bash MSYS path mangling
        if kind == "cmd" or m["text"].startswith("/"):
            m["entities"] = [{"offset": 0, "length": len(m["text"].split()[0]), "type": "bot_command"}]
        send({"message": m})
    elif kind == "loc":
        m = base_msg(chat_id)
        m["location"] = {"latitude": float(sys.argv[3]), "longitude": float(sys.argv[4])}
        send({"message": m})
    elif kind == "cb":
        msg = base_msg(chat_id)
        send({"callback_query": {
            "id": str(_uid), "from": user(chat_id), "message": msg,
            "chat_instance": "test", "data": sys.argv[3]}})
    else:
        sys.exit("unknown kind")

if __name__ == "__main__":
    main()
