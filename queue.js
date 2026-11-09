// queue.js - promotes people from the Application Center / Rank Center games.
// The games write "this user should get rank X" into an Ordered DataStore.
// This file reads it, changes the group rank and removes the entry.
const { EmbedBuilder } = require('discord.js');

module.exports = function createQueue(ctx) {
  const { rbx, getRoles, findRole, getMembership, setRank, logAction, COLORS, roleName } = ctx;

  // ---------- CONFIG ----------
  const STORE = process.env.QUEUE_STORE || 'RankQueue'; // must match QUEUE_DATASTORE in the Roblox scripts
  const SCOPE = 'global';
  const SWEEP_SECONDS = 60;

  // QUEUE_UNIVERSES=1234567:Application Center,7654321:Rank Center   (universe ID : label)
  const UNIVERSES = (process.env.QUEUE_UNIVERSES || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(s => {
      const [id, ...rest] = s.split(':');
      return { id: id.trim(), label: rest.join(':').trim() || `Game ${id.trim()}` };
    });

  const base = uni =>
    `https://apis.roblox.com/cloud/v2/universes/${uni}/ordered-data-stores/${STORE}/scopes/${SCOPE}/entries`;
  const listOf = d =>
    d?.orderedDataStoreEntries || d?.entries || Object.values(d || {}).find(Array.isArray) || [];
  const entryId = e => String(e.id || String(e.path).split('/').pop());

  const warned = new Set(); // avoids repeating the same warning every minute
  const warnOnce = (key, text) => {
    if (!warned.has(key)) { warned.add(key); console.warn(text); }
  };

  async function robloxName(userId) {
    try {
      const res = await fetch('https://users.roblox.com/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [Number(userId)], excludeBannedUsers: false }),
      });
      const { data } = await res.json();
      return data?.[0]?.name || `User ${userId}`;
    } catch {
      return `User ${userId}`;
    }
  }

  async function sweepUniverse({ id: uni, label }) {
    const d = await rbx('GET', `${base(uni)}?maxPageSize=50`);
    const entries = listOf(d);
    if (!entries.length) return;

    const roles = await getRoles();
    for (const e of entries) {
      const userId = entryId(e);
      const raw = Number(e.value) || 0;
      const rank = Math.floor(raw / 1000); // target group rank
      const score = raw % 1000;            // test score (0 for purchases)
      try {
        const target = findRole(roles, String(rank));
        if (!target || target.rank <= 0 || target.rank >= 255) {
          warnOnce(`${uni}:${userId}:rank`, `Queue (${label}): rank ${rank} does not exist in the group (user ${userId})`);
          continue;
        }
        const mem = await getMembership(userId, roles);
        if (!mem.inGroup) {
          warnOnce(`${uni}:${userId}:group`, `Queue (${label}): user ${userId} is not in the group yet, waiting`);
          continue;
        }
        if (mem.role && mem.role.rank >= target.rank) {
          await rbx('DELETE', `${base(uni)}/${userId}`); // already has this rank (or higher)
          continue;
        }

        await setRank(userId, target.path, mem.role?.path);
        await rbx('DELETE', `${base(uni)}/${userId}`);

        const name = await robloxName(userId);
        const isTest = score > 0;
        logAction(new EmbedBuilder().setColor(COLORS.ok)
          .setTitle(isTest ? '📝 Application passed' : '💳 Rank purchased')
          .setDescription(
            `**${name}**: ${mem.role ? roleName(mem.role) : 'Unknown'} → **${roleName(target)}**`
            + (isTest ? `\nScore: **${score}%**` : ''),
          )
          .setFooter({ text: label }));
      } catch (err) {
        console.error(`Queue (${label}) failed for user ${userId}:`, err.message);
      }
    }
  }

  async function sweep() {
    for (const u of UNIVERSES) {
      try {
        await sweepUniverse(u);
      } catch (e) {
        console.error(`Queue (${u.label}):`, e.message);
      }
    }
  }

  function start() {
    if (!UNIVERSES.length) {
      return console.warn('QUEUE_UNIVERSES is empty: Application Center / Rank Center promotions are off');
    }
    sweep();
    setInterval(sweep, SWEEP_SECONDS * 1000);
  }

  return { start };
};
