/* ============================================================
   COXE — site backend (Express + MongoDB)
   ------------------------------------------------------------
   - Yorumlar ve indirme sayaçları MongoDB'de tutulur.
   - İsimler DB'de tam saklanır ama siteye HER ZAMAN maskeli
     gönderilir (örn. "Kaan Yılmaz" -> "Ka*** K.").
   - Kendi veritabanın: .env dosyasına MONGODB_URI koy
     (örn. MongoDB Atlas). Yoksa otomatik geçici (in-memory)
     bir MongoDB başlar — demo için ideal, veriler kalıcı olmaz.
   ============================================================ */
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '16kb' }));
// CORS — site Netlify gibi farklı bir adresten API'ye ulaşabilsin diye
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

let db;
let dbMode = '';

// ---------- yardımcılar ----------
function maskName(name) {
  const parts = String(name || 'Anon').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Co***';
  const first = parts[0];
  const head = first.length <= 2 ? first[0] + '***' : first.slice(0, 2) + '***';
  const rest = parts.slice(1).map(w => w[0].toUpperCase() + '.').join(' ');
  return rest ? head + ' ' + rest : head;
}

function clean(str, max) {
  return String(str || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const BUILDS = ['Mod · 1.21.11', 'External · 1.20 → 1.21.11'];

// ---------- örnek veriler (ilk açılışta) ----------
async function seed() {
  const reviews = db.collection('reviews');
  if ((await reviews.countDocuments()) === 0) {
    await reviews.insertMany([
      { name: 'Ahmet Yılmaz', text: "Switched from a paid client I won't name. Coxe is faster, cleaner, and hasn't cost me a single frame. Unreal that this is free.", build: 'External · 1.20 → 1.21.11', rating: 5, createdAt: new Date(Date.now() - 864e5 * 4) },
      { name: 'Mert Demir', text: "The 1.21.11 mod dropped the same day as the Minecraft update. My FPS literally did not move. ClickGUI is the cleanest I've used.", build: 'Mod · 1.21.11', rating: 5, createdAt: new Date(Date.now() - 864e5 * 3) },
      { name: 'Efe Koç', text: 'One exe that works on every version I play — 1.20 practice servers and 1.21.11 alike. Cloud configs mean my setup follows me everywhere.', build: 'External · 1.20 → 1.21.11', rating: 5, createdAt: new Date(Date.now() - 864e5 * 2) },
      { name: 'Deniz Kaya', text: 'Aim assist feels human, not like a robot glued to heads. Config codes from the Discord took me 10 seconds to import. GG.', build: 'External · 1.20 → 1.21.11', rating: 4, createdAt: new Date(Date.now() - 864e5 * 1) }
    ]);
    console.log('[seed] örnek yorumlar eklendi');
  }
  await db.collection('stats').updateOne(
    { _id: 'downloads' },
    { $setOnInsert: { mod: 41208, external: 43892 } },
    { upsert: true }
  );
}

// ---------- API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, db: 'mongodb', mode: dbMode }));

app.get('/api/reviews', async (req, res) => {
  try {
    const list = await db.collection('reviews').find({}).sort({ createdAt: -1 }).limit(30).toArray();
    // ⚠️ İsimler ASLA tam gitmez — sadece maskeli hali + baş harf
    res.json(list.map(r => ({
      name: maskName(r.name),
      initial: (r.name || '?').charAt(0).toUpperCase(),
      text: r.text,
      build: r.build,
      rating: r.rating || 5,
      createdAt: r.createdAt
    })));
  } catch (e) { res.status(500).json({ error: 'DB hatası' }); }
});

const lastPost = new Map();
app.post('/api/reviews', async (req, res) => {
  try {
    const now = Date.now(), ip = req.ip;
    if (lastPost.get(ip) && now - lastPost.get(ip) < 15000)
      return res.status(429).json({ error: 'Çok hızlısın kanka, 15 sn bekle' });

    const name = clean(req.body.name, 30);
    const text = clean(req.body.text, 300);
    let rating = parseInt(req.body.rating, 10);
    if (!(rating >= 1 && rating <= 5)) rating = 5;
    const build = BUILDS.includes(req.body.build) ? req.body.build : BUILDS[1];

    if (name.length < 2 || text.length < 3)
      return res.status(400).json({ error: 'İsim (en az 2) ve yorum (en az 3 karakter) gerekli' });

    lastPost.set(ip, now);
    await db.collection('reviews').insertOne({ name, text, build, rating, createdAt: new Date(), ip });
    res.json({ ok: true, shownAs: maskName(name) });
  } catch (e) { res.status(500).json({ error: 'DB hatası' }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const d = (await db.collection('stats').findOne({ _id: 'downloads' })) || { mod: 0, external: 0 };
    res.json({ mod: d.mod, external: d.external, total: d.mod + d.external });
  } catch (e) { res.status(500).json({ error: 'DB hatası' }); }
});

app.post('/api/downloads/:type', async (req, res) => {
  try {
    const t = req.params.type === 'mod' ? 'mod' : 'external';
    await db.collection('stats').updateOne({ _id: 'downloads' }, { $inc: { [t]: 1 } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB hatası' }); }
});

// ---------- başlat ----------
(async () => {
  let uri = process.env.MONGODB_URI;
  if (uri) {
    dbMode = 'custom (MONGODB_URI)';
  } else {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    uri = mem.getUri();
    dbMode = 'in-memory (demo) — kalıcı değil, .env ile MONGODB_URI ver';
  }
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'coxe');
  await seed();
  console.log('[db] MongoDB bağlı:', dbMode);
  app.listen(PORT, '0.0.0.0', () => console.log('[coxe] site yayında → http://localhost:' + PORT));
})().catch(err => { console.error('[fatal]', err); process.exit(1); });
