"""
Disor Bot — v6.0 "Omniscient"
═══════════════════════════════════════════════════════════════
الجديد في هذا الإصدار:
  1. رؤية شاملة لكل السيرفرات: list_all_guilds + عمل العمليات على أي سيرفر
  2. استنساخ سيرفر كامل: clone_server (كاتيكوريات + رومات + رتب)
  3. إرسال رسائل لأي قناة في أي سيرفر: send_message
  4. منشن @everyone حقيقي عبر execute (يحاول فعلياً، ما يخمن الفشل)
  5. فصل التفكير عن الموديل: extended_thinking مستقل عن وضع المحادثة
     + حذف كتلة <think> كاملة من الرد قبل إرساله للمستخدم
  6. /محادثة-جديدة فيها خيارين منفصلين: نوع الموديل + تفعيل التفكير
  7. كل ميزات v5 محفوظة
═══════════════════════════════════════════════════════════════
"""

import asyncio
import json
import os
import random
import re
import time
import tempfile
import urllib.parse
from datetime import datetime, timedelta, timezone

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

# القناة الافتراضية (إذا لم تُضف قنوات في DB، يستخدم هذي)
DEFAULT_CHANNEL_ID = int(os.getenv("ALLOWED_CHANNEL_ID", "0"))

CONTROL_ROLE_NAME  = os.getenv("CONTROL_ROLE", "")

# ══════════════════════════════════════════════════════════════
#  POW Providers
# ══════════════════════════════════════════════════════════════
RAILWAY_URL           = os.getenv("RAILWAY_URL", "https://web-production-c09dc.up.railway.app")
POW_PROXY_TELEGRAM    = os.getenv("POW_PROXY_TELEGRAM", "http://107.172.78.104:8800")
DEFAULT_POW_PROVIDER  = os.getenv("DEFAULT_POW_PROVIDER", "railway")

# ══════════════════════════════════════════════════════════════
#  Attachment Handling
# ══════════════════════════════════════════════════════════════
MAX_ATTACHMENT_BYTES = 1_000_000
TEXT_EXTENSIONS = {
    '.py', '.js', '.ts', '.html', '.css', '.json', '.txt', '.md',
    '.sql', '.java', '.c', '.cpp', '.rb', '.go', '.rs', '.swift',
    '.kt', '.php', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.sh',
    '.bat', '.ps1', '.log', '.csv', '.tsv', '.r', '.lua', '.pl',
    '.scala', '.dart', '.jsx', '.tsx', '.tf', '.bicep', '.cmake',
    '.graphql', '.gql', '.proto', '.prisma', '.razor', '.blade',
    '.twig', '.liquid', '.haml', '.pug', '.mustache', '.handlebars',
    '.ejs', '.njk', '.styl', '.less', '.scss', '.sass', '.coffee',
    '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc',
    '.babelrc', '.npmrc', '.yarnrc', '.bazel', '.toml', '.lock',
    '.env', '.gitignore', '.dockerfile', '.makefile', '.ipynb',
    '.vue', '.svelte', '.astro', '.elm', '.ex', '.exs', '.erl',
    '.clj', '.fs', '.fsx', '.hrl', '.rpy', '.gd',
}
TEXT_CONTENT_TYPES = {'text/', 'application/json', 'application/xml', 'application/javascript'}


def is_text_attachment(attachment: discord.Attachment) -> bool:
    if attachment.content_type:
        for prefix in TEXT_CONTENT_TYPES:
            if attachment.content_type.startswith(prefix):
                return True
    _, ext = os.path.splitext(attachment.filename.lower())
    return ext in TEXT_EXTENSIONS


# ══════════════════════════════════════════════════════════════
#  MongoDB
# ══════════════════════════════════════════════════════════════
mongo_client  = AsyncIOMotorClient(MONGODB_URI)
db            = mongo_client["disor_db"]
sessions_col  = db["chat_sessions"]
settings_col  = db["settings"]
channels_col  = db["allowed_channels"]   # قنوات مسموحة لكل سيرفر

# ══════════════════════════════════════════════════════════════
#  Discord Client
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
#  RAM Cache
#  user_sessions: { (guild_id, user_id): {session_id, parent_message_id, mode} }
# ══════════════════════════════════════════════════════════════
user_sessions: dict[tuple[int, int], dict] = {}
session_lock  = asyncio.Lock()

# Cache للقنوات المسموحة { guild_id: set[channel_id] }
allowed_channels_cache: dict[int, set[int]] = {}

# ══════════════════════════════════════════════════════════════
#  Allowed Channels DB helpers
# ══════════════════════════════════════════════════════════════

async def get_allowed_channels(guild_id: int) -> set[int]:
    """يجيب القنوات المسموحة من الكاش أو DB"""
    if guild_id in allowed_channels_cache:
        return allowed_channels_cache[guild_id]

    doc = await channels_col.find_one({"guild_id": guild_id})
    if doc and doc.get("channel_ids"):
        ids = set(doc["channel_ids"])
    elif DEFAULT_CHANNEL_ID:
        ids = {DEFAULT_CHANNEL_ID}
    else:
        ids = set()

    allowed_channels_cache[guild_id] = ids
    return ids


async def add_allowed_channel(guild_id: int, channel_id: int):
    ids = await get_allowed_channels(guild_id)
    ids.add(channel_id)
    allowed_channels_cache[guild_id] = ids
    await channels_col.update_one(
        {"guild_id": guild_id},
        {"$addToSet": {"channel_ids": channel_id}},
        upsert=True,
    )


async def remove_allowed_channel(guild_id: int, channel_id: int):
    ids = await get_allowed_channels(guild_id)
    ids.discard(channel_id)
    allowed_channels_cache[guild_id] = ids
    await channels_col.update_one(
        {"guild_id": guild_id},
        {"$pull": {"channel_ids": channel_id}},
    )


# ══════════════════════════════════════════════════════════════
#  Control Role helpers
# ══════════════════════════════════════════════════════════════

async def get_control_role(guild_id: int) -> str:
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
    if not role_name:
        return True
    if member.guild_permissions.administrator:
        return True
    return any(r.name.lower() == role_name.lower() for r in member.roles)


# ══════════════════════════════════════════════════════════════
#  POW Provider helpers
# ══════════════════════════════════════════════════════════════

async def get_pow_provider(guild_id: int) -> str:
    doc = await settings_col.find_one({"guild_id": guild_id})
    if doc and doc.get("pow_provider"):
        return doc["pow_provider"]
    return DEFAULT_POW_PROVIDER


async def set_pow_provider(guild_id: int, provider: str):
    if provider not in ("railway", "telegram"):
        raise ValueError("provider must be 'railway' or 'telegram'")
    await settings_col.update_one(
        {"guild_id": guild_id},
        {"$set": {"pow_provider": provider}},
        upsert=True,
    )


# ══════════════════════════════════════════════════════════════
#  DB Sessions
# ══════════════════════════════════════════════════════════════

async def db_save_session(
    user_id: int,
    guild_id: int,
    session_id: str,
    parent_message_id: str | None,
    mode: str = "default",
    label: str | None = None,
    thinking: bool = False,
):
    """
    يحفظ/يحدّث محادثة واحدة. المفتاح الحقيقي هو session_id —
    بهذي الطريقة كل رسالة جديدة تُحدّث نفس السجل بدل إنشاء سجل جديد.
    label يُحدد مرة وحدة عند إنشاء المحادثة فقط (أول رسالة).
    """
    update_fields = {
        "parent_message_id": parent_message_id,
        "mode"             : mode,
        "thinking"         : bool(thinking),
        "updated_at"       : datetime.utcnow(),
    }
    set_on_insert = {
        "user_id"   : user_id,
        "guild_id"  : guild_id,
        "session_id": session_id,
        "label"     : label or f"محادثة {datetime.now().strftime('%d/%m %H:%M')}",
        "created_at": datetime.utcnow(),
    }
    await sessions_col.update_one(
        {"user_id": user_id, "guild_id": guild_id, "session_id": session_id},
        {"$set": update_fields, "$setOnInsert": set_on_insert},
        upsert=True,
    )


async def db_get_sessions(user_id: int, guild_id: int) -> list[dict]:
    cursor = (
        sessions_col
        .find({"user_id": user_id, "guild_id": guild_id})
        .sort("updated_at", -1)
        .limit(10)
    )
    return await cursor.to_list(length=10)


async def db_delete_session(user_id: int, guild_id: int, label: str):
    await sessions_col.delete_one({"user_id": user_id, "guild_id": guild_id, "label": label})


async def load_latest_session(user_id: int, guild_id: int) -> dict | None:
    doc = await sessions_col.find_one(
        {"user_id": user_id, "guild_id": guild_id},
        sort=[("updated_at", -1)],
    )
    if doc and doc.get("session_id"):
        return {
            "session_id"       : doc["session_id"],
            "parent_message_id": doc.get("parent_message_id"),
            "mode"             : doc.get("mode", "default"),
            "thinking"         : doc.get("thinking", False),
            "label"            : doc.get("label"),
        }
    return None


# ══════════════════════════════════════════════════════════════
#  Bot Self-Awareness helpers
# ══════════════════════════════════════════════════════════════

async def build_bot_context(guild: discord.Guild, current_channel: discord.abc.GuildChannel | None = None) -> str:
    """يبني سياقاً شاملاً عن البوت نفسه لتزويد الـ AI"""
    bot_member = guild.get_member(client.user.id)

    # ── معلومات أساسية ──
    bot_user  = client.user
    bot_name  = bot_user.display_name or bot_user.name
    bot_id    = bot_user.id
    bot_disc  = getattr(bot_user, 'discriminator', '0')
    bot_tag   = f"{bot_user.name}#{bot_disc}" if bot_disc != '0' else f"@{bot_user.name}"
    created   = bot_user.created_at.strftime("%Y-%m-%d")
    guild_cnt = len(client.guilds)

    # ── بايو / وصف ──
    bio = "غير متوفر"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"https://discord.com/api/v10/users/{bot_id}",
                headers={"Authorization": f"Bot {USER_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as r:
                if r.status == 200:
                    data = await r.json()
                    bio = data.get("bio") or "غير متوفر"
    except Exception:
        pass

    # ── رتب البوت في السيرفر الحالي ──
    bot_roles: list[str] = []
    bot_perms_list: list[str] = []
    highest_role = "@everyone"
    is_admin     = False

    if bot_member:
        bot_roles = [r.name for r in bot_member.roles if r.name != "@everyone"]
        highest_role = bot_member.top_role.name
        perms = bot_member.guild_permissions
        is_admin = perms.administrator
        if is_admin:
            bot_perms_list = ["administrator (كل الصلاحيات)"]
        else:
            bot_perms_list = [p for p, v in perms if v]

    # ── القنوات المسموحة ──
    allowed_ids = await get_allowed_channels(guild.id)
    allowed_names = []
    for cid in allowed_ids:
        ch = guild.get_channel(cid)
        allowed_names.append(f"#{ch.name}" if ch else f"ID:{cid}")

    # ── موقع البوت في السيرفر الحالي ──
    guild_name   = guild.name
    guild_id_str = str(guild.id)
    member_count = guild.member_count
    owner        = guild.owner
    owner_name   = owner.display_name if owner else "غير معروف"

    # ── كل السيرفرات الأخرى التي البوت فيها (وعي شامل) ──
    other_guilds_lines = []
    for g in client.guilds:
        if g.id == guild.id:
            continue
        other_guilds_lines.append(f"  - {g.name} (ID: {g.id}, أعضاء: {g.member_count})")

    # ── القناة الحالية بالضبط ──
    channel_block = []
    if current_channel is not None:
        ch_name = getattr(current_channel, "name", "غير معروف")
        ch_id   = current_channel.id
        ch_type = "نصية" if isinstance(current_channel, discord.TextChannel) else "صوتية"
        channel_block = [
            "",
            "  [القناة التي يتحدث فيها المستخدم معك الآن]",
            f"  الاسم : #{ch_name}",
            f"  النوع : {ch_type}",
            f"  الـ ID: {ch_id}",
        ]

    # ── بناء النص ──
    lines = [
        "══════════════════════════════════",
        "  [معلومات البوت — السياق الكامل]",
        "══════════════════════════════════",
        f"  الاسم             : {bot_name}",
        f"  التاق             : {bot_tag}",
        f"  الـ ID            : {bot_id}",
        f"  تاريخ الإنشاء    : {created}",
        f"  البايو            : {bio}",
        f"  عدد السيرفرات    : {guild_cnt} سيرفر",
        "",
        "  [السيرفر الحالي]",
        f"  الاسم             : {guild_name}",
        f"  الـ ID            : {guild_id_str}",
        f"  عدد الأعضاء      : {member_count}",
        f"  الأونر            : {owner_name}",
        *channel_block,
        "",
        "  [رتب البوت في هذا السيرفر]",
        f"  الرتب             : {', '.join(bot_roles) if bot_roles else 'لا رتب'}",
        f"  أعلى رتبة        : {highest_role}",
        f"  أدمن؟             : {'نعم ✅' if is_admin else 'لا ❌'}",
        "",
        "  [صلاحياته في هذا السيرفر]",
        f"  {', '.join(bot_perms_list) if bot_perms_list else 'لا صلاحيات'}",
        "",
        "  [القنوات التي يستمع فيها البوت في هذا السيرفر]",
        f"  {', '.join(allowed_names) if allowed_names else 'لم تُحدد قنوات'}",
        "",
        "  [سيرفرات أخرى البوت موجود فيها — يقدر يعمل عليها بأداة execute مع target_guild]",
        *(other_guilds_lines if other_guilds_lines else ["  لا يوجد سيرفرات أخرى"]),
        "══════════════════════════════════",
    ]
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════
#  DeepSeek API
# ══════════════════════════════════════════════════════════════

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


async def _get_pow(guild_id: int) -> dict:
    token    = DEEPSEEK_TOKEN
    provider = await get_pow_provider(guild_id)

    if provider == "telegram":
        encoded_token = urllib.parse.quote(token, safe='')
        url = f"{POW_PROXY_TELEGRAM}/get_pow?authorization={encoded_token}"
        async with aiohttp.ClientSession() as s:
            try:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=15)) as r:
                    if r.status == 200:
                        data = await r.json()
                        pr = data.get("x_ds_pow_response") or data.get("pow_response")
                        if pr:
                            return {"pow_response": pr, "pow_data": data.get("solved_json")}
            except Exception:
                pass
        raise RuntimeError("POW fetch failed (telegram proxy)")

    pow_url = f"{RAILWAY_URL}/pow"
    async with aiohttp.ClientSession() as s:
        for url in [f"{pow_url}?authorization={token}", pow_url]:
            try:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=15)) as r:
                    if r.status == 200:
                        data = await r.json()
                        pr = data.get("x_ds_pow_response") or data.get("pow_response")
                        if pr:
                            return {"pow_response": pr, "pow_data": data.get("solved_json")}
            except Exception:
                continue
    raise RuntimeError("POW fetch failed (railway)")


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
    # حذف كتلة التفكير بالكامل — لا نريدها تظهر مختلطة مع الرد
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<thinking>[\s\S]*?</thinking>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```(?:json)?\s*([\s\S]*?)```", r"\1", text)
    return text.strip()


async def _stream_ds(
    prompt: str,
    guild_id: int,
    session_id: str | None = None,
    parent_message_id: str | None = None,
    mode: str = "default",
    thinking: bool = False,
) -> tuple[str, str, str | None]:
    token = DEEPSEEK_TOKEN
    if not token:
        raise RuntimeError("DEEPSEEK_TOKEN not set")
    if not session_id:
        session_id = await _new_ds_session()

    pow_d = await _get_pow(guild_id)
    hdrs  = _build_headers(pow_d["pow_response"], token)

    # model_type: "default" أو "expert" — القيم المقبولة من API: DEFAULT/default/expert/vision
    # thinking_enabled مستقل تماماً عن model_type — يتحكم بالتفكير العميق فقط
    model_type = "expert" if mode == "expert" else "default"

    payload = {
        "chat_session_id"  : session_id,
        "parent_message_id": parent_message_id,
        "prompt"           : prompt,
        "ref_file_ids"     : [],
        "thinking_enabled" : bool(thinking),
        "search_enabled"   : False,
        "model_type"       : model_type,
        "action"           : None,
        "preempt"          : False,
        "stream"           : True,
    }
    if pow_d.get("pow_data") is not None:
        payload["pow"] = pow_d["pow_data"]

    full_text     = ""
    thinking_text = ""
    new_pmid      = None

    async with aiohttp.ClientSession() as s:
        async with s.post(
            "https://chat.deepseek.com/api/v0/chat/completion",
            headers=hdrs,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                raise RuntimeError(f"DS {resp.status}: {error_text}")
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
                        if isinstance(v, dict):
                            for frag in v.get("response", {}).get("fragments", []):
                                ftype = (frag.get("type") or "").upper()
                                if ftype == "RESPONSE":
                                    full_text += frag.get("content", "")
                                elif ftype in ("THINKING", "THOUGHT", "REASONING"):
                                    thinking_text += frag.get("content", "")
                                # أي نوع آخر غير معروف يُتجاهل عمداً (احتياط أمان لمنع تسرب التفكير)
                        elif isinstance(v, str):
                            # بعض الإصدارات ترسل النص كسلسلة مباشرة بدون تصنيف fragments —
                            # في وضع التفكير المفعّل، هذا الفرع قد يحوي التفكير أيضاً، لذا نمرره
                            # عبر _strip لاحقاً لإزالة أي وسوم <think> محتملة كحماية إضافية.
                            full_text += v
                    except Exception:
                        pass

    return _strip(full_text), session_id, new_pmid


# ══════════════════════════════════════════════════════════════
#  Guild Lookup helpers
# ══════════════════════════════════════════════════════════════

def _find_channel(guild: discord.Guild, q: str) -> discord.abc.GuildChannel | None:
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
    try:
        mid = int(str(q).strip())
        m   = guild.get_member(mid)
        if m:
            return m
    except (ValueError, TypeError):
        pass

    ql = str(q).lower().strip()
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


def _find_guild(q: str) -> discord.Guild | None:
    """يبحث عن سيرفر من بين كل السيرفرات التي البوت فيها — بالـ ID أو الاسم"""
    try:
        gid = int(str(q).strip())
        g   = client.get_guild(gid)
        if g:
            return g
    except (ValueError, TypeError):
        pass

    ql = str(q).lower().strip()
    for g in client.guilds:
        if g.name.lower() == ql:
            return g
    for g in client.guilds:
        if ql in g.name.lower():
            return g
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


def tool_list_all_guilds() -> dict:
    """يجيب قائمة كل السيرفرات التي البوت موجود فيها حالياً — وعي شامل خارج السيرفر الحالي"""
    rows = []
    for g in client.guilds:
        bot_member = g.get_member(client.user.id)
        is_admin   = bool(bot_member and bot_member.guild_permissions.administrator)
        rows.append({
            "id"          : g.id,
            "name"        : g.name,
            "member_count": g.member_count,
            "owner_id"    : g.owner_id,
            "bot_is_admin": is_admin,
            "channels"    : len([c for c in g.channels if not isinstance(c, discord.CategoryChannel)]),
            "roles"       : len(g.roles),
        })
    return {"guilds": rows, "total": len(rows)}


async def tool_get_messages(
    channel: discord.TextChannel,
    limit: int = 100,
    member_id: int | None = None,
) -> dict:
    msgs = []
    async for msg in channel.history(limit=min(limit, 500)):
        if member_id and msg.author.id != member_id:
            continue
        msgs.append({
            "id"      : msg.id,
            "author"  : msg.author.display_name,
            "author_id": msg.author.id,
            "content" : msg.content[:500],
            "time"    : msg.created_at.strftime("%Y-%m-%d %H:%M"),
        })
    return {"messages": msgs, "count": len(msgs)}



async def tool_get_audit_log(guild: discord.Guild, limit: int = 20, action: str | None = None) -> dict:
    """يعرض آخر سجلات التدقيق لمساعدة الإدارة على معرفة من نفّذ ماذا ومتى."""
    action_obj = None
    if action:
        action_key = action.lower().strip()
        action_obj = getattr(discord.AuditLogAction, action_key, None)

    entries = []
    try:
        async for entry in guild.audit_logs(limit=min(int(limit), 100), action=action_obj):
            entries.append({
                "id": entry.id,
                "action": str(entry.action).replace("AuditLogAction.", ""),
                "user": entry.user.display_name if entry.user else None,
                "user_id": entry.user.id if entry.user else None,
                "target": str(entry.target) if entry.target else None,
                "reason": entry.reason,
                "created_at": entry.created_at.strftime("%Y-%m-%d %H:%M"),
            })
    except discord.Forbidden:
        return {"error": "⛔ البوت لا يملك صلاحية 'عرض سجل التدقيق' في هذا السيرفر. تأكد من إعطائه الصلاحية."}
    except Exception as e:
        return {"error": f"❌ فشل جلب سجل التدقيق: {str(e)}"}

    return {"audit_log": entries, "count": len(entries)}

async def tool_get_invites(guild: discord.Guild) -> dict:
    """يعرض دعوات السيرفر النشطة مع الاستخدامات والانتهاء."""
    invites = await guild.invites()
    return {
        "invites": [
            {
                "code": invite.code,
                "url": invite.url,
                "channel": invite.channel.name if invite.channel else None,
                "inviter": invite.inviter.display_name if invite.inviter else None,
                "uses": invite.uses,
                "max_uses": invite.max_uses,
                "expires_at": invite.expires_at.strftime("%Y-%m-%d %H:%M") if invite.expires_at else None,
            }
            for invite in invites[:100]
        ],
        "count": len(invites),
    }


def tool_get_emojis(guild: discord.Guild) -> dict:
    """يعرض إيموجيات السيرفر المخصصة وحالتها."""
    return {
        "emojis": [
            {
                "id": emoji.id,
                "name": emoji.name,
                "animated": emoji.animated,
                "available": emoji.available,
                "url": str(emoji.url),
            }
            for emoji in guild.emojis
        ],
        "count": len(guild.emojis),
    }


def tool_get_stickers(guild: discord.Guild) -> dict:
    """يعرض ملصقات السيرفر المخصصة."""
    return {
        "stickers": [
            {
                "id": sticker.id,
                "name": sticker.name,
                "description": sticker.description,
                "emoji": sticker.emoji,
                "url": sticker.url,
            }
            for sticker in guild.stickers
        ],
        "count": len(guild.stickers),
    }


async def tool_get_bans(guild: discord.Guild, limit: int = 100) -> dict:
    """يعرض الأعضاء المحظورين وأسباب الحظر."""
    bans = []
    async for ban in guild.bans(limit=min(int(limit), 1000)):
        bans.append({
            "user_id": ban.user.id,
            "username": ban.user.name,
            "display": ban.user.display_name,
            "reason": ban.reason,
        })
    return {"bans": bans, "count": len(bans)}


async def tool_get_pinned_messages(channel: discord.TextChannel) -> dict:
    """يعرض الرسائل المثبتة في قناة نصية."""
    pins = await channel.pins()
    return {
        "pinned_messages": [
            {
                "id": msg.id,
                "author": msg.author.display_name,
                "author_id": msg.author.id,
                "content": msg.content[:500],
                "created_at": msg.created_at.strftime("%Y-%m-%d %H:%M"),
                "jump_url": msg.jump_url,
            }
            for msg in pins[:50]
        ],
        "count": len(pins),
    }


def tool_get_voice_states(guild: discord.Guild) -> dict:
    """يعرض الموجودين حالياً في القنوات الصوتية وحالاتهم."""
    rows = []
    for channel in guild.voice_channels:
        for member in channel.members:
            voice = member.voice
            rows.append({
                "member_id": member.id,
                "display": member.display_name,
                "channel_id": channel.id,
                "channel": channel.name,
                "muted": bool(voice and (voice.mute or voice.self_mute)),
                "deafened": bool(voice and (voice.deaf or voice.self_deaf)),
                "streaming": bool(voice and voice.self_stream),
            })
    return {"voice_states": rows, "count": len(rows)}


async def tool_search_messages(channel: discord.TextChannel, query: str, limit: int = 200) -> dict:
    """يبحث نصياً داخل آخر رسائل قناة محددة."""
    ql = str(query).lower().strip()
    matches = []
    async for msg in channel.history(limit=min(int(limit), 1000)):
        if ql and ql in msg.content.lower():
            matches.append({
                "id": msg.id,
                "author": msg.author.display_name,
                "author_id": msg.author.id,
                "content": msg.content[:500],
                "time": msg.created_at.strftime("%Y-%m-%d %H:%M"),
                "jump_url": msg.jump_url,
            })
        if len(matches) >= 50:
            break
    return {"matches": matches, "count": len(matches)}

async def tool_execute(
    guild: discord.Guild,
    channel: discord.TextChannel,
    action: str,
    params: dict,
) -> dict:
    """
    تنفذ عملية واحدة وترجع النتيجة.
    إذا تضمنت params مفتاح "target_guild"، يتم تنفيذ العملية على ذلك السيرفر بدلاً من
    السيرفر الحالي — هذا يسمح للبوت بالعمل على أي سيرفر هو عضو فيه، ليس فقط الحالي.
    """
    try:
        # ── دعم العمل على سيرفر آخر غير السيرفر الحالي ──
        if params.get("target_guild"):
            found_guild = _find_guild(str(params["target_guild"]))
            if not found_guild:
                return {"ok": False, "msg": f"❌ ما لقيت سيرفر: **{params['target_guild']}**"}
            guild = found_guild
            # القناة الحالية لا تنتمي بالضرورة للسيرفر الهدف، فنفرغها إلا إذا حُددت صراحة
            if not params.get("channel"):
                channel = None

        a = action.lower().strip()

        if a == "create_category":
            cat = await guild.create_category(name=params["name"])
            return {"ok": True, "msg": f"✅ تم إنشاء الكاتيكوري **{cat.name}** في **{guild.name}**"}

        elif a == "create_channel":
            cat_obj = None
            if params.get("category"):
                cat_obj = _find_category(guild, str(params["category"]))
            if params.get("type", "text").lower() == "voice":
                ch = await guild.create_voice_channel(name=params["name"], category=cat_obj)
            else:
                ch = await guild.create_text_channel(name=params["name"], category=cat_obj)
            loc = f" تحت **{cat_obj.name}**" if cat_obj else ""
            return {"ok": True, "msg": f"✅ تم إنشاء الروم **{ch.name}**{loc} في **{guild.name}**"}

        elif a == "delete_channel":
            ch = _find_channel(guild, str(params["name"]))
            if not ch:
                return {"ok": False, "msg": f"❌ ما لقيت روم: **{params['name']}**"}
            name = ch.name
            await ch.delete()
            return {"ok": True, "msg": f"✅ تم حذف الروم **{name}**"}

        elif a == "rename_channel":
            ch = _find_channel(guild, str(params["channel"]))
            if not ch:
                return {"ok": False, "msg": f"❌ ما لقيت روم: **{params['channel']}**"}
            old = ch.name
            await ch.edit(name=params["new_name"])
            return {"ok": True, "msg": f"✅ تم تغيير اسم **{old}** → **{params['new_name']}**"}

        elif a == "clear_channel":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None:
                return {"ok": False, "msg": "❌ حدد القناة (channel) صراحة عند العمل على سيرفر آخر."}
            limit = int(params.get("limit", 100))
            before_msg = None
            if params.get("before"):
                try:
                    before_id = int(params["before"])
                    before_msg = await target_ch.fetch_message(before_id)
                except:
                    pass
            check = None
            if before_msg:
                check = lambda m: m.id < before_msg.id  # أقدم من الرسالة المرجعية
            deleted = await target_ch.purge(limit=min(limit, 500), check=check)
            return {"ok": True, "msg": f"✅ تم حذف **{len(deleted)}** رسالة من **{target_ch.name}**"}

        elif a == "delete_member_messages":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None:
                return {"ok": False, "msg": "❌ حدد القناة (channel) صراحة عند العمل على سيرفر آخر."}
            limit = int(params.get("limit", 100))
            before_msg = None
            if params.get("before"):
                try:
                    before_id = int(params["before"])
                    before_msg = await target_ch.fetch_message(before_id)
                except:
                    pass
            def check(m):
                ok = m.author.id == member.id
                if before_msg:
                    ok = ok and m.id < before_msg.id
                return ok
            deleted = await target_ch.purge(limit=min(limit, 500), check=check)
            return {"ok": True, "msg": f"✅ تم حذف **{len(deleted)}** رسالة للعضو **{member.display_name}**"}
            
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
            return {"ok": True, "msg": f"✅ تم إنشاء الرتبة **{role.name}** في **{guild.name}**"}

        elif a == "delete_role":
            role = _find_role(guild, str(params["name"]))
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت رتبة: **{params['name']}**"}
            name = role.name
            await role.delete()
            return {"ok": True, "msg": f"✅ تم حذف الرتبة **{name}**"}

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

        elif a == "grant_role":
            member = _find_member(guild, str(params["member"]))
            role   = _find_role(guild, str(params["role"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت الرتبة: **{params['role']}**"}
            await member.add_roles(role)
            return {"ok": True, "msg": f"✅ أعطيت **{member.display_name}** رتبة **{role.name}**"}

        elif a == "revoke_role":
            member = _find_member(guild, str(params["member"]))
            role   = _find_role(guild, str(params["role"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            if not role:
                return {"ok": False, "msg": f"❌ ما لقيت الرتبة: **{params['role']}**"}
            await member.remove_roles(role)
            return {"ok": True, "msg": f"✅ سحبت رتبة **{role.name}** من **{member.display_name}**"}

        elif a == "kick_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            name = member.display_name
            await member.kick(reason=params.get("reason", "—"))
            return {"ok": True, "msg": f"✅ تم كيك **{name}**"}

        elif a == "ban_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            name = member.display_name
            await member.ban(reason=params.get("reason", "—"), delete_message_days=0)
            return {"ok": True, "msg": f"✅ تم بان **{name}**"}

        elif a == "change_nickname":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            old = member.display_name
            await member.edit(nick=params["nickname"])
            return {"ok": True, "msg": f"✅ تم تغيير نكنيم **{old}** → **{params['nickname']}**"}

        elif a == "slowmode":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None:
                return {"ok": False, "msg": "❌ حدد القناة (channel) صراحة عند العمل على سيرفر آخر."}
            seconds = int(params.get("seconds", 0))
            await target_ch.edit(slowmode_delay=seconds)
            if seconds == 0:
                return {"ok": True, "msg": f"✅ تم إيقاف السلو مود في **{target_ch.name}**"}
            return {"ok": True, "msg": f"✅ تم تفعيل سلو مود **{seconds}** ثانية في **{target_ch.name}**"}

        elif a == "move_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            vc = _find_channel(guild, str(params["channel"]))
            if not vc or not isinstance(vc, discord.VoiceChannel):
                return {"ok": False, "msg": f"❌ ما لقيت فويس: **{params['channel']}**"}
            await member.move_to(vc)
            return {"ok": True, "msg": f"✅ تم نقل **{member.display_name}** إلى **{vc.name}**"}

        # ── إرسال رسالة لأي قناة، في السيرفر الحالي أو أي سيرفر آخر ──
        elif a == "send_message":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة (channel) لإرسال الرسالة."}
            content = str(params.get("content", "")).strip()
            if not content:
                return {"ok": False, "msg": "❌ محتوى الرسالة فارغ."}
            sent = await target_ch.send(content[:2000])
            return {
                "ok": True,
                "msg": f"✅ تم إرسال الرسالة في **#{target_ch.name}** ({guild.name})",
                "message_id": sent.id,
            }

        # ── منشن @everyone حقيقي — يحاول فعلياً ولا يخمن الفشل ──
        elif a == "mention_everyone":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة (channel) للمنشن."}
            extra = str(params.get("content", "")).strip()
            text  = f"@everyone {extra}".strip() if extra else "@everyone"
            sent = await target_ch.send(
                text[:2000],
                allowed_mentions=discord.AllowedMentions(everyone=True),
            )
            return {
                "ok": True,
                "msg": f"✅ تم إرسال منشن @everyone في **#{target_ch.name}**",
                "message_id": sent.id,
            }

        elif a == "create_thread":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة لإنشاء الثريد."}
            thread = await target_ch.create_thread(
                name=params["name"],
                type=discord.ChannelType.public_thread,
                auto_archive_duration=int(params.get("auto_archive_duration", 1440)),
            )
            return {"ok": True, "msg": f"✅ تم إنشاء الثريد **{thread.name}** في **#{target_ch.name}**", "thread_id": thread.id}

        elif a == "lock_channel":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة لقفلها."}
            await target_ch.set_permissions(guild.default_role, send_messages=False)
            return {"ok": True, "msg": f"🔒 تم قفل الكتابة في **#{target_ch.name}**"}

        elif a == "unlock_channel":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة لفتحها."}
            await target_ch.set_permissions(guild.default_role, send_messages=None)
            return {"ok": True, "msg": f"🔓 تم فتح الكتابة في **#{target_ch.name}**"}

        elif a == "set_channel_topic":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة لتعديل الوصف."}
            topic = str(params.get("topic", ""))[:1024]
            await target_ch.edit(topic=topic)
            return {"ok": True, "msg": f"✅ تم تعديل وصف **#{target_ch.name}**"}

        elif a == "create_invite":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, (discord.TextChannel, discord.VoiceChannel)):
                    target_ch = found
            if target_ch is None:
                return {"ok": False, "msg": "❌ حدد قناة صحيحة لإنشاء الدعوة."}
            max_age = int(params.get("max_age", 86400))
            max_uses = int(params.get("max_uses", 0))
            invite = await target_ch.create_invite(max_age=max_age, max_uses=max_uses, unique=True, reason=params.get("reason", "Created by Disor Bot"))
            return {"ok": True, "msg": f"✅ تم إنشاء دعوة للقناة **{target_ch.name}**: {invite.url}", "url": invite.url}

        elif a == "timeout_member":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            minutes = max(1, min(int(params.get("minutes", 10)), 40320))
            until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
            await member.timeout(until, reason=params.get("reason", "—"))
            return {"ok": True, "msg": f"⏳ تم إعطاء تايم آوت لـ **{member.display_name}** لمدة **{minutes}** دقيقة"}

        elif a == "remove_timeout":
            member = _find_member(guild, str(params["member"]))
            if not member:
                return {"ok": False, "msg": f"❌ ما لقيت العضو: **{params['member']}**"}
            await member.timeout(None, reason=params.get("reason", "—"))
            return {"ok": True, "msg": f"✅ تم إزالة التايم آوت عن **{member.display_name}**"}

        elif a == "unban_member":
            user_id = int(params["user"])
            user = await client.fetch_user(user_id)
            await guild.unban(user, reason=params.get("reason", "—"))
            return {"ok": True, "msg": f"✅ تم فك الحظر عن **{user}**"}

        elif a == "pin_message":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة لتثبيت الرسالة."}
            msg = await target_ch.fetch_message(int(params["message_id"]))
            await msg.pin(reason=params.get("reason", "Pinned by Disor Bot"))
            return {"ok": True, "msg": f"📌 تم تثبيت الرسالة في **#{target_ch.name}**"}

        elif a == "unpin_message":
            target_ch = channel
            if params.get("channel"):
                found = _find_channel(guild, str(params["channel"]))
                if found and isinstance(found, discord.TextChannel):
                    target_ch = found
            if target_ch is None or not isinstance(target_ch, discord.TextChannel):
                return {"ok": False, "msg": "❌ حدد قناة نصية صحيحة لإلغاء التثبيت."}
            msg = await target_ch.fetch_message(int(params["message_id"]))
            await msg.unpin(reason=params.get("reason", "Unpinned by Disor Bot"))
            return {"ok": True, "msg": f"📌 تم إلغاء تثبيت الرسالة من **#{target_ch.name}**"}

        # ── استنساخ سيرفر كامل: كاتيكوريات + رومات + رتب ──
        elif a == "clone_server":
            source_guild = guild
            if params.get("source_guild"):
                found = _find_guild(str(params["source_guild"]))
                if not found:
                    return {"ok": False, "msg": f"❌ ما لقيت سيرفر مصدر: **{params['source_guild']}**"}
                source_guild = found
            target = guild
            if params.get("target_guild") and params["target_guild"] != params.get("source_guild"):
                found = _find_guild(str(params["target_guild"]))
                if not found:
                    return {"ok": False, "msg": f"❌ ما لقيت سيرفر هدف: **{params['target_guild']}**"}
                target = found

            if source_guild.id == target.id:
                return {"ok": False, "msg": "❌ السيرفر المصدر والهدف لا يمكن أن يكونا نفس السيرفر."}

            created_roles      = 0
            created_categories = 0
            created_channels   = 0
            errors: list[str]  = []

            # 1) نسخ الرتب أولاً (بدون @everyone) — من الأقل صلاحية للأعلى حتى يصير الترتيب منطقي
            role_map: dict[int, discord.Role] = {}
            source_roles = [r for r in source_guild.roles if r.name != "@everyone"]
            source_roles.sort(key=lambda r: r.position)
            for r in source_roles:
                try:
                    new_role = await target.create_role(
                        name=r.name,
                        colour=r.colour,
                        permissions=r.permissions,
                        hoist=r.hoist,
                        mentionable=r.mentionable,
                    )
                    role_map[r.id] = new_role
                    created_roles += 1
                except Exception as e:
                    errors.append(f"رتبة {r.name}: {e}")

            # 2) نسخ الكاتيكوريات
            cat_map: dict[int, discord.CategoryChannel] = {}
            for cat in sorted(source_guild.categories, key=lambda c: c.position):
                try:
                    new_cat = await target.create_category(name=cat.name)
                    cat_map[cat.id] = new_cat
                    created_categories += 1
                except Exception as e:
                    errors.append(f"كاتيكوري {cat.name}: {e}")

            # 3) نسخ الرومات (نصية وصوتية) داخل الكاتيكوريات المطابقة
            source_channels = [
                c for c in source_guild.channels
                if not isinstance(c, discord.CategoryChannel)
            ]
            for ch in sorted(source_channels, key=lambda c: c.position):
                try:
                    target_cat = cat_map.get(ch.category.id) if ch.category else None
                    if isinstance(ch, discord.TextChannel):
                        await target.create_text_channel(
                            name=ch.name,
                            category=target_cat,
                            topic=ch.topic,
                            nsfw=ch.nsfw,
                            slowmode_delay=ch.slowmode_delay,
                        )
                    elif isinstance(ch, discord.VoiceChannel):
                        await target.create_voice_channel(
                            name=ch.name,
                            category=target_cat,
                            bitrate=min(ch.bitrate, target.bitrate_limit),
                            user_limit=ch.user_limit,
                        )
                    else:
                        continue
                    created_channels += 1
                except Exception as e:
                    errors.append(f"روم {ch.name}: {e}")

            summary = (
                f"✅ تم استنساخ **{source_guild.name}** → **{target.name}**\n"
                f"الرتب: {created_roles} | الكاتيكوريات: {created_categories} | الرومات: {created_channels}"
            )
            if errors:
                summary += f"\n⚠️ بعض العناصر فشلت ({len(errors)}): " + "، ".join(errors[:5])
            return {"ok": len(errors) == 0 or created_channels > 0, "msg": summary, "errors": errors}

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

def build_system(bot_name: str, mode: str = "default", thinking: bool = False) -> str:
    mode_note = ""
    if thinking:
        mode_note = "\n(التفكير العميق مفعّل لهذي المحادثة — خذ وقتك في التحليل الداخلي قبل الإجابة. هذا التفكير يُحذف تلقائياً قبل وصول الرد للمستخدم، لذا لا تحاول أنت إخفاءه أو الإشارة له — فقط فكّر بحرية ثم أعطِ الرد النهائي بشكل طبيعي.)\n"

    return f"""بيئة التشغيل: أنت تعمل حالياً داخل تطبيق Discord، باسم "{bot_name}"، طورك <@656783724662226963>.
هذي مجرد بيئة تشغيل — شخصيتك وطريقة كلامك وذكاؤك هي نفسها أنت، لم تتغير. لا تتصرف بشكل مختلف أو مقتضب أو رسمي لمجرد أنك في Discord. تكلم بطبيعية وعمق وتفصيل وحس فكاهي إذا ناسب، تماماً متى كنت في أي واجهة أخرى. القيود الوحيدة المفروضة عليك هنا هي تقنية فقط (تنسيق Discord، الأدوات المتاحة لإدارة السيرفر) — وليست قيوداً على شخصيتك أو أسلوبك أو عمق إجاباتك.
{mode_note}
══════════════════════════════════════════════
معلوماتك عن نفسك (Self-awareness)
══════════════════════════════════════════════
تم تزويدك بسياق كامل عنك في قسم [معلومات البوت] أسفل هذا التعليمات: اسمك، الديسكورد تاغ، الـ ID، تاريخ الإنشاء، بايوك، عدد السيرفرات اللي أنت فيها، السيرفر الحالي، رتبك فيه، وصلاحياتك بالضبط. إذا سُئلت عن أي من هذي المعلومات، أجب مباشرة من هذا السياق وبثقة تامة. لا تقل أبداً "لا أعرف" أو "ليس لدي هذه المعلومة" إذا كانت موجودة هناك.
وتكلم بفصحى دائما الا اذا طلب منك المستخدم تغيير لهجتك.

══════════════════════════════════════════════
تنسيق Discord — القيد التقني الوحيد على الشكل
══════════════════════════════════════════════
**نص** بولد | *نص* مائل | __نص__ تحته خط | ~~نص~~ يتوسط | `كود` كود مضمّن
```لغة\\nكود\\n``` كود بلوك | > اقتباس | # / ## / ### عناوين | - عنصر قائمة | ||نص|| سبويلر
منشن عضو: <@ID> | منشن الكل: @everyone | منشن رتبة: <@&ROLE_ID> | روم: <#CHANNEL_ID>
❌ ممنوع جداول HTML أو Markdown، وممنوع أي وسم HTML مثل <br>

══════════════════════════════════════════════
المنشن — قدرة كاملة، ليست أداة، ولا تحتاج إذناً
══════════════════════════════════════════════
المنشن مجرد نص تكتبه مباشرة في ردك، تماماً مثل أي كلمة أخرى. ليس أداة منفصلة وليس شيئاً "غير مسموح" أو "لم تُدرّب عليه".
- لمنشن عضو أو @everyone في **رد عادي بنفس القناة الحالية التي تتحدث فيها الآن**: فقط اكتبه كنص مباشر <@ID> أو @everyone. إذا ما عندك ID العضو، استخدمه من قسم [أعضاء تم منشنتهم] إن وُجد، أو ابحث بـ get_members ثم اكتب <@ID> الناتج.
- لمنشن عضو أو @everyone أو إرسال أي رسالة في **قناة مختلفة عن الحالية** (بنفس السيرفر أو بسيرفر آخر بالكامل): استخدم أداة execute مع action "send_message" أو "mention_everyone" — ردك النصي العادي يصل فقط للقناة الحالية ولا ينتقل تلقائياً لقناة أخرى.
- **ممنوع تماماً افتراض الفشل**: لا تقل أبداً "@everyone غير مسموح هنا" أو "الصلاحية ناقصة" أو "القناة لا تدعم ذلك" كتخمين مسبق. جرّب الأمر فعلياً عبر execute أولاً، واعتمد فقط على رسالة الخطأ الحقيقية الراجعة من Discord إن فشلت العملية فعلاً. إذا نجحت، أخبر بنجاحها مباشرة دون أعذار بديلة.
واي شيء اخر غير مذكور في الادوات لكن لديك القدرة على تنفيذه فقم بتنفيذه لاتقتصر على الادوات والمعلومات الموجودة هنا فقط!

══════════════════════════════════════════════
الأدوات المتاحة — استخدمها فقط لإدارة السيرفر الفعلية
══════════════════════════════════════════════
get_channels / get_categories / get_roles / get_members / get_messages / server_info / list_all_guilds
get_audit_log / get_invites / get_emojis / get_stickers / get_bans / get_pinned_messages / get_voice_states / search_messages / execute / file

أدوات القراءة (get_channels, get_categories, get_roles, get_members, server_info, get_messages) تقبل
"target_guild" اختياري داخل params (اسم أو ID سيرفر) لقراءة بيانات أي سيرفر آخر أنت عضو فيه، وليس فقط الحالي.
search_messages و get_pinned_messages تقبل "channel" اختياري لتحديد قناة نصية. get_audit_log يقبل "limit" و "action" اختياريين.
استخدم list_all_guilds لمعرفة كل السيرفرات المتاحة لك مع أسمائها وIDs.

عمليات execute:
create_category | create_channel | delete_channel | rename_channel
clear_channel | delete_member_messages | create_role | delete_role
edit_role | grant_role | revoke_role | kick_member | ban_member
change_nickname | slowmode | move_member | send_message | mention_everyone | create_thread
lock_channel | unlock_channel | set_channel_topic | create_invite | timeout_member | remove_timeout
unban_member | pin_message | unpin_message | clone_server

كل عمليات execute (ما عدا clone_server) تقبل "target_guild" اختياري داخل params لتنفيذ العملية على
سيرفر آخر غير الحالي، وتقبل "channel" اختياري لتحديد قناة غير القناة الحالية.

أمثلة:
```json
{{"tool": "execute", "action": "kick_member", "params": {{"member": "ID_أو_اسم", "reason": "..."}}}}
```
```json
{{"tool": "execute", "action": "send_message", "params": {{"channel": "اسم-القناة", "content": "نص الرسالة"}}}}
```
```json
{{"tool": "execute", "action": "mention_everyone", "params": {{"channel": "إعلانات", "content": "تجمع مهم الآن!"}}}}
```
```json
{{"tool": "execute", "action": "clone_server", "params": {{"source_guild": "اسم/ID (اختياري، افتراضياً السيرفر الحالي)", "target_guild": "اسم/ID السيرفر الهدف"}}}}
```
clone_server ينسخ كل الرتب، الكاتيكوريات، والرومات (نصية وصوتية) من سيرفر مصدر إلى سيرفر هدف — مفيد لنسخ احتياطي
أو تجهيز سيرفر جديد بنفس البنية. يحتاج البوت صلاحية إدارية في كلا السيرفرين.

══════════════════════════════════════════════
أنت Agent مستقل — أكمل المهمة كاملة من نفسك دون انتظار
══════════════════════════════════════════════
عندك القدرة على استدعاء أكثر من أداة في تسلسل واحد متواصل قبل أن ترد على المستخدم. لا تتوقف بعد أداة واحدة لتسأل المستخدم "أي أمر؟" أو "ماذا افعل بعد؟" — أنت من يقرر الخطوة التالية بناءً على نتيجة الأداة السابقة.

مثال: إذا طلب المستخدم "غيّر اسم فلان إلى كذا" ولم تكن متأكداً من الـ ID:
  الخطوة 1: استدعِ get_members مع query باسم الشخص.
  الخطوة 2: من النتيجة، خذ حقل "id" للعضو المطابق (وليس الاسم النصي).
  الخطوة 3: مباشرة وفي نفس التسلسل، استدعِ execute مع change_nickname باستخدام ذلك الـ id رقمياً.
  لا تتوقف بين الخطوة 2 والخطوة 3 لتسأل المستخدم أي شيء — نفّذ مباشرة.

قاعدة حاسمة لتفادي "العضو غير موجود":
- إذا استخدمت get_members ووجدت العضو في النتيجة، استخدم حقل "id" الرقمي **بالضبط كما هو** في خطوة execute التالية مباشرة — لا تعيد كتابته أو تخمينه من الذاكرة.
- لا تقل "العضو غير موجود" إلا بعد أن جربت get_members فعلياً ولم يظهر أي نتيجة مطابقة.
- لا تقل "رتبته أعلى مني" أو "الصلاحية ناقصة" من نفسك — هذا تخمين. إذا فشلت العملية فعلياً، ستحصل على رسالة خطأ واضحة من Discord توضح السبب فاعتمد عليها فقط.
- نفس المبدأ ينطبق على القنوات، الرتب، والسيرفرات: جرّب فعلياً بالأداة قبل أن تفترض الفشل أو تعتذر.

══════════════════════════════════════════════
كتابة الكود — مضمّن أم ملف؟
══════════════════════════════════════════════
- كود قصير (تقريباً أقل من 25 سطر): اكتبه مباشرة في ردك العادي داخل صندوق كود ```لغة ... ``` — Discord يدعم هذا بشكل كامل. لا تستخدم أداة file لكود بسيط وقصير. مثال على كود قصير يُكتب مباشرة في الشات وليس كملف:
```js
const {{ AttachmentBuilder }} = require('discord.js');
const fs = require('fs');
fs.writeFileSync('/tmp/code.js', 'console.log("hello");');
const file = new AttachmentBuilder('/tmp/code.js', {{ name: 'code.js' }});
message.channel.send({{ content: 'هذا الكود المطلوب:', files: [file] }});
```
- كود طويل أو ملف كامل متعدد الأجزاء: استخدم أداة file، ونبّه المستخدم بلطف أنك أرسلته كملف لطوله.
صيغة أداة file (داخل ```json فقط):
```json
{{"file": {{"name": "script.py", "content": "..."}}, "reply": "تفضل، الكود طويل فأرسلته كملف."}}
```

══════════════════════════════════════════════
شكل الردود
══════════════════════════════════════════════
- أي رد عادي (دردشة، شرح، كود قصير، منشن) = نص طبيعي مباشر، بدون أي JSON على الإطلاق.
- JSON يُستخدم فقط وحصرياً داخل ```json عند استدعاء أداة فعلية من القائمة أعلاه.
- لا تضع مفتاح "reply" بمفرده داخل JSON لمجرد الرد العادي — فقط اكتب ردك كنص مباشر.

══════════════════════════════════════════════
قواعد إضافية
══════════════════════════════════════════════
- لا رسائل تأكيد قبل التنفيذ — نفّذ مباشرة وأخبر بالنتيجة.
- لا تخترع بيانات السيرفر (أسماء، IDs) — استخدم الأدوات للتحقق دائماً.
- المرفقات النصية تظهر تلقائياً في رسالة المستخدم بين علامات ```، اقرأها مباشرة دون أداة خاصة.
- استمرارية الحوار: محادثة واحدة ممتدة، لا ترحب في كل رسالة، لا تكرر التعريف بنفسك إلا إذا سُئلت."""


# ══════════════════════════════════════════════════════════════
#  AGENT LOOP
# ══════════════════════════════════════════════════════════════
MAX_STEPS = 12


def extract_json_objects(text: str) -> list[dict]:
    """يستخرج كل كائنات JSON الفردية من النص، حتى لو كانت متعددة أو بدون ```json"""
    objects = []
    # أولاً: استخراج المحتوى داخل ```json (قد يكون عدة أسطر)
    for match in re.finditer(r"```json\s*([\s\S]*?)```", text):
        block = match.group(1).strip()
        # محاولة تحميل ككائن واحد
        try:
            obj = json.loads(block)
            if isinstance(obj, dict):
                objects.append(obj)
        except json.JSONDecodeError:
            # قد يكون هناك عدة كائنات متجاورة: {"a":1}{"b":2}
            # نستخدم regex لاستخراج كل كائن متكامل
            for m in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", block):
                try:
                    objects.append(json.loads(m.group()))
                except:
                    pass
    # ثانياً: البحث عن أي JSON في النص العادي (خارج ```json)
    # نمسح النص الموجود داخل ```json أولاً لتجنب التكرار
    cleaned = re.sub(r"```json\s*[\s\S]*?```", "", text)
    for m in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", cleaned):
        try:
            obj = json.loads(m.group())
            if isinstance(obj, dict) and obj not in objects:
                objects.append(obj)
        except:
            pass
    return objects


async def run_agent(
    guild: discord.Guild,
    channel: discord.TextChannel,
    user_msg: str,
    user_info: str,
    bot_context: str,
    bot_name: str,
    session_id: str | None,
    parent_message_id: str | None,
    guild_id: int,
    mode: str = "default",
    thinking: bool = False,
) -> tuple[str, str, str | None, list[str]]:

    system     = build_system(bot_name, mode, thinking)
    cur_sid    = session_id
    cur_pmid   = parent_message_id
    cur_prompt = f"{system}\n\n{bot_context}\n\n{user_info}\n\nUser: {user_msg}"

    for step in range(MAX_STEPS):
        print(f"[Agent {step+1}/{MAX_STEPS}] mode={mode} thinking={thinking}")
        try:
            raw, cur_sid, cur_pmid = await _stream_ds(
                cur_prompt, guild_id, cur_sid, cur_pmid, mode, thinking
            )
        except Exception as e:
            return f"⚠️ خطأ في الاتصال: {e}", cur_sid, cur_pmid, []

        print(f"  raw: {raw[:300]}")

        # استخراج كل كائنات JSON
        json_objects = extract_json_objects(raw)

        all_results = []
        files_to_send = []
        final_reply_text = None

        for obj in json_objects:
            # إذا كان يحتوي على reply فقط بدون أوامر
            if "reply" in obj and "tool" not in obj and "file" not in obj and "action" not in obj:
                final_reply_text = obj["reply"]
                continue

            # التعامل مع أداة file (صيغة مباشرة)
            if "file" in obj:
                file_info = obj["file"]
                if isinstance(file_info, dict) and "name" in file_info and "content" in file_info:
                    safe_name = os.path.basename(file_info["name"]) or "output.txt"
                    content   = str(file_info["content"])
                    try:
                        tmp = tempfile.NamedTemporaryFile(
                            mode='w', suffix='_' + safe_name, delete=False, encoding='utf-8'
                        )
                        tmp.write(content)
                        tmp.close()
                        files_to_send.append(tmp.name)
                        all_results.append(f"[FILE_CREATED: {safe_name}]")
                        if "reply" in obj:
                            final_reply_text = obj["reply"]
                    except Exception as e:
                        all_results.append(f"[FILE_ERROR: {e}]")
                continue

            # إذا كان tool == "file"
            if obj.get("tool") == "file":
                params = obj.get("params", {})
                if isinstance(params, dict) and "name" in params and "content" in params:
                    safe_name = os.path.basename(params["name"]) or "output.txt"
                    content   = str(params["content"])
                    try:
                        tmp = tempfile.NamedTemporaryFile(
                            mode='w', suffix='_' + safe_name, delete=False, encoding='utf-8'
                        )
                        tmp.write(content)
                        tmp.close()
                        files_to_send.append(tmp.name)
                        all_results.append(f"[FILE_CREATED: {safe_name}]")
                        if "reply" in obj:
                            final_reply_text = obj["reply"]
                    except Exception as e:
                        all_results.append(f"[FILE_ERROR: {e}]")
                continue

            # أوامر execute (أو أدوات أخرى)
            tool = obj.get("tool", "")
            if tool == "execute":
                action = obj.get("action", "")
                params = obj.get("params", {})
                result = await tool_execute(guild, channel, action, params)
                all_results.append(f"[TOOL_RESULT: {action}]\n{json.dumps(result, ensure_ascii=False)}")
            elif tool in (
                "get_channels", "get_categories", "get_roles", "get_members", "server_info", "list_all_guilds",
                "get_messages", "get_audit_log", "get_invites", "get_emojis", "get_stickers", "get_bans",
                "get_pinned_messages", "get_voice_states", "search_messages",
            ):
                # أدوات القراءة – مع دعم target_guild
                read_params = obj.get("params", {})
                target_guild = guild
                if read_params.get("target_guild"):
                    found = _find_guild(str(read_params["target_guild"]))
                    if found:
                        target_guild = found
                    else:
                        result = {"error": f"ما لقيت سيرفر: {read_params['target_guild']}"}
                        all_results.append(f"[TOOL_RESULT: {tool}]\n{json.dumps(result, ensure_ascii=False)}")
                        continue
                if tool == "get_channels":
                    result = tool_get_channels(target_guild)
                elif tool == "get_categories":
                    result = tool_get_categories(target_guild)
                elif tool == "get_roles":
                    result = tool_get_roles(target_guild)
                elif tool == "get_members":
                    result = tool_get_members(target_guild, read_params.get("query"))
                elif tool == "server_info":
                    result = tool_server_info(target_guild)
                elif tool == "list_all_guilds":
                    result = tool_list_all_guilds()
                elif tool == "get_messages":
                    limit = int(read_params.get("limit", 100))
                    member_id = read_params.get("member_id")
                    target_ch = channel
                    if read_params.get("channel"):
                        ch_found = _find_channel(target_guild, str(read_params["channel"]))
                        if ch_found and isinstance(ch_found, discord.TextChannel):
                            target_ch = ch_found
                    if isinstance(target_ch, discord.TextChannel):
                        result = await tool_get_messages(target_ch, limit, member_id)
                    else:
                        result = {"error": "حدد قناة نصية صحيحة"}
                elif tool == "get_audit_log":
                    result = await tool_get_audit_log(target_guild, int(read_params.get("limit", 20)), read_params.get("action"))
                elif tool == "get_invites":
                    result = await tool_get_invites(target_guild)
                elif tool == "get_emojis":
                    result = tool_get_emojis(target_guild)
                elif tool == "get_stickers":
                    result = tool_get_stickers(target_guild)
                elif tool == "get_bans":
                    result = await tool_get_bans(target_guild, int(read_params.get("limit", 100)))
                elif tool == "get_pinned_messages":
                    target_ch = channel
                    if read_params.get("channel"):
                        ch_found = _find_channel(target_guild, str(read_params["channel"]))
                        if ch_found and isinstance(ch_found, discord.TextChannel):
                            target_ch = ch_found
                    result = await tool_get_pinned_messages(target_ch) if isinstance(target_ch, discord.TextChannel) else {"error": "حدد قناة نصية صحيحة"}
                elif tool == "get_voice_states":
                    result = tool_get_voice_states(target_guild)
                elif tool == "search_messages":
                    target_ch = channel
                    if read_params.get("channel"):
                        ch_found = _find_channel(target_guild, str(read_params["channel"]))
                        if ch_found and isinstance(ch_found, discord.TextChannel):
                            target_ch = ch_found
                    if isinstance(target_ch, discord.TextChannel):
                        result = await tool_search_messages(target_ch, read_params.get("query", ""), int(read_params.get("limit", 200)))
                    else:
                        result = {"error": "حدد قناة نصية صحيحة"}
                all_results.append(f"[TOOL_RESULT: {tool}]\n{json.dumps(result, ensure_ascii=False)}")
            else:
                # أداة غير معروفة
                all_results.append(f"[UNKNOWN_TOOL: {tool}]")

        # إذا كان هناك رد نصي صريح، نرسله فوراً
        if final_reply_text:
            return final_reply_text, cur_sid, cur_pmid, files_to_send

        # إذا لم تكن هناك أي نتائج (لا أوامر ولا رد)، نعيد النص كما هو
        if not all_results:
            return raw, cur_sid, cur_pmid, []

        # وإلا، نرسل النتائج مجتمعة للنموذج ليكمل
        combined = "\n".join(all_results)
        cur_prompt = f"نتائج الأوامر:\n{combined}\n\nاستمر في التنفيذ أو قدم الرد النهائي."

    return "✅ تم.", cur_sid, cur_pmid, []


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
**/محادثة-جديدة** — ابدأ محادثة جديدة، اختر نوع الموديل (عادي/خبير) وفعّل التفكير العميق إن أردت
**/محادثاتي** — عرض محادثاتك المحفوظة مع نوعها

## 📡 إدارة القنوات المسموحة (أدمن فقط)
**/قنوات-مسموحة** — عرض القنوات المسموحة في هذا السيرفر
**/إضافة-قناة** `[قناة]` — إضافة قناة للقائمة المسموحة
**/حذف-قناة** `[قناة]` — حذف قناة من القائمة المسموحة

## ⚙️ إعدادات البوت (أدمن فقط)
**/رتبة-التحكم** `[اسم الرتبة]` — حدد الرتبة التي تستطيع استخدام البوت
**/الرتبة-الحالية** — عرض رتبة التحكم الحالية
**/مزود-باو** `[railway|telegram]` — تبديل مزود POW

## 🛠️ قدرات الذكاء الاصطناعي
**قراءة:** الرومات، الكاتيكوريات، الرتب، الأعضاء، الرسائل، معلومات السيرفر، سجل التدقيق، الدعوات، الإيموجيات، الملصقات، المحظورين، المثبتات، حالات الفويس، والبحث داخل الرسائل — في السيرفر الحالي أو أي سيرفر آخر
**الوعي الشامل:** يعرف كل السيرفرات التي هو فيها، رتبه، صلاحياته، والقناة التي يتحدث فيها بالضبط
**إدارة الرومات:** إنشاء / حذف / تغيير اسم / سلو مود / حذف رسائل / إنشاء ثريد / قفل وفتح الكتابة / تعديل وصف القناة / إنشاء دعوات
**إدارة الرتب:** إنشاء / حذف / تعديل / إعطاء / سحب
**إدارة الأعضاء:** كيك / بان / فك بان / تايم آوت وإزالته / تغيير نكنيم / نقل للفويس
**الرسائل والمنشن:** إرسال رسائل أو منشن @everyone في أي قناة بأي سيرفر هو فيه + تثبيت/إلغاء تثبيت رسائل
**استنساخ سيرفر:** نسخ كامل البنية (رتب + كاتيكوريات + رومات) من سيرفر إلى آخر
**الملفات:** قراءة المرفقات النصية + إنشاء ملفات وإرسالها (كود قصير يُكتب مباشرة، الطويل فقط كملف)

## 🧠 أوضاع المحادثة
- **نوع الموديل:** عادي أو خبير (Expert)
- **التفكير العميق:** يمكن تفعيله أو تعطيله بشكل مستقل عن نوع الموديل — والتفكير لا يظهر في ردك أبداً، فقط النتيجة النهائية

> الأوامر تشتغل بالاسم أو الـ ID"""

    await interaction.response.send_message(help_text, ephemeral=True)


@client.tree.command(name="محادثة-جديدة", description="ابدأ محادثة جديدة مع اختيار الموديل ووضع التفكير")
@app_commands.describe(
    وضع="نوع الموديل: عادي أو خبير",
    تفكير="هل تريد تفعيل التفكير العميق؟ (مستقل عن نوع الموديل)",
)
@app_commands.choices(
    وضع=[
        app_commands.Choice(name="🗨️ عادي", value="default"),
        app_commands.Choice(name="🧠 خبير (Expert)", value="expert"),
    ],
    تفكير=[
        app_commands.Choice(name="⚡ بدون تفكير — رد مباشر وأسرع", value="off"),
        app_commands.Choice(name="🔍 مع تفكير عميق — تحليل أدق قبل الرد", value="on"),
    ],
)
async def cmd_new_chat(interaction: discord.Interaction, وضع: str = "default", تفكير: str = "off"):
    user_id  = interaction.user.id
    guild_id = interaction.guild_id
    key      = (guild_id, user_id)
    think_on = (تفكير == "on")

    async with session_lock:
        # المحادثة السابقة محفوظة أصلاً (تُحدّث تلقائياً مع كل رسالة)
        # هنا فقط نمسح الجلسة النشطة لبدء محادثة جديدة من الصفر
        user_sessions[key] = {
            "session_id"       : None,
            "parent_message_id": None,
            "mode"             : وضع,
            "thinking"         : think_on,
        }

    mode_label  = "🧠 خبير" if وضع == "expert" else "🗨️ عادي"
    think_label = "🔍 مفعّل" if think_on else "⚡ غير مفعّل"
    await interaction.response.send_message(
        f"✅ **بدأت محادثة جديدة!**\n"
        f"الموديل: **{mode_label}**\n"
        f"التفكير العميق: **{think_label}**\n"
        f"المحادثة السابقة تم حفظها في `/محادثاتي`",
        ephemeral=True,
    )


@client.tree.command(name="محادثاتي", description="عرض محادثاتك المحفوظة")
async def cmd_my_chats(interaction: discord.Interaction):
    user_id  = interaction.user.id
    guild_id = interaction.guild_id
    sessions = await db_get_sessions(user_id, guild_id)

    if not sessions:
        await interaction.response.send_message(
            "📭 ما عندك محادثات محفوظة في هذا السيرفر.", ephemeral=True
        )
        return

    mode_icons = {"expert": "🧠", "default": "🗨️"}
    lines = ["# محادثاتك المحفوظة\n"]
    for i, s in enumerate(sessions, 1):
        updated   = s.get("updated_at")
        time_str  = updated.strftime("%d/%m %H:%M") if hasattr(updated, "strftime") else "—"
        mode      = s.get("mode", "default")
        icon      = mode_icons.get(mode, "🗨️")
        think_tag = " 🔍" if s.get("thinking") else ""
        lines.append(f"**{i}.** {icon}{think_tag} {s['label']} — آخر تحديث: {time_str}")

    lines.append("\n> اكتب رقم المحادثة لتحميلها")
    await interaction.response.send_message("\n".join(lines), ephemeral=True)

    def check(m: discord.Message):
        return m.author.id == user_id and m.content.strip().isdigit()

    try:
        msg = await client.wait_for("message", check=check, timeout=30.0)
        idx = int(msg.content.strip()) - 1
        if 0 <= idx < len(sessions):
            chosen = sessions[idx]
            async with session_lock:
                user_sessions[(guild_id, user_id)] = {
                    "session_id"       : chosen["session_id"],
                    "parent_message_id": chosen["parent_message_id"],
                    "mode"             : chosen.get("mode", "default"),
                    "thinking"         : chosen.get("thinking", False),
                    "label"            : chosen.get("label"),
                }
            mode_label  = "🧠 خبير" if chosen.get("mode") == "expert" else "🗨️ عادي"
            think_label = " + 🔍 تفكير" if chosen.get("thinking") else ""
            await msg.reply(
                f"✅ تم تحميل محادثة **{chosen['label']}** ({mode_label}{think_label})\n"
                f"تقدر تكمل من حيث توقفت!"
            )
        else:
            await msg.reply("❌ رقم غير صحيح")
    except asyncio.TimeoutError:
        pass


# ══════════════════════════════════════════════════════════════
#  القنوات المسموحة — أوامر
# ══════════════════════════════════════════════════════════════

@client.tree.command(name="قنوات-مسموحة", description="عرض القنوات التي يستمع فيها البوت")
async def cmd_list_channels(interaction: discord.Interaction):
    guild_id = interaction.guild_id
    guild    = interaction.guild
    ids      = await get_allowed_channels(guild_id)

    if not ids:
        await interaction.response.send_message(
            "📭 لا توجد قنوات مضافة. استخدم **/إضافة-قناة** لإضافة قنوات.",
            ephemeral=True,
        )
        return

    lines = ["# القنوات المسموحة في هذا السيرفر\n"]
    for cid in ids:
        ch = guild.get_channel(cid)
        if ch:
            lines.append(f"- #{ch.name} (`{cid}`)")
        else:
            lines.append(f"- ~~قناة محذوفة~~ (`{cid}`)")

    await interaction.response.send_message("\n".join(lines), ephemeral=True)


@client.tree.command(name="إضافة-قناة", description="أضف قناة للقائمة المسموحة (أدمن فقط)")
@app_commands.describe(قناة="اختر القناة التي تريد إضافتها")
async def cmd_add_channel(interaction: discord.Interaction, قناة: discord.TextChannel):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("⛔ هذا الأمر للأدمن فقط.", ephemeral=True)
        return

    await add_allowed_channel(interaction.guild_id, قناة.id)
    await interaction.response.send_message(
        f"✅ تم إضافة **#{قناة.name}** للقنوات المسموحة.\n"
        f"البوت سيستمع الآن في هذه القناة.",
        ephemeral=True,
    )


@client.tree.command(name="حذف-قناة", description="احذف قناة من القائمة المسموحة (أدمن فقط)")
@app_commands.describe(قناة="اختر القناة التي تريد حذفها من القائمة")
async def cmd_remove_channel(interaction: discord.Interaction, قناة: discord.TextChannel):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("⛔ هذا الأمر للأدمن فقط.", ephemeral=True)
        return

    ids = await get_allowed_channels(interaction.guild_id)
    if قناة.id not in ids:
        await interaction.response.send_message(
            f"❌ **#{قناة.name}** غير موجودة في القائمة المسموحة.",
            ephemeral=True,
        )
        return

    await remove_allowed_channel(interaction.guild_id, قناة.id)
    await interaction.response.send_message(
        f"✅ تم حذف **#{قناة.name}** من القنوات المسموحة.",
        ephemeral=True,
    )


# ══════════════════════════════════════════════════════════════
#  رتبة التحكم — أوامر
# ══════════════════════════════════════════════════════════════

@client.tree.command(name="رتبة-التحكم", description="حدد الرتبة اللي تستطيع استخدام البوت (أدمن فقط)")
@app_commands.describe(role="اسم الرتبة (اتركها فارغة لتعطيل القيد)")
async def cmd_set_control_role(interaction: discord.Interaction, role: str = ""):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("⛔ هذا الأمر للأدمن فقط.", ephemeral=True)
        return

    await set_control_role(interaction.guild_id, role)
    if role:
        await interaction.response.send_message(
            f"✅ تم تحديد رتبة التحكم: **{role}**\n"
            f"الآن فقط أصحاب هذي الرتبة يقدرون يستخدمون البوت.",
            ephemeral=True,
        )
    else:
        await interaction.response.send_message(
            "✅ تم إزالة قيد الرتبة — الكل يقدر يستخدم البوت.",
            ephemeral=True,
        )


@client.tree.command(name="الرتبة-الحالية", description="عرض رتبة التحكم الحالية")
async def cmd_get_control_role(interaction: discord.Interaction):
    role = await get_control_role(interaction.guild_id)
    if role:
        await interaction.response.send_message(
            f"🔒 رتبة التحكم: **{role}**", ephemeral=True
        )
    else:
        await interaction.response.send_message(
            "🔓 لا يوجد قيد — الكل يقدر يستخدم البوت.", ephemeral=True
        )


@client.tree.command(name="مزود-باو", description="تبديل مزود POW (أدمن فقط)")
@app_commands.describe(provider="اختر المزود: railway أو telegram")
@app_commands.choices(provider=[
    app_commands.Choice(name="🚂 Railway (افتراضي)", value="railway"),
    app_commands.Choice(name="✈️ Telegram Proxy", value="telegram"),
])
async def cmd_set_pow_provider(interaction: discord.Interaction, provider: str):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("⛔ هذا الأمر للأدمن فقط.", ephemeral=True)
        return

    await set_pow_provider(interaction.guild_id, provider)
    await interaction.response.send_message(
        f"✅ تم تبديل مزود POW إلى **{provider}**", ephemeral=True
    )


# ══════════════════════════════════════════════════════════════
#  EVENTS
# ══════════════════════════════════════════════════════════════

@client.event
async def on_ready():
    name = client.user.display_name or client.user.name
    print(f"✅ {name} ({client.user.id}) ready")
    print(f"📡 Guilds ({len(client.guilds)}): {[g.name for g in client.guilds]}")

    # تهيئة القنوات الافتراضية لكل سيرفر (إذا لم تُضف بعد)
    if DEFAULT_CHANNEL_ID:
        for guild in client.guilds:
            ids = await get_allowed_channels(guild.id)
            if not ids:
                await add_allowed_channel(guild.id, DEFAULT_CHANNEL_ID)
                print(f"  [{guild.name}] تهيئة قناة افتراضية: {DEFAULT_CHANNEL_ID}")

    try:
        await mongo_client.admin.command("ping")
        print("✅ MongoDB OK")
    except Exception as e:
        print(f"❌ MongoDB: {e}")


@client.event
async def on_message(m: discord.Message):
    if m.author.id == client.user.id:
        return
    if not m.guild:
        return   # رسائل DM — تجاهل

    # ── التحقق من القناة ──
    allowed_ids = await get_allowed_channels(m.guild.id)
    if allowed_ids and m.channel.id not in allowed_ids:
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

    # استخراج النص — نشيل منشن البوت نفسه فقط، ونبقي منشنات الأعضاء الآخرين كما هي
    content = m.content
    content = content.replace(f"<@{client.user.id}>", "").replace(f"<@!{client.user.id}>", "")
    final = content.strip()

    # ── منشنات أعضاء آخرين في الرسالة (غير البوت) — نوضحها صراحة للذكاء ──
    other_mentions = [u for u in m.mentions if u.id != client.user.id]
    if other_mentions:
        mention_lines = ["\n[أعضاء تم منشنتهم في هذي الرسالة]"]
        for u in other_mentions:
            mem = m.guild.get_member(u.id)
            disp = mem.display_name if mem else u.display_name
            mention_lines.append(f"  - <@{u.id}> ← الاسم: {disp} | اليوزرنيم: @{u.name} | الـ ID: {u.id}")
        final += "\n" + "\n".join(mention_lines)

    # ── معالجة المرفقات ──
    if m.attachments:
        for att in m.attachments:
            if is_text_attachment(att):
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(att.url) as resp:
                            if resp.status != 200:
                                final += f"\n[ملف: {att.filename}] (فشل التحميل)"
                                continue
                            data = await resp.content.read(MAX_ATTACHMENT_BYTES)
                            text = data.decode('utf-8', errors='replace')
                            if len(data) >= MAX_ATTACHMENT_BYTES:
                                text += "\n... (تم اقتطاع الملف لكبر حجمه)"
                            _, ext  = os.path.splitext(att.filename)
                            lang    = ext.lstrip('.') if ext else ''
                            final  += f"\n[ملف: {att.filename}]\n```{lang}\n{text}\n```"
                except Exception as e:
                    final += f"\n[ملف: {att.filename}] (خطأ: {e})"
            else:
                final += f"\n[ملف غير نصي: {att.filename}]"

    if not final:
        await m.reply("وين أساعدك؟ 😄")
        return

    # ── إيموجي 👀 ──
    try:
        await m.add_reaction("👀")
    except Exception:
        pass

    # ── معلومات المستخدم ──
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

    # ── سياق البوت (self-awareness) ──
    bot_context = await build_bot_context(m.guild, m.channel)

    # ── تحميل جلسة المستخدم (نفس الجلسة عبر القنوات في نفس السيرفر) ──
    key = (m.guild.id, author.id)
    async with session_lock:
        if key not in user_sessions:
            latest = await load_latest_session(author.id, m.guild.id)
            if latest:
                user_sessions[key] = latest
            else:
                user_sessions[key] = {
                    "session_id": None, "parent_message_id": None,
                    "mode": "default", "thinking": False,
                }
        us = user_sessions[key]

    bot_name = client.user.display_name or client.user.name
    mode     = us.get("mode", "default")
    thinking = us.get("thinking", False)

    # ── إيموجي ⏳ + إزالة 👀 ──
    try:
        await m.add_reaction("⏳")
        await m.remove_reaction("👀", client.user)
    except Exception:
        pass

    try:
        reply, new_sid, new_pmid, generated_files = await run_agent(
            guild             = m.guild,
            channel           = m.channel,
            user_msg          = final,
            user_info         = user_info,
            bot_context       = bot_context,
            bot_name          = bot_name,
            session_id        = us["session_id"],
            parent_message_id = us["parent_message_id"],
            guild_id          = m.guild.id,
            mode              = mode,
            thinking          = thinking,
        )

        async with session_lock:
            us["session_id"]        = new_sid
            us["parent_message_id"] = new_pmid

        if new_sid:
            # label يُنشأ مرة وحدة عند أول رسالة بهذي الجلسة، ثم يُعاد استخدامه
            async with session_lock:
                if not us.get("label"):
                    us["label"] = f"محادثة {datetime.now().strftime('%d/%m %H:%M')}"
                label = us["label"]
            await db_save_session(author.id, m.guild.id, new_sid, new_pmid, mode, label, thinking)

        reply  = reply or "✅ تم."
        chunks = [reply[i:i+1990] for i in range(0, len(reply), 1990)]

        if generated_files:
            discord_files = [discord.File(fp) for fp in generated_files]
            if chunks:
                await m.reply(content=chunks[0], files=discord_files)
                for chunk in chunks[1:]:
                    await m.channel.send(chunk)
            else:
                await m.reply(files=discord_files)
            for fp in generated_files:
                try:
                    os.unlink(fp)
                except Exception:
                    pass
        else:
            for chunk in chunks:
                await m.reply(chunk)

        # ── إيموجي ☑️ + إزالة ⏳ ──
        try:
            await m.add_reaction("☑️")
            await m.remove_reaction("⏳", client.user)
        except Exception:
            pass

    except Exception as e:
        print(f"[on_message] {e}")
        await m.reply(f"⚠️ خطأ غير متوقع: {str(e)[:300]}")
        try:
            await m.add_reaction("❌")
            await m.remove_reaction("⏳", client.user)
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
