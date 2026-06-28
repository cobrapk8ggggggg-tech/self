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

# ================= MongoDB =================
MONGODB_URI = os.getenv("MONGODB_URI")
mongo_client = AsyncIOMotorClient(MONGODB_URI)
db = mongo_client["disor_db"]
history_col = db["history"]

# ================= KEYS =================
USER_TOKEN = os.getenv("USER_TOKEN")
DEEPSEEK_TOKEN = os.getenv("DEEPSEEK_TOKEN")
ALLOWED_CHANNEL_ID = int(os.getenv("ALLOWED_CHANNEL_ID", "1356830719170842710"))

# ================= سياقات المستخدمين (لكل مستخدم جلسة خاصة) =================
user_sessions = {}   # user_id -> {"session_id": str, "parent_message_id": str}
session_lock = asyncio.Lock()

# ================= DeepSeek API helpers =================
RAILWAY_SERVER_URL = "https://web-production-c09dc.up.railway.app"
POW_API_URL = f"{RAILWAY_SERVER_URL}/pow"

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
        'User-Agent': 'DeepSeek/2.1.1 Android/36',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '2.1.1',
        'x-client-locale': 'ar',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-rangers-id': generate_rangers_id(),
        'x-client-timezone-offset': get_tz_offset(),
        'x-device-id': generate_device_id(),
        'x-os-version': '30',
        'x-app-version': '2.1.1',
        'Authorization': f'Bearer {token}',
        'X-DS-PoW-Response': pow_response,
        'accept-charset': 'UTF-8',
    }

def clean_response(text: str) -> str:
    """إزالة كلمات FINISHEDSEARCH و FINISHED من الرد"""
    text = re.sub(r'\bFINISHEDSEARCH\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\bFINISHED\b', '', text, flags=re.IGNORECASE)
    return text.strip()

async def get_fresh_pow(token):
    try:
        async with aiohttp.ClientSession() as session:
            url = f"{POW_API_URL}?authorization={token}"
            async with session.get(url) as resp:
                if resp.status != 200:
                    async with session.get(POW_API_URL) as fallback_resp:
                        if fallback_resp.status != 200:
                            raise Exception(f"POW failed: {fallback_resp.status}")
                        data = await fallback_resp.json()
                else:
                    data = await resp.json()
            if not data.get('pow_response') and not data.get('x_ds_pow_response'):
                raise Exception("Incomplete POW response")
            return {
                'pow_response': data.get('x_ds_pow_response') or data['pow_response'],
                'pow_data': data.get('solved_json')
            }
    except Exception as e:
        print(f"Error getting POW: {e}")
        raise

async def create_chat_session(token):
    url = "https://chat.deepseek.com/api/v0/chat_session/create"
    headers = {
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-client-platform': 'web',
        'x-client-version': '2.0.0',
        'x-client-locale': 'en_US',
        'x-client-timezone-offset': get_tz_offset(),
        'x-app-version': '2.0.0',
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'Accept': '*/*'
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json={}) as resp:
            data = await resp.json()
            if data.get('data', {}).get('biz_data', {}).get('chat_session', {}).get('id'):
                return data['data']['biz_data']['chat_session']['id']
            else:
                raise Exception('Invalid session response: ' + json.dumps(data))

async def deepseek_simple_completion(system_content, user_content, session_id=None, parent_message_id=None, search_enabled=False, thinking_enabled=False):
    prompt = f"{system_content}\n\nUser: {user_content}" if system_content else user_content
    token = DEEPSEEK_TOKEN
    if not token:
        raise Exception("DEEPSEEK_TOKEN not set")

    if session_id is None:
        session_id = await create_chat_session(token)

    pow_data = await get_fresh_pow(token)
    headers = build_headers(pow_data['pow_response'], token)

    payload = {
        "chat_session_id": session_id,
        "parent_message_id": parent_message_id,
        "prompt": prompt,
        "ref_file_ids": [],
        "thinking_enabled": thinking_enabled,
        "search_enabled": search_enabled,
        "model_type": "default",
        "action": None,
        "preempt": False,
        "pow": pow_data['pow_data'],
        "stream": True
    }

    url = "https://chat.deepseek.com/api/v0/chat/completion"

    full_text = ""
    new_parent_message_id = None
    first_chunk_processed = False

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise Exception(f"DeepSeek API error {resp.status}: {text}")
            buffer = ""
            async for chunk in resp.content.iter_chunked(1024):
                text = chunk.decode('utf-8')
                buffer += text
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if line.startswith("data: "):
                        data_str = line[6:]
                        try:
                            data = json.loads(data_str)
                            if not first_chunk_processed:
                                if 'request_message_id' in data and 'response_message_id' in data:
                                    new_parent_message_id = data['response_message_id']
                                    first_chunk_processed = True
                            v = data.get('v')
                            if v:
                                if isinstance(v, str):
                                    full_text += v
                                elif isinstance(v, dict) and 'response' in v:
                                    fragments = v['response'].get('fragments', [])
                                    for frag in fragments:
                                        if frag['type'] == 'RESPONSE':
                                            full_text += frag.get('content', '')
                        except:
                            pass
            if buffer.startswith("data: "):
                try:
                    data = json.loads(buffer[6:])
                    if not first_chunk_processed and 'request_message_id' in data and 'response_message_id' in data:
                        new_parent_message_id = data['response_message_id']
                    v = data.get('v')
                    if isinstance(v, str):
                        full_text += v
                    elif isinstance(v, dict):
                        for frag in v.get('response', {}).get('fragments', []):
                            if frag['type'] == 'RESPONSE':
                                full_text += frag.get('content', '')
                except:
                    pass
    return clean_response(full_text), session_id, new_parent_message_id

# ================= INTENTS =================
client = discord.Client()

def get_bot_info():
    """الحصول على معلومات البوت تلقائياً من التوكن"""
    name = client.user.name if client.user else "Disor 1"
    uid = client.user.id if client.user else 0
    return name, uid

def build_ai_about(bot_name: str) -> str:
    return f"""
You are a Discord bot named {bot_name}.
- Talk in Arabic only, NEVER use any other language
- You help users manage their Discord server
- talk friendly and talk with اللهجة العراقية العامية

What you can do?
you can Only do these skills:
- Create Channels: Voices, Text and add them to categories
- Delete Channels
- Edit Channel Name
- Create Roles
- Give Roles
- Create Categories
- more soon...

Aliases:
Channel: روم - شات - غرفة - قناة - شانل
Voice: فويس - صوتي
Role: رول - رتبة

Discord Permissions:
⚙️ General Server Permissions

administrator: Grants all permissions and bypasses channel restrictions. (this role is so dengerous to grant, its make the user like the server owner)

manage_channels: Create, edit, or delete channels.
manage_roles: Create, edit, or delete roles.
manage_expressions: Create, edit, or delete custom emojis, stickers, and sounds.
view_audit_log: View the server's history of actions.
view_guild_insights: View server analytics and data.
manage_webhooks: Create, edit, or delete webhooks.
manage_guild: Change the server name, region, or settings.
create_instant_invite: Generate invite links.
change_nickname: Change own nickname.
manage_nicknames: Change other members' nicknames.
kick_members: Kick members from the server.
ban_members: Permanently ban members.
manage_events: Create, edit, or delete scheduled events.
moderate_members: Timeout members or approve membership requests.
view_creator_monetization_analytics: View team monetization statistics. [1, 2, 3, 4, 5]

💬 Text Permissions
view_channel: Read text channels and see voice channels.
send_messages: Send messages in text channels.
send_messages_in_threads: Send messages within threads.
create_public_threads: Create threads visible to everyone.
create_private_threads: Create threads visible only to invited users.
embed_links: Allow links to generate rich previews.
attach_files: Upload files and images.
add_reactions: Add new emoji reactions to messages.
external_emojis: Use emojis from other servers.
external_stickers: Use stickers from other servers.
mention_everyone: Notify everyone via @everyone or @here tags.
manage_messages: Delete or pin messages.
manage_threads: Rename, archive, or delete threads.
read_message_history: View past messages in a channel.
send_tts_messages: Use the text-to-speech /tts command.
use_application_commands: Use slash commands and context menus.
send_voice_messages: Send audio voice messages. [1, 2, 3, 4, 5]

🔊 Voice Permissions
connect: Join voice or stage channels.
speak: Talk in voice channels.
stream: Stream video or share screens.
use_embedded_activities: Start and play Discord Activities.
use_voice_activation: Talk without using push-to-talk.
priority_speaker: Reduce other users' volume when speaking.
mute_members: Mute other users in voice.
deafen_members: Deafen other users in voice.
move_members: Move users between voice channels.
request_to_speak: Request to talk in Stage channels.
use_soundboard: Use soundboard sounds in voice.
use_external_sounds: Use sounds from other servers

⚠️ IMPORTANT: The role's NAME does not determine its permissions.
A role named "Admin", "Moderator", "Staff", etc. does NOT automatically need 
"administrator": true.

Only set "administrator": true if the user EXPLICITLY says something like:
- "give it administrator permission"
- "full admin access" / "كل الصلاحيات"
- "owner-level permissions"
- "give it the administrator permission specifically"

If the user just says "create an Admin role with what it needs" WITHOUT 
explicitly requesting "administrator" permission itself, infer the SPECIFIC 
permissions needed instead (manage_roles, manage_channels, kick_members, 
ban_members, manage_messages, manage_guild, moderate_members, etc.)

When in doubt, prefer specific permissions over "administrator": true.
"""

# ستُملأ عند التشغيل
AiAbout = ""

# ================= EVENTS =================
@client.event
async def on_ready():
    global AiAbout
    name, uid = get_bot_info()
    AiAbout = build_ai_about(name)
    print(f"Logged as: {name} ({uid})")
    try:
        await mongo_client.admin.command("ping")
        print("MongoDB connected.")
    except Exception as e:
        print(f"MongoDB connection error: {e}")

# ================= HELPERS =================
def return_server_info(guild: discord.Guild):
    if not guild:
        return ""
    info = ""
    info += f"Server: {guild.name} - {guild.id}\nCategories:\n"
    for category in guild.categories:
        info += f"- {category.name} ({category.id})\n"
    info += "Channels:\n"
    for channel in guild.channels:
        info += f"- {channel.name} ({channel.id})\n"
    info += "Roles:\n"
    for role in guild.roles:
        info += f"- Pos: {role.position}, Name: {role.name} ({role.id})\n"
    return info

async def disor_get_category(guild: discord.Guild, target: str):
    server_categories = {category.name: str(category.id) for category in guild.categories}
    system_msg = "You going to take a name of category and search for one in the list and return its id ONLY"
    user_msg = f"{target}\ncategories: {server_categories}"
    full_prompt = f"{system_msg}\n{user_msg}"
    text, _, _ = await deepseek_simple_completion(None, full_prompt, parent_message_id=None)
    try:
        cat_id = int(text.strip())
        return guild.get_channel(cat_id)
    except:
        return None

async def disor_get_channel(guild: discord.Guild, target: str):
    server_channels = {channel.name: str(channel.id) for channel in guild.channels}
    system_msg = "You going to take a name of channel and search for one in the list and return its id ONLY"
    user_msg = f"{target}\nchannels: {server_channels}"
    full_prompt = f"{system_msg}\n{user_msg}"
    text, _, _ = await deepseek_simple_completion(None, full_prompt, parent_message_id=None)
    try:
        ch_id = int(text.strip())
        return guild.get_channel(ch_id)
    except:
        return None

async def disor_get_role(guild: discord.Guild, target: str):
    server_roles = {role.name: {"id": str(role.id), "color": str(role.color)} for role in guild.roles}
    system_msg = "You going to take a name of role and search for one in the list and return its id ONLY"
    user_msg = f"{target}\nroles: {server_roles}"
    full_prompt = f"{system_msg}\n{user_msg}"
    text, _, _ = await deepseek_simple_completion(None, full_prompt, parent_message_id=None)
    try:
        role_id = int(text.strip())
        return guild.get_role(role_id)
    except:
        return None

async def disor_get_member(guild: discord.Guild, target: str):
    server_members = {}
    sorted_members = ""
    for member in guild.members:
        server_members[member.name] = {"id": str(member.id), "global_name": str(member.global_name)}
        sorted_members += f"{member.name}: {member.global_name} ({member.id})\n"
    system_msg = "You going to take a name of member and search for one in the list and return its id ONLY\n- Don't chat with me, return ID ONLY!\n- be direct and return ID\n- if you found two or more members with the same name choose one of them randomly"
    user_msg = f"{target}\nMembers:\n{sorted_members}"
    full_prompt = f"{system_msg}\n{user_msg}"
    text, _, _ = await deepseek_simple_completion(None, full_prompt, parent_message_id=None)
    try:
        member_id = int(text.strip())
        return guild.get_member(member_id)
    except:
        return None

async def run_commands(commands: list, guild: discord.Guild):
    for command in commands:
        for key in command:
            await asyncio.sleep(1)
            try:
                if key.startswith("CreateChannel"):
                    print(f"Running: CreateChannel")
                    if command[key]["Type"] == "text":
                        channel = await guild.create_text_channel(name=command[key]["Name"])
                        if command[key].get("Category"):
                            cat = await disor_get_category(guild, command[key]["Category"])
                            if cat:
                                await channel.edit(category=cat)
                    elif command[key]["Type"] == "voice":
                        channel = await guild.create_voice_channel(name=command[key]["Name"])
                        if command[key].get("Category"):
                            cat = await disor_get_category(guild, command[key]["Category"])
                            if cat:
                                await channel.edit(category=cat)

                elif key.startswith("DeleteChannel"):
                    print(f"Running: DeleteChannel")
                    channel = await disor_get_channel(guild, command[key]["Name"])
                    if channel:
                        await channel.delete()

                elif key.startswith("EditChannelName"):
                    print(f"Running: EditChannelName")
                    channel = await disor_get_channel(guild, command[key]["Channel"])
                    if channel:
                        await channel.edit(name=command[key]["Name"])

                elif key.startswith("CreateRole"):
                    print(f"Running: CreateRole")
                    role = await guild.create_role(
                        name=command[key]["Name"],
                        colour=discord.Colour.from_str(command[key]["Color"])
                    )
                    perms = discord.Permissions(**command[key]["Perms"])
                    await role.edit(permissions=perms)
                    await guild.edit_role_positions(positions={role: command[key]["Position"] + 1})

                elif key.startswith("GrantRole"):
                    print(f"Running: GrantRole")
                    member = await disor_get_member(guild, command[key]["Member"])
                    role_to_grant = await disor_get_role(guild, command[key]["Name"])
                    if member and role_to_grant:
                        await member.add_roles(role_to_grant)

                elif key.startswith("CreateCategory"):
                    print(f"Running: CreateCategory")
                    await guild.create_category(name=command[key]["Name"])
            except Exception as e:
                print(f"Command error: {e}")

# ================= MESSAGE HANDLER =================
@client.event
async def on_message(m: discord.Message):
    if m.author.id == client.user.id:
        return

    if m.channel.id != ALLOWED_CHANNEL_ID:
        return

    # التحقق من التفاعل: منشن أو رد على رسالة البوت
    is_mention = client.user.mention in m.content
    is_reply_to_bot = (
        m.reference and
        m.reference.resolved and
        isinstance(m.reference.resolved, discord.Message) and
        m.reference.resolved.author.id == client.user.id
    )

    if not (is_mention or is_reply_to_bot):
        return

    user_id = m.author.id

    # استخراج النص
    if is_mention:
        final = m.content.replace(client.user.mention, "").strip()
    else:
        final = m.content.strip()

    if not final:
        return

    # أمر إعادة تعيين المحادثة
    if final.startswith("!newchat") or final.strip() == "محادثة جديدة":
        async with session_lock:
            if user_id in user_sessions:
                del user_sessions[user_id]
        await m.reply("تم بدء محادثة جديدة، السياق السابق ألغي.")
        return

    async with session_lock:
        if user_id not in user_sessions:
            user_sessions[user_id] = {"session_id": None, "parent_message_id": None}
        us = user_sessions[user_id]

    async with m.channel.typing():
        # ==== تصنيف النية ====
        intent_system = f"""Look at the user message and see if he wants to talk or want action, also if the user is asking questions return 'USER_IS_MESSAGING'
About you: {AiAbout}
DON'T chat with the user just take his message and return: 'USER_IS_MESSAGING' or 'USER_WANTS_ACTION' ONLY"""
        intent_prompt = f"User message: {final}"
        intent_res, _, _ = await deepseek_simple_completion(
            intent_system, intent_prompt,
            session_id=us["session_id"],
            parent_message_id=None
        )
        intent = clean_response(intent_res).strip()

        if intent.startswith("USER_IS_MESSAGING"):
            # ==== دردشة عادية ====
            chat_system = f"تحدث إلى المستخدم وساعده أو قدم له أي مساعدة يطلبها...\nAbout you: {AiAbout}\nServer Information:\n{return_server_info(m.guild)}"
            chat_res, new_sid, new_parent = await deepseek_simple_completion(
                chat_system, final,
                session_id=us["session_id"],
                parent_message_id=us["parent_message_id"]
            )
            async with session_lock:
                us["session_id"] = new_sid
                us["parent_message_id"] = new_parent
            await m.reply(chat_res)

        elif intent.startswith("USER_WANTS_ACTION"):
            # ==== طلب إجراء ====
            ack_system = f"""You tell the user you will TRY to do the action, but you're not sure if it will succeed.
- Say things like 'let me try' or 'give me a sec' or 'on it'
- NEVER say 'done' or 'completed' because you don't know yet
- Keep it short, one sentence only
About you: {AiAbout}"""
            ack_prompt = f"User wants: {final}"
            ack_res, _, _ = await deepseek_simple_completion(
                ack_system, ack_prompt,
                session_id=us["session_id"],
                parent_message_id=None
            )
            await m.reply(clean_response(ack_res))

            # ==== تحليل الأمر إلى JSON ====
            parser_system = f"""Take the user input and reply with JSON only NEVER CHANGE THE JSON FORMAT.

If the user asks for something NOT in your available skills/actions (check "About you" below), respond with:
{{"NoSkill0": {{"Reply": "رد طبيعي هنا يوضح إنك معرفش تعمل الطلب ده"}}}}

Format: {{"CreateChannel0": {{"Name": "...", "Type": "..."}}}}

⚠️ NEVER leave a field empty ("") or omit a key if information is missing.
If information is not provided or not found in Server Information, use these defaults:
- "Name": generate a reasonable name based on context, NEVER leave empty
- "Color": "#99AAB5" (Discord's default role color)
- "Position": 0 (bottom, just above @everyone)
- "Perms": {{}} (no special permissions) (THIS IS THE IMPORTANT KEY, DON'T REMOVE IT!!!)

Server Information:
{return_server_info(m.guild)}

if the user asked you to put a role higher than role, just type in 'Position' key the target role Pos
if the user asked you to put a role lower than role, just type in 'Position' key the target role Pos - 1

About you: {AiAbout}"""
            parser_prompt = f"User request: {final}"
            parser_res, _, _ = await deepseek_simple_completion(
                parser_system, parser_prompt,
                session_id=us["session_id"],
                parent_message_id=None
            )
            cleaned = clean_response(parser_res)
            print("Parser output:", cleaned)
            try:
                raw = json.loads(cleaned)
                commands = []
                for key, value in raw.items():
                    if key.startswith("NoSkill"):
                        await m.reply(value["Reply"])
                    else:
                        commands.append({key: value})
                if commands:
                    await run_commands(commands, m.guild)
            except json.JSONDecodeError as e:
                await m.reply(f"⚠️ حدث خطأ في تحليل الأمر. تأكد من صيغة الطلب.\nالتفاصيل: {e}")

# ================= RUN =================
client.run(USER_TOKEN)