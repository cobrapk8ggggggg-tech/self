import discord
import asyncio
import json
import os
from groq import Groq as G
from motor.motor_asyncio import AsyncIOMotorClient

MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
GUILD = None

# ================= MongoDB =================
MONGODB_URI = os.getenv("MONGODB_URI")
mongo_client = AsyncIOMotorClient(MONGODB_URI)
db = mongo_client["disor_db"]
history_col = db["history"]

# ================= KEYS =================
USER_TOKEN = os.getenv("USER_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
ALLOWED_CHANNEL_ID = int(os.getenv("ALLOWED_CHANNEL_ID", "1356830719170842710"))

disor = G(api_key=GROQ_API_KEY)

# ================= INTENTS =================
client = discord.Client()

# ================= EVENTS =================
@client.event
async def on_ready():
    print(f"Logged as: {client.user}")
    # تأكيد اتصال MongoDB
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

AiAbout = f"""
You are a Discord bot named Disor 1.
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

def disor_get_category(guild: discord.Guild, target: str):
    server_categories = {}
    for category in guild.categories:
        server_categories[category.name] = {"id": str(category.id)}

    default_categories = {
        "System": {"id": "1234567899"},
        "Generals": {"id": "1321462575"},
        "Moderators": {"id": "432534654"},
    }

    disor_category = disor.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You going to take a name of category and search for one in the list and return its id ONLY"},
            # امثلة بالعراقية
            {"role": "user", "content": f"سويلي روم اسمه chat و حطه بكاتجوري General\ncategories: {default_categories}"},
            {"role": "assistant", "content": "1321462575"},
            {"role": "user", "content": f"هذا الكاتجوري ايديه: 1321462575\ncategories: {default_categories}"},
            {"role": "assistant", "content": "1321462575"},
            {"role": "user", "content": f"دز الروم للكاتجوري مال المشرفين\ncategories: {default_categories}"},
            {"role": "assistant", "content": "432534654"},
            {"role": "user", "content": f"{target}\ncategories: {server_categories}"}
        ]
    )
    return guild.get_channel(int(disor_category.choices[0].message.content))

def disor_get_channel(guild: discord.Guild, target: str):
    server_channels = {}
    for channel in guild.channels:
        server_channels[channel.name] = {"id": str(channel.id)}

    default_channels = {
        "chat": {"id": "1234567899"},
        "voice 1": {"id": "1321462575"},
        "welcomes": {"id": "432534654"},
    }

    disor_channel = disor.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You going to take a name of category and search for one in the list and return its id ONLY"},
            {"role": "user", "content": f"شات العام\nchannels: {default_channels}"},
            {"role": "assistant", "content": "1234567899"},
            {"role": "user", "content": f"الروم الصوتي مال رقم 1\nchannels: {default_channels}"},
            {"role": "assistant", "content": "1321462575"},
            {"role": "user", "content": f"welcomes | ترحيب\nchannels: {default_channels}"},
            {"role": "assistant", "content": "432534654"},
            {"role": "user", "content": f"{target}\nchannels: {server_channels}"}
        ]
    )
    return guild.get_channel(int(disor_channel.choices[0].message.content))

def disor_get_role(guild: discord.Guild, target: str):
    server_roles = {}
    for role in guild.roles:
        server_roles[role.name] = {
            "id": str(role.id),
            "color": str(role.color)
        }

    default_roles = {
        "vip": {"id": "1234567899", "color": "#ff0000"},
        "admin": {"id": "1321462575", "color": "#00ff00"},
        "member": {"id": "432534654", "color": "#0000ff"},
    }

    disor_role = disor.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You going to take a name of role and search for one in the list and return its id ONLY"},
            {"role": "user", "content": f"الرول الأحمر\nroles: {default_roles}"},
            {"role": "assistant", "content": "1234567899"},
            {"role": "user", "content": f"الادمن | admin\nroles: {default_roles}"},
            {"role": "assistant", "content": "1321462575"},
            {"role": "user", "content": f"العضو او ممبر\nroles: {default_roles}"},
            {"role": "assistant", "content": "432534654"},
            {"role": "user", "content": f"{target}\nroles: {server_roles}"}
        ]
    )
    return guild.get_role(int(disor_role.choices[0].message.content))

def disor_get_member(guild: discord.Guild, target: str):
    server_members = {}
    for member in guild.members:
        server_members[member.name] = {
            "id": str(member.id),
            "global_name": str(member.global_name)
        }

    default_members = {
        "ahmed": {"id": "1234567899", "global_name": "Hamada"},
        "mostafa": {"id": "1321462575", "global_name": "MOSTAFA IZ"},
        "mohammed": {"id": "432534654", "global_name": "Zigzag 0C"},
    }

    sorted_members = ""
    for member in server_members:
        sorted_members += f"{member}: {server_members[member]['global_name']} ({server_members[member]['id']})\n"

    disor_member = disor.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You going to take a name of member and search for one in the list and return its id ONLY\n- Don't chat with me, return ID ONLY!\n- be direct and return ID\n- if you found two or more members with the same name choose one of them randomly"},
            {"role": "user", "content": f"حمادة\nMembers: {default_members}"},
            {"role": "assistant", "content": "1234567899"},
            {"role": "user", "content": f"mostafa iz\nMembers: {default_members}"},
            {"role": "assistant", "content": "1321462575"},
            {"role": "user", "content": f"Zigzag\nMembers: {default_members}"},
            {"role": "assistant", "content": "432534654"},
            {"role": "user", "content": f"{target}\nMembers:\n{sorted_members}"}
        ]
    )
    return guild.get_member(int(disor_member.choices[0].message.content))

async def run_commands(commands: list, guild: discord.Guild):
    for command in commands:
        for key in command:
            await asyncio.sleep(1)
            if key.startswith("CreateChannel"):
                print(f"Running command: Creating channel")
                if command[key]["Type"] == "text":
                    channel = await guild.create_text_channel(name=command[key]["Name"])
                    if command[key]["Category"] is not None:
                        await channel.edit(category=disor_get_category(guild, command[key]["Category"]))
                elif command[key]["Type"] == "voice":
                    channel = await guild.create_voice_channel(name=command[key]["Name"])
                    if command[key]["Category"] is not None:
                        await channel.edit(category=disor_get_category(guild, command[key]["Category"]))

            elif key.startswith("DeleteChannel"):
                print(f"Running command: Deleting channel")
                channel = disor_get_channel(guild, command[key]["Name"])
                await channel.delete()

            elif key.startswith("EditChannelName"):
                print(f"Running command: Changing channel name")
                channel = disor_get_channel(guild, command[key]["Channel"])
                await channel.edit(name=command[key]["Name"])

            elif key.startswith("CreateRole"):
                print(f"Running command: Creating role")
                role = await guild.create_role(
                    name=command[key]["Name"],
                    colour=discord.Colour.from_str(command[key]["Color"])
                )
                perms = discord.Permissions(**command[key]["Perms"])
                await role.edit(permissions=perms)
                await guild.edit_role_positions(positions={role: command[key]["Position"] + 1})

            elif key.startswith("GrantRole"):
                print(f"Running command: Giving role")
                member = disor_get_member(guild, command[key]["Member"])
                role_to_grant = disor_get_role(guild, command[key]["Name"])
                await member.add_roles(role_to_grant)

            elif key.startswith("CreateCategory"):
                print(f"Running command: Creating category")
                await guild.create_category(name=command[key]["Name"])

# ================= MESSAGE HANDLER =================
@client.event
async def on_message(m: discord.Message):
    if m.author.id == client.user.id:
        return

    if m.channel.id == ALLOWED_CHANNEL_ID:
        if client.user.mention in m.content:
            final = m.content.replace(client.user.mention, "")

            async with m.channel.typing():
                response = disor.chat.completions.create(
                    model=MODEL,
                    messages=[
                        {"role": "system", "content": f"Look at the user message and see if he wants to talk or want action, also if the user is asking questions return 'USER_IS_MESSAGING'\nAbout you: {AiAbout}\nDON'T chat with the user just take his message and return: 'USER_IS_MESSAGING' or 'USER_WANTS_ACTION' ONLY"},
                        # امثلة بالعراقية
                        {"role": "user", "content": "شلونك يمعود"},
                        {"role": "assistant", "content": "USER_IS_MESSAGING"},
                        {"role": "user", "content": "ممكن تطرد هذا الشخص من السيرفر"},
                        {"role": "assistant", "content": "USER_WANTS_ACTION"},
                        {"role": "user", "content": "الو"},
                        {"role": "assistant", "content": "USER_IS_MESSAGING"},
                        {"role": "user", "content": "سويلي روم اسمه chat"},
                        {"role": "assistant", "content": "USER_WANTS_ACTION"},
                        {"role": "user", "content": "هلا"},
                        {"role": "assistant", "content": "USER_IS_MESSAGING"},
                        {"role": "user", "content": final},
                    ]
                )

                print(response.choices[0].message.content)
                if response.choices[0].message.content.startswith("USER_IS_MESSAGING"):
                    chatbot = disor.chat.completions.create(
                        model=MODEL,
                        messages=[
                            {"role": "system", "content": f"تحدث إلى المستخدم وساعده أو قدم له أي مساعدة يطلبها...\nAbout you: {AiAbout}\nServer Information:\n{return_server_info(m.guild)}"},
                            {"role": "user", "content": final}
                        ]
                    )
                    await m.reply(chatbot.choices[0].message.content)

                elif response.choices[0].message.content.startswith("USER_WANTS_ACTION"):
                    actioner = disor.chat.completions.create(
                        model=MODEL,
                        messages=[
                            {"role": "system", "content": f"""You tell the user you will TRY to do the action, but you're not sure if it will succeed.
                            - Say things like 'let me try' or 'give me a sec' or 'on it'
                            - NEVER say 'done' or 'completed' because you don't know yet
                            - Keep it short, one sentence only
                            About you: {AiAbout}"""},
                            # امثلة بالعراقية
                            {"role": "user", "content": "سويلي روم اسمه chat"},
                            {"role": "assistant", "content": "خليني اشوف، ثواني"},
                            {"role": "user", "content": "طرد هذا الشخص"},
                            {"role": "assistant", "content": "دعني احاول"},
                            {"role": "user", "content": "شيل هذا الروم"},
                            {"role": "assistant", "content": "تمام، لحظة"},
                            {"role": "user", "content": final}
                        ]
                    )

                    # حفظ بالـ MongoDB بدل القائمة
                    await history_col.insert_one({"role": "user", "content": ""})

                    await m.reply(actioner.choices[0].message.content)

                    commands = []

                    parser = disor.chat.completions.create(
                        model=MODEL,
                        messages=[
                            {"role": "system", "content": f"""Take the user input and reply with JSON only NEVER CHANGE THE JSON FORMAT.

                            If the user asks for something NOT in your available skills/actions (check "About you" below), respond with:
                            {{"NoSkill0": {{"Reply": "رد طبيعي هنا يوضح إنك معرفش تعمل الطلب ده"}}}}

                            Format: {{"CreateChannel0": {{"Name": "...", "Type": "..."}}}}
                             
                            ⚠️ NEVER leave a field empty ("") or omit a key if information is missing.
                            If information is not provided or not found in Server Information, use these defaults:
                            - "Name": generate a reasonable name based on context, NEVER leave empty
                            - "Color": "#99AAB5" (Discord's default role color)
                            - "Position": 0 (bottom, just above @everyone)
                            - "Perms": none (no special permissions) (THIS IS THE IMPORTANT KEY, DON'T REMOVE IT!!!)
                            
                            Server Information:
                            {return_server_info(m.guild)}

                            if the user asked you to put a role higher than role, just type in 'Position' key the target role Pos
                            if the user asked you to put a role lower than role, just type in 'Position' key the target role Pos - 1

                            About you: {AiAbout}"""},
                            # امثلة بالعراقية
                            {"role": "user", "content": "سويلي روم اسمه chat"},
                            {"role": "assistant", "content": "{\"CreateChannel0\": {\"Name\": \"chat\", \"Type\": \"text\", \"Category\": null}}"},
                            {"role": "user", "content": "سويلي روم اسمه chat و روم ثاني اسمه welcome"},
                            {"role": "assistant", "content": "{\"CreateChannel0\": {\"Name\": \"chat\", \"Type\": \"text\", \"Category\": null}, \"CreateChannel1\": {\"Name\": \"welcome\", \"Type\": \"text\", \"Category\": null}}"},
                            {"role": "user", "content": "سويلي روم صوتي اسمه voice 1"},
                            {"role": "assistant", "content": "{\"CreateChannel0\": {\"Name\": \"voice 1\", \"Type\": \"voice\", \"Category\": null}}"},
                            {"role": "user", "content": "سويلي روم اسمه chat و حطه بكاتجوري General"},
                            {"role": "assistant", "content": "{\"CreateChannel0\": {\"Name\": \"chat\", \"Type\": \"text\", \"Category\": \"General\"}}"},
                            {"role": "user", "content": "شيل الروم اللي اسمه chat"},
                            {"role": "assistant", "content": "{\"DeleteChannel0\": {\"Name\": \"chat\"}}"},
                            {"role": "user", "content": "غير اسم الروم chat لـ welcome"},
                            {"role": "assistant", "content": "{\"EditChannelName0\": {\"Channel\": \"chat\", \"Name\": \"welcome\"}}"},
                            {"role": "user", "content": "غير اسم الروم اللي اسمه chat لـ welcome"},
                            {"role": "assistant", "content": "{\"EditChannelName0\": {\"Channel\": \"chat\", \"Name\": \"welcome\"}}"},
                            {"role": "user", "content": "سويلي رتبة اسمها VIP لونها اخضر و اعطيها صلاحية add_reactions"},
                            {"role": "assistant", "content": "{\"CreateRole0\": {\"Name\": \"VIP\", \"Color\": \"#00FF00\", \"Position\": 0, \"Perms\": {\"add_reactions\": true}}}"},
                            {"role": "user", "content": "انطي العضو محمد رتبة الادمن اللي لونها ازرق"},
                            {"role": "assistant", "content": "{\"GrantRole0\": {\"Name\": \"ادمن اللي لونها ازرق\", \"Member\": \"محمد\"}}"},
                            {"role": "user", "content": "بلكي اعمل كاتجوري اسمها Generals"},
                            {"role": "assistant", "content": "{\"CreateCategory0\": {\"Name\": \"Generals\"}}"},
                            {"role": "user", "content": final}
                        ]
                    )

                    print(parser.choices[0].message.content)

                    try:
                        raw = json.loads(parser.choices[0].message.content)
                        for key, value in raw.items():
                            if key.startswith("NoSkill"):
                                await m.reply(raw[key]["Reply"])
                            else:
                                commands.append({key: value})
                    except Exception as e:
                        await m.reply(parser.choices[0].message.content)

                    await run_commands(commands, m.guild)

# ================= RUN =================
client.run(USER_TOKEN)