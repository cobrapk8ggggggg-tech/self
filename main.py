"""
Disor Bot — v4.0 "Professional"
═══════════════════════════════════════════════════════════════
الجديد في هذا الإصدار:
  1. _find_member يدعم البحث بالـ ID رقمياً
  2. Markdown متوافق 100% مع Discord (لا جداول، لا HTML)
  3. نداء الأعضاء بشكل طبيعي ومريح
  4. أدوات جديدة: get_messages, delete_messages, server_info,
                  slowmode, clear_channel, move_member
  5. نظام صلاحيات: رتبة محددة فقط + Slash Commands + DB للـ sessions
  6. نظام إيموجي: 👀 → ⏳ → ☑️
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
from discord import app_commands
from motor.motor_asyncio import AsyncIOMotorClient

# ══════════════════════════════════════════════════════════════
#  ENV
# ══════════════════════════════════════════════════════════════
MONGODB_URI        = os.getenv("MONGODB_URI")
USER_TOKEN         = os.getenv("USER_TOKEN")
DEEPSEEK_TOKEN     = os.getenv("DEEPSEEK_TOKEN")
ALLOWED_CHANNEL_ID = int(os.getenv("ALLOWED_CHANNEL_ID", "1356830719170842710"))

# رتبة التحكم — اسم الرتبة اللي تقدر تستخدم البوت (فارغة = الكل)
CONTROL_ROLE_NAME  = os.getenv("CONTROL_ROLE", "")

# ══════════════════════════════════════════════════════════════
#  MongoDB
# ══════════════════════════════════════════════════════════════
mongo_client  = AsyncIOMotorClient(MONGODB_URI)
db            = mongo_client["disor_db"]
sessions_col  = db["chat_sessions"]   # حفظ الـ DS sessions
settings_col  = db["settings"]        # إعدادات البوت (رتبة التحكم، إلخ)

# ══════════════════════════════════════════════════════════════
#  Discord — Client + CommandTree
# ══════════════════════════════════════════════════════════════
intents                 = discord.Intents.default()
intents.members         = True
intents.message_content = True
intents.guilds          = True


class DisorClient(discord.Client):
    def __init__(self):
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        await self.tree.sync()
        print("✅ Slash commands synced")


client = DisorClient()

# ══════════════════════════════════════════════════════════════
#  RAM Sessions Cache  { user_id: {"session_id", "parent_message_id"} }
# ══════════════════════════════════════════════════════════════
user_sessions: dict[int, dict] = {}
session_lock  = asyncio.Lock()

# ══════════════════════════════════════════════════════════════
#  Control Role helpers
# ══════════════════════════════════════════════════════════════

async def get_control_role(guild_id: int) -> str:
    """يجيب اسم رتبة التحكم من DB أو ENV"""
    doc = await settings_col.find_one({"guild_id": guild_id})
    if doc and doc.get("control_role"):
        return doc["control_role"]
    return CONTROL_ROLE_NAME


async def set_control_role(guild_id: int, role_name: str):
    await settings_col.update_one(
        {"guild_id": guild_id},
        {"$set": {"control_role": role_name}},
        upsert=True,
    )


def member_has_control(member: discord.Member, role_name: str) -> bool:
    """هل العضو عنده رتبة التحكم؟"""
    if not role_name:
        return True   # لا قيود — الكل يقدر يستخدم
    if member.guild_permissions.administrator:
        return True   # الأدمن دايماً يقدر
    return any(r.name.lower() == role_name.lower() for r in member.roles)


# ══════════════════════════════════════════════════════════════
#  DB Sessions
# ══════════════════════════════════════════════════════════════

async def db_save_session(user_id: int, label: str, session_id: str, parent_message_id: str | None):
    await sessions_col.update_one(
        {"user_id": user_id, "label": label},
        {"$set": {
            "session_id"       : session_id,
            "parent_message_id": parent_message_id,
            "updated_at"       : datetime.utcnow(),
        }},
        upsert=True,
    )


async def db_get_sessions(user_id: int) -> list[dict]:
    cursor = sessions_col.find({"user_id": user_id}).sort("updated_at", -1).limit(10)
    return await cursor.to_list(length=10)


async def db_delete_session(user_id: int, label: str):
    await sessions_col.delete_one({"user_id": user_id, "label": label})


# ══════════════════════════════════════════════════════════════
#  DeepSeek API — Low-level
# ══════════════════════════════════════════════════════════════
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
    raise RuntimeError("POW fetch failed")


async def _new_ds_session() -> str:
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
                raise RuntimeError(f"Bad session: {data}")
            return sid


def _strip(text: str) -> str:
    text = re.sub(r"\bFINISHEDSEARCH\b|\bFINISHED\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```(?:json)?\s*([\s\S]*?)```", r"\1", text)
    return text.strip()


async def _stream_ds(
    prompt: str,
    session_id: str | None = None,
    parent_message_id: str | None = None,
) -> tuple[str, str, str | None]:
    token = DEEPSEEK_TOKEN
    if not token:
        raise RuntimeError("DEEPSEEK_TOKEN not set")
    if not session_id:
        session_id = await _new_ds_session()

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


# ══════════════════════════════════════════════════════════════
#  Guild Lookup — يدعم الاسم والـ ID
# ══════════════════════════════════════════════════════════════

def _find_channel(guild: discord.Guild, q: str) -> discord.abc.GuildChannel | None:
    # بحث بالـ ID
    try:
        ch = guild.get_channel(int(q))
        if ch:
            return ch
    except (ValueError, TypeError):
        pass
    ql = q.lower().strip()
    for ch in guild.channels:
        if ch.name.lower() == ql:
            return ch
    for ch in guild.channels:
        if ql in ch.name.lower():
            return ch
    return None


def _find_category(guild: discord.Guild, q: str) -> discord.CategoryChannel | None:
    try:
        c = guild.get_channel(int(q))
        if isinstance(c, discord.CategoryChannel):
            return c
    except (ValueError, TypeError):
        pass
    ql = q.lower().strip()
    for c in guild.categories:
        if c.name.lower() == ql:
            return c
    for c in guild.categories:
        if ql in c.name.lower():
            return c
    return None


def _find_role(guild: discord.Guild, q: str) -> discord.Role | None:
    try:
        r = guild.get_role(int(q))
        if r:
            return r
    except (ValueError, TypeError):
        pass
    ql = q.lower().strip()
    for r in guild.roles:
        if r.name.lower() == ql:
            return r
    for r in guild.roles:
        if ql in r.name.lower():
            return r
    return None


def _find_member(guild: discord.Guild, q: str) -> discord.Member | None:
    # ── بحث بالـ ID أولاً (رقم أو نص رقمي) ──
    try:
        mid = int(str(q).strip())
        m   = guild.get_member(mid)
        if m:
            return m
    except (ValueError, TypeError):
        pass

    # ── بحث بالاسم ──
    ql = str(q).lower().strip()

    # exact match
    for m in guild.members:
        if m.name.lower() == ql:
            return m
        if m.nick and m.nick.lower() == ql:
            return m
        if m.global_name and m.global_name.lower() == ql:
            return m

    # partial match
    for m in guild.members:
        if ql in m.name.lower():
            return m
        if m.nick and ql in m.nick.lower():
            return m
        if m.global_name and ql in m.global_name.lower():
            return m

    return None


# ══════════════════════════════════════════════════════════════
#  TOOLS
# ══════════════════════════════════════════════════════════════

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


def tool_server_info(guild: discord.Guild) -> dict:
    return {
        "name"        : guild.name,
        "id"          : guild.id,
        "member_count": guild.member_count,
        "owner_id"    : guild.owner_id,
        "created_at"  : str(guild.created_at.date()),
        "boost_level" : guild.premium_tier,
        "boosts"      : guild.premium_subscription_count,
        "channels"    : len([c for c in guild.channels if not isinstance(c, discord.CategoryChannel)]),
        "categories"  : len(guild.categories),
        "roles"       : len(guild.roles),
    }


async def tool_get_messages(
    channel: discord.TextChannel,
    limit: int = 100,
    member_id: int | None = None,
) -> dict:
    """يجيب آخر N رسالة من قناة — اختياري: فلتر بالعضو"""
    msgs = []
    async for msg in channel.history(limit=min(limit, 500)):
        if member_id and msg.author.id != member_id:
            continue
        msgs.append({
            "id"     : msg.id,
            "author" : msg.author.display_name,
            "author_id": msg.author.id,
            "content": msg.content[:500],
            "time"   : msg.created_at.strftime("%Y-%m-%d %H:%M"),
        })
    return {"messages": msgs, "count": len(msgs)}


async def tool_execute(
    guild: discord.Guild,
    channel: discord.TextChannel,
    action: str,
    params: dict,
) -> dict:
    """تنفذ عملية واحدة وترجع النتيجة"""
    try:
        a = action.lower().strip()

        # ── create_category ─────────────────────────────────
        if a == "create_category":
            cat = await guild.create_category(name=params["name"])
            return {"ok": True, "msg": f"✅ تم إنشاء الكاتيكوري **{cat.name}**"}

        # ── create_channel ───────────────────────────────────
        elif a == "create_channel":
            cat_obj = None
            if params.get("category"):
                cat_obj = _find_category(guild, str(params["category"]))
            if params.get("type", "text").lower() == "voice":
                ch = await guild.create_voice_channel(name=params["name"], category=cat_obj)
            else:
                ch = await guild.create_text_channel(name=params["name"], category=cat_obj)
            loc = f" تحت **{cat_obj.name}**" if cat_obj else ""
            return {"ok": True, "msg": f"✅ تم إنشاء الروم **{ch.name}**{loc}"}

        # ── delete_channel ───────────────────────────────────
        elif a == "delete_channel":
            ch = _find_channel(guild, str(params["name"]))
            if not ch:
                return {"ok": False, "msg": f"❌ ما لقيت روم: **{params['name']}**"}
            name = ch.name
            await ch.delete()
            return {"ok": True, "msg": f"✅ تم حذف الروم **{name}**"}

        # ── rename_channel ───────────────────────────────────
        elif a == "rename_channel":
            ch = _find_channel(guild, str(params["channel"]))
            if not ch:
                return {"ok": False, "msg": f"❌ ما لقيت روم: **{params['channel']}**"}
            old = ch.name
            await ch.edit(name=params["new_name"])
            return {"ok": True, "msg": f"✅ تم تغيير اسم **{old}** → **{params['new_name']}**"}

        # ── clear_channel ────────────────────────────────────
        elif a == "clear_channel":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            limit = int(params.get("limit", 100))
            deleted = await target_ch.purge(limit=min(limit, 500))
            return {"ok": True, "msg": f"✅ تم حذف **{len(deleted)}** رسالة من **{target_ch.name}**"}

        # ── delete_member_messages ───────────────────────────
        elif a == "delete_member_messages":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            limit   = int(params.get("limit", 100))
            deleted = await target_ch.purge(
                limit=min(limit, 500),
                check=lambda m: m.author.id == member.id,
            )
            return {"ok": True, "msg": f"✅ تم حذف **{len(deleted)}** رسالة للعضو **{member.display_name}**"}

        # ── create_role ──────────────────────────────────────
        elif a == "create_role":
            try:
                color = discord.Colour.from_str(params.get("color", "#99AAB5"))
            except Exception:
                color = discord.Colour.default()
            perms = discord.Permissions(**params.get("perms", {}))
            role  = await guild.create_role(name=params["name"], colour=color, permissions=perms)
            pos   = params.get("position", 0)
            if pos and pos > 0:
                try:
                    await guild.edit_role_positions(positions={role: pos})
                except Exception as pe:
                    print(f"[role pos] {pe}")
            return {"ok": True, "msg": f"✅ تم إنشاء الرتبة **{role.name}**"}

        # ── delete_role ──────────────────────────────────────
        elif a == "delete_role":
            role = _find_role(guild, str(params["name"]))
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت رتبة: **{params['name']}**"}
            name = role.name
            await role.delete()
            return {"ok": True, "msg": f"✅ تم حذف الرتبة **{name}**"}

        # ── edit_role ────────────────────────────────────────
        elif a == "edit_role":
            role = _find_role(guild, str(params["name"]))
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت رتبة: **{params['name']}**"}
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
            member = _find_member(guild, str(params["member"]))
            role   = _find_role(guild, str(params["role"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت الرتبة: **{params['role']}**"}
            await member.add_roles(role)
            return {"ok": True, "msg": f"✅ أعطيت **{member.display_name}** رتبة **{role.name}**"}

        # ── revoke_role ──────────────────────────────────────
        elif a == "revoke_role":
            member = _find_member(guild, str(params["member"]))
            role   = _find_role(guild, str(params["role"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت الرتبة: **{params['role']}**"}
            await member.remove_roles(role)
            return {"ok": True, "msg": f"✅ سحبت رتبة **{role.name}** من **{member.display_name}**"}

        # ── kick_member ──────────────────────────────────────
        elif a == "kick_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            name = member.display_name
            await member.kick(reason=params.get("reason", "—"))
            return {"ok": True, "msg": f"✅ تم كيك **{name}**"}

        # ── ban_member ───────────────────────────────────────
        elif a == "ban_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            name = member.display_name
            await member.ban(reason=params.get("reason", "—"), delete_message_days=0)
            return {"ok": True, "msg": f"✅ تم بان **{name}**"}

        # ── change_nickname ──────────────────────────────────
        elif a == "change_nickname":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            old = member.display_name
            await member.edit(nick=params["nickname"])
            return {"ok": True, "msg": f"✅ تم تغيير نكنيم **{old}** → **{params['nickname']}**"}

        # ── slowmode ─────────────────────────────────────────
        elif a == "slowmode":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            seconds = int(params.get("seconds", 0))
            await target_ch.edit(slowmode_delay=seconds)
            if seconds == 0:
                return {"ok": True, "msg": f"✅ تم إيقاف السلو مود في **{target_ch.name}**"}
            return {"ok": True, "msg": f"✅ تم تفعيل سلو مود **{seconds}** ثانية في **{target_ch.name}**"}

        # ── move_member ──────────────────────────────────────
        elif a == "move_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            vc = _find_channel(guild, str(params["channel"]))
            if not vc or not isinstance(vc, discord.VoiceChannel):
                return {"ok": False, "msg": f"❌ ما لقيت فويس: **{params['channel']}**"}
            await member.move_to(vc)
            return {"ok": True, "msg": f"✅ تم نقل **{member.display_name}** إلى **{vc.name}**"}

        else:
            return {"ok": False, "msg": f"⚠️ عملية غير معروفة: {action}"}

    except discord.Forbidden:
        return {"ok": False, "msg": f"⛔ البوت ما عنده صلاحية تنفيذ **{action}**"}
    except discord.HTTPException as e:
        return {"ok": False, "msg": f"❌ خطأ Discord في **{action}**: {e.text}"}
    except Exception as e:
        print(f"[tool_execute] {action} → {e}")
        return {"ok": False, "msg": f"❌ خطأ: {e}"}


# ══════════════════════════════════════════════════════════════
#  SYSTEM PROMPT
# ══════════════════════════════════════════════════════════════

def build_system(bot_name: str) -> str:
    return f"""أنت {bot_name}، بوت ديسكورد احترافي يدير السيرفرات.
تتكلم بالعربية باللهجة العراقية العامية بشكل طبيعي ومريح.
تعرّف نفسك بـ "{bot_name}".
تخاطب المستخدم باسمه بشكل طبيعي — إذا اسمه "ZEUS" تقول "زيوس"، إذا اسمه "Ahmed" تقول "أحمد".

══════════════════════════════════════════════
Discord Markdown المدعوم فقط
══════════════════════════════════════════════
**نص**          ← بولد
*نص*            ← مائل
__نص__          ← تحته خط
~~نص~~          ← يتوسط
`كود`           ← كود صغير
```كود```       ← كود بلوك
> نص            ← اقتباس
>>> نص          ← اقتباس متعدد
# عنوان        ← عنوان كبير
## عنوان       ← عنوان وسط
### عنوان      ← عنوان صغير
- عنصر         ← قائمة
||نص||          ← سبويلر
:emoji_name:    ← إيموجي

❌ لا تستخدم جداول HTML أو جداول Markdown — Discord لا يدعمها
❌ لا تستخدم <br> أو أي HTML
✅ استخدم الـ bullet points والأسطر للتنظيم بدل الجداول

══════════════════════════════════════════════
الأدوات المتاحة — استخدمها فقط عند الحاجة
══════════════════════════════════════════════
get_channels              → قائمة الرومات
get_categories            → قائمة الكاتيكوريات
get_roles                 → قائمة الرتب
get_members               → قائمة الأعضاء (اختياري: query للبحث)
get_messages              → آخر رسائل القناة الحالية (اختياري: limit, member_id)
server_info               → معلومات عامة عن السيرفر
execute                   → تنفيذ عملية

══════════════════════════════════════════════
عمليات execute
══════════════════════════════════════════════
create_category         | {{name}}
create_channel          | {{name, type:"text|voice", category?}}
delete_channel          | {{name}}
rename_channel          | {{channel, new_name}}
clear_channel           | {{channel?, limit?:100}} — يحذف رسائل
delete_member_messages  | {{member, channel?, limit?:100}}
create_role             | {{name, color?:"#hex", position?:N, perms?:{{perm:true}}}}
delete_role             | {{name}}
edit_role               | {{name, new_name?, color?, perms?}}
grant_role              | {{member:"اسم أو ID", role:"اسم أو ID"}}
revoke_role             | {{member:"اسم أو ID", role:"اسم أو ID"}}
kick_member             | {{member:"اسم أو ID", reason?}}
ban_member              | {{member:"اسم أو ID", reason?}}
change_nickname         | {{member:"اسم أو ID", nickname}}
slowmode                | {{channel?, seconds:0}} — 0 يوقف السلو مود
move_member             | {{member:"اسم أو ID", channel:"فويس"}}

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

⚠️ administrator فقط إذا طلبه المستخدم صراحة

══════════════════════════════════════════════
شكل الرد — JSON فقط
══════════════════════════════════════════════
{{"tool": "get_channels"}}
{{"tool": "get_members", "params": {{"query": "اسم"}}}}
{{"tool": "get_messages", "params": {{"limit": 100}}}}
{{"tool": "server_info"}}
{{"tool": "execute", "action": "create_channel", "params": {{"name": "...", "type": "text"}}}}
{{"reply": "ردك هنا"}}

قواعد:
1. لا رسائل تأكيد — نفذ مباشرة وأخبر بالنتيجة
2. لا تخترع بيانات السيرفر — استخدم الأدوات
3. عمليات متعددة → واحدة واحدة وانتظر نتيجة كل واحدة
4. بعد كل العمليات → رد بـ reply مختصر
5. محادثة عادية أو سؤال → reply مباشرة بدون أدوات
6. استخدم Discord Markdown فقط في الـ reply"""


# ══════════════════════════════════════════════════════════════
#  AGENT LOOP
# ══════════════════════════════════════════════════════════════
MAX_STEPS = 12


async def run_agent(
    guild: discord.Guild,
    channel: discord.TextChannel,
    user_msg: str,
    user_info: str,
    bot_name: str,
    session_id: str | None,
    parent_message_id: str | None,
) -> tuple[str, str, str | None]:

    system     = build_system(bot_name)
    cur_sid    = session_id
    cur_pmid   = parent_message_id
    cur_prompt = f"{system}\n\n{user_info}\n\nUser: {user_msg}"

    for step in range(MAX_STEPS):
        print(f"[Agent {step+1}/{MAX_STEPS}]")
        try:
            raw, cur_sid, cur_pmid = await _stream_ds(cur_prompt, cur_sid, cur_pmid)
        except Exception as e:
            return f"⚠️ خطأ في الاتصال: {e}", cur_sid, cur_pmid

        print(f"  raw: {raw[:300]}")

        # parse JSON
        parsed = None
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            try:
                parsed = json.loads(m.group())
            except Exception:
                pass

        if parsed is None:
            return raw, cur_sid, cur_pmid

        if "reply" in parsed:
            return parsed["reply"], cur_sid, cur_pmid

        tool = parsed.get("tool", "")
        if not tool:
            return raw, cur_sid, cur_pmid

        # ── تنفيذ الأداة ──
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

        elif tool == "server_info":
            result = tool_server_info(guild)

        elif tool == "get_messages":
            p         = parsed.get("params") or {}
            limit     = int(p.get("limit", 100))
            member_id = p.get("member_id")
            if isinstance(channel, discord.TextChannel):
                result = await tool_get_messages(channel, limit, member_id)
            else:
                result = {"error": "القناة الحالية ليست نصية"}

        elif tool == "execute":
            action = parsed.get("action", "")
            params = parsed.get("params", {})
            result = await tool_execute(guild, channel, action, params)

        else:
            result = {"error": f"أداة غير معروفة: {tool}"}

        print(f"  tool='{tool}' → {str(result)[:200]}")

        cur_prompt = (
            f"[TOOL_RESULT: {tool}]\n"
            f"{json.dumps(result, ensure_ascii=False)}\n\n"
            f"استكمل."
        )

    return "✅ تم.", cur_sid, cur_pmid


# ══════════════════════════════════════════════════════════════
#  SLASH COMMANDS
# ══════════════════════════════════════════════════════════════

@client.tree.command(name="اوامر", description="عرض جميع الأوامر المتاحة")
async def cmd_help(interaction: discord.Interaction):
    bot_name = client.user.display_name or client.user.name
    help_text = f"""# أوامر {bot_name}

## 💬 التفاعل مع الذكاء الاصطناعي
منشن البوت أو ردّ على رسالته للتحدث معه

## 🗂️ إدارة المحادثات
**/محادثة-جديدة** — ابدأ محادثة جديدة مع الذكاء
**/محادثاتي** — عرض محادثاتك المحفوظة واختيار واحدة

## ⚙️ إعدادات البوت
**/رتبة-التحكم** `[اسم الرتبة]` — حدد الرتبة اللي تقدر تستخدم البوت
**/الرتبة-الحالية** — عرض رتبة التحكم الحالية

## 🛠️ الأدوات المتاحة للذكاء الاصطناعي
**قراءة البيانات:**
- قراءة الرومات، الكاتيكوريات، الرتب، الأعضاء
- قراءة رسائل المحادثة (آخر 500 رسالة)
- معلومات السيرفر

**إدارة الرومات:**
- إنشاء / حذف / تغيير اسم روم
- حذف رسائل (كلها أو لعضو معين)
- السلو مود

**إدارة الرتب:**
- إنشاء / حذف / تعديل رتبة
- إعطاء / سحب رتبة من عضو

**إدارة الأعضاء:**
- كيك / بان / تغيير نكنيم
- نقل عضو لفويس

> **تلميح:** كل الأوامر تشتغل بالاسم أو الـ ID"""

    await interaction.response.send_message(help_text, ephemeral=True)


@client.tree.command(name="محادثة-جديدة", description="ابدأ محادثة جديدة مع الذكاء الاصطناعي")
async def cmd_new_chat(interaction: discord.Interaction):
    user_id = interaction.user.id

    # نحفظ الـ session الحالي في DB
    async with session_lock:
        if user_id in user_sessions and user_sessions[user_id].get("session_id"):
            us    = user_sessions[user_id]
            label = f"محادثة {datetime.now().strftime('%d/%m %H:%M')}"
            await db_save_session(
                user_id, label,
                us["session_id"],
                us["parent_message_id"],
            )
        user_sessions[user_id] = {"session_id": None, "parent_message_id": None}

    await interaction.response.send_message(
        "✅ **بدأت محادثة جديدة!** المحادثة السابقة تم حفظها في `/محادثاتي`",
        ephemeral=True,
    )


@client.tree.command(name="محادثاتي", description="عرض محادثاتك المحفوظة")
async def cmd_my_chats(interaction: discord.Interaction):
    user_id  = interaction.user.id
    sessions = await db_get_sessions(user_id)

    if not sessions:
        await interaction.response.send_message(
            "📭 ما عندك محادثات محفوظة.", ephemeral=True
        )
        return

    lines = ["# محادثاتك المحفوظة\n"]
    for i, s in enumerate(sessions, 1):
        updated = s.get("updated_at", "").strftime("%d/%m %H:%M") if hasattr(s.get("updated_at", ""), "strftime") else "—"
        lines.append(f"**{i}.** {s['label']} — آخر تحديث: {updated}")

    lines.append("\n> اكتب رقم المحادثة اللي تبي تحمّلها بعد هذي الرسالة")
    await interaction.response.send_message("\n".join(lines), ephemeral=True)

    # ننتظر رد المستخدم لاختيار المحادثة
    def check(m: discord.Message):
        return m.author.id == user_id and m.content.strip().isdigit()

    try:
        msg = await client.wait_for("message", check=check, timeout=30.0)
        idx = int(msg.content.strip()) - 1
        if 0 <= idx < len(sessions):
            chosen = sessions[idx]
            async with session_lock:
                user_sessions[user_id] = {
                    "session_id"       : chosen["session_id"],
                    "parent_message_id": chosen["parent_message_id"],
                }
            await msg.reply(
                f"✅ تم تحميل محادثة **{chosen['label']}** — تقدر تكمل من حيث توقفت!"
            )
        else:
            await msg.reply("❌ رقم غير صحيح")
    except asyncio.TimeoutError:
        pass


@client.tree.command(name="رتبة-التحكم", description="حدد الرتبة اللي تقدر تستخدم البوت")
@app_commands.describe(role="اسم الرتبة (اتركها فارغة لتعطيل القيد)")
async def cmd_set_control_role(interaction: discord.Interaction, role: str = ""):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("⛔ هذا الأمر للأدمن فقط.", ephemeral=True)
        return

    await set_control_role(interaction.guild_id, role)
    if role:
        await interaction.response.send_message(
            f"✅ تم تحديد رتبة التحكم: **{role}**\nالآن فقط أصحاب هذي الرتبة يقدرون يستخدمون البوت.",
            ephemeral=True,
        )
    else:
        await interaction.response.send_message(
            "✅ تم إزالة قيد الرتبة — الكل يقدر يستخدم البوت الآن.",
            ephemeral=True,
        )


@client.tree.command(name="الرتبة-الحالية", description="عرض رتبة التحكم الحالية")
async def cmd_get_control_role(interaction: discord.Interaction):
    role = await get_control_role(interaction.guild_id)
    if role:
        await interaction.response.send_message(
            f"🔒 رتبة التحكم الحالية: **{role}**", ephemeral=True
        )
    else:
        await interaction.response.send_message(
            "🔓 لا يوجد قيد — الكل يقدر يستخدم البوت.", ephemeral=True
        )


# ══════════════════════════════════════════════════════════════
#  EVENTS
# ══════════════════════════════════════════════════════════════

@client.event
async def on_ready():
    name = client.user.display_name or client.user.name
    print(f"✅ {name} ({client.user.id}) ready")
    print(f"📡 Guilds: {[g.name for g in client.guilds]}")
    try:
        await mongo_client.admin.command("ping")
        print("✅ MongoDB OK")
    except Exception as e:
        print(f"❌ MongoDB: {e}")


@client.event
async def on_message(m: discord.Message):
    if m.author.id == client.user.id:
        return
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

    # التحقق من رتبة التحكم
    control_role = await get_control_role(m.guild.id)
    if not member_has_control(m.author, control_role):
        await m.reply(f"⛔ ما عندك صلاحية — تحتاج رتبة **{control_role}** لاستخدام البوت.")
        return

    # استخراج النص
    content = m.content
    for mention in m.mentions:
        content = content.replace(f"<@{mention.id}>", "").replace(f"<@!{mention.id}>", "")
    final = content.strip()

    if not final:
        await m.reply("وين أساعدك؟ 😄")
        return

    # ── نظام الإيموجي: 👀 (وصلت) ──
    try:
        await m.add_reaction("👀")
    except Exception:
        pass

    # معلومات المستخدم
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
        f"  (انطق الاسم بشكل طبيعي عربياً أو نطق مريح — لا تكتبه حرفياً)\n"
    )

    async with session_lock:
        if author.id not in user_sessions:
            user_sessions[author.id] = {"session_id": None, "parent_message_id": None}
        us = user_sessions[author.id]

    bot_name = client.user.display_name or client.user.name

    # ── نظام الإيموجي: استبدال 👀 بـ ⏳ (يكتب) ──
    try:
        await m.remove_reaction("👀", client.user)
        await m.add_reaction("⏳")
    except Exception:
        pass

    async with m.channel.typing():
        try:
            reply, new_sid, new_pmid = await run_agent(
                guild             = m.guild,
                channel           = m.channel,
                user_msg          = final,
                user_info         = user_info,
                bot_name          = bot_name,
                session_id        = us["session_id"],
                parent_message_id = us["parent_message_id"],
            )

            async with session_lock:
                us["session_id"]        = new_sid
                us["parent_message_id"] = new_pmid

            # حفظ في DB
            if new_sid:
                label = f"محادثة {datetime.now().strftime('%d/%m %H:%M')}"
                await db_save_session(author.id, label, new_sid, new_pmid)

            reply = reply or "✅ تم."

            # إرسال مع تقسيم
            chunks = [reply[i:i+1990] for i in range(0, len(reply), 1990)]
            for chunk in chunks:
                await m.reply(chunk)

            # ── نظام الإيموجي: استبدال ⏳ بـ ☑️ (تم) ──
            try:
                await m.remove_reaction("⏳", client.user)
                await m.add_reaction("☑️")
            except Exception:
                pass

        except Exception as e:
            print(f"[on_message] {e}")
            await m.reply(f"⚠️ خطأ غير متوقع: {str(e)[:300]}")
            try:
                await m.remove_reaction("⏳", client.user)
                await m.add_reaction("❌")
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════
#  Entry Point
# ══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    missing = [v for v in ("USER_TOKEN", "DEEPSEEK_TOKEN") if not os.getenv(v)]
    if missing:
        raise EnvironmentError(f"❌ متغيرات مفقودة: {', '.join(missing)}")
    client.run(USER_TOKEN)