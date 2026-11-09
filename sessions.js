// sessions.js - Planetary (Orbit) sessions -> Discord. Fully automatic, no commands.
// 1) Announces claimed sessions (message + Discord event with the game link).
// 2) Reminds people who are not in the game N minutes before their session (DM + channel message).
const fs = require('fs');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  GuildScheduledEventPrivacyLevel, GuildScheduledEventEntityType,
} = require('discord.js');

module.exports = function createSessions(ctx) {
  const { client, db, save, getChannel, logAction, COLORS, getBrand } = ctx;

  const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);

  // ---------- CONFIG (.env) ----------
  // PLANETARY_URL: only the domain is used (any path after it is ignored)
  const rawUrl = (process.env.PLANETARY_URL || '').trim();
  let BASE_URL = '';
  let urlWorkspaceId = '';
  if (rawUrl) {
    try {
      const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      BASE_URL = u.origin;
      urlWorkspaceId = (/\/workspace\/(\d+)/.exec(u.pathname) || [])[1] || '';
    } catch { /* invalid URL, reported when the bot starts */ }
  }
  const API_KEY = (process.env.PLANETARY_API_KEY || '').trim();
  // Workspace id (the number in .../workspace/123456). Falls back to the id in PLANETARY_URL, then ROBLOX_GROUP_ID.
  const WORKSPACE_ID = (process.env.PLANETARY_WORKSPACE_ID || urlWorkspaceId || process.env.ROBLOX_GROUP_ID || '').trim();

  // Accepts "/api/...", a full URL, "%7Bid%7D" or "{id}" and returns a clean path with the workspace id filled in
  function normalizePath(p) {
    let s = String(p || '').trim();
    if (/^https?:\/\//i.test(s)) {
      try { const u = new URL(s); s = u.pathname + u.search; } catch { /* keep as is */ }
    }
    s = s.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    if (WORKSPACE_ID) s = s.replace(/\{(?:id|workspace|workspaceid|workspace_id|groupid|group_id)\}/gi, WORKSPACE_ID);
    if (s && !s.startsWith('/')) s = `/${s}`;
    return s;
  }
  const SESSIONS_PATH = normalizePath(
    process.env.PLANETARY_SESSIONS_PATH || '/api/public/v1/workspace/{id}/sessions/upcoming?limit=50&page=1');

  // Role name that counts as "claimed" (e.g. host). Empty = use the session owner / creator instead.
  const CLAIM_ROLE = (process.env.PLANETARY_CLAIM_ROLE ?? 'host').trim().toLowerCase();
  const CHANNEL_ID = process.env.SESSIONS_CHANNEL_ID;        // where the announcement is posted
  const PING_ROLE_ID = process.env.SESSIONS_PING_ROLE_ID;    // optional role to ping
  const GAME_LINK = (process.env.SESSION_GAME_LINK || '').trim();
  const NAME_OVERRIDE = (process.env.SESSION_NAME || '').trim(); // fixed name chosen by you (optional)
  const ANNOUNCE_EXISTING = process.env.PLANETARY_ANNOUNCE_EXISTING === 'true';
  const RESET = process.env.PLANETARY_RESET === 'true';      // clears what the bot remembers (use once, then remove)
  const DEBUG = process.env.SESSIONS_DEBUG === 'true';       // prints what the API answers (turn off when it works)
  const GUILD_ID = process.env.GUILD_ID;
  const POLL_SECONDS = Math.max(30, Number(process.env.SESSIONS_POLL_SECONDS) || 60);

  // ---------- Attendance reminders (needs the SessionPresence script in the game) ----------
  const ROBLOX_API_KEY = (process.env.ROBLOX_API_KEY || '').trim();
  const PRESENCE_UNIVERSES = list(process.env.PRESENCE_UNIVERSE_IDS);
  const PRESENCE_STORE = process.env.PRESENCE_STORE || 'InGame';
  const PRESENCE_FRESH_SECONDS = Math.max(60, Number(process.env.PRESENCE_FRESH_SECONDS) || 120);
  const REMINDER_MINUTES = Math.max(1, Number(process.env.SESSION_REMINDER_MINUTES) || 10);
  const REMINDER_CHANNEL_ID = process.env.SESSIONS_REMINDER_CHANNEL_ID || CHANNEL_ID;
  // Roles that are checked besides the host (e.g. host,co-host,trainer)
  const REMINDER_ROLES = list(process.env.SESSION_REMINDER_ROLES ?? 'host').map(s => s.toLowerCase());
  const FULL_MEMBER_SCAN = process.env.SESSIONS_FULL_MEMBER_SCAN === 'true'; // see the notes
  const remindersOn = () => PRESENCE_UNIVERSES.length > 0 && !!ROBLOX_API_KEY;

  // Texts (edit freely). {name} = the session name.
  const INTRO = process.env.SESSION_INTRO || 'There is a scheduled session: **{name}**. More details can be found below.';
  const LABELS = { host: 'Host', join: 'Staff Join', end: 'Shift End' };
  const TIME_NOTE = 'Please note all times found above in this description are in your local time.';
  const REMINDER = {
    greeting: 'Hello {username},',
    body: 'Our systems indicate that you are not at your session yet, and are therefore being sent this reminder.',
    rule: 'You must be in the game {minutes} minutes before the start of a session.',
    warning: 'Failure to attend a session you have scheduled without cancelling before it begins will result in **sanctions.**',
    button: 'Join Session',
  };

  // Optional: links.json -> { "robloxUsername": "discordUserId" } (used for the DM and the mention)
  const LINKS = {};
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync('./links.json', 'utf8')))) LINKS[k.toLowerCase()] = String(v);
  } catch { /* links.json is optional */ }

  // Paths tried automatically when the configured one does not work
  const CANDIDATES = [
    '/api/public/v1/workspace/{id}/sessions/upcoming?limit=50&page=1',
    '/api/public/v1/workspace/{id}/sessions/upcoming',
    '/api/public/v1/workspace/{id}/sessions',
    '/api/public/v1/sessions/upcoming',
    '/api/public/v1/sessions',
    '/api/public/v1/workspace/sessions/upcoming',
    '/api/public/v1/workspaces/{id}/sessions/upcoming',
    '/api/public/v1/{id}/sessions/upcoming',
  ].map(normalizePath).filter(p => !p.includes('{'));

  db.planetary = db.planetary || {};   // sessions already announced: { sessionId: {...} }
  db.reminders = db.reminders || {};   // reminders already handled: { "sessionId:username": {...} }

  const configured = () => !!(BASE_URL && API_KEY);
  const validLink = l => /^https?:\/\/\S+$/i.test(l) && l.length <= 512;

  // ---------- Messages ----------
  const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
  const intro = name => INTRO.replaceAll('{name}', name);
  const timeline = s => [
    `${LABELS.host}: ${s.host}`,
    `${LABELS.join}: ${ts(s.startTs)}`,
    `${LABELS.end}: ${ts(s.endTs)}`,
  ].join('\n');

  const announceEmbed = s => new EmbedBuilder().setColor(COLORS.ok)
    .setTitle(s.name.slice(0, 256))
    .setDescription(`${intro(s.name)}\n\n${timeline(s)}\n\n*${TIME_NOTE}*`)
    .setFooter({ text: getBrand(), iconURL: client.user.displayAvatarURL() });

  const eventDescription = s => `${intro(s.name).replace(/\*\*/g, '')}\n\n${timeline(s)}`.slice(0, 1000);

  const linkRow = (eventUrl, gameLink) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Discord Event').setStyle(ButtonStyle.Link).setURL(eventUrl),
    new ButtonBuilder().setLabel('Join Game').setStyle(ButtonStyle.Link).setURL(gameLink),
  );

  const info = (title, description) => logAction(new EmbedBuilder().setColor(COLORS.info)
    .setTitle(title).setDescription(description.slice(0, 3900)).setFooter({ text: getBrand() }));

  // ---------- Planetary API ----------
  async function request(path) {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
        redirect: 'manual', // a redirect means we reached a web page, not the API
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error('The Planetary API took too long to answer.');
      const code = err.cause?.code || err.cause?.message || err.message;
      throw new Error(`Could not reach ${BASE_URL} (${code}). PLANETARY_URL must be only the domain of your workspace, e.g. https://yourworkspace.planetaryapp.cloud`);
    }
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, text: body, data };
  }

  const usable = r => r.ok && r.data && typeof r.data === 'object';

  let activePath = SESSIONS_PATH;
  let lastDiscovery = 0;

  // Tries the usual paths until one answers with data
  async function discover(skip) {
    lastDiscovery = Date.now();
    for (const p of CANDIDATES) {
      if (p === skip) continue;
      try {
        const r = await request(p);
        if (usable(r)) return { path: p, r };
      } catch { /* try the next one */ }
    }
    return null;
  }

  // ---------- Reading the sessions (tolerant: the field names are guessed) ----------
  const asList = d => Array.isArray(d)
    ? d
    : (d?.sessions || d?.data || d?.upcoming || d?.items || d?.results || Object.values(d || {}).find(Array.isArray) || []);

  const pick = (o, keys) => {
    for (const k of keys) {
      const v = o?.[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const toMs = v => {
    if (v === null || v === undefined || v === '') return null;
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    return Number.isFinite(t) && t > Date.UTC(2020, 0, 1) && t < Date.UTC(2100, 0, 1) ? t : null;
  };

  // Start time: known names first, then any field that looks like a date
  function findTime(x) {
    const direct = toMs(pick(x, ['date', 'startTime', 'startsAt', 'startDate', 'start', 'scheduledFor', 'scheduledAt', 'scheduled', 'time', 'timestamp']));
    if (direct) return direct;
    for (const [k, v] of Object.entries(x)) {
      if (/date|time|start|scheduled|begin/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        const t = toMs(v);
        if (t) return t;
      }
    }
    return null;
  }

  // A person can be a string, or an object with some username field
  function personName(p) {
    if (!p) return null;
    if (typeof p === 'string') return str(p);
    return str(pick(p, ['username', 'userName', 'robloxUsername', 'displayName', 'name']))
      ?? str(pick(p.user, ['username', 'userName', 'robloxUsername', 'displayName', 'name']));
  }
  // Person inside a list entry like { role, user } ("name" is usually the role there, so it is skipped)
  const entryPerson = u => personName(u?.user) ?? personName(u?.member)
    ?? str(pick(u, ['username', 'userName', 'robloxUsername', 'displayName']));

  // role id -> role name, when the session describes its roles/slots
  function roleMapOf(x) {
    const map = {};
    const visit = (node, label) => {
      if (Array.isArray(node)) { node.forEach(n => visit(n, label)); return; }
      if (!node || typeof node !== 'object') return;
      const name = str(node.name) ?? str(node.title) ?? label;
      if (node.id !== undefined && node.id !== null && name) map[String(node.id)] = name;
      for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, name);
    };
    visit(x.sessionType?.slots ?? x.slots ?? x.roleSlots, null);
    return map;
  }
  function entryRole(u, roleMap) {
    const r = u?.role ?? u?.roleName ?? u?.position ?? (typeof u?.slot === 'string' ? u.slot : undefined);
    const direct = typeof r === 'string' ? r : (str(r?.name) ?? str(r?.title));
    const byId = roleMap[String(u?.roleID ?? u?.roleId ?? u?.role?.id ?? '')];
    return String(direct ?? byId ?? '').toLowerCase();
  }

  const PEOPLE_KEYS = ['users', 'participants', 'roles', 'slots', 'attendees', 'staff', 'members'];

  // Turns one session of the API into what the bot needs
  function mapSession(x) {
    const roleMap = roleMapOf(x);
    let host = personName(pick(x, ['host', 'hostedBy', 'hostName', 'hostUsername', 'claimedBy', 'claimer']));
    if (!host && CLAIM_ROLE) {
      for (const key of PEOPLE_KEYS) {
        const arr = x[key];
        if (!Array.isArray(arr)) continue;
        const e = arr.find(u => u && typeof u === 'object' && entryPerson(u) && entryRole(u, roleMap).includes(CLAIM_ROLE));
        if (e) { host = entryPerson(e); break; }
      }
    }
    if (!host && !CLAIM_ROLE) host = personName(pick(x, ['owner', 'creator', 'createdBy']));

    // everyone who must be in the game before the session (the host + the roles in SESSION_REMINDER_ROLES)
    const people = [];
    const addPerson = n => { if (n && !people.some(p => p.toLowerCase() === n.toLowerCase())) people.push(n); };
    addPerson(host);
    if (REMINDER_ROLES.length) {
      for (const key of PEOPLE_KEYS) {
        const arr = x[key];
        if (!Array.isArray(arr)) continue;
        for (const u of arr) {
          if (!u || typeof u !== 'object') continue;
          const who = entryPerson(u);
          if (who && REMINDER_ROLES.some(r => entryRole(u, roleMap).includes(r))) addPerson(who);
        }
      }
    }

    const startTs = findTime(x);
    const name = str(pick(x, ['name', 'title'])) ?? str(x.sessionType?.name) ?? str(x.type?.name) ?? str(x.type) ?? 'Session';
    const dur = Number(pick(x, ['duration', 'length', 'minutes']) ?? 60) || 60;
    return {
      id: String(pick(x, ['id', 'sessionId', 'uuid', '_id']) ?? (startTs ? `${name}@${startTs}` : '')),
      name,
      startTs,
      durMs: dur > 10000 ? dur : dur * 60e3, // minutes, unless it is already in milliseconds
      host,
      people,
      gameLink: str(pick(x, ['gameLink', 'link', 'placeUrl'])),
    };
  }

  // Short version of a session (long texts cut, lists shortened) for the diagnostic message
  function compact(v, depth = 0) {
    if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
    if (Array.isArray(v)) {
      if (depth > 3) return `[${v.length} items]`;
      return v.slice(0, 2).map(i => compact(i, depth + 1)).concat(v.length > 2 ? [`… +${v.length - 2} more`] : []);
    }
    if (v && typeof v === 'object') {
      if (depth > 3) return '{…}';
      return Object.fromEntries(Object.entries(v).slice(0, 25).map(([k, val]) => [k, compact(val, depth + 1)]));
    }
    return v;
  }
  const sampleOf = raw =>
    raw.find(x => [x.users, x.participants, x.roles, x.slots].some(a => Array.isArray(a) && a.length)) ?? raw[0];

  // ---------- Announce / update / unclaim ----------
  async function announceSession(m) {
    const guild = client.guilds.cache.get(GUILD_ID);
    const channel = await getChannel(CHANNEL_ID);
    if (!channel) throw new Error('SESSIONS_CHANNEL_ID is missing or the channel was not found.');
    const gameLink = String(m.gameLink || GAME_LINK || '').trim();
    if (!/^https?:\/\/\S+$/i.test(gameLink) || gameLink.length > 100)
      throw new Error('Set a valid SESSION_GAME_LINK (max 100 characters) in the .env.');

    const s = { name: NAME_OVERRIDE || m.name, host: m.host, startTs: m.startTs, endTs: m.startTs + m.durMs };

    let event;
    try {
      event = await guild.scheduledEvents.create({
        name: s.name.slice(0, 100),
        scheduledStartTime: new Date(s.startTs),
        scheduledEndTime: new Date(s.endTs),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: gameLink },
        description: eventDescription(s),
        reason: `Session claimed by ${s.host} (Planetary)`,
      });
    } catch (err) {
      if (err.code === 50013) throw new Error('Missing permissions: the bot needs "Manage Events".');
      throw err;
    }

    try {
      const msg = await channel.send({
        content: PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined,
        embeds: [announceEmbed(s)],
        components: [linkRow(event.url, gameLink)],
        allowedMentions: { roles: PING_ROLE_ID ? [PING_ROLE_ID] : [] },
      });
      db.planetary[m.id] = {
        name: s.name, host: s.host, startTs: s.startTs, endTs: s.endTs,
        eventId: event.id, channelId: channel.id, messageId: msg.id,
      };
      save();
      logAction(new EmbedBuilder().setColor(COLORS.info).setTitle('📅 Session claimed').setFooter({ text: getBrand() })
        .setDescription(`**${s.name}**\nHost: ${s.host}\nStaff Join: ${ts(s.startTs, 'F')}`));
    } catch (err) {
      await event.delete().catch(() => {});
      throw err;
    }
  }

  async function refreshSession(rec, m) {
    rec.host = m.host;
    const s = { name: rec.name, host: rec.host, startTs: rec.startTs, endTs: rec.endTs };
    const guild = client.guilds.cache.get(GUILD_ID);
    const event = await guild.scheduledEvents.fetch(rec.eventId).catch(() => null);
    if (event) await event.edit({ description: eventDescription(s) }).catch(() => {});
    const ch = await getChannel(rec.channelId);
    const msg = await ch?.messages.fetch(rec.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [announceEmbed(s)] }).catch(() => {});
    save();
  }

  async function unclaimSession(id, rec) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (rec.eventId) await guild.scheduledEvents.delete(rec.eventId).catch(() => {});
    const ch = await getChannel(rec.channelId);
    const msg = await ch?.messages.fetch(rec.messageId).catch(() => null);
    if (msg?.embeds[0]) {
      await msg.edit({
        embeds: [EmbedBuilder.from(msg.embeds[0]).setColor(COLORS.bad).setTitle(`❌ Host left: ${rec.name}`.slice(0, 256))],
        components: [],
      }).catch(() => {});
    }
    delete db.planetary[id]; // can be announced again if someone claims it later
    save();
  }

  // ---------- Attendance: who is in the game? ----------
  const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const robloxIds = new Map();

  async function robloxId(username) {
    const key = username.toLowerCase();
    if (robloxIds.has(key)) return robloxIds.get(key);
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Roblox users API error (HTTP ${res.status})`);
    const id = (await res.json()).data?.[0]?.id ?? null;
    if (id) robloxIds.set(key, id);
    return id;
  }

  // Last time (unix seconds) the SessionPresence script marked this player in a game, or null
  async function lastSeen(universe, userId) {
    const url = `https://apis.roblox.com/cloud/v2/universes/${universe}/ordered-data-stores/${encodeURIComponent(PRESENCE_STORE)}/scopes/global/entries/${userId}`;
    const res = await fetch(url, { headers: { 'x-api-key': ROBLOX_API_KEY }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null; // never marked
    if (!res.ok) throw new Error(`Presence read failed in universe ${universe} (HTTP ${res.status}): ${(await res.text()).replace(/\s+/g, ' ').slice(0, 150)}`);
    return Number((await res.json()).value) || null;
  }

  async function isInGame(userId) {
    const now = Math.floor(Date.now() / 1000);
    for (const universe of PRESENCE_UNIVERSES) {
      const seen = await lastSeen(universe, userId);
      if (seen && now - seen <= PRESENCE_FRESH_SECONDS) return true;
    }
    return false;
  }

  // Finds the Discord account of a Roblox username (for the DM and the mention)
  let scanned = false;
  async function findDiscordUser(username) {
    const lower = username.toLowerCase();
    if (LINKS[lower]) return LINKS[lower];

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return null;
    const re = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(lower)}([^a-z0-9_]|$)`, 'i');
    const matches = members => [...members.values()].filter(mem => !mem.user.bot
      && [mem.nickname, mem.displayName, mem.user.username, mem.user.globalName].some(n => n && re.test(n)));

    if (FULL_MEMBER_SCAN) {
      try {
        if (!scanned) { await guild.members.fetch(); scanned = true; }
        const found = matches(guild.members.cache);
        if (found.length === 1) return found[0].id;
      } catch (e) { attendanceError(`Member scan failed: ${e.message}`); }
    }
    try {
      const found = matches(await guild.members.search({ query: username, limit: 10 }));
      if (found.length === 1) return found[0].id;
    } catch { /* needs the "Server Members Intent" enabled in the Developer Portal */ }
    return null;
  }

  const reminderEmbed = (m, person) => new EmbedBuilder().setColor(COLORS.pending)
    .setTitle((NAME_OVERRIDE || m.name).slice(0, 256))
    .setDescription([
      REMINDER.greeting.replaceAll('{username}', person),
      REMINDER.body,
      REMINDER.rule.replaceAll('{minutes}', String(REMINDER_MINUTES)),
      REMINDER.warning,
    ].join('\n\n'))
    .setFooter({ text: getBrand(), iconURL: client.user.displayAvatarURL() });

  async function sendReminder(m, person) {
    const embed = reminderEmbed(m, person);
    const gameLink = String(m.gameLink || GAME_LINK || '').trim();
    const components = validLink(gameLink)
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(REMINDER.button).setStyle(ButtonStyle.Link).setURL(gameLink))]
      : [];

    const discordId = await findDiscordUser(person);
    let dm = false;
    if (discordId) {
      try {
        const user = await client.users.fetch(discordId);
        await user.send({ embeds: [embed], components });
        dm = true;
      } catch { /* DMs closed */ }
    }

    const channel = await getChannel(REMINDER_CHANNEL_ID);
    if (channel) {
      const note = dm ? '' : (discordId ? '\n*(I could not send a DM)*' : '\n*(no Discord account linked to this username)*');
      await channel.send({
        content: `${discordId ? `<@${discordId}>` : `**${person}**`}${note}`,
        embeds: [embed],
        components,
        allowedMentions: { users: discordId ? [discordId] : [] },
      });
    }
    return { dm, discordId, channel: !!channel };
  }

  const seenAttendanceErrors = new Set();
  function attendanceError(message) {
    if (seenAttendanceErrors.has(message)) return;
    seenAttendanceErrors.add(message);
    console.error(`Sessions (attendance): ${message}`);
    logAction(new EmbedBuilder().setColor(COLORS.bad).setTitle('⚠️ Sessions: attendance check problem')
      .setDescription(message.slice(0, 1000)).setFooter({ text: getBrand() }));
  }

  // From (start - N minutes) until the start: whoever is not in the game gets one reminder
  async function checkAttendance(items) {
    if (!remindersOn()) return;
    const now = Date.now();
    const window = REMINDER_MINUTES * 60e3;
    for (const m of items) {
      if (!m.people.length || now < m.startTs - window || now >= m.startTs) continue;
      for (const person of m.people) {
        const key = `${m.id}:${person.toLowerCase()}`;
        if (db.reminders[key]) continue;
        try {
          const userId = await robloxId(person);
          if (!userId) {
            attendanceError(`Roblox user "${person}" was not found (session "${m.name}").`);
            db.reminders[key] = { skipped: true, at: now };
            continue;
          }
          if (await isInGame(userId)) {
            db.reminders[key] = { present: true, at: now };
            continue;
          }
          const res = await sendReminder(m, person);
          db.reminders[key] = { present: false, dm: res.dm, at: now };
          console.log(`Sessions: reminder sent to ${person} for "${m.name}" (DM: ${res.dm ? 'yes' : 'no'})`);
          info('⏰ Attendance reminder sent',
            `**${person}** was not in the game for **${NAME_OVERRIDE || m.name}** (starts ${ts(m.startTs)}).\n`
            + `DM: ${res.dm ? 'sent' : (res.discordId ? 'failed (DMs closed?)' : 'no linked Discord account')} | Channel: ${res.channel ? 'sent' : 'not configured'}`);
        } catch (err) {
          attendanceError(`Could not check ${person} for "${m.name}": ${err.message}`);
        }
      }
    }
  }

  // ---------- Status messages (console + log channel, only when something changes) ----------
  let connected = false;
  let lastError = null;
  let lastSignature = '';
  const seenErrors = new Set();

  function reportError(message) {
    if (message === lastError) return;
    lastError = message;
    connected = false;
    console.error(`Sessions: ${message}`);
    logAction(new EmbedBuilder().setColor(COLORS.bad).setTitle('⚠️ Sessions: problem with the Planetary workspace')
      .setDescription(message.slice(0, 1000)).setFooter({ text: getBrand() }));
  }

  function reportOk(raw, items, body) {
    const withHost = items.filter(m => m.host).length;
    const signature = `${raw.length}/${items.length}/${withHost}`;
    if (DEBUG && signature !== lastSignature) {
      lastSignature = signature;
      console.log(`Sessions (debug): ${raw.length} session(s), ${items.length} readable, ${withHost} with a host`);
    }
    if (connected) return;
    connected = true;
    lastError = null;
    console.log(`Sessions: connected to Planetary (${activePath}) - ${raw.length} session(s) found, ${withHost} with a host`);
    if (raw.length && !items.length) {
      console.warn('Sessions: sessions were found but none has a readable start time.');
    }

    // nothing found: send what the API returns, so the reading can be fixed
    if (DEBUG || raw.length === 0 || withHost === 0) {
      const sample = raw.length ? JSON.stringify(compact(sampleOf(raw)), null, 1).slice(0, 1500) : body.slice(0, 500);
      console.log('Sessions: sample of what the API returns:\n' + sample);
      info('🔎 Sessions: what the Planetary API returns',
        `Sessions found: **${raw.length}** | readable: **${items.length}** | with a host: **${withHost}**\n`
        + (raw.length === 0 ? 'The API returned **no upcoming sessions**.\n' : '')
        + '```json\n' + sample + '\n```\n'
        + 'If sessions with a host are not being detected, send this to the developer (remove anything private first).');
    }
  }

  // ---------- Polling ----------
  let polling = false;
  async function poll() {
    if (!configured() || polling) return;
    polling = true;
    try {
      if (activePath.includes('{')) {
        throw new Error('PLANETARY_SESSIONS_PATH has {id} but the workspace id is unknown. Add PLANETARY_WORKSPACE_ID=your_workspace_number to the .env (the number in .../workspace/123456).');
      }
      let r = await request(activePath);

      // wrong path: look for the right one (at most once per hour)
      if (!usable(r) && r.status !== 401 && r.status !== 403 && Date.now() - lastDiscovery > 3600e3) {
        const found = await discover(activePath);
        if (found) {
          activePath = found.path;
          r = found.r;
          console.log(`Sessions: found a working path: ${activePath}\nSessions: put PLANETARY_SESSIONS_PATH=${activePath} in the .env to skip the search next time.`);
        }
      }

      if (r.status === 401 || r.status === 403) {
        throw new Error(`Planetary rejected the API key (HTTP ${r.status}). Check PLANETARY_API_KEY (it should start with "orbit_") and that the key can read sessions.`);
      }
      if (r.status >= 300 && r.status < 400) {
        throw new Error(`${activePath} was redirected to a web page (HTTP ${r.status}). PLANETARY_URL must be only the domain (no /workspace/...) and the path must be the API path (/api/public/...).`);
      }
      if (r.status >= 520 && r.status <= 530) {
        throw new Error(`Cloudflare reports a bad answer from the Planetary server (HTTP ${r.status}) on ${activePath}. Usually the workspace id in the path is wrong, or the workspace is temporarily down. Check PLANETARY_WORKSPACE_ID.`);
      }
      if (!r.ok) {
        const why = r.status === 404
          ? 'that path does not exist in your workspace'
          : r.text.replace(/\s+/g, ' ').slice(0, 120);
        throw new Error(`Planetary API error (HTTP ${r.status}) on ${activePath}: ${why}. Check PLANETARY_SESSIONS_PATH in the .env (docs.planetaryapp.us > API Reference > Sessions > "Get Upcoming Sessions").`);
      }
      if (!r.data || typeof r.data !== 'object') {
        throw new Error(`${activePath} did not answer with data (it returned a web page). Check PLANETARY_URL (only the domain) and PLANETARY_SESSIONS_PATH.`);
      }

      const raw = asList(r.data);
      const items = raw.map(mapSession).filter(m => m.id && m.startTs);
      reportOk(raw, items, r.text);

      const first = !db.planetaryReady;
      let remembered = 0;
      for (const m of items) {
        const rec = db.planetary[m.id];
        try {
          if (m.host && !rec) {
            if (first && !ANNOUNCE_EXISTING) {
              // first run: remember what was already claimed, without announcing it
              db.planetary[m.id] = { skipped: true, host: m.host, endTs: m.startTs + m.durMs };
              remembered++;
            } else if (m.startTs < Date.now() + 60e3) {
              db.planetary[m.id] = { skipped: true, host: m.host, endTs: m.startTs + m.durMs }; // too late for an event
            } else {
              await announceSession(m);
            }
          } else if (rec?.skipped && !m.host) {
            delete db.planetary[m.id];
          } else if (rec && !rec.skipped) {
            if (!m.host) await unclaimSession(m.id, rec);
            else if (m.host !== rec.host) await refreshSession(rec, m);
          }
        } catch (err) {
          const key = `${m.id}:${err.message}`;
          if (!seenErrors.has(key)) {
            seenErrors.add(key);
            console.error(`Sessions: session ${m.id}: ${err.message}`);
            logAction(new EmbedBuilder().setColor(COLORS.bad).setTitle('⚠️ Sessions: could not announce a session')
              .setDescription(`**${m.name}**\n${err.message}`.slice(0, 1000)).setFooter({ text: getBrand() }));
          }
        }
      }

      if (first && remembered) {
        console.log(`Sessions: ${remembered} session(s) already had a host when the bot first connected, so they were NOT announced. New claims will be.`);
        info('ℹ️ Sessions: already-claimed sessions were not announced',
          `**${remembered}** session(s) already had a host when the bot first connected, so they were only remembered. `
          + 'New claims from now on are announced.\nTo announce them too: put `PLANETARY_ANNOUNCE_EXISTING=true` and `PLANETARY_RESET=true` in the .env, restart once, then remove both lines.');
      }

      // people who are not in the game shortly before their session
      await checkAttendance(items);

      db.planetaryReady = true;
      save();
    } catch (err) {
      reportError(err.message);
    } finally {
      polling = false;
    }
  }

  function start() {
    if (!BASE_URL) return console.warn('Sessions: PLANETARY_URL is missing or invalid in the .env (session announcements are off)');
    if (!API_KEY) return console.warn('Sessions: PLANETARY_API_KEY is missing in the .env (session announcements are off)');
    console.log(`Sessions: using ${BASE_URL}${SESSIONS_PATH}`);
    console.log(remindersOn()
      ? `Sessions: attendance reminders ON (${REMINDER_MINUTES} min before, universe(s): ${PRESENCE_UNIVERSES.join(', ')})`
      : 'Sessions: attendance reminders are OFF (set PRESENCE_UNIVERSE_IDS in the .env to turn them on)');
    if (RESET) {
      db.planetary = {};
      db.planetaryReady = false;
      console.log('Sessions: remembered sessions cleared (PLANETARY_RESET=true). Remove that line from the .env after this start.');
    }
    const cutoff = Date.now() - 30 * 86400e3; // forget sessions that ended more than 30 days ago
    for (const [id, r] of Object.entries(db.planetary)) {
      if ((r.endTs || 0) < cutoff) delete db.planetary[id];
    }
    const reminderCutoff = Date.now() - 7 * 86400e3; // forget reminders older than 7 days
    for (const [k, r] of Object.entries(db.reminders)) {
      if ((r.at || 0) < reminderCutoff) delete db.reminders[k];
    }
    save();
    setTimeout(poll, 5000);
    setInterval(poll, POLL_SECONDS * 1000);
  }

  // No commands: everything runs by itself
  return {
    buildCommands: () => [],
    handle: async () => false,
    handleButton: async () => false,
    handleModal: async () => false,
    start,
  };
};
