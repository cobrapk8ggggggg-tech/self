import os
import re
import json
import time
import uuid
import base64
from pathlib import Path
from typing import Any, Dict, Optional, Generator

import requests


def parse_cookies_str(cookies_str: str) -> dict:
    cookies = {}
    for part in cookies_str.split(';'):
        if '=' in part:
            k, v = part.strip().split('=', 1)
            cookies[k] = v
    return cookies


class QwenAPI:
    BASE = "https://chat.qwen.ai"

    DEVICE_ID = os.getenv("QWEN_DEVICE_ID", "ai41028e1f8c77e8b2786e747bbb688d45")
    MINI_WUA_NEW = os.getenv("QWEN_MINI_WUA_NEW", "aFgR23MLtqLGGJyrcbapgd+3XceWqBxoJgwW5OfWJyoy3xEC7dShaw+ngiFDudGDdY6tt1kIeyR2PVktTjGdU3Bq8hFdQ4COyBLsSGPWyu6LrCN93vNCG600RwsH2PZgTpNQVxwdd5WDtQJl/bbuWLjXYRlDIHL+VeV7aQR6TkveYD25QvPjRymkV")
    MINI_WUA_CHAT = os.getenv("QWEN_MINI_WUA_CHAT", "amQS4zB7f+nI4zFIidbQfWJS4DFq6eY/JGTsMp6g0eEgI1hW/WjAixbY00rXCEfaU1m0k8YFrAS7FdfKBfhdNv3tVDb9W9lKxCkU9N7WoxP6NBjjq7KDfBtkYRQwFDVeAnTLV3as78GbA/GIYRwe/sGfa+Ec4kEd6w8P5tnHKvatdiI6yyDOBdQyG")
    APP_WAF = os.getenv("QWEN_APP_WAF", "Z9Tr56YmQpXcO2K_d_3nAbJvRqMLFW8HTNjvRguWHEowM1xY")
    AUTH_TOKEN = os.getenv("QWEN_AUTH_TOKEN", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjJjMzNlM2I3LTRjZGMtNDIzNi05ZDQ4LTYxMGNkOGY0YjU1ZiIsImxhc3RfcGFzc3dvcmRfY2hhbmdlIjoxNzg0MzA3OTgyLCJleHAiOjE3ODg0NjAxMTd9.0Qks1iSkJlNXuJZwOXIqbBPVb2_nCFbZe3qBBI6kDak")
    USER_ID = os.getenv("QWEN_USER_ID", "ae55d1b2-652b-4128-a2ab-d8af014d06dd")
    COOKIES_STR = os.getenv("QWEN_COOKIES_STR", "")

    UA_NEW = "Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2),Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite"
    UA_CHAT = "Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite,Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2)"

    def __init__(self):
        self.s = requests.Session()
        self.thinking_enabled = True
        self.auto_search = True
        self.last_response_id = None
        self.cookies = parse_cookies_str(self.COOKIES_STR) if self.COOKIES_STR else {}
        self.cookies.setdefault("x-ap", "eu-central-1")
        self.cookies.setdefault("acw_tc", "0a03e58c17857397926041890e494252933302e11e7e13facd87298e0a89a3")
        if self.AUTH_TOKEN:
            self.cookies["token"] = self.AUTH_TOKEN
        for k, v in self.cookies.items():
            self.s.cookies.set(k, v, domain="chat.qwen.ai", path="/")

    def _headers(self, kind="chat", auth=False, stream=False) -> Dict[str, str]:
        h = {
            "X-Platform": "android",
            "Accept": "*/*,text/event-stream" if stream else "application/json",
            "User-Agent": self.UA_CHAT if kind == "chat" else self.UA_NEW,
            "x-device-id": self.DEVICE_ID,
            "source": "app",
            "x-mini-wua": self.MINI_WUA_CHAT if kind == "chat" else self.MINI_WUA_NEW,
            "x-request-id": str(uuid.uuid4()),
            "Accept-Language": "en-US",
            "Accept-Charset": "UTF-8",
            "Content-Type": "application/json; charset=UTF-8" if kind == "chat" else "application/json",
            "Host": "chat.qwen.ai",
            "Connection": "Keep-Alive",
            "Accept-Encoding": "gzip, deflate",
        }
        if kind == "chat":
            h["Cache-Control"] = "no-store"
            h["app_waf"] = self.APP_WAF
        if auth and self.AUTH_TOKEN:
            h["Authorization"] = "Bearer " + self.AUTH_TOKEN
        return h

    def _post_json(self, url: str, payload: Dict[str, Any], headers: Dict[str, str], stream=False):
        r = self.s.post(url, headers=headers, data=json.dumps(payload), cookies=self.cookies, stream=stream, timeout=120)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:1000]}")
        return r

    def h5_headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Accept-Language": "ar-BH,ar;q=0.9",
            "Version": "0.2.81",
            "source": "h5",
            "X-Request-Id": str(uuid.uuid4()),
            "Timezone": time.strftime("%a %b %d %Y %H:%M:%S GMT+0300"),
        }

    def new_chat(self, mode="normal") -> str:
        url = self.BASE + "/api/v2/chats/new"
        payload = {"chat_mode": "normal", "project_id": ""}
        headers = self._headers("new", auth=True)
        headers["Accept"] = "application/json"
        headers["Accept-Encoding"] = "gzip"
        headers["X-Platform"] = "android"
        r = self._post_json(url, payload, headers)
        data = r.json()
        cid = data.get("chat_id") or data.get("id") or data.get("data", {}).get("chat_id") or data.get("data", {}).get("id")
        if not cid:
            raise RuntimeError("لم أجد chat_id في الرد: " + json.dumps(data, ensure_ascii=False)[:1000])
        return cid

    def get_chat(self, chat_id: str, limit: int = 6) -> Dict[str, Any]:
        url = f"{self.BASE}/api/v2/chats/{chat_id}?direction=up&limit={limit}"
        r = self.s.get(url, headers=self._headers("new"), timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:1000]}")
        return r.json()

    def get_current_id(self, chat_id: str) -> Optional[str]:
        try:
            data = self.get_chat(chat_id)
            d = data.get("data", {})
            cur = d.get("currentId") or d.get("chat", {}).get("history", {}).get("currentId")
            if cur:
                return cur
            msgs = d.get("chat", {}).get("messages", []) or []
            for m in reversed(msgs):
                if isinstance(m, dict) and m.get("role") == "assistant" and m.get("id"):
                    return m.get("id")
            for m in reversed(msgs):
                if isinstance(m, dict) and m.get("id"):
                    return m.get("id")
        except Exception:
            return None
        return None

    def text_payload(self, chat_id: str, prompt: str, stream=True, model="qwen3.8-max", parent_id: Optional[str] = None) -> Dict[str, Any]:
        ts = int(time.time())
        fid = str(uuid.uuid4())
        msg = {
            "id": None,
            "fid": fid,
            "chat_type": "t2t",
            "content": prompt,
            "role": "user",
            "feature_config": {
                "thinking_enabled": self.thinking_enabled,
                "output_schema": "phase",
                "research_mode": "normal",
                "auto_thinking": self.thinking_enabled,
                "thinking_mode": "Deep" if self.thinking_enabled else "Fast",
                "thinking_format": "summary",
                "auto_search": self.auto_search,
            },
            "timestamp": ts,
            "sub_chat_type": "t2t",
            "models": [model],
            "model": "",
            "files": [],
            "user_action": "chat",
            "extra": {"meta": {"subChatType": "t2t"}},
        }

        payload = {
            "stream": stream,
            "version": "2.1",
            "incremental_output": True,
            "chatId": chat_id,
            "chat_id": chat_id,
            "chat_mode": "normal",
            "model": model,
            "messages": [msg],
            "timestamp": ts,
        }

        # بعد أول رد: parent هو response_id/currentId السابق
        if parent_id:
            msg["parentId"] = parent_id
            msg["parent_id"] = parent_id
            payload["parentId"] = parent_id
            payload["parent_id"] = parent_id
        else:
            payload["parentId"] = ""
            payload["parent_id"] = None
            msg["parentId"] = None
            msg["parent_id"] = None

        return payload

    def chat(self, chat_id: str, prompt: str, stream=True, model="qwen3.8-max", parent_id: Optional[str] = None):
        url = f"{self.BASE}/api/v2/chat/completions"
        payload = self.text_payload(chat_id, prompt, stream=stream, model=model, parent_id=parent_id)
        headers = self._headers("chat", auth=True, stream=stream)
        # مطابق للطلب: chat_id أيضاً في query params
        r = self.s.post(url, params={"chat_id": chat_id}, data=json.dumps(payload), headers=headers, cookies=self.cookies, stream=stream, timeout=120)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:1000]}")
        if stream:
            return self.parse_sse(r)
        return r.json()

    def parse_sse(self, r) -> Generator[str, None, None]:
        self.last_response_id = None
        self.last_created_parent_id = None
        for raw in r.iter_lines(decode_unicode=True):
            if not raw:
                continue
            line = raw.strip()
            if line.startswith("data:"):
                line = line[5:].strip()
            if line in ("[DONE]", "done"):
                break
            try:
                obj = json.loads(line)
            except Exception:
                continue

            created = obj.get("response.created") if isinstance(obj, dict) else None
            if isinstance(created, dict) and created.get("response_id"):
                self.last_response_id = created.get("response_id")
                self.last_created_parent_id = created.get("parent_id")

            if isinstance(obj, dict) and obj.get("response_id"):
                self.last_response_id = obj.get("response_id")

            txt = self.extract_text(obj)
            if txt:
                yield txt

    def extract_text(self, obj: Any) -> str:
        if obj is None:
            return ""
        if isinstance(obj, str):
            return obj
        if isinstance(obj, list):
            return "".join(self.extract_text(x) for x in obj)
        if not isinstance(obj, dict):
            return ""

        # لا نطبع نص التفكير غالباً، فقط content/answer/output عند توفرها
        for path in [
            ("choices", 0, "delta", "content"),
            ("choices", 0, "message", "content"),
            ("data", "choices", 0, "delta", "content"),
            ("data", "choices", 0, "message", "content"),
            ("message", "content"),
            ("delta", "content"),
            ("data", "content"),
            ("content",),
            ("answer",),
            ("output", "text"),
            ("text",),
        ]:
            cur = obj
            ok = True
            for k in path:
                if isinstance(k, int) and isinstance(cur, list) and len(cur) > k:
                    cur = cur[k]
                elif isinstance(k, str) and isinstance(cur, dict) and k in cur:
                    cur = cur[k]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str) and cur:
                return cur

        # Qwen أحياناً يرسل phases/events
        for key in ("messages", "contents", "items", "events", "phases", "data"):
            if key in obj:
                txt = self.extract_text(obj[key])
                if txt:
                    return txt
        return ""

    def video_payload(self, chat_id: str, prompt: str, size="16:9", model="qwen3.7-plus", parent_id: Optional[str] = None) -> Dict[str, Any]:
        ts = int(time.time())
        parent_id = parent_id or str(uuid.uuid4())
        return {
            "stream": False,
            "incremental_output": True,
            "chat_id": chat_id,
            "chat_mode": "normal",
            "model": model,
            "parent_id": parent_id,
            "messages": [{
                "chat_type": "t2v",
                "content": prompt,
                "role": "user",
                "feature_config": {
                    "output_schema": "phase",
                    "thinking_enabled": self.thinking_enabled,
                    "thinking_format": "summary",
                    "auto_thinking": self.thinking_enabled,
                    "auto_search": self.auto_search,
                },
                "parentId": parent_id,
                "parent_id": parent_id,
                "timestamp": ts,
                "sub_chat_type": "t2v",
                "models": [model],
                "user_action": "chat",
                "extra": {"meta": {"subChatType": "t2v"}},
            }],
            "timestamp": ts,
            "size": size,
            "share_id": "",
            "version": "2.1",
            "origin_branch_message_id": "",
        }

    def generate_video(self, chat_id: str, prompt: str, size="16:9", parent_id: Optional[str] = None) -> Dict[str, Any]:
        url = f"{self.BASE}/api/v2/chat/completions?chat_id={chat_id}"
        payload = self.video_payload(chat_id, prompt, size=size, parent_id=parent_id)
        r = self._post_json(url, payload, self._headers("chat", auth=True))
        data = r.json()
        data["_parent_id"] = payload["parent_id"]
        return data

    def task_status(self, task_id: str) -> Dict[str, Any]:
        url = f"{self.BASE}/api/v1/tasks/status/{task_id}"
        r = self.s.get(url, headers=self._headers("new", auth=True), timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:1000]}")
        return r.json()

    def find_task_id(self, obj: Any) -> Optional[str]:
        if isinstance(obj, dict):
            for k in ("task_id", "taskId", "taskIdStr", "id", "resource_id"):
                v = obj.get(k)
                if isinstance(v, str) and re.fullmatch(r"[0-9a-fA-F-]{20,}", v):
                    return v
            for v in obj.values():
                found = self.find_task_id(v)
                if found:
                    return found
        elif isinstance(obj, list):
            for x in obj:
                found = self.find_task_id(x)
                if found:
                    return found
        return None

    def find_video_url(self, obj: Any) -> Optional[str]:
        if isinstance(obj, str):
            m = re.search(r"https://cdn\.qwenlm\.ai/[^\s\"']+\.mp4(?:\?key=[^\s\"']+)?", obj)
            return m.group(0) if m else None
        if isinstance(obj, dict):
            for k in ("video_url", "url", "download_url", "resource_url"):
                v = obj.get(k)
                if isinstance(v, str) and ".mp4" in v:
                    return v
            for v in obj.values():
                found = self.find_video_url(v)
                if found:
                    return found
        elif isinstance(obj, list):
            for x in obj:
                found = self.find_video_url(x)
                if found:
                    return found
        return None

    def download(self, url: str, out: str):
        with self.s.get(url, stream=True, timeout=300) as r:
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
            with open(out, "wb") as f:
                for chunk in r.iter_content(1024 * 256):
                    if chunk:
                        f.write(chunk)
        return out


def main():
    q = QwenAPI()
    chats: Dict[str, Dict[str, Any]] = {}
    current = None
    name = "الرئيسية"
    stream = True
    model = "qwen3.8-max"

    print("=" * 60)
    print("Qwen API Client")
    print("=" * 60)
    print("/new [اسم] | /list | /switch id | /stream | /think | /search | /model name | /raw سؤال | /video وصف | /status task_id | /exit")

    try:
        current = q.new_chat("normal")
        chats[current] = {"name": name, "current_id": None, "message_count": 0}
        print(f"✅ chat_id: {current}")
    except Exception as e:
        print(f"❌ فشل إنشاء محادثة: {e}")
        return

    while True:
        try:
            text = input(f"\n[{chats[current]['name']}] أنت: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nخروج")
            break
        if not text:
            continue
        if text == "/exit":
            break

        if text.startswith("/"):
            cmd, _, arg = text.partition(" ")
            arg = arg.strip()
            if cmd == "/new":
                try:
                    cid = q.new_chat("normal")
                    chats[cid] = {"name": arg or f"محادثة {len(chats)+1}", "current_id": None, "message_count": 0}
                    current = cid
                    print(f"✅ {cid}")
                except Exception as e:
                    print(f"❌ {e}")
                continue
            if cmd == "/list":
                for cid, info in chats.items():
                    print(f"{cid[:12]}... | {info['name']}" + (" 🔵" if cid == current else ""))
                continue
            if cmd == "/switch":
                found = [cid for cid in chats if arg and (cid.startswith(arg) or arg in cid)]
                if found:
                    current = found[0]
                    print("✅ تم التبديل")
                else:
                    print("❌ غير موجود")
                continue
            if cmd == "/stream":
                stream = not stream
                print("✅ stream =", stream)
                continue
            if cmd == "/think":
                q.thinking_enabled = not q.thinking_enabled
                print("✅ التفكير =", "مفعل" if q.thinking_enabled else "متوقف")
                continue
            if cmd == "/search":
                q.auto_search = not q.auto_search
                print("✅ البحث التلقائي =", "مفعل" if q.auto_search else "متوقف")
                continue
            if cmd == "/model":
                if arg:
                    model = arg
                print("model =", model)
                continue
            if cmd == "/history":
                try:
                    data = q.get_chat(current)
                    msgs = data.get("data", {}).get("chat", {}).get("messages", [])
                    if not msgs:
                        hist = data.get("data", {}).get("chat", {}).get("history", {}).get("messages", {})
                        msgs = list(hist.values()) if isinstance(hist, dict) else []
                    print(f"عدد الرسائل في السيرفر: {len(msgs)}")
                    for m in msgs[-8:]:
                        role = m.get("role")
                        content = m.get("content") or ""
                        if not content and m.get("content_list"):
                            content = "".join(x.get("content", "") for x in m.get("content_list", []) if x.get("phase") == "answer")
                        print(f"- {role}: {content[:120]}")
                except Exception as e:
                    print(f"❌ history error: {e}")
                continue
            if cmd == "/raw":
                if not arg:
                    print("اكتب السؤال بعد /raw")
                    continue
                try:
                    resp = q.chat(current, arg, stream=False, model=model, parent_id=(chats[current].get("current_id") if chats[current].get("message_count",0)>0 else None))
                    print(json.dumps(resp, ensure_ascii=False, indent=2))
                except Exception as e:
                    print(f"❌ {e}")
                continue
            if cmd == "/status":
                if not arg:
                    print("اكتب task_id")
                    continue
                try:
                    resp = q.task_status(arg)
                    print(json.dumps(resp, ensure_ascii=False, indent=2))
                    url = q.find_video_url(resp)
                    if url:
                        out = f"qwen_video_{arg}.mp4"
                        q.download(url, out)
                        print(f"✅ تم تنزيل الفيديو: {out}")
                except Exception as e:
                    print(f"❌ {e}")
                continue
            if cmd == "/video":
                if not arg:
                    print("اكتب الوصف بعد /video")
                    continue
                try:
                    video_chat = q.new_chat("normal")
                    resp = q.generate_video(video_chat, arg)
                    print(json.dumps(resp, ensure_ascii=False, indent=2))
                    task = q.find_task_id(resp)
                    if task:
                        print(f"✅ task_id: {task}")
                        print(f"تابع الحالة بالأمر: /status {task}")
                    else:
                        print("⚠️ لم أجد task_id، استخدم /raw أو انسخ الرد لفحصه")
                except Exception as e:
                    print(f"❌ {e}")
                continue
            print("أمر غير معروف")
            continue

        try:
            if stream:
                print("🤖 Qwen: ", end="", flush=True)
                full = ""
                for chunk in q.chat(current, text, stream=True, model=model, parent_id=(chats[current].get("current_id") if chats[current].get("message_count",0)>0 else None)):
                    full += chunk
                    print(chunk, end="", flush=True)
                print()
                if full:
                    chats[current]["message_count"] = chats[current].get("message_count", 0) + 1
                    chats[current]["message_count"] = chats[current].get("message_count", 0) + 1
                chats[current]["current_id"] = q.last_response_id or q.get_current_id(current) or chats[current].get("current_id")
                if not full:
                    print("⚠️ الرد فارغ. جرّب: /raw " + text)
            else:
                resp = q.chat(current, text, stream=False, model=model, parent_id=(chats[current].get("current_id") if chats[current].get("message_count",0)>0 else None))
                out = q.extract_text(resp) or json.dumps(resp, ensure_ascii=False, indent=2)
                print("🤖 Qwen:", out)
                chats[current]["current_id"] = q.last_response_id or q.get_current_id(current) or chats[current].get("current_id")
        except Exception as e:
            print(f"❌ {e}")


if __name__ == "__main__":
    main()
