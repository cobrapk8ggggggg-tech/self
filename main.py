import discord
import asyncio
import json
import os
import random
import time
import re
from datetime import datetime
from motor.motor_asyncio import AsyncIOMotorClient
import aiohttp

# ═══════════════════════════════════════════
#                  MongoDB
# ═══════════════════════════════════════════
MONGODB_URI = os.getenv("MONGODB_URI")
mongo_client = AsyncIOMotorClient(MONGODB_URI)
db = mongo_client["disor_db"]
history_col = db["history"]

# ═══════════════════════════════════════════
#                    KEYS
# ═══════════════════════════════════════════
USER_TOKEN       = os.getenv("USER_TOKEN")
DEEPSEEK_TOKEN   = os.getenv("DEEPSEEK_TOKEN")
ALLOWED_CHANNEL_ID = int(os.getenv("ALLOWED_CHANNEL_ID", "1356830719170842710"))
PREFIX           = os.getenv("PREFIX", "!")  # البادئة الافتراضية

# ═══════════════════════════════════════════
#               User Sessions
# ═══════════════════════════════════════════
user_sessions = {}   # user_id -> {"session_id": str, "parent_message_id": str}
session_lock  = asyncio.Lock()

# ═══════════════════════════════════════════
#           DeepSeek API Helpers
# ═══════════════════════════════════════════
RAILWAY_SERVER_URL = "https://web-production-c09dc.up.railway.app"
POW_API_URL        = f"{RAILWAY_SERVER_URL}/pow"

def generate_device_id():
    chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    return ''.join(random.choice(chars) for _ in range(88))

def generate_rangers_id():
    ts = int(time.time() * 1000)
    rv = random.randint(1000000000, 9999999999)
    return str((ts << 32) | rv)

def get_tz_offset():
    offset = -datetime.now().astimezone().utcoffset().total_seconds()
    return str(int(offset))

def build_headers(pow_response, token):
    return {
        'User-Agent'               : 'DeepSeek/2.1.1 Android/36',
        'Accept'                   : 'application/json',
        'Accept-Encoding'          : 'gzip',
        'Content-Type'             : 'application/json',
        'x-client-platform'        : 'android',
        'x-client-version'         : '2.1.1',
        'x-client-locale'          : 'ar',
        'x-client-bundle-id'       : 'com.deepseek.chat',
        'x-rangers-id'             : generate_rangers_id(),
        'x-client-timezone-offset' : get_tz_offset(),
        'x-device-id'              : generate_device_id(),
        'x-os-version'             : '30',
        'x-app-version'            : '2.1.1',
        'Authorization'            : f'Bearer {token}',
        'X-DS-PoW-Response'        : pow_response,
        'accept-charset'           : 'UTF-8',
    }

def clean_response(text: str) -> str:
    """إزالة كلمات FINISHEDSEARCH وFINISHED وأي markdown json backticks"""
    text = re.sub(r'\bFINISHEDSEARCH\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\bFINISHED\b',       '', text, flags=re.IGNORECASE)
    # إزالة ```json ... ``` أو ``` ... ```
    text = re.sub(r'```(?:json)?\s*([\s\S]*?)```', r'\1', text)
    return text.strip()

async def get_fresh_pow(token):
    try:
        async with aiohttp.ClientSession() as session:
            url = f"{POW_API_URL}?authorization={token}"
            async with session.get(url) as resp:
                if resp.status != 200:
                    async with session.get(POW_API_URL) as fallback:
                        if fallback.status != 200:
                            raise Exception(f"POW failed: {fallback.status}")
                        data = await fallback.json()
                else:
                    data = await resp.json()
            if not data.get('pow_response') and not data.get('x_ds_pow_response'):
                raise Exception("Incomplete POW response")
            return {
                'pow_response': data.get('x_ds_pow_response') or data['pow_response'],
                'pow_data'    : data.get('solved_json')
            }
    except Exception as e:
        print(f"[POW Error] {e}")
        raise

async def create_chat_session(token):
    url = "https://chat.deepseek.com/api/v0/chat_session/create"
    headers = {
        'x-client-bundle-id'       : 'com.deepseek.chat',
        'x-client-platform'        : 'web',
        'x-client-version'         : '2.0.0',
        'x-client-locale'          : 'en_US',
        'x-client-timezone-offset' : get_tz_offset(),
        'x-app-version'            : '2.0.0',
        'Authorization'            : f'Bearer {token}',
        'Content-Type'             : 'application/json',
        'Accept'                   : '*/*'
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json={}) as resp:
            data = await resp.json()
            sid = data.get('data', {}).get('biz_data', {}).get('chat_session', {}).get('id')
            if sid:
                return sid
            raise Exception('Invalid session response: ' + json.dumps(data))

async def deepseek_completion(
    system_content,
    user_content,
    session_id=None,
    parent_message_id=None,
):
    """
    استدعاء DeepSeek مع دعم session متواصل.
    يرجع: (full_text, session_id, new_parent_message_id)
    """
    token = DEEPSEEK_TOKEN
    if not token:
        raise Exception("DEEPSEEK_TOKEN not set")

    if session_id is None:
        session_id = await create_chat_session(token)

    pow_data = await get_fresh_pow(token)
    headers  = build_headers(pow_data['pow_response'], token)

    # دمج الـ system مع prompt (DeepSeek لا يدعم system role مباشرة)
    prompt = f"{system_content}\n\nUser: {user_content}" if system_content else user_content

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
        "pow"              : pow_data['pow_data'],
        "stream"           : True
    }

    url       = "https://chat.deepseek.com/api/v0/chat/completion"
    full_text = ""
    new_parent_message_id = None

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise Exception(f"DeepSeek API error {resp.status}: {text}")

            buffer = ""
            async for chunk in resp.content.iter_chunked(1024):
                buffer += chunk.decode('utf-8')
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    try:
                        data = json.loads(data_str)
                        if new_parent_message_id is None and 'response_message_id' in data:
                            new_parent_message_id = data['response_message_id']
                        v = data.get('v')
                        if isinstance(v, str):
                            full_text += v
                        elif isinstance(v, dict) and 'response' in v:
                            for frag in v['response'].get('fragments', []):
                                if frag.get('type') == 'RESPONSE':
                                    full_text += frag.get('content', '')
                    except Exception:
                        pass

    return clean_response(full_text), session_id, new_parent_message_id


# ═══════════════════════════════════════════════════════
#  deepseek_one_shot — استدعاء مستقل بدون session محفوظ
#  مناسب للعمليات التحليلية (parser, intent, lookup)
# ═══════════════════════════════════════════════════════
async def deepseek_one_shot(system_content: str, user_content: str) -> str:
    text, _, _ = await deepseek_completion(system_content, user_content)
    return text.strip()


# ═══════════════════════════════════════════
#              Discord Client
# ═══════════════════════════════════════════
# ملاحظة: استخدام client = discord.Client() فقط لأن الإصدار القديم لا يدعم Intents
# الحساب الشخصي يقرأ الرسائل والأعضاء بشكل طبيعي بدون الحاجة لتفعيل intents خاصة
client = discord.Client()

# ═══════════════════════════════════════════
#                 Account Info
# ═══════════════════════════════════════════
def get_account_info():
    """تجلب معلومات الحساب المستخدم كسيلف بوت"""
    name = client.user.name if client.user else "Disor"
    uid  = client.user.id   if client.user else 0
    return name, uid

def build_ai_about(account_name: str) -> str:
    return f"""
أنت مساعد ديسكورد ذكي، تعمل من خلال حساب {account_name}.
- تتكلم بالعربي فقط، وتستخدم اللهجة العراقية العامية
- تساعد المستخدمين في إدارة سيرفراتهم على ديسكورد
- أنت لست بوتاً رسمياً، بل مساعد شخصي عبر حساب عادي

المهام اللي تقدر تسويها:
1. إنشاء روم نصي (text channel)
2. إنشاء روم صوتي (voice channel)
3. إنشاء كاتيكوري (category)
4. حذف روم
5. تغيير اسم روم
6. إنشاء رتبة (role) مع صلاحياتها ولونها
7. إعطاء رتبة لعضو (grant role)
8. حذف رتبة (delete role)
9. كيك عضو (kick member)
10. بان عضو (ban member)
11. تغيير نكنيم عضو (change nickname)

الأسماء المستعارة:
- روم/شات/غرفة/قناة/شانل = Channel
- فويس/صوتي = Voice Channel
- رول/رتبة = Role
- كاتيكوري/تصنيف/قسم = Category

⚠️ مهم جداً بخصوص الـ administrator permission:
لا تعطي administrator إلا لو المستخدم طلبه صراحة.
إذا قال "أدمن رول" بس ما ذكر administrator تحديداً، استخدم صلاحيات محددة مثل:
manage_channels, manage_roles, kick_members, ban_members, manage_messages, manage_guild, moderate_members

Discord Permissions المتاحة:
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
request_to_speak, use_soundboard, use_external_sounds
"""

AiAbout = ""


# ═══════════════════════════════════════════
#           Server Info Builder
# ═══════════════════════════════════════════
def get_server_info(guild: discord.Guild) -> str:
    if not guild:
        return "لا يوجد سيرفر"

    lines = [f"السيرفر: {guild.name} (ID: {guild.id})"]

    # كاتيكوريات
    lines.append("\n📁 الكاتيكوريات:")
    for cat in guild.categories:
        lines.append(f"  • {cat.name}  |  ID: {cat.id}")

    # قنوات
    lines.append("\n💬 الرومات:")
    for ch in guild.channels:
        t = "نصي" if isinstance(ch, discord.TextChannel) else "صوتي" if isinstance(ch, discord.VoiceChannel) else "كاتيكوري" if isinstance(ch, discord.CategoryChannel) else "أخرى"
        cat_name = ch.category.name if ch.category else "بدون كاتيكوري"
        lines.append(f"  • [{t}] {ch.name}  |  ID: {ch.id}  |  كاتيكوري: {cat_name}")

    # رتب
    lines.append("\n🎖️ الرتب (من الأعلى للأدنى):")
    for role in sorted(guild.roles, key=lambda r: r.position, reverse=True):
        lines.append(f"  • Pos:{role.position}  {role.name}  |  ID: {role.id}  |  لون: {role.color}")

    # أعضاء
    lines.append(f"\n👥 عدد الأعضاء: {guild.member_count}")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════
#  Lookup Helpers — تستخدم ID مباشرة بدون AI عشان موثوق
# ═══════════════════════════════════════════════════════
def find_channel_by_name(guild: discord.Guild, name: str) -> discord.abc.GuildChannel | None:
    """بحث عن قناة بالاسم (case-insensitive, partial match)"""
    name_lower = name.lower().strip()
    # بحث exact أول
    for ch in guild.channels:
        if ch.name.lower() == name_lower:
            return ch
    # ثم partial
    for ch in guild.channels:
        if name_lower in ch.name.lower():
            return ch
    return None

def find_category_by_name(guild: discord.Guild, name: str) -> discord.CategoryChannel | None:
    name_lower = name.lower().strip()
    for cat in guild.categories:
        if cat.name.lower() == name_lower:
            return cat
    for cat in guild.categories:
        if name_lower in cat.name.lower():
            return cat
    return None

def find_role_by_name(guild: discord.Guild, name: str) -> discord.Role | None:
    name_lower = name.lower().strip()
    for role in guild.roles:
        if role.name.lower() == name_lower:
            return role
    for role in guild.roles:
        if name_lower in role.name.lower():
            return role
    return None

def find_member_by_name(guild: discord.Guild, name: str) -> discord.Member | None:
    name_lower = name.lower().strip()
    for member in guild.members:
        if member.name.lower() == name_lower:
            return member
        if member.display_name.lower() == name_lower:
            return member
    for member in guild.members:
        if name_lower in member.name.lower() or name_lower in member.display_name.lower():
            return member
    return None


# ═══════════════════════════════════════════
#         تنفيذ الأوامر — run_commands
# ═══════════════════════════════════════════
async def run_commands(commands: list, guild: discord.Guild) -> list[str]:
    """
    ينفذ قائمة الأوامر ويرجع قائمة رسائل النتائج (نجاح/فشل).
    """
    results = []

    for command in commands:
        for key, value in command.items():
            await asyncio.sleep(0.5)
            try:

                # ────────── CreateCategory ──────────
                if key.startswith("CreateCategory"):
                    cat = await guild.create_category(name=value["Name"])
                    results.append(f"✅ تم إنشاء الكاتيكوري **{cat.name}**")

                # ────────── CreateChannel ──────────
                elif key.startswith("CreateChannel"):
                    ch_type  = value.get("Type", "text").lower()
                    ch_name  = value["Name"]
                    cat_name = value.get("Category", "")

                    # إيجاد الكاتيكوري
                    category_obj = None
                    if cat_name:
                        category_obj = find_category_by_name(guild, cat_name)

                    if ch_type == "voice":
                        ch = await guild.create_voice_channel(name=ch_name, category=category_obj)
                    else:
                        ch = await guild.create_text_channel(name=ch_name, category=category_obj)

                    loc = f" تحت **{category_obj.name}**" if category_obj else ""
                    results.append(f"✅ تم إنشاء الروم **{ch.name}**{loc}")

                # ────────── DeleteChannel ──────────
                elif key.startswith("DeleteChannel"):
                    ch = find_channel_by_name(guild, value["Name"])
                    if ch:
                        name = ch.name
                        await ch.delete()
                        results.append(f"✅ تم حذف الروم **{name}**")
                    else:
                        results.append(f"❌ ما لقيت روم اسمه **{value['Name']}**")

                # ────────── EditChannelName ──────────
                elif key.startswith("EditChannelName"):
                    ch = find_channel_by_name(guild, value["Channel"])
                    if ch:
                        old = ch.name
                        await ch.edit(name=value["Name"])
                        results.append(f"✅ تم تغيير اسم **{old}** إلى **{value['Name']}**")
                    else:
                        results.append(f"❌ ما لقيت روم اسمه **{value['Channel']}**")

                # ────────── CreateRole ──────────
                elif key.startswith("CreateRole"):
                    color_str = value.get("Color", "#99AAB5")
                    try:
                        color = discord.Colour.from_str(color_str)
                    except Exception:
                        color = discord.Colour.default()

                    perms_dict = value.get("Perms", {})
                    perms = discord.Permissions(**perms_dict)

                    role = await guild.create_role(
                        name=value["Name"],
                        colour=color,
                        permissions=perms
                    )

                    # ضبط الموضع إذا حُدد
                    pos = value.get("Position", 0)
                    if pos and pos > 0:
                        try:
                            await guild.edit_role_positions(positions={role: pos})
                        except Exception as pe:
                            print(f"[Position Error] {pe}")

                    results.append(f"✅ تم إنشاء الرتبة **{role.name}**")

                # ────────── DeleteRole ──────────
                elif key.startswith("DeleteRole"):
                    role = find_role_by_name(guild, value["Name"])
                    if role:
                        name = role.name
                        await role.delete()
                        results.append(f"✅ تم حذف الرتبة **{name}**")
                    else:
                        results.append(f"❌ ما لقيت رتبة اسمها **{value['Name']}**")

                # ────────── GrantRole ──────────
                elif key.startswith("GrantRole"):
                    member = find_member_by_name(guild, value["Member"])
                    role   = find_role_by_name(guild, value["Name"])
                    if not member:
                        results.append(f"❌ ما لقيت العضو **{value['Member']}**")
                    elif not role:
                        results.append(f"❌ ما لقيت الرتبة **{value['Name']}**")
                    else:
                        await member.add_roles(role)
                        results.append(f"✅ تم إعطاء **{member.display_name}** رتبة **{role.name}**")

                # ────────── RevokeRole ──────────
                elif key.startswith("RevokeRole"):
                    member = find_member_by_name(guild, value["Member"])
                    role   = find_role_by_name(guild, value["Name"])
                    if not member:
                        results.append(f"❌ ما لقيت العضو **{value['Member']}**")
                    elif not role:
                        results.append(f"❌ ما لقيت الرتبة **{value['Name']}**")
                    else:
                        await member.remove_roles(role)
                        results.append(f"✅ تم سحب رتبة **{role.name}** من **{member.display_name}**")

                # ────────── KickMember ──────────
                elif key.startswith("KickMember"):
                    member = find_member_by_name(guild, value["Member"])
                    if not member:
                        results.append(f"❌ ما لقيت العضو **{value['Member']}**")
                    else:
                        reason = value.get("Reason", "بدون سبب")
                        name   = member.display_name
                        await member.kick(reason=reason)
                        results.append(f"✅ تم كيك **{name}** — السبب: {reason}")

                # ────────── BanMember ──────────
                elif key.startswith("BanMember"):
                    member = find_member_by_name(guild, value["Member"])
                    if not member:
                        results.append(f"❌ ما لقيت العضو **{value['Member']}**")
                    else:
                        reason = value.get("Reason", "بدون سبب")
                        name   = member.display_name
                        await member.ban(reason=reason, delete_message_days=0)
                        results.append(f"✅ تم بان **{name}** — السبب: {reason}")

                # ────────── ChangeNickname ──────────
                elif key.startswith("ChangeNickname"):
                    member = find_member_by_name(guild, value["Member"])
                    if not member:
                        results.append(f"❌ ما لقيت العضو **{value['Member']}**")
                    else:
                        old  = member.display_name
                        await member.edit(nick=value["Nickname"])
                        results.append(f"✅ تم تغيير نكنيم **{old}** إلى **{value['Nickname']}**")

                # ────────── EditRolePerms ──────────
                elif key.startswith("EditRolePerms"):
                    role = find_role_by_name(guild, value["Name"])
                    if not role:
                        results.append(f"❌ ما لقيت الرتبة **{value['Name']}**")
                    else:
                        perms = discord.Permissions(**value.get("Perms", {}))
                        await role.edit(permissions=perms)
                        results.append(f"✅ تم تعديل صلاحيات رتبة **{role.name}**")

                else:
                    results.append(f"⚠️ أمر غير معروف: {key}")

            except discord.Forbidden:
                results.append(f"⛔ ما عندي صلاحية لتنفيذ **{key}** — تأكد إن الحساب عنده الصلاحيات الكافية")
            except discord.HTTPException as e:
                results.append(f"❌ خطأ في تنفيذ **{key}**: {e.text}")
            except Exception as e:
                results.append(f"❌ خطأ غير متوقع في **{key}**: {str(e)}")
                print(f"[run_commands Error] {key}: {e}")

    return results


# ═══════════════════════════════════════════
#              Events
# ═══════════════════════════════════════════
@client.event
async def on_ready():
    global AiAbout
    name, uid = get_account_info()
    AiAbout   = build_ai_about(name)
    print(f"✅ Logged in as: {name} ({uid})")
    print(f"📡 Guilds: {[g.name for g in client.guilds]}")
    try:
        await mongo_client.admin.command("ping")
        print("✅ MongoDB connected.")
    except Exception as e:
        print(f"❌ MongoDB error: {e}")


# ═══════════════════════════════════════════
#           Message Handler
# ═══════════════════════════════════════════
PARSER_SYSTEM = """
أنت محلل أوامر. مهمتك تحويل طلب المستخدم إلى JSON فقط.

القواعد:
1. رد بـ JSON فقط — لا نص، لا شرح، لا backticks
2. إذا الطلب ما يتعلق بالأوامر المتاحة رد بـ: {"NoSkill0": {"Reply": "رد بالعراقي يوضح إنك ما تقدر تسوي الطلب"}}
3. ممكن تدمج أكثر من أمر في نفس الرد

الأوامر المتاحة وصيغتها:

CreateCategory0:  {"Name": "اسم الكاتيكوري"}
CreateChannel0:   {"Name": "اسم الروم", "Type": "text|voice", "Category": "اسم الكاتيكوري أو فاضي"}
DeleteChannel0:   {"Name": "اسم الروم"}
EditChannelName0: {"Channel": "الاسم الحالي", "Name": "الاسم الجديد"}
CreateRole0:      {"Name": "اسم الرتبة", "Color": "#RRGGBB", "Position": رقم, "Perms": {"اسم_الصلاحية": true/false}}
DeleteRole0:      {"Name": "اسم الرتبة"}
GrantRole0:       {"Member": "اسم العضو", "Name": "اسم الرتبة"}
RevokeRole0:      {"Member": "اسم العضو", "Name": "اسم الرتبة"}
KickMember0:      {"Member": "اسم العضو", "Reason": "السبب"}
BanMember0:       {"Member": "اسم العضو", "Reason": "السبب"}
ChangeNickname0:  {"Member": "اسم العضو", "Nickname": "النكنيم الجديد"}
EditRolePerms0:   {"Name": "اسم الرتبة", "Perms": {"اسم_الصلاحية": true/false}}

ملاحظات:
- الأرقام في نهاية الأمر (0,1,2...) تميز بين الأوامر المتعددة من نفس النوع
- مثال لأوامر متعددة: {"CreateChannel0": {...}, "CreateChannel1": {...}, "CreateRole0": {...}}
- إذا ما ذُكر لون للرول استخدم "#99AAB5"
- إذا ما ذُكر موضع للرول استخدم 0
- لا تضع administrator في الـ Perms إلا إذا طلبه المستخدم صراحة

⚠️ رد بـ JSON فقط — لا أي نص آخر
"""

@client.event
async def on_message(m: discord.Message):
    # تجاهل رسائل الحساب نفسه (السيلف بوت يتجاهل نفسه)
    if m.author.id == client.user.id:
        return

    # القناة المسموح بها فقط
    if m.channel.id != ALLOWED_CHANNEL_ID:
        return

    content = m.content

    # التحقق من أن الرسالة موجهة للسيلف بوت
    # إما أن تبدأ بالبادئة أو أن تكون رداً على رسالة من الحساب نفسه
    starts_with_prefix = content.startswith(PREFIX)
    is_reply_to_self = (
        m.reference and
        m.reference.resolved and
        isinstance(m.reference.resolved, discord.Message) and
        m.reference.resolved.author.id == client.user.id
    )

    if not (starts_with_prefix or is_reply_to_self):
        return

    # استخراج النص بدون البادئة
    if starts_with_prefix:
        final = content[len(PREFIX):].strip()
    else:
        final = content.strip()

    if not final:
        await m.reply("شقصدك؟ قولي وين أساعدك 😄")
        return

    # ───────── أمر إعادة المحادثة ─────────
    if final.lower() in ("!newchat", "محادثة جديدة", "!reset"):
        async with session_lock:
            user_sessions.pop(m.author.id, None)
        await m.reply("✅ تم مسح السياق، محادثة جديدة من الصفر!")
        return

    user_id = m.author.id

    # استرجاع أو إنشاء session
    async with session_lock:
        if user_id not in user_sessions:
            user_sessions[user_id] = {"session_id": None, "parent_message_id": None}
        us = user_sessions[user_id]

    server_info = get_server_info(m.guild)

    async with m.channel.typing():
        try:
            # ══════════════════════════════════════
            #  خطوة 1: تحديد النية (ACTION أو CHAT)
            # ══════════════════════════════════════
            intent_sys = f"""أنت محدد نية. رد بكلمة واحدة فقط: ACTION أو CHAT
ACTION = المستخدم يريد تنفيذ عملية في السيرفر (إنشاء روم، حذف، إنشاء رتبة، إلخ)
CHAT   = المستخدم يتكلم أو يسأل سؤال أو يريد معلومة

{AiAbout}

السيرفر الحالي:
{server_info}"""
            intent_prompt = f"رسالة المستخدم: {final}"

            intent_raw = await deepseek_one_shot(intent_sys, intent_prompt)
            intent     = intent_raw.strip().upper()

            print(f"[Intent] '{final}' → {intent}")

            # ══════════════════════════════════════
            #  CHAT MODE
            # ══════════════════════════════════════
            if "ACTION" not in intent:
                chat_sys = f"""تحدث مع المستخدم وساعده.
{AiAbout}

معلومات السيرفر الحالي:
{server_info}"""

                reply, new_sid, new_pmid = await deepseek_completion(
                    chat_sys, final,
                    session_id=us["session_id"],
                    parent_message_id=us["parent_message_id"]
                )

                async with session_lock:
                    us["session_id"]        = new_sid
                    us["parent_message_id"] = new_pmid

                await m.reply(reply or "مو واضح قصدك، وضح أكثر 😅")
                return

            # ══════════════════════════════════════
            #  ACTION MODE
            # ══════════════════════════════════════

            # رسالة تأكيد سريعة
            ack_sys = f"""قول للمستخدم إنك راح تحاول تنفذ طلبه.
- جملة واحدة قصيرة باللهجة العراقية
- لا تقول "خلاص" أو "خلصت" لأنك لسه ما نفذت
- مثال: "حاضر، جربلك هسه!" أو "على عيني، أشوف شأسوي"
{AiAbout}"""
            ack_res = await deepseek_one_shot(ack_sys, f"المستخدم يريد: {final}")
            await m.reply(clean_response(ack_res))

            # ══════════════════════════════════════
            #  خطوة 2: تحليل الأمر إلى JSON
            # ══════════════════════════════════════
            parser_prompt = f"""معلومات السيرفر:
{server_info}

{AiAbout}

طلب المستخدم: {final}"""

            parser_raw = await deepseek_one_shot(PARSER_SYSTEM, parser_prompt)
            print(f"[Parser Raw]\n{parser_raw}")

            # تنظيف الـ JSON
            cleaned = clean_response(parser_raw)
            # محاولة استخراج JSON من النص لو فيه نص زيادة
            json_match = re.search(r'\{[\s\S]*\}', cleaned)
            if json_match:
                cleaned = json_match.group()

            print(f"[Parser Cleaned]\n{cleaned}")

            try:
                raw = json.loads(cleaned)
            except json.JSONDecodeError as je:
                print(f"[JSON Error] {je}\nRaw: {cleaned}")
                await m.reply(f"⚠️ ما قدرت أفهم الطلب، عيد الصياغة بشكل أوضح.")
                return

            # ══════════════════════════════════════
            #  خطوة 3: تنفيذ الأوامر
            # ══════════════════════════════════════
            commands = []
            no_skill_replies = []

            for key, value in raw.items():
                if key.startswith("NoSkill"):
                    no_skill_replies.append(value.get("Reply", "ما أقدر أسوي هذا الطلب."))
                else:
                    commands.append({key: value})

            # ارسل رسائل NoSkill
            for reply in no_skill_replies:
                await m.reply(reply)

            # نفذ الأوامر
            if commands:
                results = await run_commands(commands, m.guild)
                if results:
                    result_text = "\n".join(results)
                    # تقسيم إذا طويل
                    if len(result_text) > 1900:
                        chunks = [result_text[i:i+1900] for i in range(0, len(result_text), 1900)]
                        for chunk in chunks:
                            await m.reply(chunk)
                    else:
                        await m.reply(result_text)

        except Exception as e:
            print(f"[on_message Error] {e}")
            await m.reply(f"⚠️ صار خطأ غير متوقع: {str(e)[:200]}")


# ═══════════════════════════════════════════
#                    RUN
# ═══════════════════════════════════════════
if __name__ == "__main__":
    if not USER_TOKEN:
        raise ValueError("USER_TOKEN غير موجود في environment variables")
    if not DEEPSEEK_TOKEN:
        raise ValueError("DEEPSEEK_TOKEN غير موجود في environment variables")

    client.run(USER_TOKEN)