require('dotenv').config();
console.log('DEBUG MONGO_URI:', process.env.MONGO_URI);
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ Falta la variable de entorno JWT_SECRET. El servidor no puede arrancar sin ella (por seguridad, ya no hay un valor por defecto).');
  process.exit(1);
}
const COC_API = 'https://api.clashofclans.com/v1';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

mongoose
  .connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/clash_db')
  .then(() => console.log('✅ Conectado exitosamente a MongoDB'))
  .catch((err) => console.error('❌ Error al conectar a MongoDB:', err));

// ═══════════ ESQUEMAS ═══════════

const clanSchema = new mongoose.Schema({
  tag: String,
  name: String,
  clanLevel: Number,
  members: Number,
  memberList: Array,
  // Dueño de este guardado: 'player:<playerTag>' si el usuario está registrado,
  // o 'device:<id>' si es invitado (ver header X-Device-Id). Así cada quien
  // tiene su propia lista en vez de una sola lista compartida por todos.
  ownerTag: { type: String, index: true },
  savedAt: { type: Date, default: Date.now },
  // true: lo guardó la app sola porque era el clan del usuario en ese momento
  //   (se puede borrar solo si detecta que ya no pertenece a él).
  // false: lo guardó el usuario a propósito con el botón 💾 -- nunca se
  //   borra automáticamente, ni aunque coincida con un clan que dejó.
  autoSaved: { type: Boolean, default: false },
});

clanSchema.index({ tag: 1, ownerTag: 1 }, { unique: true });

const Clan = mongoose.models.Clan || mongoose.model('Clan', clanSchema);

// ═══ Fecha de vinculación del clan (global, no depende de quién lo guardó) ═══
// A diferencia de Clan (que tiene un doc por cada ownerTag que lo guarda),
// aquí hay UN solo doc por tag: la primera vez que este clan aparece en la
// app -- de cualquier usuario -- queda fijada para siempre. Así todos los
// miembros del clan ven la misma fecha sin importar el dispositivo.
const clanLinkSchema = new mongoose.Schema({
  tag: { type: String, unique: true, index: true },
  linkedAt: { type: Date, default: Date.now },
  // ═══ Caché de estado para el vigía de guerras (evita golpear la API de
  // Supercell en cada pasada para clanes que no están en guerra) ═══
  nextWarCheckAt: { type: Date, default: null }, // null = nunca chequeado, chequear ya
  lastWarState: String, // 'notInWar' | 'preparation' | 'inWar' | etc.
  nextCwlCheckAt: { type: Date, default: null }, // null = chequear ya
});

const ClanLink =
  mongoose.models.ClanLink || mongoose.model('ClanLink', clanLinkSchema);

const warSchema = new mongoose.Schema({
  warId: { type: String, unique: true },
  clanTag: { type: String, required: true },
  opponentTag: String,
  opponentName: String,
  state: String,
  teamSize: Number,
  endTime: String,
  result: String,
  isCwl: { type: Boolean, default: false },
  monthlyStatsCounted: { type: Boolean, default: false },

  clanStats: {
    name: String,
    tag: String,
    stars: Number,
    destructionPercentage: Number,
    attacks: Number,
  },

  opponentStats: {
    name: String,
    tag: String,
    stars: Number,
    destructionPercentage: Number,
    attacks: Number,
  },

  members: [
    {
      tag: String,
      name: String,
      townhallLevel: Number,
      mapPosition: Number,
      attacks: [
        {
          attackerTag: String,
          defenderTag: String,
          stars: Number,
          destructionPercentage: Number,
          order: Number,
        },
      ],
      opponentAttacks: Number,
    },
  ],

  savedAt: { type: Date, default: Date.now },
});

const WarHistory = mongoose.models.WarHistory || mongoose.model('WarHistory', warSchema);

// ═══ CAPITAL DEL CLAN (Raid Weekends) — mirror de warSchema ═══
const capitalRaidSchema = new mongoose.Schema({
  raidWeekendId: { type: String, unique: true }, // `${clanTag}_${startTime}`
  clanTag: { type: String, required: true },
  state: String, // 'ongoing' | 'ended'
  startTime: String,
  endTime: String,
  capitalTotalLoot: Number,
  raidsCompleted: Number,
  totalAttacks: Number,
  enemyDistrictsDestroyed: Number,
  offensiveReward: Number,
  defensiveReward: Number,

  members: [
    {
      tag: String,
      name: String,
      attacks: Number,
      attackLimit: Number,
      bonusAttackLimit: Number,
      capitalResourcesLooted: Number,
    },
  ],

  savedAt: { type: Date, default: Date.now },
});

const CapitalRaid =
  mongoose.models.CapitalRaid || mongoose.model('CapitalRaid', capitalRaidSchema);

// ═══ FOTOS DIARIAS DE DONACIONES (para el ranking de puntos del clan) ═══
// Las donaciones se resetean CADA SEMANA dentro del juego, no cada mes,
// así que no se puede leer un "total del mes" directo de la API de
// Supercell. En vez de eso, tomamos una foto diaria del contador crudo
// (acumulado de esa semana) y calculamos las ganancias reales comparando
// contra el día anterior -- si el valor bajó, es que hubo reset y el
// valor de hoy YA es la ganancia nueva desde cero.
const donationSnapshotSchema = new mongoose.Schema({
  clanTag: { type: String, required: true, index: true },
  snapshotDate: { type: Date, required: true }, // medianoche UTC del día de la foto
  members: [
    {
      tag: String,
      name: String,
      donations: Number, // valor crudo tal cual lo da la API ese día (acumulado semanal)
    },
  ],
  createdAt: { type: Date, default: Date.now },
});

donationSnapshotSchema.index({ clanTag: 1, snapshotDate: 1 }, { unique: true });

const DonationSnapshot =
  mongoose.models.DonationSnapshot || mongoose.model('DonationSnapshot', donationSnapshotSchema);

const warAssignmentSchema = new mongoose.Schema({
  warId: { type: String, required: true },
  playerTag: { type: String, required: true },
  targetNumber: String,
  updatedAt: { type: Date, default: Date.now },
});

warAssignmentSchema.index({ warId: 1, playerTag: 1 }, { unique: true });

const WarAssignment =
  mongoose.models.WarAssignment || mongoose.model('WarAssignment', warAssignmentSchema);

const userSessionSchema = new mongoose.Schema({
  playerTag: { type: String, required: true, unique: true },
  playerName: String,
  role: String,
  clanTag: String,
  trophies: Number,
  isLeader: Boolean,
  pushToken: String,
  registeredAt: { type: Date, default: Date.now },
  lastAccessAt: { type: Date, default: Date.now },
});

const UserSession = mongoose.models.UserSession || mongoose.model('UserSession', userSessionSchema);

const playerMonthlyStatsSchema = new mongoose.Schema({
  clanTag: String,
  playerTag: String,
  playerName: String,
  periodKey: String,
  stars: { type: Number, default: 0 },
  attacks: { type: Number, default: 0 },
  wars: { type: Number, default: 0 },
  destruction: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

playerMonthlyStatsSchema.index({ clanTag: 1, playerTag: 1, periodKey: 1 }, { unique: true });

const PlayerMonthlyStats =
  mongoose.models.PlayerMonthlyStats ||
  mongoose.model('PlayerMonthlyStats', playerMonthlyStatsSchema);

const announcementSchema = new mongoose.Schema({
  clanTag: String,
  title: String,
  body: String,
  createdBy: String,
  createdByName: String,
  createdAt: { type: Date, default: Date.now },
  editedAt: Date,
  editedByName: String,
});

const Announcement =
  mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);

const warRulesSchema = new mongoose.Schema({
  clanTag: { type: String, unique: true },
  rules: String,
  warPolicy: String,
  minAttacks: { type: Number, default: 2 },

  // ═══ SANCIONES ═══
  autoSanctionNoAttack: { type: Boolean, default: true },
  sanctionDurationWars: { type: Number, default: 2 },
  sanctionAppliesToCwl: { type: Boolean, default: false },

  // ═══ SANCIONES — CAPITAL DEL CLAN ═══
  autoSanctionNoAttackCapital: { type: Boolean, default: true },
  sanctionDurationRaidWeekends: { type: Number, default: 2 },

  updatedAt: Date,
  updatedBy: String,
});

const WarRules = mongoose.models.WarRules || mongoose.model('WarRules', warRulesSchema);

// ═══════════ MODELO DE SANCIONES ═══════════

const sanctionSchema = new mongoose.Schema({
  clanTag: String,
  playerTag: String,
  playerName: String,
  reason: { type: String, default: 'No realizó ataques en la guerra' },
  originWarId: String,

  totalWars: { type: Number, default: 2 },
  servedWars: { type: Number, default: 0 },
  servedWarIds: [String],

  active: { type: Boolean, default: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  createdBy: String,
});

sanctionSchema.index({ clanTag: 1, playerTag: 1, active: 1 });

const Sanction = mongoose.models.Sanction || mongoose.model('Sanction', sanctionSchema);

// ═══════════ MODELO DE SANCIONES — CAPITAL DEL CLAN ═══════════
// Modelo separado (no reutiliza Sanction) para no arriesgar las sanciones
// de guerra ya guardadas: mismos campos, pero contando raid weekends.
const capitalSanctionSchema = new mongoose.Schema({
  clanTag: String,
  playerTag: String,
  playerName: String,
  reason: { type: String, default: 'No realizó ataques en el Raid Weekend' },
  originRaidWeekendId: String,

  totalRaidWeekends: { type: Number, default: 2 },
  servedRaidWeekends: { type: Number, default: 0 },
  servedRaidWeekendIds: [String],

  active: { type: Boolean, default: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  createdBy: String,
});

capitalSanctionSchema.index({ clanTag: 1, playerTag: 1, active: 1 });

const CapitalSanction =
  mongoose.models.CapitalSanction || mongoose.model('CapitalSanction', capitalSanctionSchema);

// ═══════════ HELPERS ═══════════

const cleanTag = (t) => (t || '').replace(/#/g, '').trim();

// Escapa caracteres especiales de regex — evita que un tag raro rompa una
// búsqueda por RegExp o matchee más de lo esperado.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rate limiting para las rutas de escritura que siguen abiertas a invitados
// (guardar/borrar/refrescar clanes, guardar guerras). No exige login (Opción B),
// pero pone un techo por IP para que no se pueda hacer spam/abuso masivo.
// 30 solicitudes cada 15 minutos es holgado para uso normal (un usuario real no
// guarda/borra/refresca clanes decenas de veces seguidas) pero corta un bot o abuso.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30,
  standardHeaders: true, // manda headers RateLimit-* (el cliente puede leer cuándo se libera)
  legacyHeaders: false,
  message: {
    error: 'Demasiadas solicitudes seguidas. Esperá unos minutos y volvé a intentarlo.',
    rateLimited: true,
  },
  handler: (req, res, next, options) => {
    return res.status(options.statusCode).json(options.message);
  },
});

// Identifica al "dueño" de la lista de clanes guardados sin exigir login:
// - Si viene un JWT válido de un usuario registrado, usa su playerTag.
// - Si no, usa el ID de invitado que manda el cliente en X-Device-Id (una vez
//   generado y guardado en el dispositivo). Así cada instalación/usuario tiene
//   su propia lista en vez de una sola lista compartida por todos.
const getOwnerId = async (req) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const session = await UserSession.findOne({ playerTag: decoded.playerTag });
      if (session) return `player:${decoded.playerTag}`;
    } catch (e) {
      // Token inválido/expirado — seguimos como invitado si mandó X-Device-Id.
    }
  }

  const deviceId = (req.headers['x-device-id'] || '').toString().trim();
  return deviceId ? `device:${deviceId}` : null;
};

// Cualquier ruta que modifique datos (guardar/borrar/refrescar clanes, guerras)
// requiere sesión válida — ya no puede llamarlas cualquiera sin loguearse.
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'No autenticado.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const session = await UserSession.findOne({ playerTag: decoded.playerTag });
    if (!session) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }

    req.authUser = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida.' });
  }
};

const clashFetch = async (endpoint) => {
  const response = await fetch(`${COC_API}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${process.env.COC_API_KEY}`,
    },
  });

  const data = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
};

// Solo líder/colíder del clan (verificado en vivo contra la API de Supercell,
// no solo confiando en el rol guardado en el JWT).
const requireLeader = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'No autenticado.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // Si el usuario cerró sesión, su UserSession fue borrado — el JWT viejo
    // no debe seguir sirviendo aunque la firma todavía sea válida.
    const session = await UserSession.findOne({ playerTag: decoded.playerTag });
    if (!session) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }

    const clanTag = cleanTag(req.query.clanTag || decoded.clanTag);

    const membersRes = await clashFetch(`/clans/%23${clanTag}/members`);

    if (!membersRes.ok) {
      return res.status(403).json({ error: 'No se pudo verificar el clan.' });
    }

    const member = membersRes.data.items?.find((m) => m.tag === decoded.playerTag);

    if (!member || !['leader', 'coLeader'].includes(member.role)) {
      return res
        .status(403)
        .json({ error: 'Solo líderes y colíderes pueden acceder.' });
    }

    req.leader = {
      ...decoded,
      clanTag,
      role: member.role,
      name: member.name,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida.' });
  }
};

const currentPeriodKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const getPeriodKeyFromEndTime = (endTime) => {
  if (!endTime || endTime.length < 6) return currentPeriodKey();
  return `${endTime.slice(0, 4)}-${endTime.slice(4, 6)}`;
};

// Suma estrellas de una guerra al casillero mensual de cada jugador (1 sola vez)
const accumulateMonthlyStars = async (warDoc) => {
  try {
    if (!warDoc || warDoc.monthlyStatsCounted) return;

    const periodKey = getPeriodKeyFromEndTime(warDoc.endTime);
    const clanTag = cleanTag(warDoc.clanTag);

    for (const m of warDoc.members || []) {
      const atks = m.attacks || [];

      const stars = atks.reduce((s, a) => s + (a.stars || 0), 0);
      const destruction = atks.reduce(
        (s, a) => s + (a.destructionPercentage || 0),
        0
      );

      await PlayerMonthlyStats.findOneAndUpdate(
        { clanTag, playerTag: m.tag, periodKey },
        {
          $inc: {
            stars,
            attacks: atks.length,
            wars: 1,
            destruction,
          },
          $setOnInsert: {
            playerName: m.name,
          },
          $set: {
            updatedAt: new Date(),
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }

    warDoc.monthlyStatsCounted = true;
    await warDoc.save();
  } catch (e) {
    console.error('Error acumulando stats mensuales:', e.message);
  }
};

// ═══════════ SANCIONES AUTOMÁTICAS ═══════════

const applyWarSanctions = async (warDoc, isCwl = false) => {
  try {
    if (!warDoc || warDoc.state !== 'warEnded') return;

    const clanTag = cleanTag(warDoc.clanTag);

    const rules = await WarRules.findOne({ clanTag });

    const autoEnabled = rules ? rules.autoSanctionNoAttack !== false : true;
    const duration = Math.max(1, Number(rules?.sanctionDurationWars || 2));
    const applyToCwl = rules?.sanctionAppliesToCwl === true;

    // Si el líder configuró que CWL no aplica, ignoramos guerras CWL
    if (isCwl && !applyToCwl) return;

    // ═══ 1. Avanzar sanciones activas existentes ═══
    const activeSanctions = await Sanction.find({ clanTag, active: true });

    for (const sanction of activeSanctions) {
      // Si la sanción nació de esta misma guerra, no la contamos otra vez
      if (sanction.originWarId === warDoc.warId) continue;

      // Evitamos contar dos veces la misma guerra
      if ((sanction.servedWarIds || []).includes(warDoc.warId)) continue;

      sanction.servedWarIds.push(warDoc.warId);
      sanction.servedWars = (sanction.servedWars || 0) + 1;

      if (sanction.servedWars >= sanction.totalWars) {
        sanction.active = false;
      }

      sanction.updatedAt = new Date();
      await sanction.save();
    }

    // Si el líder desactivó sanciones automáticas, no creamos nuevas
    if (!autoEnabled) return;

    // ═══ 2. Sancionar a los que no atacaron ═══
    const noAttackMembers = (warDoc.members || []).filter(
      (m) => !(m.attacks && m.attacks.length > 0)
    );

    for (const member of noAttackMembers) {
      const existingActive = await Sanction.findOne({
        clanTag,
        playerTag: member.tag,
        active: true,
      });

      if (existingActive) {
        // Si ya estaba sancionado y volvió a no atacar, reiniciamos la sanción
        existingActive.playerName = member.name;
        existingActive.reason = 'No realizó ataques en la guerra';
        existingActive.originWarId = warDoc.warId;
        existingActive.totalWars = duration;
        existingActive.servedWars = 0;
        existingActive.servedWarIds = [];
        existingActive.active = true;
        existingActive.updatedAt = new Date();

        await existingActive.save();
      } else {
        await Sanction.create({
          clanTag,
          playerTag: member.tag,
          playerName: member.name,
          reason: 'No realizó ataques en la guerra',
          originWarId: warDoc.warId,
          totalWars: duration,
          servedWars: 0,
          servedWarIds: [],
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'auto',
        });
      }
    }
  } catch (err) {
    console.error('Error aplicando sanciones:', err.message);
  }
};

// ═══════════ RUTAS DE CLANES ═══════════

// ═══ CAPITAL DEL CLAN — sanciones automáticas (mirror de applyWarSanctions) ═══
const applyCapitalSanctions = async (raidDoc) => {
  try {
    if (!raidDoc || raidDoc.state !== 'ended') return;

    const clanTag = cleanTag(raidDoc.clanTag);
    const rules = await WarRules.findOne({ clanTag });

    const autoEnabled = rules ? rules.autoSanctionNoAttackCapital !== false : true;
    const duration = Math.max(1, Number(rules?.sanctionDurationRaidWeekends || 2));

    // ═══ 1. Avanzar sanciones activas existentes ═══
    const activeSanctions = await CapitalSanction.find({ clanTag, active: true });

    for (const sanction of activeSanctions) {
      if (sanction.originRaidWeekendId === raidDoc.raidWeekendId) continue;
      if ((sanction.servedRaidWeekendIds || []).includes(raidDoc.raidWeekendId)) continue;

      sanction.servedRaidWeekendIds.push(raidDoc.raidWeekendId);
      sanction.servedRaidWeekends = (sanction.servedRaidWeekends || 0) + 1;

      if (sanction.servedRaidWeekends >= sanction.totalRaidWeekends) {
        sanction.active = false;
      }

      sanction.updatedAt = new Date();
      await sanction.save();
    }

    if (!autoEnabled) return;

    // ═══ 2. Sancionar a los que no atacaron ni una vez en el Raid Weekend ═══
    const noAttackMembers = (raidDoc.members || []).filter((m) => !(m.attacks > 0));

    for (const member of noAttackMembers) {
      const existingActive = await CapitalSanction.findOne({
        clanTag,
        playerTag: member.tag,
        active: true,
      });

      if (existingActive) {
        existingActive.playerName = member.name;
        existingActive.reason = 'No realizó ataques en el Raid Weekend';
        existingActive.originRaidWeekendId = raidDoc.raidWeekendId;
        existingActive.totalRaidWeekends = duration;
        existingActive.servedRaidWeekends = 0;
        existingActive.servedRaidWeekendIds = [];
        existingActive.active = true;
        existingActive.updatedAt = new Date();
        await existingActive.save();
      } else {
        await CapitalSanction.create({
          clanTag,
          playerTag: member.tag,
          playerName: member.name,
          reason: 'No realizó ataques en el Raid Weekend',
          originRaidWeekendId: raidDoc.raidWeekendId,
          totalRaidWeekends: duration,
          servedRaidWeekends: 0,
          servedRaidWeekendIds: [],
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'auto',
        });
      }
    }
  } catch (err) {
    console.error('Error aplicando sanciones de Capital:', err.message);
  }
};

// Guarda el Raid Weekend en Mongo si ya terminó (mirror de saveRegularWarIfEnded)
const saveCapitalRaidIfEnded = async (clanTag, season) => {
  if (!season || season.state !== 'ended' || !season.endTime) return null;

  const cClan = cleanTag(clanTag);
  const raidWeekendId = `${cClan}_${season.startTime}`;

  let existing = await CapitalRaid.findOne({ raidWeekendId });

  if (!existing) {
    const members = season.members || [];
    existing = await CapitalRaid.create({
      raidWeekendId,
      clanTag: cClan,
      state: season.state,
      startTime: season.startTime,
      endTime: season.endTime,
      capitalTotalLoot: season.capitalTotalLoot || 0,
      raidsCompleted: season.raidsCompleted || 0,
      totalAttacks: season.totalAttacks || 0,
      enemyDistrictsDestroyed: season.enemyDistrictsDestroyed || 0,
      offensiveReward: season.offensiveReward || 0,
      defensiveReward: season.defensiveReward || 0,
      members: members.map((m) => ({
        tag: m.tag,
        name: m.name,
        attacks: m.attacks || 0,
        attackLimit: m.attackLimit || 0,
        bonusAttackLimit: m.bonusAttackLimit || 0,
        capitalResourcesLooted: m.capitalResourcesLooted || 0,
      })),
    });
  }

  await applyCapitalSanctions(existing);
  return existing;
};

app.get('/api/clan/:tag', async (req, res) => {
  try {
    const tag = cleanTag(req.params.tag);
    const { ok, status, data } = await clashFetch(`/clans/%23${tag}`);

    if (!ok) {
      return res.status(status).json({ error: 'El clan no existe. Revisa el Tag.' });
    }

    // Primera vez que este tag pasa por la app -> queda fijada la fecha.
    // Si ya existía, $setOnInsert no la toca y solo se lee la que ya había.
    const link = await ClanLink.findOneAndUpdate(
      { tag },
      { $setOnInsert: { tag, linkedAt: new Date() } },
      { upsert: true, new: true }
    );

    return res.json({ ...data, linkedAt: link.linkedAt });
  } catch (err) {
    return res.status(500).json({ error: 'Error al consultar la API de Supercell' });
  }
});

// Devuelve { "#TAG1": 14, "#TAG2": 12, ... } con el TH de cada miembro del clan,
// resuelto en el servidor con una sola llamada desde el cliente.
app.get('/api/clan-townhalls/:tag', async (req, res) => {
  try {
    const { ok, status, data } = await clashFetch(
      `/clans/%23${cleanTag(req.params.tag)}`
    );

    if (!ok) {
      return res.status(status).json({ error: 'El clan no existe. Revisa el Tag.' });
    }

    const members = data.memberList || [];
    const results = await Promise.all(
      members.map(async (m) => {
        try {
          const player = await clashFetch(`/players/%23${cleanTag(m.tag)}`);
          if (!player.ok) return [m.tag, null];
          return [m.tag, typeof player.data.townHallLevel === 'number' ? player.data.townHallLevel : null];
        } catch (e) {
          return [m.tag, null];
        }
      })
    );

    const townHalls = {};
    results.forEach(([tag, th]) => {
      if (th !== null) townHalls[tag] = th;
    });

    return res.json({ townHalls });
  } catch (err) {
    return res.status(500).json({ error: 'Error al consultar la API de Supercell' });
  }
});

app.get('/api/player/:tag', async (req, res) => {
  try {
    const { ok, status, data } = await clashFetch(
      `/players/%23${cleanTag(req.params.tag)}`
    );

    if (!ok) {
      return res
        .status(status)
        .json({ error: 'No se pudo obtener el detalle del jugador.' });
    }

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Error al consultar la API de Supercell' });
  }
});

app.post('/api/save-clan', writeLimiter, async (req, res) => {
  try {
    const { autoSaved, ...clanData } = req.body || {};

    if (!clanData || !clanData.tag) {
      return res.status(400).json({ error: 'Datos del clan no válidos' });
    }

    const ownerTag = await getOwnerId(req);
    if (!ownerTag) {
      return res.status(400).json({ error: 'Falta identificar el dispositivo o la sesión (X-Device-Id).' });
    }

    // Decide si este guardado cuenta como "automático" o "manual":
    // - autoSaved === true (lo manda saveClanTag del cliente): solo lo
    //   marcamos como automático si el clan es nuevo o ya era automático.
    //   Si el usuario lo había guardado a mano antes, NO se degrada --
    //   su elección manual queda protegida para siempre.
    // - cualquier otro caso (botón 💾 manual, o llamadas viejas sin el
    //   campo): siempre queda protegido como manual.
    const existing = await Clan.findOne({ tag: clanData.tag, ownerTag });
    const nextAutoSaved =
      autoSaved === true ? (existing ? existing.autoSaved !== false : true) : false;

    const savedClan = await Clan.findOneAndUpdate(
      { tag: clanData.tag, ownerTag },
      { ...clanData, ownerTag, savedAt: new Date(), autoSaved: nextAutoSaved },
      { upsert: true, new: true }
    );

    return res.json({ message: '¡Clan guardado en MongoDB!', clan: savedClan });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo guardar en MongoDB' });
  }
});

app.get('/api/saved-clans', async (req, res) => {
  try {
    const ownerTag = await getOwnerId(req);
    if (!ownerTag) return res.json([]);
    return res.json(await Clan.find({ ownerTag }).sort({ savedAt: -1 }));
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'No se pudieron obtener los clanes guardados' });
  }
});

app.delete('/api/delete-clan/:tag', writeLimiter, async (req, res) => {
  try {
    const rawTag = cleanTag(req.params.tag);
    const ownerTag = await getOwnerId(req);
    if (!ownerTag) {
      return res.status(400).json({ error: 'Falta identificar el dispositivo o la sesión (X-Device-Id).' });
    }

    const deletedClan = await Clan.findOneAndDelete({
      tag: { $regex: new RegExp(`^#?${escapeRegex(rawTag)}$`, 'i') },
      ownerTag,
    });

    if (!deletedClan) {
      return res
        .status(404)
        .json({ error: 'El clan no se encontró en tu lista de guardados.' });
    }

    return res.json({ message: 'Clan eliminado exitosamente.', tag: rawTag });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo eliminar el clan.' });
  }
});

app.post('/api/refresh-clan/:tag', writeLimiter, async (req, res) => {
  try {
    const rawTag = cleanTag(req.params.tag);
    const ownerTag = await getOwnerId(req);
    if (!ownerTag) {
      return res.status(400).json({ error: 'Falta identificar el dispositivo o la sesión (X-Device-Id).' });
    }

    const { ok, status, data } = await clashFetch(`/clans/%23${rawTag}`);

    if (!ok) {
      return res
        .status(status)
        .json({ error: 'No se pudo obtener la información de Supercell.' });
    }

    const updatedClan = await Clan.findOneAndUpdate(
      { tag: { $regex: new RegExp(`^#?${escapeRegex(rawTag)}$`, 'i') }, ownerTag },
      { ...data, ownerTag, savedAt: new Date() },
      { new: true }
    );

    if (!updatedClan) {
      return res.status(404).json({ error: 'El clan no está en tu lista de guardados.' });
    }

    return res.json({ message: 'Estadísticas actualizadas con éxito.', clan: updatedClan });
  } catch (err) {
    return res.status(500).json({ error: 'Error interno al actualizar el clan.' });
  }
});

// ═══════════ RUTAS DE GUERRA ═══════════

// Guarda una guerra normal terminada en el historial si todavía no está guardada.
// Reutilizable tanto por el endpoint /api/clan-war/:tag (cuando el usuario abre la app)
// como por el vigía automático en segundo plano (sin necesidad de que nadie abra la app).
const saveRegularWarIfEnded = async (data) => {
  if (!(data.state === 'warEnded' && data.endTime && data.clan && data.opponent)) return null;

  const cClan = cleanTag(data.clan.tag);
  const cOpp = cleanTag(data.opponent.tag);
  const warId = `${cClan}_${cOpp}_${data.endTime}`;

  let existing = await WarHistory.findOne({ warId });

  if (!existing) {
    let result = 'tie';

    if (data.clan.stars > data.opponent.stars) result = 'win';
    else if (data.clan.stars < data.opponent.stars) result = 'lose';
    else if (data.clan.destructionPercentage > data.opponent.destructionPercentage)
      result = 'win';
    else if (data.clan.destructionPercentage < data.opponent.destructionPercentage)
      result = 'lose';

    existing = await WarHistory.create({
      warId,
      clanTag: cClan,
      opponentTag: cOpp,
      opponentName: data.opponent.name,
      state: data.state,
      teamSize: data.teamSize,
      endTime: data.endTime,
      result,

      clanStats: {
        name: data.clan.name,
        tag: data.clan.tag,
        stars: data.clan.stars || 0,
        destructionPercentage: data.clan.destructionPercentage || 0,
        attacks: data.clan.attacks || 0,
      },

      opponentStats: {
        name: data.opponent.name,
        tag: data.opponent.tag,
        stars: data.opponent.stars || 0,
        destructionPercentage: data.opponent.destructionPercentage || 0,
        attacks: data.opponent.attacks || 0,
      },

      members: data.clan.members || [],
    });
  }

  await accumulateMonthlyStars(existing);
  await applyWarSanctions(existing, false);
  return existing;
};

app.get('/api/clan-war/:tag', async (req, res) => {
  try {
    const { ok, status, data } = await clashFetch(
      `/clans/%23${cleanTag(req.params.tag)}/currentwar`
    );

    if (!ok) {
      return res
        .status(status)
        .json({ error: data.message || 'No se pudo obtener la información de la guerra.' });
    }

    await saveRegularWarIfEnded(data);

    return res.json(data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Error interno al consultar la guerra de clanes.' });
  }
});

// Tablero del clan: reglas + anuncios, de solo lectura y sin requerir rol de líder.
// Lo consume la pestaña "Tablero del clan", visible para todo el clan (miembros e invitados).
app.get('/api/clan-board/:tag', async (req, res) => {
  try {
    const tag = cleanTag(req.params.tag);

    const [rulesDoc, announcements] = await Promise.all([
      WarRules.findOne({ clanTag: tag }),
      Announcement.find({ clanTag: tag }).sort({ createdAt: -1 }).limit(20),
    ]);

    return res.json({
      rules: rulesDoc?.rules || '',
      announcements,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener el tablero del clan.' });
  }
});

app.get('/api/clan-capital/:tag', async (req, res) => {
  try {
    const { ok, status, data } = await clashFetch(
      `/clans/%23${cleanTag(req.params.tag)}/capitalraidseasons?limit=1`
    );

    if (!ok) {
      return res
        .status(status)
        .json({ error: data.message || 'No se pudo obtener el Raid Weekend.' });
    }

    const season = (data.items || [])[0] || null;

    if (!season) {
      return res.json({ state: 'notInRaid' });
    }

    await saveCapitalRaidIfEnded(req.params.tag, season);

    return res.json(season);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Error interno al consultar el Raid Weekend.' });
  }
});

app.get('/api/capital-history/:tag', async (req, res) => {
  try {
    const clanTag = cleanTag(req.params.tag);
    const history = await CapitalRaid.find({ clanTag }).sort({ endTime: -1 }).limit(20);
    return res.json(history);
  } catch (err) {
    return res.status(500).json({ error: 'Error en historial de Capital.' });
  }
});

// Devuelve las donaciones "ganadas" día a día durante el mes (no el
// acumulado crudo, que se resetea cada semana dentro del juego). El
// formato de cada entrada -- { weekStart, members: [{ tag, name, donations }] } --
// ya es el que espera computeMonthlyClanPoints en el frontend, así que
// no hace falta tocar nada más allá de este endpoint.
app.get('/api/donation-snapshots/:tag', async (req, res) => {
  try {
    const clanTag = cleanTag(req.params.tag);

    // Traemos ~40 días para tener margen incluso cruzando el cambio de mes
    // (el primer día del rango solo sirve de base de comparación, no cuenta).
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 40);
    const snapshots = await DonationSnapshot.find({
      clanTag,
      snapshotDate: { $gte: since },
    }).sort({ snapshotDate: 1 });

    const deltas = [];
    let previousByTag = null;

    snapshots.forEach((snap) => {
      const currentByTag = {};
      snap.members.forEach((m) => { currentByTag[m.tag] = m; });

      const members = snap.members.map((m) => {
        const prevDonations = previousByTag?.[m.tag]?.donations;
        let earned;
        if (typeof prevDonations !== 'number') {
          earned = 0; // primera vez que vemos a este miembro, sin base de comparación todavía
        } else if (m.donations >= prevDonations) {
          earned = m.donations - prevDonations;
        } else {
          earned = m.donations; // el contador bajó -> hubo reset semanal, esto ya es lo nuevo
        }
        return { tag: m.tag, name: m.name, donations: earned };
      });

      deltas.push({ weekStart: snap.snapshotDate, members });
      previousByTag = currentByTag;
    });

    return res.json(deltas);
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener snapshots de donaciones.' });
  }
});

app.post('/api/save-war', writeLimiter, async (req, res) => {
  try {
    const war = req.body;

    if (!war || !war.clan || !war.opponent) {
      return res.status(400).json({ error: 'Datos de guerra no válidos.' });
    }

    if (war.state !== 'warEnded') {
      return res
        .status(400)
        .json({ error: 'Solo se pueden guardar guerras finalizadas.' });
    }

    const cClan = cleanTag(war.clan.tag);
    const cOpp = cleanTag(war.opponent.tag);
    const warId = `${cClan}_${cOpp}_${war.endTime || ''}`;

    const existingWar = await WarHistory.findOne({ warId });

    if (existingWar) {
      return res
        .status(400)
        .json({ error: 'Esta guerra ya está registrada en el historial.' });
    }

    let result = 'draw';

    if (war.clan.stars > war.opponent.stars) result = 'win';
    else if (war.clan.stars < war.opponent.stars) result = 'lose';
    else if (war.clan.destructionPercentage > war.opponent.destructionPercentage)
      result = 'win';
    else if (war.clan.destructionPercentage < war.opponent.destructionPercentage)
      result = 'lose';

    const created = await WarHistory.create({
      warId,
      clanTag: cClan,
      opponentTag: cOpp,
      opponentName: war.opponent.name,
      state: war.state,
      teamSize: war.teamSize,
      endTime: war.endTime,
      result,

      clanStats: {
        name: war.clan.name,
        tag: war.clan.tag,
        stars: war.clan.stars || 0,
        destructionPercentage: war.clan.destructionPercentage || 0,
        attacks: war.clan.attacks || 0,
      },

      opponentStats: {
        name: war.opponent.name,
        tag: war.opponent.tag,
        stars: war.opponent.stars || 0,
        destructionPercentage: war.opponent.destructionPercentage || 0,
        attacks: war.opponent.attacks || 0,
      },

      members: war.clan.members || [],
    });

    await accumulateMonthlyStars(created);
    await applyWarSanctions(created, false);

    return res.json({ message: '¡Guerra guardada exitosamente en MongoDB!' });
  } catch (err) {
    console.error('Error en /api/save-war:', err.message);
    return res.status(500).json({ error: 'Error interno al guardar la guerra.' });
  }
});

// Resume un conjunto de guerras al mismo formato que usa "Rendimiento
// General" -- se reutiliza tanto para el histórico completo como para el
// recorte del mes actual en "Rendimiento Mensual".
const summarizeWars = (warsArray) => {
  const totalWars = warsArray.length;
  if (totalWars === 0) {
    return { totalWars: 0, wins: 0, losses: 0, draws: 0, winRate: '0.0%', avgStarsPerWar: '0.0', avgDestruction: '0.0%' };
  }
  let wins = 0, losses = 0, draws = 0, totalStars = 0, totalDestruction = 0;
  warsArray.forEach((war) => {
    if (war.result === 'win') wins++;
    else if (war.result === 'lose') losses++;
    else draws++;
    totalStars += war.clanStats?.stars || 0;
    totalDestruction += war.clanStats?.destructionPercentage || 0;
  });
  return {
    totalWars,
    wins,
    losses,
    draws,
    winRate: `${((wins / totalWars) * 100).toFixed(1)}%`,
    avgStarsPerWar: (totalStars / totalWars).toFixed(1),
    avgDestruction: `${(totalDestruction / totalWars).toFixed(1)}%`,
  };
};

app.get('/api/clan-stats/:tag', async (req, res) => {
  try {
    const rawTag = cleanTag(req.params.tag);

    const wars = await WarHistory.find({
      clanTag: { $regex: new RegExp(rawTag, 'i') },
    });

    if (!wars.length) {
      return res
        .status(404)
        .json({ error: 'No hay guerras registradas para calcular estadísticas.' });
    }

    const totalWars = wars.length;

    let wins = 0;
    let losses = 0;
    let draws = 0;
    let totalStars = 0;
    let totalDestruction = 0;

    const memberMap = {};

    wars.forEach((war) => {
      if (war.result === 'win') wins++;
      else if (war.result === 'lose') losses++;
      else draws++;

      totalStars += war.clanStats?.stars || 0;
      totalDestruction += war.clanStats?.destructionPercentage || 0;

      (war.members || []).forEach((m) => {
        const key = m.tag || m.name;

        if (!memberMap[key]) {
          memberMap[key] = {
            tag: key,
            name: m.name || 'Sin Nombre',
            warsParticipated: 0,
            totalAttacks: 0,
            totalStars: 0,
            totalDestruction: 0,
          };
        }

        memberMap[key].warsParticipated += 1;

        (m.attacks || []).forEach((atk) => {
          memberMap[key].totalAttacks += 1;
          memberMap[key].totalStars += atk.stars || 0;
          memberMap[key].totalDestruction += atk.destructionPercentage || 0;
        });
      });
    });

    const memberPerformance = Object.values(memberMap).map((p) => {
      const avgStarsPerAtk =
        p.totalAttacks > 0 ? (p.totalStars / p.totalAttacks).toFixed(2) : '0.00';

      const avgDestPerAtk =
        p.totalAttacks > 0
          ? (p.totalDestruction / p.totalAttacks).toFixed(1)
          : '0.0';

      return {
        ...p,
        avgStarsPerAtk: parseFloat(avgStarsPerAtk),
        avgDestPerAtk: parseFloat(avgDestPerAtk),
      };
    });

    memberPerformance.sort((a, b) => b.avgStarsPerAtk - a.avgStarsPerAtk);

    // ═══ Rendimiento Mensual: el mismo resumen, pero solo con las guerras
    // que terminaron dentro del mes calendario actual. Se reinicia solo al
    // cambiar de mes porque currentPeriodKey() siempre calcula "ahora". ═══
    const period = currentPeriodKey();
    const monthlyWars = wars.filter((war) => getPeriodKeyFromEndTime(war.endTime) === period);

    return res.json({
      summary: {
        totalWars,
        wins,
        losses,
        draws,
        winRate: `${((wins / totalWars) * 100).toFixed(1)}%`,
        avgStarsPerWar: (totalStars / totalWars).toFixed(1),
        avgDestruction: `${(totalDestruction / totalWars).toFixed(1)}%`,
      },
      monthlySummary: { ...summarizeWars(monthlyWars), period },
      topPlayerMVP: memberPerformance[0] || null,
      rankingMembers: memberPerformance,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Error al generar estadísticas del clan.' });
  }
});

app.get('/api/war-history/:tag', async (req, res) => {
  try {
    const history = await WarHistory.find({
      clanTag: { $regex: new RegExp(cleanTag(req.params.tag), 'i') },
    })
      .sort({ savedAt: -1 })
      .limit(10);

    return res.json(history);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Error al consultar el historial de guerras.' });
  }
});

// ═══════════ WAR PLANNER ═══════════

app.post('/api/war-planner/assign', requireLeader, async (req, res) => {
  try {
    const { warId, playerTag, targetNumber } = req.body;

    if (!warId || !playerTag) {
      return res.status(400).json({ error: 'warId y playerTag son requeridos.' });
    }

    await WarAssignment.findOneAndUpdate(
      { warId, playerTag },
      { targetNumber, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    return res.json({ message: 'Objetivo asignado correctamente.' });
  } catch (error) {
    return res.status(500).json({ error: 'Error interno al guardar la asignación.' });
  }
});

app.get('/api/war-planner/:warId', async (req, res) => {
  try {
    const assignments = await WarAssignment.find({ warId: req.params.warId });

    return res.json(
      assignments.reduce((acc, curr) => {
        acc[curr.playerTag] = curr;
        return acc;
      }, {})
    );
  } catch (error) {
    return res.status(500).json({ error: 'Error al obtener asignaciones.' });
  }
});

// ═══════════ CWL ═══════════

app.get('/api/cwl-group/:clanTag', async (req, res) => {
  try {
    const { ok, status, data } = await clashFetch(
      `/clans/%23${cleanTag(req.params.clanTag)}/currentwar/leaguegroup`
    );

    if (status === 404) {
      return res.status(200).json({ notInCwl: true, message: 'El clan no está en CWL.' });
    }

    if (!ok) {
      return res
        .status(status)
        .json({ error: data.message || 'Error al obtener datos de CWL.' });
    }

    return res.json(data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Error interno del servidor al consultar CWL.' });
  }
});

// Guarda una guerra de CWL terminada en el historial si todavía no está guardada.
// Reutilizable por el endpoint /api/cwl-war/:warTag y por el vigía automático.
const saveCwlWarIfEnded = async (data) => {
  if (!(data.state === 'warEnded' && data.clan && data.opponent && data.endTime)) return null;

  const cClan = cleanTag(data.clan.tag);
  const cOpp = cleanTag(data.opponent.tag);
  const warId = `CWL_${cClan}_${cOpp}_${data.endTime}`;

  let existing = await WarHistory.findOne({ warId });

  if (!existing) {
    let result = 'draw';

    if (data.clan.stars > data.opponent.stars) result = 'win';
    else if (data.clan.stars < data.opponent.stars) result = 'lose';
    else if (data.clan.destructionPercentage > data.opponent.destructionPercentage)
      result = 'win';
    else if (data.clan.destructionPercentage < data.opponent.destructionPercentage)
      result = 'lose';

    existing = await WarHistory.create({
      warId,
      clanTag: cClan,
      opponentTag: cOpp,
      opponentName: data.opponent.name,
      state: data.state,
      teamSize: data.teamSize,
      endTime: data.endTime,
      result,
      isCwl: true,

      clanStats: {
        name: data.clan.name,
        tag: data.clan.tag,
        stars: data.clan.stars || 0,
        destructionPercentage: data.clan.destructionPercentage || 0,
        attacks: data.clan.attacks || 0,
      },

      opponentStats: {
        name: data.opponent.name,
        tag: data.opponent.tag,
        stars: data.opponent.stars || 0,
        destructionPercentage: data.opponent.destructionPercentage || 0,
        attacks: data.opponent.attacks || 0,
      },

      members: data.clan.members || [],
    });
  }

  await accumulateMonthlyStars(existing);
  await applyWarSanctions(existing, true);
  return existing;
};

app.get('/api/cwl-war/:warTag', async (req, res) => {
  try {
    const { ok, status, data } = await clashFetch(
      `/clanwarleagues/wars/%23${cleanTag(req.params.warTag)}`
    );

    if (!ok) {
      return res
        .status(status)
        .json({ error: data.message || 'Error al consultar el detalle de la guerra.' });
    }

    await saveCwlWarIfEnded(data);

    return res.json(data);
  } catch (error) {
    return res
      .status(500)
      .json({ error: 'Error al consultar el detalle de la guerra de CWL.' });
  }
});

// ═══════════ IDENTIDAD ═══════════

app.post('/api/user/register', async (req, res) => {
  try {
    const { apiToken, clanTag } = req.body;

    if (!apiToken || !clanTag) {
      return res
        .status(400)
        .json({ error: 'El código API y el clan son requeridos.' });
    }

    const code = apiToken.trim();
    const clanClean = cleanTag(clanTag);

    const membersRes = await clashFetch(`/clans/%23${clanClean}/members`);

    if (!membersRes.ok) {
      return res.status(404).json({ error: 'No se pudo obtener la lista del clan.' });
    }

    const members = membersRes.data.items || [];

    let owner = null;
    let invalidCount = 0;
    let errorCount = 0;

    const BATCH = 5;

    for (let i = 0; i < members.length && !owner; i += BATCH) {
      const chunk = members.slice(i, i + BATCH);

      const results = await Promise.all(
        chunk.map(async (m) => {
          try {
            const cleanPlayer = m.tag.replace(/#/g, '').toUpperCase();

            const verifyRes = await fetch(
              `${COC_API}/players/%23${cleanPlayer}/verifytoken`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${process.env.COC_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ token: code }),
              }
            );

            const verifyData = await verifyRes.json().catch(() => ({}));

            if (verifyRes.ok && verifyData.status === 'ok') return m;

            if (verifyRes.ok && verifyData.status === 'invalid') invalidCount++;
            else errorCount++;

            return null;
          } catch (e) {
            errorCount++;
            return null;
          }
        })
      );

      owner = results.find((r) => r !== null) || null;
    }

    if (!owner) {
      return res.status(403).json({
        error: `El código no coincidió con ningún miembro (${members.length} revisados). Copialo de nuevo en el juego: Ajustes → Más ajustes → Código API.`,
      });
    }

    const isLeader = ['leader', 'coLeader'].includes(owner.role);

    const roleNames = {
      leader: 'Líder',
      coLeader: 'Colíder',
      admin: 'Anciano',
      member: 'Miembro',
    };

    await UserSession.findOneAndUpdate(
      { playerTag: owner.tag },
      {
        playerName: owner.name,
        role: owner.role,
        clanTag: clanClean,
        isLeader,
        trophies: owner.trophies || 0,
        registeredAt: new Date(),
        lastAccessAt: new Date(),
      },
      { upsert: true }
    );

    const sessionToken = jwt.sign(
      {
        playerTag: owner.tag,
        name: owner.name,
        role: owner.role,
        clanTag: clanClean,
        isLeader,
      },
      JWT_SECRET,
      { expiresIn: '3650d' }
    );

    return res.json({
      success: true,
      sessionToken,
      user: {
        playerTag: owner.tag,
        name: owner.name,
        role: owner.role,
        roleName: roleNames[owner.role] || owner.role,
        clanTag: clanClean,
        isLeader,
        trophies: owner.trophies || 0,
      },
    });
  } catch (err) {
    console.error('Error en registro de usuario:', err);
    return res.status(500).json({ error: 'Error al registrar. Intentá de nuevo.' });
  }
});

app.post('/api/user/validate', async (req, res) => {
  try {
    const { sessionToken } = req.body;

    if (!sessionToken) {
      return res.status(401).json({ valid: false });
    }

    const decoded = jwt.verify(sessionToken, JWT_SECRET);

    const session = await UserSession.findOne({ playerTag: decoded.playerTag });

    if (!session) {
      return res.status(401).json({ valid: false });
    }

    session.lastAccessAt = new Date();
    await session.save();

    return res.json({
      valid: true,
      user: {
        playerTag: decoded.playerTag,
        name: decoded.name,
        role: decoded.role,
        clanTag: decoded.clanTag,
        isLeader: !!decoded.isLeader,
        trophies: session.trophies,
      },
    });
  } catch (err) {
    return res.status(401).json({ valid: false });
  }
});

app.post('/api/user/logout', async (req, res) => {
  try {
    const { playerTag } = req.body;

    if (playerTag) {
      await UserSession.findOneAndDelete({ playerTag });
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error al cerrar sesión.' });
  }
});

// Guarda el token de push de Expo del usuario logueado, para poder
// avisarle desde la gestión de miembros de su clan.
app.post('/api/user/push-token', async (req, res) => {
  try {
    const { sessionToken, pushToken } = req.body;

    if (!sessionToken || !pushToken) {
      return res.status(400).json({ error: 'Datos incompletos.' });
    }

    const decoded = jwt.verify(sessionToken, JWT_SECRET);

    await UserSession.findOneAndUpdate(
      { playerTag: decoded.playerTag },
      { pushToken, lastAccessAt: new Date() }
    );

    return res.json({ success: true });
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida.' });
  }
});

// ═══════════ RANKING MENSUAL ═══════════

app.get('/api/monthly-ranking/:clanTag', async (req, res) => {
  try {
    const period = req.query.period || currentPeriodKey();

    const ranking = await PlayerMonthlyStats.find({
      clanTag: cleanTag(req.params.clanTag),
      periodKey: period,
    }).sort({ stars: -1, destruction: -1 });

    return res.json({ period, ranking });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener el ranking.' });
  }
});

app.get('/api/player-monthly/:playerTag', async (req, res) => {
  try {
    const query = { playerTag: cleanTag(req.params.playerTag) };

    if (req.query.period) query.periodKey = req.query.period;

    return res.json({
      stats: await PlayerMonthlyStats.find(query).sort({ periodKey: -1 }),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener stats mensuales.' });
  }
});

// ═══════════ PANEL DE LÍDERES ═══════════

app.get('/api/leaders/dashboard', requireLeader, async (req, res) => {
  try {
    const clanTag = req.leader.clanTag;

    const clanRes = await clashFetch(`/clans/%23${clanTag}`);

    if (!clanRes.ok) {
      return res.status(404).json({ error: 'Clan no encontrado.' });
    }

    const warRes = await clashFetch(`/clans/%23${clanTag}/currentwar`);
    const war = warRes.ok ? warRes.data : null;

    let inactiveInWar = [];

    if (war && war.state === 'inWar' && war.clan?.members) {
      inactiveInWar = war.clan.members
        .filter((m) => !m.attacks || m.attacks.length === 0)
        .map((m) => ({
          tag: m.tag,
          name: m.name,
          mapPosition: m.mapPosition,
          townhallLevel: m.townhallLevel,
        }));
    }

    const announcements = await Announcement.find({ clanTag })
      .sort({ createdAt: -1 })
      .limit(5);

    const capitalRes = await clashFetch(`/clans/%23${clanTag}/capitalraidseasons?limit=1`);
    const capital = capitalRes.ok ? (capitalRes.data.items || [])[0] || null : null;

    const sanctionsActiveCount = await Sanction.countDocuments({ clanTag, active: true });
    const capitalSanctionsActiveCount = await CapitalSanction.countDocuments({ clanTag, active: true });

    return res.json({
      clan: clanRes.data,
      war: war && war.state !== 'notInWar' ? war : null,
      inactiveInWar,
      announcements,
      capital,
      sanctionsActiveCount,
      capitalSanctionsActiveCount,
      leaderInfo: req.leader,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error al cargar el dashboard.' });
  }
});

app.get('/api/leaders/war-report', requireLeader, async (req, res) => {
  try {
    const warRes = await clashFetch(`/clans/%23${req.leader.clanTag}/currentwar`);

    if (!warRes.ok || warRes.data.state === 'notInWar') {
      return res.json({
        inWar: false,
        message: 'El clan no está en guerra actualmente.',
      });
    }

    const war = warRes.data;
    const members = war.clan?.members || [];

    const report = members.map((m) => ({
      tag: m.tag,
      name: m.name,
      mapPosition: m.mapPosition,
      townhallLevel: m.townhallLevel,
      attacksUsed: m.attacks?.length || 0,
      starsEarned: (m.attacks || []).reduce((s, a) => s + (a.stars || 0), 0),
      didAttack: (m.attacks?.length || 0) > 0,
    }));

    const noAttack = report.filter((r) => !r.didAttack);
    const oneAttack = report.filter((r) => r.attacksUsed === 1);

    return res.json({
      inWar: true,
      state: war.state,
      teamSize: war.teamSize,
      report,
      summary: {
        totalMembers: members.length,
        noAttackCount: noAttack.length,
        noAttackNames: noAttack.map((m) => m.name),
        oneAttackCount: oneAttack.length,
        oneAttackNames: oneAttack.map((m) => m.name),
        allAttacked: noAttack.length === 0 && oneAttack.length === 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error al generar el reporte de guerra.' });
  }
});

app.get('/api/leaders/announcements', requireLeader, async (req, res) => {
  try {
    return res.json(
      await Announcement.find({ clanTag: req.leader.clanTag })
        .sort({ createdAt: -1 })
        .limit(20)
    );
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener anuncios.' });
  }
});

app.post('/api/leaders/announcements', requireLeader, async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Título y contenido requeridos.' });
    }

    const ann = await Announcement.create({
      clanTag: req.leader.clanTag,
      title,
      body,
      createdBy: req.leader.playerTag,
      createdByName: req.leader.name,
    });

    return res.json({ success: true, announcement: ann });
  } catch (err) {
    return res.status(500).json({ error: 'Error al crear el anuncio.' });
  }
});

app.delete('/api/leaders/announcements/:id', requireLeader, async (req, res) => {
  try {
    const ann = await Announcement.findById(req.params.id);

    if (!ann || ann.clanTag !== req.leader.clanTag) {
      return res.status(404).json({ error: 'Anuncio no encontrado.' });
    }

    await Announcement.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error al eliminar el anuncio.' });
  }
});

app.put('/api/leaders/announcements/:id', requireLeader, async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Título y contenido requeridos.' });
    }

    const ann = await Announcement.findById(req.params.id);

    if (!ann || ann.clanTag !== req.leader.clanTag) {
      return res.status(404).json({ error: 'Anuncio no encontrado.' });
    }

    ann.title = title;
    ann.body = body;
    ann.editedAt = new Date();
    ann.editedByName = req.leader.name;
    await ann.save();

    return res.json({ success: true, announcement: ann });
  } catch (err) {
    return res.status(500).json({ error: 'Error al editar el anuncio.' });
  }
});

// ═══════════ REGLAS + CONFIGURACIÓN DE SANCIONES ═══════════

app.get('/api/leaders/rules', requireLeader, async (req, res) => {
  try {
    const rules = await WarRules.findOne({ clanTag: req.leader.clanTag });

    return res.json(
      rules || {
        clanTag: req.leader.clanTag,
        rules: '',
        warPolicy: '',
        minAttacks: 2,
        autoSanctionNoAttack: true,
        sanctionDurationWars: 2,
        sanctionAppliesToCwl: false,
      }
    );
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener reglas.' });
  }
});

app.put('/api/leaders/rules', requireLeader, async (req, res) => {
  try {
    const {
      rules,
      warPolicy,
      minAttacks,
      autoSanctionNoAttack,
      sanctionDurationWars,
      sanctionAppliesToCwl,
      autoSanctionNoAttackCapital,
      sanctionDurationRaidWeekends,
    } = req.body;

    // Se combina con lo ya guardado: quien edita solo el texto de reglas (Tablero del
    // clan) no debe pisar la configuración de sanciones, y viceversa (Liderazgo).
    const existing = await WarRules.findOne({ clanTag: req.leader.clanTag });

    const merged = {
      rules: rules !== undefined ? rules : (existing?.rules || ''),
      warPolicy: warPolicy !== undefined ? warPolicy : (existing?.warPolicy || ''),
      minAttacks: minAttacks !== undefined ? minAttacks : (existing?.minAttacks ?? 2),

      autoSanctionNoAttack: autoSanctionNoAttack !== undefined
        ? autoSanctionNoAttack !== false
        : (existing?.autoSanctionNoAttack !== false),
      sanctionDurationWars: sanctionDurationWars !== undefined
        ? Math.max(1, Number(sanctionDurationWars || 2))
        : (existing?.sanctionDurationWars ?? 2),
      sanctionAppliesToCwl: sanctionAppliesToCwl !== undefined
        ? !!sanctionAppliesToCwl
        : !!existing?.sanctionAppliesToCwl,

      autoSanctionNoAttackCapital: autoSanctionNoAttackCapital !== undefined
        ? autoSanctionNoAttackCapital !== false
        : (existing?.autoSanctionNoAttackCapital !== false),
      sanctionDurationRaidWeekends: sanctionDurationRaidWeekends !== undefined
        ? Math.max(1, Number(sanctionDurationRaidWeekends || 2))
        : (existing?.sanctionDurationRaidWeekends ?? 2),

      updatedAt: new Date(),
      updatedBy: req.leader.playerTag,
    };

    const updated = await WarRules.findOneAndUpdate(
      { clanTag: req.leader.clanTag },
      merged,
      { upsert: true, new: true }
    );

    return res.json({ success: true, rules: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Error al guardar reglas.' });
  }
});

// ═══════════ SANCIONES (PANEL LÍDERES) ═══════════

app.get('/api/leaders/sanctions', requireLeader, async (req, res) => {
  try {
    const clanTag = req.leader.clanTag;

    const sanctions = await Sanction.find({ clanTag }).sort({
      active: -1,
      createdAt: -1,
    });

    const active = sanctions.filter((s) => s.active);
    const history = sanctions.filter((s) => !s.active).slice(0, 20);

    return res.json({ active, history });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener sanciones.' });
  }
});

app.post('/api/leaders/sanctions', requireLeader, async (req, res) => {
  try {
    const { playerTag, playerName, totalWars, reason } = req.body;

    if (!playerTag || !totalWars) {
      return res
        .status(400)
        .json({ error: 'playerTag y totalWars son requeridos.' });
    }

    const sanction = await Sanction.findOneAndUpdate(
      {
        clanTag: req.leader.clanTag,
        playerTag,
        active: true,
      },
      {
        $set: {
          playerName: playerName || '',
          reason: reason || 'Sanción manual',
          totalWars: Math.max(1, Number(totalWars)),
          servedWars: 0,
          servedWarIds: [],
          active: true,
          updatedAt: new Date(),
          createdBy: req.leader.playerTag,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, sanction });
  } catch (err) {
    return res.status(500).json({ error: 'Error al crear sanción.' });
  }
});

app.put('/api/leaders/sanctions/:id', requireLeader, async (req, res) => {
  try {
    const sanction = await Sanction.findOne({
      _id: req.params.id,
      clanTag: req.leader.clanTag,
    });

    if (!sanction) {
      return res.status(404).json({ error: 'Sanción no encontrada.' });
    }

    const { totalWars, active, reason } = req.body;

    if (typeof totalWars !== 'undefined') {
      sanction.totalWars = Math.max(1, Number(totalWars));
    }

    if (typeof active !== 'undefined') {
      sanction.active = !!active;
    }

    if (reason) {
      sanction.reason = reason;
    }

    sanction.updatedAt = new Date();
    await sanction.save();

    return res.json({ success: true, sanction });
  } catch (err) {
    return res.status(500).json({ error: 'Error al actualizar sanción.' });
  }
});

app.delete('/api/leaders/sanctions/:id', requireLeader, async (req, res) => {
  try {
    const sanction = await Sanction.findOne({
      _id: req.params.id,
      clanTag: req.leader.clanTag,
    });

    if (!sanction) {
      return res.status(404).json({ error: 'Sanción no encontrada.' });
    }

    sanction.active = false;
    sanction.updatedAt = new Date();
    await sanction.save();

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error al levantar sanción.' });
  }
});

// ═══════════ SANCIONES — CAPITAL DEL CLAN (gestión de líderes) ═══════════

app.get('/api/leaders/capital-sanctions', requireLeader, async (req, res) => {
  try {
    const clanTag = req.leader.clanTag;

    const sanctions = await CapitalSanction.find({ clanTag }).sort({
      active: -1,
      createdAt: -1,
    });

    const active = sanctions.filter((s) => s.active);
    const history = sanctions.filter((s) => !s.active).slice(0, 20);

    return res.json({ active, history });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener sanciones de Capital.' });
  }
});

app.post('/api/leaders/capital-sanctions', requireLeader, async (req, res) => {
  try {
    const { playerTag, playerName, totalRaidWeekends, reason } = req.body;

    if (!playerTag || !totalRaidWeekends) {
      return res
        .status(400)
        .json({ error: 'playerTag y totalRaidWeekends son requeridos.' });
    }

    const sanction = await CapitalSanction.findOneAndUpdate(
      {
        clanTag: req.leader.clanTag,
        playerTag,
        active: true,
      },
      {
        $set: {
          playerName: playerName || '',
          reason: reason || 'Sanción manual',
          totalRaidWeekends: Math.max(1, Number(totalRaidWeekends)),
          servedRaidWeekends: 0,
          servedRaidWeekendIds: [],
          active: true,
          updatedAt: new Date(),
          createdBy: req.leader.playerTag,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, sanction });
  } catch (err) {
    return res.status(500).json({ error: 'Error al crear sanción de Capital.' });
  }
});

app.put('/api/leaders/capital-sanctions/:id', requireLeader, async (req, res) => {
  try {
    const sanction = await CapitalSanction.findOne({
      _id: req.params.id,
      clanTag: req.leader.clanTag,
    });

    if (!sanction) {
      return res.status(404).json({ error: 'Sanción no encontrada.' });
    }

    const { totalRaidWeekends, active, reason } = req.body;

    if (typeof totalRaidWeekends !== 'undefined') {
      sanction.totalRaidWeekends = Math.max(1, Number(totalRaidWeekends));
    }
    if (typeof active !== 'undefined') {
      sanction.active = !!active;
    }
    if (reason) {
      sanction.reason = reason;
    }

    sanction.updatedAt = new Date();
    await sanction.save();

    return res.json({ success: true, sanction });
  } catch (err) {
    return res.status(500).json({ error: 'Error al actualizar sanción de Capital.' });
  }
});

app.delete('/api/leaders/capital-sanctions/:id', requireLeader, async (req, res) => {
  try {
    const sanction = await CapitalSanction.findOne({
      _id: req.params.id,
      clanTag: req.leader.clanTag,
    });

    if (!sanction) {
      return res.status(404).json({ error: 'Sanción no encontrada.' });
    }

    sanction.active = false;
    sanction.updatedAt = new Date();
    await sanction.save();

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error al levantar sanción de Capital.' });
  }
});

// ═══════════ NOTIFICACIONES A MIEMBROS (gestión de líderes) ═══════════

app.post('/api/leaders/notify-member', requireLeader, async (req, res) => {
  try {
    const { memberTag, title, body } = req.body;

    if (!memberTag || !title || !body) {
      return res.status(400).json({ error: 'Datos incompletos.' });
    }

    const target = await UserSession.findOne({
      playerTag: memberTag,
      clanTag: req.leader.clanTag,
    });

    // El miembro nunca abrió/registró la app -> no tiene token guardado.
    if (!target || !target.pushToken) {
      return res.json({ success: true, registered: false });
    }

    const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: target.pushToken, title, body, sound: 'default' }),
    });

    const pushData = await pushRes.json().catch(() => ({}));

    return res.json({ success: true, registered: true, result: pushData });
  } catch (err) {
    return res.status(500).json({ error: 'Error al enviar la notificación.' });
  }
});

// ═══════════ VIGÍA AUTOMÁTICO DE GUERRAS ═══════════
// Revisa periódicamente TODOS los clanes ya guardados (Clan collection) y guarda en el
// historial cualquier guerra normal o de CWL que haya terminado, sin necesidad de que
// alguien abra la app en ese momento. Así las estadísticas del mes (incluyendo CWL)
// quedan completas aunque nadie haya "visto" el clan justo cuando terminó la guerra.
let watcherRunning = false;

// Pequeña pausa entre clanes para no ráfaguear la API de Supercell (además
// del filtrado por nextWarCheckAt, esto evita picos de N requests simultáneos
// cuando a muchos clanes les toca chequeo en la misma pasada).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WAR_WATCHER_REQUEST_DELAY_MS = 300;

// La API de Supercell devuelve fechas como "20260817T123456.000Z", que
// `new Date()` no parsea directo -- hay que convertirla a ISO primero.
const parseClashDate = (str) => {
  if (!str || str.length < 15) return null;
  const iso = `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T${str.slice(9, 11)}:${str.slice(11, 13)}:${str.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Intervalos de "vuelvo a chequear en..." según el estado. La idea: un clan
// que no está en guerra no necesita revisarse cada 20 min -- solo cerca de
// cuando podría empezar su próxima preparación no lo sabemos con certeza,
// así que igual bajamos bastante la frecuencia en ese caso.
const NOT_IN_WAR_RECHECK_MS = 2 * 60 * 60 * 1000; // 2h
const PREPARATION_RECHECK_MS = 15 * 60 * 1000; // 15min (para agarrar el inicio pronto)
const WAR_ENDED_RECHECK_MS = 2 * 60 * 60 * 1000; // 2h
const MIN_INWAR_RECHECK_MS = 5 * 60 * 1000; // no bajar de 5 min aunque falte poco
const NOT_IN_CWL_RECHECK_MS = 24 * 60 * 60 * 1000; // 1 vez al día

const computeNextWarCheck = (state, endTimeStr) => {
  const now = Date.now();
  if (state === 'inWar' && endTimeStr) {
    const end = parseClashDate(endTimeStr); // ya existe en el archivo (usado en otros lados)
    if (end) {
      const msToEnd = end.getTime() - now;
      return new Date(now + Math.max(MIN_INWAR_RECHECK_MS, Math.min(msToEnd, WAR_WATCHER_INTERVAL_MS)));
    }
  }
  if (state === 'preparation') return new Date(now + PREPARATION_RECHECK_MS);
  if (state === 'warEnded') return new Date(now + WAR_ENDED_RECHECK_MS);
  // 'notInWar' o cualquier otro estado desconocido
  return new Date(now + NOT_IN_WAR_RECHECK_MS);
};

const pollClanWars = async (tag) => {
  const rawTag = cleanTag(tag);
  const link = await ClanLink.findOne({ tag: rawTag });

  // Guerra normal en curso/terminada
  let warState = null;
  let warEndTime = null;
  try {
    const { ok, data } = await clashFetch(`/clans/%23${rawTag}/currentwar`);
    if (ok) {
      warState = data.state;
      warEndTime = data.endTime;
      await saveRegularWarIfEnded(data);
    }
  } catch (e) {
    // Si falla un clan puntual, seguimos con los demás.
  }

  const nextWarCheckAt = computeNextWarCheck(warState, warEndTime);

  // CWL: si ya sabemos que este mes no está en liga, no volvemos a chequear
  // hasta el día siguiente. Si sí está (o nunca chequeamos), revisamos rondas.
  const cwlDue = !link?.nextCwlCheckAt || link.nextCwlCheckAt <= new Date();
  let nextCwlCheckAt = link?.nextCwlCheckAt || null;

  if (cwlDue) {
    try {
      const cwl = await clashFetch(`/clans/%23${rawTag}/currentwar/leaguegroup`);
      if (cwl.ok && cwl.data && !cwl.data.notInCwl && Array.isArray(cwl.data.rounds)) {
        const warTags = cwl.data.rounds
          .flatMap((round) => round.warTags || [])
          .filter((t) => t && t !== '#0');

        for (const warTag of warTags) {
          try {
            const warRes = await clashFetch(`/clanwarleagues/wars/%23${cleanTag(warTag)}`);
            if (warRes.ok) await saveCwlWarIfEnded(warRes.data);
          } catch (e) {
            // Continuamos con las demás rondas si una falla.
          }
        }
        // Está en CWL este mes: seguimos chequeando cada pasada (no cacheamos).
        nextCwlCheckAt = null;
      } else {
        // No está en CWL este mes -> no hace falta volver a mirar hasta mañana.
        nextCwlCheckAt = new Date(Date.now() + NOT_IN_CWL_RECHECK_MS);
      }
    } catch (e) {
      // El clan puede no estar en CWL este mes; no es un error real.
    }
  }

  await ClanLink.findOneAndUpdate(
    { tag: rawTag },
    { $set: { nextWarCheckAt, lastWarState: warState, nextCwlCheckAt } },
    { upsert: true }
  );
};

const runWarWatcher = async () => {
  if (watcherRunning) return;
  watcherRunning = true;
  try {
    const clans = await Clan.find({}, { tag: 1 });
    // Con ownerTag, el mismo clan puede estar guardado por varios dueños
    // (varios documentos con el mismo tag) — deduplicamos para no pegarle
    // a la API de Supercell más de una vez por clan en cada pasada.
    const uniqueTags = [...new Set(clans.map((c) => cleanTag(c.tag).toUpperCase()).filter(Boolean))];

    // Filtramos por nextWarCheckAt: si un clan no está en guerra, no le toca
    // todavía -- así en 5,000 clanes guardados normalmente solo unos pocos
    // cientos (los que están en guerra/prep) se consultan cada pasada.
    const now = new Date();
    const links = await ClanLink.find(
      { tag: { $in: uniqueTags } },
      { tag: 1, nextWarCheckAt: 1 }
    );
    const nextCheckByTag = new Map(links.map((l) => [l.tag, l.nextWarCheckAt]));

    const dueTags = uniqueTags.filter((tag) => {
      const next = nextCheckByTag.get(tag);
      return !next || next <= now; // nunca chequeado, o ya le toca
    });

    console.log(`🔎 Vigía de guerras: ${dueTags.length}/${uniqueTags.length} clanes a consultar esta pasada.`);

    for (const tag of dueTags) {
      await pollClanWars(tag);
      await sleep(WAR_WATCHER_REQUEST_DELAY_MS);
    }
  } catch (e) {
    console.error('⚠️ Error en el vigía automático de guerras:', e.message);
  } finally {
    watcherRunning = false;
  }
};

const WAR_WATCHER_INTERVAL_MS = 20 * 60 * 1000; // cada 20 minutos
setInterval(runWarWatcher, WAR_WATCHER_INTERVAL_MS);
// Primera pasada poco después de levantar el servidor.
setTimeout(runWarWatcher, 30 * 1000);

// ═══════════ VIGÍA DIARIO DE DONACIONES ═══════════
// Mirror del vigía de guerras: recorre todos los clanes guardados y les
// toma una foto diaria de donaciones (ver donationSnapshotSchema). Con
// una pasada al día alcanza -- el reset del juego es semanal, así que
// no hace falta más frecuencia que esa para no perder datos.
let donationWatcherRunning = false;

const startOfUTCDay = (d = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const pollClanDonations = async (clanDoc) => {
  const rawTag = cleanTag(clanDoc.tag);
  try {
    const { ok, data } = await clashFetch(`/clans/%23${rawTag}`);
    if (!ok) return;

    const members = (data.memberList || []).map((m) => ({
      tag: m.tag,
      name: m.name,
      donations: m.donations || 0,
    }));

    await DonationSnapshot.findOneAndUpdate(
      { clanTag: rawTag, snapshotDate: startOfUTCDay() },
      { $set: { members } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (e) {
    // Si falla un clan puntual, seguimos con los demás; se reintenta mañana.
  }
};

const runDonationWatcher = async () => {
  if (donationWatcherRunning) return;
  donationWatcherRunning = true;
  try {
    const clans = await Clan.find();
    const uniqueByTag = new Map();
    for (const c of clans) {
      const key = cleanTag(c.tag).toUpperCase();
      if (key && !uniqueByTag.has(key)) uniqueByTag.set(key, c);
    }
    for (const clanDoc of uniqueByTag.values()) {
      await pollClanDonations(clanDoc);
    }
  } catch (e) {
    console.error('⚠️ Error en el vigía de donaciones:', e.message);
  } finally {
    donationWatcherRunning = false;
  }
};

const DONATION_WATCHER_INTERVAL_MS = 24 * 60 * 60 * 1000; // una vez al día
setInterval(runDonationWatcher, DONATION_WATCHER_INTERVAL_MS);
// Primera pasada poco después de levantar el servidor (corrida aparte del
// vigía de guerras, para no competir por el rate limit de la API justo al inicio).
setTimeout(runDonationWatcher, 45 * 1000);

// ═══════════ SERVIDOR ═══════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor Node.js corriendo en el puerto ${PORT}`);
});