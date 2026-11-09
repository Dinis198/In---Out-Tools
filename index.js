require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, PermissionFlagsBits, MessageFlags, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes,
} = require('discord.js');

// ╔════════════════════════════════════════════════════════════╗
// ║  BOT NAME: write the name between the quotes.              ║
// ║  It is used everywhere (embeds, commands, DMs, status...). ║
// ╚════════════════════════════════════════════════════════════╝
const BOT_NAME = 'In-&-Out Tools';

// true = when the bot starts, it also changes its server nickname and its account name to BOT_NAME.
// (Discord only allows 2 account-name changes per hour.)
const RENAME_BOT = false;

// ╔════════════════════════════════════════════════════════════╗
// ║  FEATURES: true = ON, false = OFF                          ║
// ║  A feature that is OFF has no commands and does not run.   ║
// ║  Restart the bot after changing anything here.             ║
// ╚════════════════════════════════════════════════════════════╝
const FEATURES = {
  pointsSystem: false,           // /points and /leaderboard (needs points.js)
  autoRank: false,               // promotes people when they reach the points set in points.js (needs pointsSystem)
  rankApplicationSystem: false, // Application Center + Rank Center promotions (needs queue.js)
  privateMessages: true,        // /pm (needs points.js)
  bans: true,                   // /ban, /unban and /get-ban
  setRank: true,                // /setrank
  requests: false,               // /request-punish and /request-rank (with Approve / Deny buttons)
  suggestions: true,            // /suggest
  tags: false,                   // /tag
  getId: true,                  // /get-id
  memberCounter: true,          // the "We've reached X members" message
  statusRotation: true,         // the Playing/Watching status that changes every few minutes
  sessions: false,
};

// Which feature each command belongs to
const COMMAND_FEATURE = {
  points: 'pointsSystem', leaderboard: 'pointsSystem',
  pm: 'privateMessages',
  ban: 'bans', unban: 'bans', 'get-ban': 'bans',
  setrank: 'setRank',
  'request-punish': 'requests', 'request-rank': 'requests',
  suggest: 'suggestions',
  tag: 'tags',
  'get-id': 'getId',
  session: 'sessions'
};
const commandEnabled = name => !COMMAND_FEATURE[name] || FEATURES[COMMAND_FEATURE[name]];

// ---------- STATUS (changes automatically) ----------
// Edit this list to choose what appears under the bot's name. "{brand}" is replaced by the bot name.
// type: 'playing' | 'watching' | 'listening' | 'competing'
const PRESENCES = [
  { type: 'watching', text: 'Promotion Logs' },
  { type: 'playing', text: 'Fresh Bay Store' },
  { type: 'listening', text: 'The Community' },
  { type: 'watching', text: 'Logs' },
  { type: 'watching', text: 'Requests' },
];
const PRESENCE_INTERVAL_MIN = 5; // how often the status changes (minutes)

// ---------- TICKET TAGS (/tag) ----------
// Quick replies that staff can send. "name" is what you pick in /tag (letters, numbers, dashes).
// "{brand}" is replaced by the bot name.
const TAGS = [
  { name: 'welcome', title: 'Welcome to {brand} support', text: 'Hello! A staff member will be with you shortly. Please describe your issue in as much detail as possible.' },
  { name: 'evidence', title: 'Evidence needed', text: 'Please send clear evidence (screenshots or a video) so we can look into this.' },
  { name: 'wait', title: 'Please wait', text: "We're looking into your ticket. Thank you for your patience!" },
  { name: 'resolved', title: 'Ticket resolved', text: 'It looks like your issue has been resolved. If you need anything else, feel free to open a new ticket.' },
];

// ---------- CONFIG ----------
const BRAND = BOT_NAME;
const getBrand = () => BRAND;
const withBrand = s => String(s).replaceAll('{brand}', BRAND);

const {
  TOKEN, GUILD_ID, ROBLOX_API_KEY, ROBLOX_GROUP_ID,
  REQUESTS_CHANNEL_ID, SUGGESTIONS_CHANNEL_ID, LOG_CHANNEL_ID,
} = process.env;
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
const UNIVERSE_IDS = list(process.env.ROBLOX_UNIVERSE_IDS);
const STAFF_ROLE_IDS = list(process.env.STAFF_ROLE_IDS);
// Discord roles whose requests run automatically ("everyone" = all members)
const AUTO_ROLE_IDS = list(process.env.AUTO_APPROVE_ROLE_IDS);
// Auto actions only apply up to this group rank (empty = no limit)
const AUTO_MAX_RANK = process.env.AUTO_MAX_RANK ? Number(process.env.AUTO_MAX_RANK) : null;

// ---------- MEMBER COUNTER ----------
// Posts (and keeps editing) ONE message like:
// "🎉 We've reached 506,639 members! We are 361 away from 507,000."
const COUNTER_CHANNEL_ID = process.env.COUNTER_CHANNEL_ID;                      // text channel for the message
const COUNTER_SOURCE = (process.env.COUNTER_SOURCE || 'roblox').toLowerCase();  // 'roblox' (group) or 'discord' (server)
const COUNTER_INTERVAL_MIN = 5;                                                 // how often it updates (minutes)
const toNum = v => (v && Number(v) > 0 ? Number(v) : null);
const MEMBER_GOAL = toNum(process.env.MEMBER_GOAL);                // your goal
const MEMBER_BACKUP_GOAL = toNum(process.env.MEMBER_BACKUP_GOAL);  // reserve goal if you don't edit yours

const EPH = { flags: MessageFlags.Ephemeral };
const COLORS = { pending: 0xfee75c, ok: 0x57f287, bad: 0xed4245, info: 0x5865f2 };

// ---------- Storage ----------
const DB_FILE = './data.json';
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
db.suggestions = db.suggestions || {};
db.nextSuggestion = db.nextSuggestion || 1;
db.requests = db.requests || {};
db.counterMessageId = db.counterMessageId || null;
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on('error', console.error);
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
const guildOf = () => client.guilds.cache.get(GUILD_ID);

// ---------- Automatic status rotation ----------
const PRESENCE_TYPES = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};
let presenceIndex = 0;

function applyPresence() {
  if (!client.user || !PRESENCES.length) return;
  const p = PRESENCES[presenceIndex % PRESENCES.length];
  client.user.setPresence({
    status: 'online',
    activities: [{ name: withBrand(p.text), type: PRESENCE_TYPES[p.type] ?? ActivityType.Playing }],
  });
  presenceIndex = (presenceIndex + 1) % PRESENCES.length;
}

// ---------- Roblox helpers ----------
async function rbx(method, url, body) {
  if (!ROBLOX_API_KEY) throw new Error('ROBLOX_API_KEY is missing');
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.message || data.raw || (Object.keys(data).length ? JSON.stringify(data) : '');
    const err = new Error(`Roblox API error (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function getRobloxUser(username) {
  const name = (username || '').trim();
  if (!name) return null;
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
  });
  if (!res.ok) throw new Error(`Roblox users API error (HTTP ${res.status})`);
  const { data } = await res.json();
  return data?.[0] ? { id: data[0].id, name: data[0].name, displayName: data[0].displayName } : null;
}

async function headshot(userId) {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    const j = await r.json();
    return j.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

const profileUrl = id => `https://www.roblox.com/users/${id}/profile`;

async function userEmbed(u, title, color) {
  const e = new EmbedBuilder().setTitle(title).setColor(color).setFooter({ text: BRAND })
    .addFields({ name: 'User', value: `[${u.name}](${profileUrl(u.id)}) (\`${u.id}\`)` });
  const img = await headshot(u.id);
  if (img) e.setThumbnail(img);
  return e;
}

function parseDuration(s) {
  if (!s || /^(perm|permanent)$/i.test(s.trim())) return null; // permanent
  const m = /^(\d+)\s*([smhdw])$/i.exec(s.trim());
  if (!m) return undefined; // invalid
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

// Ban / unban in every configured universe
async function setBan(userId, active, reason, secs) {
  const body = active
    ? {
        gameJoinRestriction: {
          active: true,
          privateReason: reason.slice(0, 1000),
          displayReason: reason.slice(0, 400),
          excludeAltAccounts: false,
          ...(secs ? { duration: `${secs}s` } : {}),
        },
      }
    : { gameJoinRestriction: { active: false } };
  return Promise.all(UNIVERSE_IDS.map(async uni => {
    try {
      await rbx('PATCH', `https://apis.roblox.com/cloud/v2/universes/${uni}/user-restrictions/${userId}?updateMask=gameJoinRestriction`, body);
      return { uni, ok: true };
    } catch (e) {
      console.error(`Ban update failed for universe ${uni}:`, e.message);
      return { uni, ok: false, error: e.message };
    }
  }));
}

// Group roles (cached 5 min)
let rolesCache = { at: 0, roles: [] };
async function getRoles() {
  if (Date.now() - rolesCache.at < 5 * 60 * 1000 && rolesCache.roles.length) return rolesCache.roles;
  const roles = [];
  let token = '';
  do {
    const data = await rbx('GET', `https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/roles?maxPageSize=20${token ? `&pageToken=${token}` : ''}`);
    roles.push(...(data.groupRoles || data.roles || []));
    token = data.nextPageToken;
  } while (token);
  rolesCache = { at: Date.now(), roles };
  return roles;
}
const roleName = r => r.displayName || r.name || `Rank ${r.rank}`;

function findRole(roles, input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) {
    const byRank = roles.find(r => r.rank === Number(s));
    if (byRank) return byRank;
  }
  return roles.find(r => roleName(r).toLowerCase() === s.toLowerCase());
}

// Gives the member the new role and removes the previous one
async function setRank(userId, rolePath, oldRolePath = null) {
  const url = `https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships/${userId}`;
  await rbx('POST', `${url}:assignRole`, { role: rolePath });
  if (oldRolePath && oldRolePath !== rolePath) {
    await rbx('POST', `${url}:unassignRole`, { role: oldRolePath })
      .catch(e => console.error('unassignRole failed:', e.message));
  }
}

// Current group membership of a user ({ inGroup, role })
async function getMembership(userId, roles) {
  const filter = encodeURIComponent(`user == 'users/${userId}'`);
  const d = await rbx('GET', `https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships?maxPageSize=10&filter=${filter}`);
  const m = (d.groupMemberships || [])[0];
  if (!m) return { inGroup: false, role: null };
  return { inGroup: true, role: roles.find(r => r.path === m.role) || null };
}

// ---------- Discord helpers ----------
const memberRoleIds = member =>
  member?.roles?.cache ? [...member.roles.cache.keys()] : (Array.isArray(member?.roles) ? member.roles : []);

function isStaff(i) {
  if (i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  return memberRoleIds(i.member).some(id => STAFF_ROLE_IDS.includes(id));
}

// Should this person's requests run automatically?
function canAutoApprove(i) {
  if (isStaff(i)) return true;
  if (AUTO_ROLE_IDS.includes('everyone')) return true;
  return memberRoleIds(i.member).some(id => AUTO_ROLE_IDS.includes(id));
}

// Rank limit for automatic actions (staff are exempt)
const rankWithinLimit = (i, rank) => isStaff(i) || AUTO_MAX_RANK === null || rank <= AUTO_MAX_RANK;

const getChannel = id => (id ? client.channels.fetch(id).catch(() => null) : Promise.resolve(null));
const logAction = async embed => { const ch = await getChannel(LOG_CHANNEL_ID); ch?.send({ embeds: [embed] }).catch(() => {}); };

function setStatus(embed, text, color) {
  const fields = (embed.data.fields || []).filter(f => f.name !== 'Status');
  return embed.setFields([...fields, { name: 'Status', value: text }]).setColor(color);
}

const reviewButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('req_approve').setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId('req_deny').setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
);

const dm = (userId, text) => client.users.fetch(userId).then(u => u.send(text)).catch(() => {});

// ---------- Member counter ----------
const fmt = n => n.toLocaleString('en-US');

// Next round number above the count (506,639 -> 507,000; 1,234 -> 1,240)
function autoGoal(count) {
  const exp = Math.max(Math.floor(Math.log10(Math.max(count, 1))) - 2, 1);
  const step = 10 ** exp;
  return (Math.floor(count / step) + 1) * step;
}

// Your goal -> reserve goal -> automatic goal
function currentGoal(count) {
  if (MEMBER_GOAL && count < MEMBER_GOAL) return MEMBER_GOAL;
  if (MEMBER_BACKUP_GOAL && count < MEMBER_BACKUP_GOAL) return MEMBER_BACKUP_GOAL;
  return autoGoal(count);
}

async function getMemberCount() {
  if (COUNTER_SOURCE === 'discord') return guildOf()?.memberCount ?? null;
  // Roblox group: public API first, Open Cloud (with your key) as a fallback
  try {
    const res = await fetch(`https://groups.roblox.com/v1/groups/${ROBLOX_GROUP_ID}`);
    if (res.ok) {
      const d = await res.json();
      if (Number.isFinite(d.memberCount)) return d.memberCount;
    }
  } catch { /* try Open Cloud below */ }
  const d = await rbx('GET', `https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}`);
  return Number(d.memberCount);
}

async function updateMemberCounter() {
  try {
    const channel = await getChannel(COUNTER_CHANNEL_ID);
    if (!channel) return console.warn('Member counter: COUNTER_CHANNEL_ID is missing or the channel was not found');
    const count = await getMemberCount();
    if (!Number.isFinite(count)) return;
    const goal = currentGoal(count);
    const text = `🎉 We've reached **${fmt(count)}** members! We are ${fmt(goal - count)} away from ${fmt(goal)}.`;

    let msg = null;
    if (db.counterMessageId) msg = await channel.messages.fetch(db.counterMessageId).catch(() => null);
    if (msg) {
      if (msg.content !== text) await msg.edit(text);
    } else {
      msg = await channel.send(text);
      db.counterMessageId = msg.id;
      save();
    }
  } catch (e) {
    console.error('Member counter:', e.message);
  }
}

// Swap Discord roles when a rank request is approved.
// Discord roles are matched by NAME with the Roblox group rank names (case-insensitive).
async function swapDiscordRoles(userId, oldName, newName) {
  const out = { ok: true, removed: null, added: null, warnings: [] };
  const guild = guildOf();
  const member = await guild?.members.fetch(userId).catch(() => null);
  if (!member) return { ...out, ok: false, reason: 'member not found in the server' };

  const find = n => (n ? guild.roles.cache.find(r => r.name.toLowerCase() === n.toLowerCase()) : null);
  const oldRole = find(oldName);
  const newRole = find(newName);
  if (!newRole) {
    out.warnings.push(`No Discord role named "${newName}" was found`);
    return out; // keep the old role so the person is never left without one
  }
  try {
    if (oldRole && oldRole.id !== newRole.id && member.roles.cache.has(oldRole.id)) {
      await member.roles.remove(oldRole, 'Rank request approved');
      out.removed = oldRole;
    }
    await member.roles.add(newRole, 'Rank request approved');
    out.added = newRole;
  } catch (e) {
    out.ok = false;
    out.reason = e.message;
  }
  return out;
}

// Runs an approved request (used by manual approval and by automatic execution)
async function executeRequest(req) {
  if (req.kind === 'game-ban') {
    const results = await setBan(req.userId, true, req.reason, null);
    return { note: `Banned in ${results.filter(r => r.ok).length}/${results.length} universes`, roleSummary: '' };
  }

  const roles = await getRoles();
  const mem = await getMembership(req.userId, roles);
  if (!mem.inGroup) throw new Error('That user is not in the Roblox group.');
  const before = mem.role;
  req.oldRoleName = before ? roleName(before) : null;

  // Demotion: one rank below the current one
  if (req.kind === 'demotion') {
    if (!before || before.rank >= 255) throw new Error('This user cannot be demoted by the bot.');
    const lower = roles.filter(r => r.rank > 0 && r.rank < before.rank).sort((a, b) => b.rank - a.rank)[0];
    if (!lower) throw new Error('This user is already at the lowest rank.');
    await setRank(req.userId, lower.path, before?.path);
    req.roleName = roleName(lower);
    return { note: `Demoted: ${req.oldRoleName} → ${req.roleName}`, roleSummary: '' };
  }

  // Rank change: Roblox rank is swapped; Discord: remove old role, add new one
  await setRank(req.userId, req.rolePath, before?.path);
  const sw = await swapDiscordRoles(req.requesterId, req.oldRoleName, req.roleName);
  const parts = [];
  if (sw.removed) parts.push(`Removed role **${sw.removed.name}**`);
  if (sw.added) parts.push(`Added role **${sw.added.name}**`);
  if (!sw.ok) parts.push(`⚠️ Could not update Discord roles (${sw.reason})`);
  parts.push(...sw.warnings.map(w => `⚠️ ${w}`));
  const roleSummary = parts.join('\n');
  return {
    note: `Rank: ${req.oldRoleName ?? 'Unknown'} → ${req.roleName}${roleSummary ? `\n${roleSummary}` : ''}`,
    roleSummary,
  };
}

// One DM to the person who made the request
function notifyRequester(req, approve, reviewerName, roleSummary) {
  const kindLabel = { 'game-ban': 'game ban', demotion: 'demotion', rank: 'rank change' }[req.kind] || 'request';
  const who = reviewerName ? `by **${reviewerName}**` : 'automatically';
  const e = new EmbedBuilder().setColor(approve ? COLORS.ok : COLORS.bad).setFooter({ text: BRAND })
    .setTitle(`${approve ? '✅ Approved' : '❌ Declined'}: ${kindLabel} request`)
    .setDescription(`Your ${kindLabel} request for **${req.username}** was ${approve ? 'approved' : 'declined'} ${who}.`);
  if (approve && (req.kind === 'rank' || req.kind === 'demotion')) {
    e.addFields({ name: 'Rank', value: `${req.oldRoleName ?? 'Unknown'} → **${req.roleName}**` });
  }
  if (approve && roleSummary) e.addFields({ name: 'Discord roles', value: roleSummary });
  client.users.fetch(req.requesterId).then(u => u.send({ embeds: [e] })).catch(() => {});
}

// ---------- Optional systems (loaded only when their feature is ON) ----------
// Points system + /pm (points.js)
const points = (FEATURES.pointsSystem || FEATURES.privateMessages)
  ? require('./points')({
      rbx, getRobloxUser, getMembership, getRoles, findRole, setRank,
      userEmbed, isStaff, logAction, COLORS, EPH, roleName, getBrand,
    })
  : { buildCommands: () => [], handle: async () => false, start() {} };

// Application Center / Rank Center promotions (queue.js)
const queue = FEATURES.rankApplicationSystem
  ? require('./queue')({ rbx, getRoles, findRole, getMembership, setRank, logAction, COLORS, roleName })
  : { start() {} };
  const sessions = FEATURES.sessions
  ? require('./session')({ client, db, save, isStaff, getChannel, logAction, COLORS, EPH, getBrand })
  : { buildCommands: () => [], handle: async () => false, handleButton: async () => false, handleModal: async () => false, start() {} };

// ---------- Slash commands (only the ones whose feature is ON) ----------
const usernameOpt = o => o.setName('username').setDescription('Roblox username').setRequired(true);

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('ban').setDescription(`Ban a user from all ${BRAND} games.`)
      .addStringOption(usernameOpt)
      .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(true))
      .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 12h, 7d, 2w (empty = permanent)')),
    new SlashCommandBuilder().setName('unban').setDescription(`Unban a user from all ${BRAND} games.`)
      .addStringOption(usernameOpt)
      .addStringOption(o => o.setName('reason').setDescription('Reason for the unban')),
    new SlashCommandBuilder().setName('get-ban').setDescription('Gets a ban issued.')
      .addStringOption(usernameOpt),
    new SlashCommandBuilder().setName('get-id').setDescription('Get a Roblox ID from a Roblox username.')
      .addStringOption(usernameOpt),
    new SlashCommandBuilder().setName('setrank').setDescription('Remotely set someones group rank')
      .addStringOption(usernameOpt)
      .addStringOption(o => o.setName('rank').setDescription('Rank name or number').setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName('request-punish').setDescription('Request a demotion/game ban.')
      .addStringOption(o => o.setName('type').setDescription('Type of punishment').setRequired(true)
        .addChoices({ name: 'Demotion', value: 'demotion' }, { name: 'Game Ban', value: 'game-ban' }))
      .addStringOption(usernameOpt)
      .addStringOption(o => o.setName('reason').setDescription('Why should this user be punished?').setRequired(true))
      .addStringOption(o => o.setName('evidence').setDescription('Link to evidence (image/video URL)').setRequired(true)),
    new SlashCommandBuilder().setName('request-rank').setDescription('Request a training rank change.'),
    new SlashCommandBuilder().setName('suggest').setDescription(`Suggestions for the ${BRAND} team`)
      .addSubcommand(s => s.setName('add').setDescription(`Submit a suggestion to the ${BRAND} team!`)
        .addStringOption(o => o.setName('suggestion').setDescription('Your suggestion').setMaxLength(1000).setRequired(true)))
      .addSubcommand(s => s.setName('approve').setDescription('This command required elevated privileges - Approve a suggestion')
        .addIntegerOption(o => o.setName('id').setDescription('Suggestion number').setMinValue(1).setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Optional note')))
      .addSubcommand(s => s.setName('disapprove').setDescription('This command required elevated privileges - Decline a suggestion')
        .addIntegerOption(o => o.setName('id').setDescription('Suggestion number').setMinValue(1).setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Optional note'))),
    new SlashCommandBuilder().setName('tag').setDescription('Send a ticket tag.')
      .addStringOption(o => o.setName('name').setDescription('Tag to send').setRequired(true).setAutocomplete(true))
      .addUserOption(o => o.setName('user').setDescription('Person to mention (optional)')),
    ...sessions.buildCommands(),
    ...points.buildCommands(BRAND),
  ]
    .filter(c => commandEnabled(c.name))
    .map(c => c.toJSON());
}

async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: buildCommands() });
}

// Applies BOT_NAME to the bot's server nickname and to the bot account (only when RENAME_BOT is true)
async function applyIdentity() {
  const out = [];
  try {
    const me = await guildOf().members.fetchMe();
    if (me.nickname !== BRAND) await me.setNickname(BRAND, 'Bot name');
    out.push('✅ Server nickname');
  } catch (e) {
    out.push(`⚠️ Server nickname not changed (${String(e.message).slice(0, 80)})`);
  }
  try {
    if (client.user.username !== BRAND) await client.user.setUsername(BRAND);
    out.push('✅ Bot account name');
  } catch (e) {
    out.push(`⚠️ Bot account name not changed (${String(e.message).slice(0, 80)})`);
  }
  return out;
}

client.once('clientReady', async () => {
  // Status rotation
  if (FEATURES.statusRotation) {
    applyPresence();
    setInterval(applyPresence, PRESENCE_INTERVAL_MIN * 60 * 1000);
  }

  // Member counter
  if (FEATURES.memberCounter) {
    updateMemberCounter();
    setInterval(updateMemberCounter, COUNTER_INTERVAL_MIN * 60 * 1000);
  }

  // Points: promotes whoever reached a rank threshold (points earned in-game)
  if (FEATURES.pointsSystem && FEATURES.autoRank) points.start();

  // Application Center / Rank Center: gives the ranks queued by the games
  if (FEATURES.rankApplicationSystem) queue.start();
  if (FEATURES.sessions) sessions.start();

  // Optional: also rename the bot itself
  if (RENAME_BOT) applyIdentity().then(results => results.forEach(r => console.log(r)));

  await registerCommands();
  console.log(`Logged in as ${client.user.tag} (name: ${BRAND})`);
  console.log('Features ON:', Object.keys(FEATURES).filter(k => FEATURES[k]).join(', ') || 'none');
  console.log('Features OFF:', Object.keys(FEATURES).filter(k => !FEATURES[k]).join(', ') || 'none');
  if (!ROBLOX_API_KEY) console.warn('⚠️ ROBLOX_API_KEY is missing');
  if (FEATURES.bans && !UNIVERSE_IDS.length) console.warn('⚠️ ROBLOX_UNIVERSE_IDS is empty (/ban will not work)');
});

// ---------- Interaction router ----------
client.on('interactionCreate', async i => {
  try {
    if (i.isAutocomplete()) return await onAutocomplete(i);
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton()) return await onButton(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (err) {
    console.error(err);
    const msg = { content: `❌ Something went wrong: ${String(err.message).slice(0, 200)}` };
    if ((i.isChatInputCommand() || i.isModalSubmit()) && i.deferred) await i.editReply({ ...msg, embeds: [] }).catch(() => {});
    else if (i.deferred || i.replied) await i.followUp({ ...msg, ...EPH }).catch(() => {});
    else if (!i.isAutocomplete()) await i.reply({ ...msg, ...EPH }).catch(() => {});
  }
});

// ---------- Autocomplete (/tag name, /setrank rank) ----------
async function onAutocomplete(i) {
  if (!commandEnabled(i.commandName)) return;

  // /tag name
  if (i.commandName === 'tag') {
    const q = i.options.getFocused().toLowerCase();
    const choices = TAGS
      .filter(t => t.name.toLowerCase().includes(q) || withBrand(t.title).toLowerCase().includes(q))
      .slice(0, 25)
      .map(t => ({ name: `${t.name} - ${withBrand(t.title)}`.slice(0, 100), value: t.name }));
    return i.respond(choices);
  }

  // /setrank rank
  if (i.commandName !== 'setrank') return;
  const q = i.options.getFocused().toLowerCase();
  const roles = await getRoles().catch(() => []);
  const choices = roles
    .filter(r => r.rank > 0 && r.rank < 255)
    .filter(r => roleName(r).toLowerCase().includes(q) || String(r.rank).startsWith(q))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 25)
    .map(r => ({ name: `${roleName(r)} (${r.rank})`.slice(0, 100), value: String(r.rank) }));
  return i.respond(choices);
}

// ---------- Slash commands ----------
async function onCommand(i) {
  // A command whose feature is OFF does nothing
  if (!commandEnabled(i.commandName))
    return i.reply({ content: '⛔ This feature is turned off.', ...EPH });

  if (await points.handle(i)) return; // /points, /leaderboard, /pm
  if (await sessions.handle(i)) return;

  const name = i.commandName;
  const staffCommands = ['ban', 'unban', 'get-ban', 'setrank', 'tag'];
  const needsStaff = staffCommands.includes(name) || (name === 'suggest' && i.options.getSubcommand() !== 'add');
  if (needsStaff && !isStaff(i)) return i.reply({ content: '⛔ This command requires elevated privileges.', ...EPH });

  // /tag
  if (name === 'tag') {
    const tag = TAGS.find(t => t.name === i.options.getString('name'));
    if (!tag) return i.reply({ content: '❌ Tag not found.', ...EPH });
    const target = i.options.getUser('user');
    const e = new EmbedBuilder().setColor(COLORS.info).setFooter({ text: BRAND })
      .setTitle(withBrand(tag.title)).setDescription(withBrand(tag.text));
    return i.reply({
      content: target ? `<@${target.id}>` : undefined,
      embeds: [e],
      allowedMentions: { users: target ? [target.id] : [] },
    });
  }

  // /get-id
  if (name === 'get-id') {
    await i.deferReply();
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) return i.editReply('❌ Roblox user not found.');
    const e = (await userEmbed(u, 'Roblox ID', COLORS.info)).setDescription(`**${u.name}**'s ID is \`${u.id}\``);
    return i.editReply({ embeds: [e] });
  }

  // /ban
  if (name === 'ban') {
    const reason = i.options.getString('reason');
    const durationRaw = i.options.getString('duration');
    const secs = parseDuration(durationRaw);
    if (secs === undefined) return i.reply({ content: '❌ Invalid duration. Use e.g. 30m, 12h, 7d, 2w.', ...EPH });
    if (!UNIVERSE_IDS.length) return i.reply({ content: '❌ No universes configured (ROBLOX_UNIVERSE_IDS).', ...EPH });
    await i.deferReply();
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) return i.editReply('❌ Roblox user not found.');
    const results = await setBan(u.id, true, reason, secs);
    const ok = results.filter(r => r.ok).length;
    const e = (await userEmbed(u, '🔨 User banned', ok === results.length ? COLORS.bad : COLORS.pending)).addFields(
      { name: 'Reason', value: reason.slice(0, 1000) },
      { name: 'Duration', value: secs ? durationRaw : 'Permanent', inline: true },
      { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
      { name: 'Universes', value: `${ok}/${results.length} succeeded`, inline: true },
    );
    const failed = results.filter(r => !r.ok);
    if (failed.length) e.addFields({ name: 'Failed', value: failed.map(f => `${f.uni}: ${f.error}`).join('\n').slice(0, 1000) });
    await i.editReply({ embeds: [e] });
    return logAction(e);
  }

  // /unban
  if (name === 'unban') {
    if (!UNIVERSE_IDS.length) return i.reply({ content: '❌ No universes configured (ROBLOX_UNIVERSE_IDS).', ...EPH });
    const reason = i.options.getString('reason') || 'No reason given';
    await i.deferReply();
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) return i.editReply('❌ Roblox user not found.');
    const results = await setBan(u.id, false);
    const ok = results.filter(r => r.ok).length;
    const e = (await userEmbed(u, '✅ User unbanned', ok === results.length ? COLORS.ok : COLORS.pending)).addFields(
      { name: 'Reason', value: reason.slice(0, 1000) },
      { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
      { name: 'Universes', value: `${ok}/${results.length} succeeded`, inline: true },
    );
    const failed = results.filter(r => !r.ok);
    if (failed.length) e.addFields({ name: 'Failed', value: failed.map(f => `${f.uni}: ${f.error}`).join('\n').slice(0, 1000) });
    await i.editReply({ embeds: [e] });
    return logAction(e);
  }

  // /get-ban
  if (name === 'get-ban') {
    if (!UNIVERSE_IDS.length) return i.reply({ content: '❌ No universes configured (ROBLOX_UNIVERSE_IDS).', ...EPH });
    await i.deferReply();
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) return i.editReply('❌ Roblox user not found.');
    const results = await Promise.all(UNIVERSE_IDS.map(async uni => {
      try {
        const d = await rbx('GET', `https://apis.roblox.com/cloud/v2/universes/${uni}/user-restrictions/${u.id}`);
        return { uni, r: d.gameJoinRestriction };
      } catch (e) {
        return e.status === 404 ? { uni, r: null } : { uni, error: e.message };
      }
    }));
    const active = results.filter(x => x.r?.active);
    const errors = results.filter(x => x.error);
    let e;
    if (active.length) {
      const r = active[0].r;
      e = (await userEmbed(u, '🔨 Active ban found', COLORS.bad)).addFields(
        { name: 'Reason', value: (r.privateReason || r.displayReason || 'No reason given').slice(0, 1000) },
        { name: 'Duration', value: r.duration || 'Permanent', inline: true },
        { name: 'Active in', value: `${active.length}/${results.length} universes`, inline: true },
      );
      if (r.startTime) e.addFields({ name: 'Issued', value: `<t:${Math.floor(Date.parse(r.startTime) / 1000)}:F>`, inline: true });
    } else {
      e = await userEmbed(u, '✅ No active ban', COLORS.ok);
    }
    if (errors.length) e.addFields({ name: 'Errors', value: errors.map(x => `${x.uni}: ${x.error}`).join('\n').slice(0, 1000) });
    return i.editReply({ embeds: [e] });
  }

  // /setrank
  if (name === 'setrank') {
    await i.deferReply();
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) return i.editReply('❌ Roblox user not found.');
    const roles = await getRoles();
    const role = findRole(roles, i.options.getString('rank'));
    if (!role) return i.editReply('❌ Rank not found. Use the exact rank name or number.');
    if (role.rank <= 0 || role.rank >= 255) return i.editReply('❌ That rank cannot be assigned by the bot.');
    const mem = await getMembership(u.id, roles);
    if (!mem.inGroup) return i.editReply('❌ That user is not in the group.');
    await setRank(u.id, role.path, mem.role?.path);
    const e = (await userEmbed(u, '📈 Rank updated', COLORS.ok)).addFields(
      { name: 'Rank', value: `${mem.role ? roleName(mem.role) : 'Unknown'} → **${roleName(role)}**`, inline: true },
      { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
    );
    await i.editReply({ embeds: [e] });
    return logAction(e);
  }

  // /request-punish
  if (name === 'request-punish') {
    const type = i.options.getString('type');
    const reason = i.options.getString('reason');
    const evidence = i.options.getString('evidence');
    await i.deferReply(EPH);
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) return i.editReply('❌ Roblox user not found.');
    const channel = await getChannel(REQUESTS_CHANNEL_ID);
    if (!channel) return i.editReply('❌ The requests channel is not configured.');

    const e = (await userEmbed(u, type === 'game-ban' ? '🔨 Game ban request' : '⬇️ Demotion request', COLORS.pending)).addFields(
      { name: 'Reason', value: reason.slice(0, 1000) },
      { name: 'Evidence', value: evidence.slice(0, 1000) },
      { name: 'Requested by', value: `<@${i.user.id}>`, inline: true },
    );
    const req = { kind: type, userId: u.id, username: u.name, reason, evidence, requesterId: i.user.id, status: 'pending' };

    // Automatic execution (only for allowed requesters and targets within the rank limit)
    let auto = canAutoApprove(i);
    let manualReason = '';
    if (auto && !isStaff(i) && AUTO_MAX_RANK !== null) {
      const mem = await getMembership(u.id, await getRoles());
      if (mem.role && mem.role.rank > AUTO_MAX_RANK) {
        auto = false;
        manualReason = ' The target is above the automatic limit, so it needs staff review.';
      }
    }
    if (auto) {
      const { note, roleSummary } = await executeRequest(req);
      req.status = 'approved';
      setStatus(e, `✅ Auto-approved\n${note}`, COLORS.ok);
      await channel.send({ embeds: [e] });
      logAction(e);
      notifyRequester(req, true, null, roleSummary);
      return i.editReply(`✅ Done. ${note}`);
    }

    // Manual review
    setStatus(e, '⏳ Pending', COLORS.pending);
    const msg = await channel.send({ embeds: [e], components: [reviewButtons()] });
    db.requests[msg.id] = req;
    save();
    return i.editReply(`✅ Your request was submitted for review.${manualReason}`);
  }

  // /request-rank (opens a form)
  if (name === 'request-rank') {
    const row = (id, label, style, required) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required));
    const modal = new ModalBuilder().setCustomId('request_rank_modal').setTitle('Request a training rank change')
      .addComponents(
        row('username', 'Roblox username', TextInputStyle.Short, true),
        row('rank', 'Requested rank (name or number)', TextInputStyle.Short, true),
        row('notes', 'Training / notes', TextInputStyle.Paragraph, false),
      );
    return i.showModal(modal);
  }

  // /suggest
  if (name === 'suggest') {
    const sub = i.options.getSubcommand();

    if (sub === 'add') {
      const channel = await getChannel(SUGGESTIONS_CHANNEL_ID);
      if (!channel) return i.reply({ content: '❌ The suggestions channel is not configured.', ...EPH });
      const text = i.options.getString('suggestion');
      const id = db.nextSuggestion++;
      const e = new EmbedBuilder().setColor(COLORS.pending).setTitle(`Suggestion #${id}`).setDescription(text)
        .setFooter({ text: BRAND })
        .setAuthor({ name: i.member?.displayName || i.user.username, iconURL: i.user.displayAvatarURL() })
        .addFields({ name: 'Status', value: '⏳ Pending' });
      const msg = await channel.send({ embeds: [e] });
      await msg.react('👍').catch(() => {});
      await msg.react('👎').catch(() => {});
      db.suggestions[id] = { channelId: channel.id, messageId: msg.id, authorId: i.user.id, text, status: 'pending' };
      save();
      return i.reply({ content: `✅ Your suggestion **#${id}** was submitted to the ${BRAND} team!`, ...EPH });
    }

    // approve / disapprove (staff only, checked above)
    const id = i.options.getInteger('id');
    const reason = i.options.getString('reason');
    const s = db.suggestions[id];
    if (!s) return i.reply({ content: '❌ Suggestion not found.', ...EPH });
    await i.deferReply(EPH);
    const ch = await getChannel(s.channelId);
    const msg = await ch?.messages.fetch(s.messageId).catch(() => null);
    if (!msg) return i.editReply('❌ Could not find the suggestion message.');
    const approve = sub === 'approve';
    const e = setStatus(
      EmbedBuilder.from(msg.embeds[0]),
      `${approve ? '✅ Approved' : '❌ Declined'} by <@${i.user.id}>${reason ? `\n**Reason:** ${reason}` : ''}`,
      approve ? COLORS.ok : COLORS.bad,
    );
    await msg.edit({ embeds: [e] });
    s.status = approve ? 'approved' : 'declined';
    save();
    dm(s.authorId, `Your suggestion **#${id}** was ${approve ? 'approved ✅' : 'declined ❌'}${reason ? `\n**Reason:** ${reason}` : ''}`);
    return i.editReply(`Suggestion #${id} ${approve ? 'approved' : 'declined'}.`);
  }
}

// ---------- Form submit (/request-rank) ----------
async function onModal(i) {
  if (i.customId !== 'request_rank_modal') return;
  await i.deferReply(EPH);
  const username = i.fields.getTextInputValue('username');
  const rankInput = i.fields.getTextInputValue('rank');
  const notes = i.fields.getTextInputValue('notes');
  const u = await getRobloxUser(username);
  if (!u) return i.editReply('❌ Roblox user not found.');
  const roles = await getRoles();
  const role = findRole(roles, rankInput);
  if (!role || role.rank <= 0 || role.rank >= 255) return i.editReply('❌ Rank not found. Use the exact rank name or number.');
  const channel = await getChannel(REQUESTS_CHANNEL_ID);
  if (!channel) return i.editReply('❌ The requests channel is not configured.');

  const e = (await userEmbed(u, '📈 Rank change request', COLORS.pending)).addFields(
    { name: 'Requested rank', value: `${roleName(role)} (${role.rank})`, inline: true },
    { name: 'Requested by', value: `<@${i.user.id}>`, inline: true },
    ...(notes ? [{ name: 'Notes', value: notes.slice(0, 1000) }] : []),
  );
  const req = {
    kind: 'rank', userId: u.id, username: u.name, rolePath: role.path, roleName: roleName(role),
    notes, requesterId: i.user.id, status: 'pending',
  };

  // Automatic execution (only for allowed requesters and ranks within the limit)
  const auto = canAutoApprove(i) && rankWithinLimit(i, role.rank);
  if (auto) {
    const { note, roleSummary } = await executeRequest(req);
    req.status = 'approved';
    setStatus(e, `✅ Auto-approved\n${note}`, COLORS.ok);
    await channel.send({ embeds: [e] });
    logAction(e);
    notifyRequester(req, true, null, roleSummary);
    return i.editReply(`✅ Done. ${note}`);
  }

  // Manual review
  setStatus(e, '⏳ Pending', COLORS.pending);
  const msg = await channel.send({ embeds: [e], components: [reviewButtons()] });
  db.requests[msg.id] = req;
  save();
  const why = canAutoApprove(i) ? ' That rank is above the automatic limit, so it needs staff review.' : '';
  return i.editReply(`✅ Your request was submitted for review.${why}`);
}

// ---------- Approve / Deny buttons ----------
async function onButton(i) {
  if (i.customId !== 'req_approve' && i.customId !== 'req_deny') return;
  if (!isStaff(i)) return i.reply({ content: '⛔ This action requires elevated privileges.', ...EPH });
  const req = db.requests[i.message.id];
  if (!req || req.status !== 'pending')
    return i.reply({ content: 'This request was already handled or no longer exists.', ...EPH });

  await i.deferUpdate();
  const approve = i.customId === 'req_approve';
  let note = '';
  let roleSummary = '';
  if (approve) ({ note, roleSummary } = await executeRequest(req));

  req.status = approve ? 'approved' : 'denied';
  save();
  const e = setStatus(
    EmbedBuilder.from(i.message.embeds[0]),
    approve ? `✅ Approved by <@${i.user.id}>${note ? `\n${note}` : ''}` : `❌ Denied by <@${i.user.id}>`,
    approve ? COLORS.ok : COLORS.bad,
  );
  await i.editReply({ embeds: [e], components: [] });
  notifyRequester(req, approve, i.member?.displayName || i.user.username, roleSummary);
}

client.login(TOKEN);
