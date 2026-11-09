// points.js - points system (Discord side). Put this file next to index.js.
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = function createPoints(ctx) {
  const {
    rbx, getRobloxUser, getMembership, getRoles, findRole, setRank,
    userEmbed, isStaff, logAction, COLORS, EPH, roleName, getBrand,
  } = ctx;

  // ---------- CONFIG ----------
  const UNIVERSE_ID = process.env.POINTS_UNIVERSE_ID;                // the game where the points are stored
  // Data save (DataStore names). Must match POINTS_DATASTORE / DOUBLE_DATASTORE in the Roblox script.
  const POINTS_STORE = process.env.POINTS_STORE || 'Points';
  const DOUBLE_STORE = process.env.DOUBLE_STORE || 'DoublePoints';
  const SCOPE = 'global';
  const DOUBLE_MULTIPLIER = 2;          // points multiplier for gamepass owners (points given with /points add)
  const AUTO_RANK_SWEEP_MIN = 5;        // how often the bot checks who reached a rank threshold (minutes)

  // When someone reaches X points they are promoted to this group rank (name or number).
  // Edit with your real ranks, from lowest to highest.
  const RANK_UP = [
    { points: 2500, rank: 55 },
    { points: 5000, rank: 60 },
    { points: 10000, rank: 62 },
    { points: 20000, rank: 65 },
  ];

  const fmt = n => Number(n).toLocaleString('en-US');
  const base = store =>
    `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE_ID}/ordered-data-stores/${store}/scopes/${SCOPE}/entries`;

  // The list of entries inside a list response (works whatever the field is called)
  const listOf = d =>
    d?.orderedDataStoreEntries || d?.entries || Object.values(d || {}).find(Array.isArray) || [];
  const entryId = e => String(e.id || String(e.path).split('/').pop());

  // ---------- Ordered data store helpers ----------
  // Returns the stored value, or null if the entry does not exist yet
  async function getEntry(store, userId) {
    try {
      const d = await rbx('GET', `${base(store)}/${userId}`);
      return Number(d.value) || 0;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Adds (or removes, with a negative amount) points. Never goes below 0.
  async function changePoints(userId, amount) {
    const current = await getEntry(POINTS_STORE, userId);
    const before = current ?? 0;
    const delta = Math.max(amount, -before);
    if (delta === 0) return { before, after: before };

    // first time: create the entry
    if (current === null) {
      const d = await rbx('POST', `${base(POINTS_STORE)}?id=${userId}`, { value: delta });
      return { before, after: Number(d.value) };
    }
    // adding: atomic increment
    if (delta > 0) {
      const d = await rbx('POST', `${base(POINTS_STORE)}/${userId}:increment`, { amount: delta });
      return { before, after: Number(d.value) };
    }
    // removing: set the new total
    const after = before + delta;
    const d = await rbx('PATCH', `${base(POINTS_STORE)}/${userId}`, { value: after });
    return { before, after: Number(d.value ?? after) };
  }

  // Promotes the user if their points reached a threshold. Returns a text or null.
  async function checkRankUp(u, points) {
    const reached = RANK_UP.filter(t => points >= t.points).sort((a, b) => b.points - a.points)[0];
    if (!reached) return null;
    const roles = await getRoles();
    const target = findRole(roles, reached.rank);
    if (!target || target.rank <= 0 || target.rank >= 255) return `⚠️ Auto-rank: rank "${reached.rank}" was not found`;
    const mem = await getMembership(u.id, roles);
    if (!mem.inGroup) return null; // not in the group: nothing to promote
    if (mem.role && mem.role.rank >= target.rank) return null; // already at or above it
    await setRank(u.id, target.path, mem.role?.path);
    return `⬆️ ${mem.role ? roleName(mem.role) : 'Unknown'} → **${roleName(target)}**`;
  }

  async function robloxNames(ids) {
    const res = await fetch('https://users.roblox.com/v1/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: ids, excludeBannedUsers: false }),
    });
    if (!res.ok) return {};
    const { data } = await res.json();
    return Object.fromEntries(data.map(u => [String(u.id), u.name]));
  }

  // ---------- Auto-rank sweep (points earned in-game) ----------
  // Goes through the top of the leaderboard and promotes everyone who reached a threshold.
  async function autoRankSweep() {
    if (!UNIVERSE_ID || !RANK_UP.length) return;
    try {
      const lowest = Math.min(...RANK_UP.map(t => t.points));
      let token = '';
      let checked = 0;
      let done = false;
      do {
        const url = `${base(POINTS_STORE)}?maxPageSize=100&orderBy=${encodeURIComponent('value desc')}`
          + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
        const d = await rbx('GET', url);
        for (const e of listOf(d)) {
          const value = Number(e.value) || 0;
          if (value < lowest) { done = true; break; } // sorted by points: nobody else qualifies
          const id = entryId(e);
          checked++;
          try {
            const text = await checkRankUp({ id: Number(id) }, value);
            if (!text) continue;
            if (text.startsWith('⚠️')) { console.warn(text); continue; }
            const names = await robloxNames([Number(id)]);
            logAction(new EmbedBuilder().setColor(COLORS.ok).setTitle('⬆️ Auto-rank')
              .setFooter({ text: getBrand() })
              .setDescription(`**${names[id] || `User ${id}`}** reached ${fmt(value)} points\n${text}`));
          } catch (err) {
            console.error(`Auto-rank failed for ${id}:`, err.message);
          }
        }
        token = done ? '' : d.nextPageToken;
      } while (token && checked < 300);
    } catch (e) {
      console.error('Auto-rank sweep:', e.message);
    }
  }

  function start() {
    autoRankSweep();
    setInterval(autoRankSweep, AUTO_RANK_SWEEP_MIN * 60 * 1000);
  }

  // ---------- Commands (rebuilt when the bot name changes) ----------
  const usernameOpt = o => o.setName('username').setDescription('Roblox username').setRequired(true);
  const amountOpt = o => o.setName('amount').setDescription('Number of points').setMinValue(1).setMaxValue(1000000).setRequired(true);
  const reasonOpt = o => o.setName('reason').setDescription('Reason (optional)');

  function buildCommands(brand) {
    return [
      new SlashCommandBuilder().setName('points').setDescription(`Manage ${brand} points`)
        .addSubcommand(s => s.setName('add').setDescription('Give points to a user')
          .addStringOption(usernameOpt).addIntegerOption(amountOpt).addStringOption(reasonOpt))
        .addSubcommand(s => s.setName('remove').setDescription('Remove points from a user')
          .addStringOption(usernameOpt).addIntegerOption(amountOpt).addStringOption(reasonOpt))
        .addSubcommand(s => s.setName('check').setDescription("Check a user's points")
          .addStringOption(usernameOpt))
        .addSubcommand(s => s.setName('debug').setDescription('Test the connection to the points data store')),
      new SlashCommandBuilder().setName('leaderboard').setDescription('Show the points leaderboard'),
      new SlashCommandBuilder().setName('pm').setDescription('Send a private message to a Discord user')
        .addUserOption(o => o.setName('user').setDescription('User to message').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Message to send').setMaxLength(1800).setRequired(true)),
    ];
  }

  // Returns true if the interaction was handled here
  async function handle(i) {
    if (!i.isChatInputCommand()) return false;
    const name = i.commandName;
    if (!['points', 'pm', 'leaderboard'].includes(name)) return false;

    // /pm
    if (name === 'pm') {
      if (!isStaff(i)) { await i.reply({ content: '⛔ This command requires elevated privileges.', ...EPH }); return true; }
      const target = i.options.getUser('user');
      if (target.bot) { await i.reply({ content: '❌ You cannot message a bot.', ...EPH }); return true; }
      const sender = i.member?.displayName || i.user.username;
      const e = new EmbedBuilder().setColor(COLORS.info)
        .setTitle(`📩 Message from the ${getBrand()} team`)
        .setDescription(i.options.getString('message'))
        .setFooter({ text: `Sent by ${sender}` });
      try {
        await target.send({ embeds: [e] });
        await i.reply({ content: `✅ Message sent to ${target.username}.`, ...EPH });
      } catch {
        await i.reply({ content: `❌ Could not message ${target.username} (their DMs may be closed).`, ...EPH });
      }
      return true;
    }

    // /points debug: shows exactly what Roblox answers
    if (name === 'points' && i.options.getSubcommand() === 'debug') {
      if (!isStaff(i)) { await i.reply({ content: '⛔ This command requires elevated privileges.', ...EPH }); return true; }
      await i.deferReply(EPH);
      const key = process.env.ROBLOX_API_KEY;
      const lines = [
        `Universe ID: ${UNIVERSE_ID || '❌ missing (POINTS_UNIVERSE_ID in .env)'}`,
        `API key: ${key ? '✅ set' : '❌ missing (ROBLOX_API_KEY in .env)'}`,
        `Data store: ${POINTS_STORE} (scope ${SCOPE})`,
      ];
      if (UNIVERSE_ID && key) {
        try {
          const url = `${base(POINTS_STORE)}?maxPageSize=1&orderBy=${encodeURIComponent('value desc')}`;
          const res = await fetch(url, { headers: { 'x-api-key': key } });
          const body = (await res.text()).slice(0, 500);
          lines.push(`List entries: HTTP ${res.status}`, `\`\`\`${body || '(empty)'}\`\`\``);
        } catch (err) {
          lines.push(`Request failed: ${err.message}`);
        }
      }
      await i.editReply(lines.join('\n'));
      return true;
    }

    if (!UNIVERSE_ID) {
      await i.reply({ content: '❌ POINTS_UNIVERSE_ID is not configured in the .env file.', ...EPH });
      return true;
    }

    // /leaderboard
    if (name === 'leaderboard') {
      await i.deferReply();
      const d = await rbx('GET', `${base(POINTS_STORE)}?maxPageSize=10&orderBy=${encodeURIComponent('value desc')}`);
      const entries = listOf(d).map(e => ({ id: entryId(e), value: Number(e.value) || 0 }));
      if (!entries.length) { await i.editReply('No points yet.'); return true; }
      const names = await robloxNames(entries.map(e => Number(e.id)));
      const medals = ['🥇', '🥈', '🥉'];
      const lines = entries.map((e, n) =>
        `${medals[n] || `**${n + 1}.**`} ${names[e.id] || `User ${e.id}`} — **${fmt(e.value)}**`);
      const embed = new EmbedBuilder().setColor(COLORS.info)
        .setTitle(`🏆 ${getBrand()} points leaderboard`).setDescription(lines.join('\n'))
        .setFooter({ text: getBrand() });
      await i.editReply({ embeds: [embed] });
      return true;
    }

    // /points add | remove | check
    const sub = i.options.getSubcommand();
    if (sub !== 'check' && !isStaff(i)) {
      await i.reply({ content: '⛔ This command requires elevated privileges.', ...EPH });
      return true;
    }
    await i.deferReply(sub === 'check' ? EPH : {});
    const u = await getRobloxUser(i.options.getString('username'));
    if (!u) { await i.editReply('❌ Roblox user not found.'); return true; }

    if (sub === 'check') {
      const pts = (await getEntry(POINTS_STORE, u.id)) ?? 0;
      const e = (await userEmbed(u, '⭐ Points', COLORS.info)).addFields({ name: 'Total', value: fmt(pts), inline: true });
      await i.editReply({ embeds: [e] });
      return true;
    }

    const amount = i.options.getInteger('amount');
    const reason = i.options.getString('reason') || 'No reason given';

    if (sub === 'add') {
      const doubled = ((await getEntry(DOUBLE_STORE, u.id)) ?? 0) > 0; // gamepass owner?
      const given = doubled ? amount * DOUBLE_MULTIPLIER : amount;
      const { before, after } = await changePoints(u.id, given);
      let rankText = null;
      try { rankText = await checkRankUp(u, after); }
      catch (err) { rankText = `⚠️ Auto-rank failed: ${err.message}`; }
      const e = (await userEmbed(u, '⭐ Points added', COLORS.ok)).addFields(
        { name: 'Added', value: `+${fmt(given)}${doubled ? ` (x${DOUBLE_MULTIPLIER} gamepass)` : ''}`, inline: true },
        { name: 'Total', value: `${fmt(before)} → ${fmt(after)}`, inline: true },
        { name: 'Staff', value: `<@${i.user.id}>`, inline: true },
        { name: 'Reason', value: reason.slice(0, 500) },
      );
      if (rankText) e.addFields({ name: 'Auto-rank', value: rankText });
      await i.editReply({ embeds: [e] });
      logAction(e);
      return true;
    }

    // remove
    const { before, after } = await changePoints(u.id, -amount);
    const e = (await userEmbed(u, '⭐ Points removed', COLORS.bad)).addFields(
      { name: 'Removed', value: `-${fmt(before - after)}`, inline: true },
      { name: 'Total', value: `${fmt(before)} → ${fmt(after)}`, inline: true },
      { name: 'Staff', value: `<@${i.user.id}>`, inline: true },
      { name: 'Reason', value: reason.slice(0, 500) },
    );
    await i.editReply({ embeds: [e] });
    logAction(e);
    return true;
  }

  return { buildCommands, handle, start };
};
