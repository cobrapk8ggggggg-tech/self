"""
Disor Bot — v3.0 "Agentic"
═══════════════════════════════════════════════════════════════
المعمارية:
  • Agent Loop حقيقي — النموذج يقرر متى يستدعي أداة ومتى يرد
  • أدوات منفصلة لكل نوع بيانات (channels / roles / members / categories)
  • session واحد للمحادثة العادية + stateless للعمليات
  • لا رسائل تأكيد — ينفذ ثم يرد بالنتيجة مباشرة
  • البوت يرى معلومات المستخدم الكاملة (نكنيم، يوزر، ID)
  • البوت يعرف نفسه باسمه الحقيقي لا باليوزر
═══════════════════════════════════════════════════════════════
"""

import asyncio
import json
import os
import random
import re
import time
from datetime import datetime

import aiohttp
import discord
from motor.motor_asyncio import AsyncIOMotorClient

# ──────────────────────────────────────────────────────────────
#  ENV
# ──────────────────────────────────────────────────────────────
MONGODB_URI        = os.getenv("MONGODB_URI")
USER_TOKEN         = os.getenv("USER_TOKEN")
DEEPSEEK_TOKEN     = os.getenv("DEEPSEEK_TOKEN")
ALLOWED_CHANNEL_ID = int(os.getenv("ALLOWED_CHANNEL_ID", "1356830719170842710"))

# ──────────────────────────────────────────────────────────────
#  MongoDB
# ──────────────────────────────────────────────────────────────
mongo_client = AsyncIOMotorClient(MONGODB_URI)
db = mongo_client["disor_db"]

# ──────────────────────────────────────────────────────────────
#  Discord Intents
# ──────────────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.members         = True   # لازم لـ guild.members
intents.message_content = True   # لازم لقراءة الرسائل
intents.guilds          = True
client = discord.Client(intents=intents)

# ──────────────────────────────────────────────────────────────
#  User Sessions  { user_id: {"session_id": str|None, "parent_message_id": str|None} }
# ──────────────────────────────────────────────────────────────
user_sessions: dict[int, dict] = {}
session_lock = asyncio.Lock()

# ──────────────────────────────────────────────────────────────
#  DeepSeek API — Low-level helpers
# ──────────────────────────────────────────────────────────────
RAILWAY_URL = "https://web-production-c09dc.up.railway.app"
POW_URL     = f"{RAILWAY_URL}/pow"


def _device_id() -> str:
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    return "".join(random.choice(chars) for _ in range(88))


def _rangers_id() -> str:
    ts = int(time.time() * 1000)
    rv = random.randint(1_000_000_000, 9_999_999_999)
    return str((ts << 32) | rv)


def _tz_offset() -> str:
    return str(int(-datetime.now().astimezone().utcoffset().total_seconds()))


def _build_headers(pow_response: str, token: str) -> dict:
    return {
        "User-Agent"               : "DeepSeek/2.1.1 Android/36",
        "Accept"                   : "application/json",
        "Accept-Encoding"          : "gzip",
        "Content-Type"             : "application/json",
        "x-client-platform"        : "android",
        "x-client-version"         : "2.1.1",
        "x-client-locale"          : "ar",
        "x-client-bundle-id"       : "com.deepseek.chat",
        "x-rangers-id"             : _rangers_id(),
        "x-client-timezone-offset" : _tz_offset(),
        "x-device-id"              : _device_id(),
        "x-os-version"             : "30",
        "x-app-version"            : "2.1.1",
        "Authorization"            : f"Bearer {token}",
        "X-DS-PoW-Response"        : pow_response,
        "accept-charset"           : "UTF-8",
    }


async def _get_pow() -> dict:
    token = DEEPSEEK_TOKEN
    async with aiohttp.ClientSession() as s:
        for url in [f"{POW_URL}?authorization={token}", POW_URL]:
            try:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=15)) as r:
                    if r.status == 200:
                        data = await r.json()
                        pr = data.get("x_ds_pow_response") or data.get("pow_response")
                        if pr:
                            return {"pow_response": pr, "pow_data": data.get("solved_json")}
            except Exception:
                continue
    raise RuntimeError("POW fetch failed after all retries")


async def _new_session() -> str:
    token = DEEPSEEK_TOKEN
    url   = "https://chat.deepseek.com/api/v0/chat_session/create"
    hdrs  = {
        "x-client-bundle-id"       : "com.deepseek.chat",
        "x-client-platform"        : "web",
        "x-client-version"         : "2.0.0",
        "x-client-locale"          : "en_US",
        "x-client-timezone-offset" : _tz_offset(),
        "x-app-version"            : "2.0.0",
        "Authorization"            : f"Bearer {token}",
        "Content-Type"             : "application/json",
        "Accept"                   : "*/*",
    }
    async with aiohttp.ClientSession() as s:
        async with s.post(url, headers=hdrs, json={}) as r:
            data = await r.json()
            sid  = (
                data.get("data", {})
                    .get("biz_data", {})
                    .get("chat_session", {})
                    .get("id")
            )
            if not sid:
                raise RuntimeError(f"Bad session response: {data}")
            return sid


def _strip(text: str) -> str:
    """تنظيف مخلفات DeepSeek من النص"""
    text = re.sub(r"\bFINISHEDSEARCH\b|\bFINISHED\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```(?:json)?\s*([\s\S]*?)```", r"\1", text)
    return text.strip()


async def _stream_ds(
    prompt: str,
    session_id: str | None = None,
    parent_message_id: str | None = None,
) -> tuple[str, str, str | None]:
    """
    استدعاء DeepSeek (streaming).
    يرجع: (text, session_id, new_parent_message_id)
    """
    token = DEEPSEEK_TOKEN
    if not token:
        raise RuntimeError("DEEPSEEK_TOKEN not set")

    if not session_id:
        session_id = await _new_session()

    pow_d = await _get_pow()
    hdrs  = _build_headers(pow_d["pow_response"], token)

    payload = {
        "chat_session_id"  : session_id,
        "parent_message_id": parent_message_id,
        "prompt"           : prompt,
        "ref_file_ids"     : [],
        "thinking_enabled" : False,
        "search_enabled"   : False,
        "model_type"       : "default",
        "action"           : None,
        "preempt"          : False,
        "pow"              : pow_d["pow_data"],
        "stream"           : True,
    }

    full_text = ""
    new_pmid  = None

    async with aiohttp.ClientSession() as s:
        async with s.post(
            "https://chat.deepseek.com/api/v0/chat/completion",
            headers=hdrs,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                raise RuntimeError(f"DS {resp.status}: {await resp.text()}")

            buf = ""
            async for chunk in resp.content.iter_chunked(1024):
                buf += chunk.decode("utf-8")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    try:
                        d = json.loads(line[6:])
                        if new_pmid is None and "response_message_id" in d:
                            new_pmid = d["response_message_id"]
                        v = d.get("v")
                        if isinstance(v, str):
                            full_text += v
                        elif isinstance(v, dict):
                            for frag in v.get("response", {}).get("fragments", []):
                                if frag.get("type") == "RESPONSE":
                                    full_text += frag.get("content", "")
                    except Exception:
                        pass

    return _strip(full_text), session_id, new_pmid


# ──────────────────────────────────────────────────────────────
#  Guild Lookup Helpers
# ──────────────────────────────────────────────────────────────

def _find_channel(guild: discord.Guild, name: str) -> discord.abc.GuildChannel | None:
    nl = name.lower().strip()
    for ch in guild.channels:
        if ch.name.lower() == nl:
            return ch
    for ch in guild.channels:
        if nl in ch.name.lower():
            return ch
    return None


def _find_category(guild: discord.Guild, name: str) -> discord.CategoryChannel | None:
    nl = name.lower().strip()
    for c in guild.categories:
        if c.name.lower() == nl:
            return c
    for c in guild.categories:
        if nl in c.name.lower():
            return c
    return None


def _find_role(guild: discord.Guild, name: str) -> discord.Role | None:
    nl = name.lower().strip()
    for r in guild.roles:
        if r.name.lower() == nl:
            return r
    for r in guild.roles:
        if nl in r.name.lower():
            return r
    return None


def _find_member(guild: discord.Guild, query: str) -> discord.Member | None:
    ql = query.lower().strip()
    for m in guild.members:
        if m.name.lower() == ql:
            return m
        if m.nick and m.nick.lower() == ql:
            return m
        if m.global_name and m.global_name.lower() == ql:
            return m
    for m in guild.members:
        if ql in m.name.lower():
            return m
        if m.nick and ql in m.nick.lower():
            return m
        if m.global_name and ql in m.global_name.lower():
            return m
    return None


# ──────────────────────────────────────────────────────────────
#  TOOLS  — كل أداة ترجع dict
# ──────────────────────────────────────────────────────────────

def tool_get_channels(guild: discord.Guild) -> dict:
    rows = []
    for ch in guild.channels:
        if isinstance(ch, discord.CategoryChannel):
            continue
        rows.append({
            "id"      : ch.id,
            "name"    : ch.name,
            "type"    : "text" if isinstance(ch, discord.TextChannel) else "voice",
            "category": ch.category.name if ch.category else None,
        })
    return {"channels": rows}


def tool_get_categories(guild: discord.Guild) -> dict:
    return {
        "categories": [
            {"id": c.id, "name": c.name, "position": c.position}
            for c in guild.categories
        ]
    }


def tool_get_roles(guild: discord.Guild) -> dict:
    return {
        "roles": [
            {
                "id"      : r.id,
                "name"    : r.name,
                "color"   : str(r.color),
                "position": r.position,
                "perms"   : [p for p, v in r.permissions if v],
            }
            for r in guild.roles
        ]
    }


def tool_get_members(guild: discord.Guild, query: str | None = None) -> dict:
    members = list(guild.members)
    if query:
        ql      = query.lower()
        members = [
            m for m in members
            if ql in m.name.lower()
            or (m.nick and ql in m.nick.lower())
            or (m.global_name and ql in m.global_name.lower())
        ]
    return {
        "members": [
            {
                "id"         : m.id,
                "username"   : m.name,
                "global_name": m.global_name,
                "nickname"   : m.nick,
                "display"    : m.display_name,
                "roles"      : [r.name for r in m.roles if r.name != "@everyone"],
            }
            for m in members[:60]
        ]
    }


async def tool_execute(guild: discord.Guild, action: str, params: dict) -> dict:
    """ينفذ عملية واحدة ويرجع نتيجتها"""
    try:
        a = action.lower().strip()

        # ── create_category ──────────────────────────────────
        if a == "create_category":
            cat = await guild.create_category(name=params["name"])
            return {"ok": True, "msg": f"✅ تم إنشاء الكاتيكوري **{cat.name}**", "id": cat.id}

        # ── create_channel ───────────────────────────────────
        elif a == "create_channel":
            cat_obj = None
            if params.get("category"):
                cat_obj = _find_category(guild, params["category"])

            ch_type = params.get("type", "text").lower()
            if ch_type == "voice":
                ch = await guild.create_voice_channel(name=params["name"], category=cat_obj)
            else:
                ch = await guild.create_text_channel(name=params["name"], category=cat_obj)

            loc = f" تحت **{cat_obj.name}**" if cat_obj else ""
            return {"ok": True, "msg": f"✅ تم إنشاء الروم **{ch.name}**{loc}", "id": ch.id}

        # ── delete_channel ───────────────────────────────────
        elif a == "delete_channel":
            ch = _find_channel(guild, params["name"])
            if not ch:
                return {"ok": False, "msg": f"❌ ما لقيت روم اسمه **{params['name']}**"}
            name = ch.name
            await ch.delete()
            return {"ok": True, "msg": f"✅ تم حذف الروم **{name}**"}

        # ── rename_channel ───────────────────────────────────
        elif a == "rename_channel":
            ch = _find_channel(guild, params["channel"])
            if not ch:
                return {"ok": False, "msg": f"❌ ما لقيت روم اسمه **{params['channel']}**"}
            old = ch.name
            await ch.edit(name=params["new_name"])
            return {"ok": True, "msg": f"✅ تم تغيير اسم **{old}** → **{params['new_name']}**"}

        # ── create_role ──────────────────────────────────────
        elif a == "create_role":
            try:
                color = discord.Colour.from_str(params.get("color", "#99AAB5"))
            except Exception:
                color = discord.Colour.default()

            perms = discord.Permissions(**params.get("perms", {}))
            role  = await guild.create_role(
                name=params["name"], colour=color, permissions=perms
            )
            pos = params.get("position", 0)
            if pos and pos > 0:
                try:
                    await guild.edit_role_positions(positions={role: pos})
                except Exception as pe:
                    print(f"[role pos] {pe}")

            return {"ok": True, "msg": f"✅ تم إنشاء الرتبة **{role.name}**", "id": role.id}

        # ── delete_role ──────────────────────────────────────
        elif a == "delete_role":
            role = _find_role(guild, params["name"])
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت رتبة اسمها **{params['name']}**"}
            name = role.name
            await role.delete()
            return {"ok": True, "msg": f"✅ تم حذف الرتبة **{name}**"}

        # ── edit_role ────────────────────────────────────────
        elif a == "edit_role":
            role = _find_role(guild, params["name"])
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت رتبة اسمها **{params['name']}**"}
            kw = {}
            if "new_name" in params:
                kw["name"] = params["new_name"]
            if "color" in params:
                try:
                    kw["colour"] = discord.Colour.from_str(params["color"])
                except Exception:
                    pass
            if "perms" in params:
                kw["permissions"] = discord.Permissions(**params["perms"])
            await role.edit(**kw)
            return {"ok": True, "msg": f"✅ تم تعديل الرتبة **{role.name}**"}

        # ── grant_role ───────────────────────────────────────
        elif a == "grant_role":
            member = _find_member(guild, params["member"])
            role   = _find_role(guild, params["role"])
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو **{params['member']}**"}
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت الرتبة **{params['role']}**"}
            await member.add_roles(role)
            return {"ok": True, "msg": f"✅ أعطيت **{member.display_name}** رتبة **{role.name}**"}

        # ── revoke_role ──────────────────────────────────────
        elif a == "revoke_role":
            member = _find_member(guild, params["member"])
            role   = _find_role(guild, params["role"])
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو **{params['member']}**"}
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت الرتبة **{params['role']}**"}
            await member.remove_roles(role)
            return {"ok": True, "msg": f"✅ سحبت رتبة **{role.name}** من **{member.display_name}**"}

        # ── kick_member ──────────────────────────────────────
        elif a == "kick_member":
            member = _find_member(guild, params["member"])
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو **{params['member']}**"}
            name = member.display_name
            await member.kick(reason=params.get("reason", "—"))
            return {"ok": True, "msg": f"✅ تم كيك **{name}**"}

        # ── ban_member ───────────────────────────────────────
        elif a == "ban_member":
            member = _find_member(guild, params["member"])
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو **{params['member']}**"}
            name = member.display_name
            await member.ban(reason=params.get("reason", "—"), delete_message_days=0)
            return {"ok": True, "msg": f"✅ تم بان **{name}**"}

        # ── change_nickname ──────────────────────────────────
        elif a == "change_nickname":
            member = _find_member(guild, params["member"])
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو **{params['member']}**"}
            old = member.display_name
            await member.edit(nick=params["nickname"])
            return {"ok": True, "msg": f"✅ تم تغيير نكنيم **{old}** → **{params['nickname']}**"}

        else:
            return {"ok": False, "msg": f"⚠️ عملية غير معروفة: {action}"}

    except discord.Forbidden:
        return {"ok": False, "msg": f"⛔ البوت ما عنده صلاحية تنفيذ **{action}**"}
    except discord.HTTPException as e:
        return {"ok": False, "msg": f"❌ خطأ Discord في **{action}**: {e.text}"}
    except Exception as e:
        print(f"[tool_execute] {action} → {e}")
        return {"ok": False, "msg": f"❌ خطأ: {e}"}


# ──────────────────────────────────────────────────────────────
#  AGENT SYSTEM PROMPT
# ──────────────────────────────────────────────────────────────

def build_system(bot_name: str) -> str:
    return f"""أنت {bot_name}، بوت ديسكورد احترافي يدير سيرفرات.
تتكلم بالعربية باللهجة العراقية العامية.
تعرّف نفسك دائماً بـ "{bot_name}" مو باليوزر.
تخاطب المستخدم باسمه (النكنيم إذا عنده، وإلا الاسم العالمي).

══════════════════════════════════
الأدوات المتاحة
══════════════════════════════════
استخدم الأدوات فقط عند الحاجة — لا ترسل كل بيانات السيرفر مع كل رسالة.

get_channels     → يجيب قائمة الرومات
get_categories   → يجيب قائمة الكاتيكوريات
get_roles        → يجيب قائمة الرتب
get_members      → يجيب قائمة الأعضاء (اختياري: query للبحث)
execute          → ينفذ عملية في السيرفر

══════════════════════════════════
العمليات المتاحة في execute
══════════════════════════════════
create_category   | params: {{name}}
create_channel    | params: {{name, type:"text|voice", category?:"اسم"}}
delete_channel    | params: {{name}}
rename_channel    | params: {{channel:"الاسم الحالي", new_name:"الجديد"}}
create_role       | params: {{name, color?:"#hex", position?:N, perms?:{{perm:true}}}}
delete_role       | params: {{name}}
edit_role         | params: {{name, new_name?, color?, perms?}}
grant_role        | params: {{member:"اسم|ID", role:"اسم"}}
revoke_role       | params: {{member:"اسم|ID", role:"اسم"}}
kick_member       | params: {{member:"اسم|ID", reason?:"..."}}
ban_member        | params: {{member:"اسم|ID", reason?:"..."}}
change_nickname   | params: {{member:"اسم|ID", nickname:"..."}}

Discord Permissions:
administrator, manage_channels, manage_roles, manage_expressions,
view_audit_log, manage_webhooks, manage_guild, create_instant_invite,
change_nickname, manage_nicknames, kick_members, ban_members,
manage_events, moderate_members, view_channel, send_messages,
send_messages_in_threads, create_public_threads, create_private_threads,
embed_links, attach_files, add_reactions, external_emojis, external_stickers,
mention_everyone, manage_messages, manage_threads, read_message_history,
send_tts_messages, use_application_commands, send_voice_messages,
connect, speak, stream, use_embedded_activities, use_voice_activation,
priority_speaker, mute_members, deafen_members, move_members,
use_soundboard, use_external_sounds

⚠️ administrator فقط إذا طلبه المستخدم صراحة بالكلام — لا تستنتجه من اسم الرتبة

══════════════════════════════════
شكل الرد — JSON فقط
══════════════════════════════════
لاستدعاء أداة:
{{"tool": "get_channels"}}
{{"tool": "get_members", "params": {{"query": "اسم"}}}}

لتنفيذ عملية:
{{"tool": "execute", "action": "create_channel", "params": {{"name": "...", "type": "text"}}}}

للرد النهائي:
{{"reply": "ردك بالعراقي هنا"}}

قواعد Agent Loop:
1. لا ترسل رسائل تأكيد — نفذ مباشرة ثم رد بالنتيجة
2. إذا احتجت بيانات السيرفر استخدم الأداة المناسبة، لا تخترع البيانات
3. إذا نفذت أكثر من عملية، نفذهم واحدة واحدة وانتظر نتيجة كل واحدة
4. بعد آخر عملية أو عند الإجابة على سؤال → رد بـ reply
5. إذا المستخدم يتكلم أو يسأل سؤال عام → رد مباشرة بـ reply بدون أدوات
6. الرد النهائي يكون مختصراً ومباشراً"""


# ──────────────────────────────────────────────────────────────
#  AGENT LOOP
# ──────────────────────────────────────────────────────────────
MAX_STEPS = 10


async def run_agent(
    guild: discord.Guild,
    user_msg: str,
    user_info: str,
    bot_name: str,
    session_id: str | None,
    parent_message_id: str | None,
) -> tuple[str, str, str | None]:
    """
    Agent Loop:
     step 1 : إرسال الرسالة للنموذج
     step N : النموذج يستدعي أداة → ننفذ → نرجع النتيجة
     step X : النموذج يرد بـ reply → نرجعه للمستخدم

    يرجع: (final_reply, session_id, parent_message_id)
    """
    system       = build_system(bot_name)
    cur_sid      = session_id
    cur_pmid     = parent_message_id
    # الرسالة الأولى = system + user_info + طلب المستخدم
    cur_prompt   = f"{system}\n\n{user_info}\n\nUser: {user_msg}"
    is_tool_turn = False   # الدورة الأولى محادثة عادية

    for step in range(MAX_STEPS):
        print(f"[Agent {step+1}/{MAX_STEPS}] sending...")
        try:
            raw, cur_sid, cur_pmid = await _stream_ds(
                cur_prompt, cur_sid, cur_pmid
            )
        except Exception as e:
            print(f"[Agent] DS error at step {step+1}: {e}")
            return f"⚠️ خطأ في الاتصال: {e}", cur_sid, cur_pmid

        print(f"[Agent {step+1}] raw: {raw[:400]}")

        # ── محاولة parse JSON ──
        parsed = None
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            try:
                parsed = json.loads(m.group())
            except Exception:
                pass

        # إذا ما فيه JSON → رد نصي مباشر (محادثة عادية)
        if parsed is None:
            return raw, cur_sid, cur_pmid

        # ── reply نهائي ──
        if "reply" in parsed:
            return parsed["reply"], cur_sid, cur_pmid

        # ── أداة ──
        tool = parsed.get("tool", "")
        if not tool:
            return raw, cur_sid, cur_pmid

        # تنفيذ الأداة
        result: dict = {}

        if tool == "get_channels":
            result = tool_get_channels(guild)

        elif tool == "get_categories":
            result = tool_get_categories(guild)

        elif tool == "get_roles":
            result = tool_get_roles(guild)

        elif tool == "get_members":
            query  = (parsed.get("params") or {}).get("query")
            result = tool_get_members(guild, query)

        elif tool == "execute":
            action = parsed.get("action", "")
            params = parsed.get("params", {})
            result = await tool_execute(guild, action, params)

        else:
            result = {"error": f"أداة غير معروفة: {tool}"}

        print(f"[Agent {step+1}] tool='{tool}' result={str(result)[:300]}")

        # نرجع نتيجة الأداة للنموذج في الدورة القادمة
        cur_prompt = f"[TOOL_RESULT for '{tool}']\n{json.dumps(result, ensure_ascii=False)}\n\nاستكمل."

    return "✅ تم.", cur_sid, cur_pmid


# ──────────────────────────────────────────────────────────────
#  Discord Events
# ──────────────────────────────────────────────────────────────

@client.event
async def on_ready():
    name = client.user.display_name or client.user.name
    uid  = client.user.id
    print(f"✅ {name} ({uid}) ready")
    print(f"📡 Guilds: {[g.name for g in client.guilds]}")
    try:
        await mongo_client.admin.command("ping")
        print("✅ MongoDB OK")
    except Exception as e:
        print(f"❌ MongoDB: {e}")


@client.event
async def on_message(m: discord.Message):
    # تجاهل رسائل البوت نفسه
    if m.author.id == client.user.id:
        return

    # القناة المسموح بها
    if m.channel.id != ALLOWED_CHANNEL_ID:
        return

    # منشن أو رد على البوت
    is_mention = client.user.mentioned_in(m) and not m.mention_everyone
    is_reply   = (
        m.reference
        and m.reference.resolved
        and isinstance(m.reference.resolved, discord.Message)
        and m.reference.resolved.author.id == client.user.id
    )
    if not (is_mention or is_reply):
        return

    # استخراج النص الصافي
    content = m.content
    for mention in m.mentions:
        content = content.replace(f"<@{mention.id}>", "").replace(f"<@!{mention.id}>", "")
    final = content.strip()

    if not final:
        await m.reply("وين أساعدك؟ 😄")
        return

    # أوامر التحكم
    if final.lower() in ("!reset", "!newchat", "محادثة جديدة"):
        async with session_lock:
            user_sessions.pop(m.author.id, None)
        await m.reply("✅ تمت إعادة تعيين المحادثة!")
        return

    # ── معلومات المستخدم الكاملة ──
    author       = m.author
    nick         = getattr(author, "nick", None)
    display_name = nick or author.global_name or author.name
    user_info    = (
        f"[معلومات المستخدم]\n"
        f"  النكنيم في السيرفر : {nick or '—'}\n"
        f"  الاسم العالمي      : {author.global_name or '—'}\n"
        f"  اليوزرنيم          : @{author.name}\n"
        f"  المعرف (ID)        : {author.id}\n"
        f"  ناديه بـ           : {display_name}\n"
    )

    # الـ session
    async with session_lock:
        if m.author.id not in user_sessions:
            user_sessions[m.author.id] = {"session_id": None, "parent_message_id": None}
        us = user_sessions[m.author.id]

    bot_name = client.user.display_name or client.user.name

    async with m.channel.typing():
        try:
            reply, new_sid, new_pmid = await run_agent(
                guild             = m.guild,
                user_msg          = final,
                user_info         = user_info,
                bot_name          = bot_name,
                session_id        = us["session_id"],
                parent_message_id = us["parent_message_id"],
            )

            async with session_lock:
                us["session_id"]        = new_sid
                us["parent_message_id"] = new_pmid

            reply = reply or "✅ تم."

            # إرسال مع تقسيم إذا طويل
            for chunk in [reply[i:i+1990] for i in range(0, len(reply), 1990)]:
                await m.reply(chunk)

        except Exception as e:
            print(f"[on_message] {e}")
            await m.reply(f"⚠️ خطأ غير متوقع: {str(e)[:300]}")


# ──────────────────────────────────────────────────────────────
#  Entry Point
# ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    missing = [v for v in ("USER_TOKEN", "DEEPSEEK_TOKEN") if not os.getenv(v)]
    if missing:
        raise EnvironmentError(f"❌ متغيرات مفقودة: {', '.join(missing)}")
    client.run(USER_TOKEN)