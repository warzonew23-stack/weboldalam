require('dotenv').config();

const mongoose = require('mongoose');

// MongoDB Csatlakozás (A MONGODB_URI-t a Vercelen kell megadnod!)
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// --- MONGODB SÉMÁK (Modellek) ---
const BanSchema = new mongoose.Schema({
    ip: { type: String, unique: true },
    type: { type: String, enum: ['24h', 'permanent'] },
    expireAt: { type: Date, default: null } // 24 órás bannál használjuk
});
// Automatikus törlés a lejárati idő után
BanSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const Ban = mongoose.model('Ban', BanSchema);

const AttemptSchema = new mongoose.Schema({
    ip: { type: String, unique: true },
    count: { type: Number, default: 0 },
    lastAttempt: { type: Date, default: Date.now }
});
const Attempt = mongoose.model('Attempt', AttemptSchema);

const SettingsSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const Settings = mongoose.model('Settings', SettingsSchema);
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');


// ==========================================
// BIZTONSÁGI EXTRÁK (SZABY KÉRÉSÉRE)
// ==========================================
const helmet = require('helmet'); // Fejléc támadások ellen
const cors = require('cors'); // Jogosulatlan domainek blokkolása

// ==========================================
// SOCKS PROXY TÁMOGATÁS
// Telepítés: npm install socks-proxy-agent
// ==========================================
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.set('trust proxy', true); // Ha proxy vagy CDN (pl. Cloudflare) mögött futsz

// --- BIZTONSÁGI MIDDLEWARE-EK ---
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '50kb' })); // Túl nagy adatszemét blokkolása
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// ==========================================
// KONFIGURÁCIÓ ÉS VÁLTOZÓK
// ==========================================
const PORT = process.env.PORT || 3000;

// Webhookok beolvasása
const MAIN_WEBHOOK = process.env.MAIN_WEBHOOK;
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK; // Belső logok (F12, Admin, Valós hibák)
const REPORT_WEBHOOK = process.env.REPORT_WEBHOOK; // Támadások logja (Spam, Manipulált kérések)

// Ha nincs külön PROXY_WEBHOOK, akkor az ALERT_WEBHOOK-ra küldi az infókat
const PROXY_WEBHOOK = process.env.PROXY_WEBHOOK || process.env.ALERT_WEBHOOK;

const PROXYCHECK_API_KEY = process.env.PROXYCHECK_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Jelszó az /admin oldalhoz
const COUNTER_API_URL = process.env.COUNTER_API_URL; 

// --- EGYEDI ÜZENET A NORMÁL LOGOKHOZ ---
const EGYEDI_UZENET = ">>> **SZABY RENDSZER AKTÍV!** Új látogató a rendszeren. Minden védelem éles.";

// --- GLOBÁLIS VÁLTOZÓ A JELENLEGI "MŰKÖDŐ" PROXYNAK (Sticky Logic) ---
// Ez tárolja az aktuálisat, amit épp használunk, hogy ne ugráljon
let CURRENT_MASTER_PROXY = null; 
let proxyList = []; // Ez a teljes lista a memóriában


/* ==========================================================
   SEGÉDFÜGGVÉNY: PROXY ÁLLAPOT KÜLDÉSE DISCORDRA
   ========================================================== */
async function logProxyStatus(title, message, color) {
    if (!PROXY_WEBHOOK) return;
    
    try {
        await axios.post(PROXY_WEBHOOK, {
            username: "Proxy Monitor",
            embeds: [{
                title: title,
                description: message,
                color: color, 
                footer: { 
                    text: `Rendszeridő: ${new Date().toLocaleTimeString()}` 
                }
            }]
        });
    } catch (e) { 
        console.error("Webhook küldési hiba:", e.message); 
    }
}


/* ==========================================================
   PROXY KONFIGURÁLÓ FÜGGVÉNY (HTTP, HTTPS, SOCKS4/5, AUTH)
   ========================================================== */
function getProxyConfig(proxyStr) {
    if (!proxyStr) return null;
    
    let protocol = 'http';
    let cleanStr = proxyStr;

    // Ha van előtag (pl. socks5://), leválasztjuk
    if (proxyStr.includes('://')) {
        const split = proxyStr.split('://');
        protocol = split[0];
        cleanStr = split[1];
    }

    const parts = cleanStr.split(':');
    if (parts.length < 2) return null;

    const host = parts[0];
    const port = parseInt(parts[1]);
    const username = parts[2] || null;
    const password = parts[3] || null;

    // SOCKS PROXY KEZELÉS
    if (protocol.startsWith('socks')) {
        let socksUrl = `${protocol}://`;
        
        if (username && password) {
            socksUrl += `${username}:${password}@`;
        }
        
        socksUrl += `${host}:${port}`;
        
        const agent = new SocksProxyAgent(socksUrl);
        return { 
            httpAgent: agent, 
            httpsAgent: agent 
        };
    }

    // HTTP/HTTPS PROXY KEZELÉS (Sima Axios config)
    const axiosConfig = {
        proxy: { 
            protocol: 'http', 
            host: host, 
            port: port 
        }
    };

    if (username && password) {
        axiosConfig.proxy.auth = { 
            username: username, 
            password: password 
        };
    }

    return axiosConfig;
}


/* ==========================================================
   LISTA KEZELÉS & HÁTTÉRFOLYAMAT
   ========================================================== */
function loadProxiesFromFile() {
    try {
        if (fs.existsSync('proxies.txt')) {
            const content = fs.readFileSync('proxies.txt', 'utf8');
            return content.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0);
        }
    } catch (err) { 
        console.log("Hiba a fájl olvasásakor:", err.message); 
    }
    return [];
}

// Kezdő betöltés
proxyList = loadProxiesFromFile();

// VERCEL MEGJEGYZÉS: A setInterval / setTimeout leáll a serverless környezetben.
// A proxykat mostantól On-Demand ellenőrzi a rendszer a Redis adatbázissal!
async function checkProxiesInBackground() {
    const rawList = loadProxiesFromFile();
    if (CURRENT_MASTER_PROXY && !rawList.includes(CURRENT_MASTER_PROXY)) {
        console.log("⚠️ A jelenlegi Master Proxyt törölték a fájlból, leváltás...");
        CURRENT_MASTER_PROXY = null;
    }
    proxyList = rawList;
    if (rawList.length === 0) console.log("⚠️ FIGYELEM: A proxies.txt üres vagy nem található!");
}


/* ==========================================================
   RÉSZLETES GEO LOG LISTÁK (TELJES ADATOKKAL)
   ========================================================== */

function formatGeoDataTeljes(geo) {
  return (
    `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n` +
    `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n` +
    `**Típus:** ${geo.type || 'Ismeretlen'}\n` +
    `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n` +
    `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n` +
    `**Ország:** ${geo.country || 'Ismeretlen'}\n` +
    `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n` +
    `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n` +
    `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n` +
    `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n` +
    `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n` +
    `**Régió:** ${geo.region || 'Ismeretlen'}\n` +
    `**Város:** ${geo.city || 'Ismeretlen'}\n` +
    `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n` +
    `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n` +
    `**ASN:** ${geo.asn || 'Ismeretlen'}\n` +
    `**Szervezet:** ${geo.org || 'Ismeretlen'}\n` +
    `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n` +
    `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n` +
    `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n` +
    `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n` +
    `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n` +
    `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n` +
    `**Valuta:** ${geo.currency || 'Ismeretlen'}\n` +
    `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n` +
    `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n` +
    `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n` +
    `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`
  );
}

function formatGeoDataVpn(geo) {
  // VPN esetében is a teljes adatot kérjük, ahogy kérted
  return (
    `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n` +
    `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n` +
    `**Típus:** ${geo.type || 'Ismeretlen'}\n` +
    `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n` +
    `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n` +
    `**Ország:** ${geo.country || 'Ismeretlen'}\n` +
    `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n` +
    `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n` +
    `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n` +
    `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n` +
    `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n` +
    `**Régió:** ${geo.region || 'Ismeretlen'}\n` +
    `**Város:** ${geo.city || 'Ismeretlen'}\n` +
    `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n` +
    `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n` +
    `**ASN:** ${geo.asn || 'Ismeretlen'}\n` +
    `**Szervezet:** ${geo.org || 'Ismeretlen'}\n` +
    `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n` +
    `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n` +
    `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n` +
    `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n` +
    `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n` +
    `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n` +
    `**Valuta:** ${geo.currency || 'Ismeretlen'}\n` +
    `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n` +
    `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n` +
    `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n` +
    `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`
  );
}

function formatGeoDataReport(geo, pageUrl) {
  // Riport esetében is a teljes adat
  return (
    (pageUrl ? `**Oldal:** ${pageUrl}\n` : '') +
    `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n` +
    `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n` +
    `**Típus:** ${geo.type || 'Ismeretlen'}\n` +
    `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n` +
    `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n` +
    `**Ország:** ${geo.country || 'Ismeretlen'}\n` +
    `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n` +
    `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n` +
    `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n` +
    `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n` +
    `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n` +
    `**Régió:** ${geo.region || 'Ismeretlen'}\n` +
    `**Város:** ${geo.city || 'Ismeretlen'}\n` +
    `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n` +
    `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n` +
    `**ASN:** ${geo.asn || 'Ismeretlen'}\n` +
    `**Szervezet:** ${geo.org || 'Ismeretlen'}\n` +
    `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n` +
    `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n` +
    `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n` +
    `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n` +
    `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n` +
    `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n` +
    `**Valuta:** ${geo.currency || 'Ismeretlen'}\n` +
    `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n` +
    `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n` +
    `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n` +
    `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`
  );
}


/* ==========================================================
   OKOS GEO LEKÉRDEZÉS (TAPADÓS / STICKY LOGIKA VERCEL KV)
   ========================================================== */
async function getGeo(ip) {
    // 1. LÉPÉS: Próbáljuk a JELENLEGI MŰKÖDŐ (MASTER) proxyt a Redisből lekérni!
    let CURRENT_MASTER_PROXY = await kv.get('current_master_proxy');

    if (CURRENT_MASTER_PROXY) {
        const config = getProxyConfig(CURRENT_MASTER_PROXY);
        
        if (config) {
            try {
                // Adunk neki 4 másodpercet
                config.timeout = 4000;
                
                const geo = await axios.get(`https://ipwhois.app/json/${ip}`, config);
                
                // Ha sikerült, visszatérünk. NEM váltunk proxyt. 
                // Így ugyanazt használjuk, amíg meg nem hal.
                if (geo.data && geo.data.success !== false) {
                    return geo.data;
                } else {
                    throw new Error("API hiba vagy Rate limit");
                }
            } catch (err) {
                console.log(`❌ A Master Proxy (${CURRENT_MASTER_PROXY}) kiesett vagy hiba történt. Új keresése...`);
                
                // Logoljuk Discordra, hogy mi történt
                await logProxyStatus(
                    "⚠️ Proxy Csere (Hiba miatt)",
                    `**A régi proxy kiesett:** \`${CURRENT_MASTER_PROXY}\`\n**Ok:** ${err.message}\n**Akció:** A rendszer azonnal új proxyt keres...`,
                    0xffa500 // Narancs szín
                );
                
                // Töröljük a jelenlegit a Redisből, hogy a kód tovább fusson és keressen újat
                await kv.del('current_master_proxy');
                CURRENT_MASTER_PROXY = null; 
            }
        }
    }

    // 2. LÉPÉS: Ha nincs Master Proxy (vagy az előbb halt meg), keresünk egy újat a listából
    const maxRetries = 10; // Maximum 10 proxyt próbálunk végig, mielőtt feladnánk
    proxyList = loadProxiesFromFile(); // Mindig frissítjük a fájlból!
    
    for (let i = 0; i < maxRetries; i++) {
        if (proxyList.length === 0) break;
        
        // Véletlenszerű jelölt választása
        const candidate = proxyList[Math.floor(Math.random() * proxyList.length)];
        const config = getProxyConfig(candidate);
        
        if (!config) continue;

        try {
            console.log(`🔍 Új jelölt tesztelése: ${candidate}...`);
            config.timeout = 4000;
            
            const geo = await axios.get(`https://ipwhois.app/json/${ip}`, config);

            if (geo.data && geo.data.success !== false) {
                // SIKER! Megvan az új Master Proxy, mehet a Redisbe!
                await kv.set('current_master_proxy', candidate);
                console.log(`✅ ÚJ MASTER PROXY BEÁLLÍTVA: ${candidate}`);
                
                // Értesítés a Discordra az új stabil proxyról
                await logProxyStatus(
                    "✅ Új Stabil Proxy Beállítva",
                    `A rendszer talált egy működő proxyt és mostantól ezt használja minden kéréshez (amíg működik).\n\n**Kiválasztott Proxy:** \`${candidate}\``,
                    0x00ff00 // Zöld szín
                );

                return geo.data;
            }
        } catch (err) {
            // Ez a jelölt nem volt jó, csendben továbbmegyünk a következőre
        }
    }

    // 3. LÉPÉS: Ha minden kötél szakad (nincs proxy vagy mind a 10 rossz volt)
    try {
        console.log("⚠️ Minden proxy teszt sikertelen, direkt lekérés következik...");
        
        await logProxyStatus(
            "🚨 MINDEN PROXY SIKERTELEN!",
            "A rendszer nem tudott proxyn keresztül kapcsolódni.\n**Akció:** Átváltás SAJÁT IP-re (Direkt mód).",
            0xff0000 // Piros szín
        );
        
        const geo = await axios.get(`https://ipwhois.app/json/${ip}`, { timeout: 5000 });
        return geo.data || {};
    } catch (err) {
        return {};
    }
}


/* ==========================================================
   EGYÉB FÜGGVÉNYEK (ADMIN, VÉDELEM, IP KEZELÉS)
   ========================================================== */

// Anti-Scraper Middleware (Bővített Enterprise Lista)
app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  
  const forbiddenAgents = [
      'curl', 
      'wget', 
      'python', 
      'libwww-perl', 
      'httpclient', 
      'axios', 
      'httrack', 
      'webcopier', 
      'cybergap', 
      'sqlmap', 
      'nmap', 
      'whatweb', 
      'nikto', 
      'paros', 
      'webscrab', 
      'netcraft', 
      'mj12bot', 
      'ahrefs', 
      'semrush', 
      'dotbot', 
      'rogue', 
      'go-http-client',
      'zgrab',
      'masscan',
      'scanner',
      'postman'
  ];
  
  if (forbiddenAgents.some(bot => ua.includes(bot)) || !ua) {
      console.log(`🛑 Blokkolt Scraping Kísérlet: ${ua} IP: ${req.ip}`);
      return res.status(403).json({
          error: "ACCESS_DENIED",
          message: "A te eszközöd/botod ki van tiltva erről a szerverről.",
          your_ip: req.ip
      });
  }
  
  next();
});

function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip.toLowerCase();
}

function getClientIp(req) {
  let ip = req.headers['cf-connecting-ip'] || 
           req.headers['x-real-ip'] || 
           (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') || 
           (req.socket.remoteAddress || '');
  console.log("Received IP: ", ip);
  return normalizeIp(ip);
}

const WHITELISTED_IPS = (process.env.ALLOWED_VPN_IPS || '').split(',').map(s => normalizeIp(s.trim())).filter(Boolean);
const MY_IPS = (process.env.MY_IP || '').split(',').map(s => normalizeIp(s.trim())).filter(Boolean);


/* ==========================================================
   MONGODB MODELLEK (SÉMÁK)
   ========================================================== */
const mongoose = require('mongoose');

// Csatlakozás (A MONGODB_URI-t a Vercel Environment Variables-be írd be!)
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB csatlakozva"))
  .catch(err => console.error("❌ MongoDB hiba:", err));

// Ban modell (24h és permanent egyben)
const BanSchema = new mongoose.Schema({
    ip: { type: String, unique: true },
    type: { type: String, enum: ['24h', 'permanent'] },
    expireAt: { type: Date, default: null } // TTL indexszel automatikusan törlődik
});
BanSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // Ez törli a lejárt banokat
const Ban = mongoose.model('Ban', BanSchema);

// Rossz próbálkozások modellje
const AttemptSchema = new mongoose.Schema({
    ip: { type: String, unique: true },
    count: { type: Number, default: 0 },
    expireAt: { type: Date }
});
AttemptSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const Attempt = mongoose.model('Attempt', AttemptSchema);

// DDoS Rate Limit modell
const RateLimitSchema = new mongoose.Schema({
    ip: { type: String, unique: true },
    count: { type: Number, default: 0 },
    expireAt: { type: Date }
});
RateLimitSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const RateLimit = mongoose.model('RateLimit', RateLimitSchema);

// Beállítások (pl. Current Proxy tárolására)
const SettingsSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const Settings = mongoose.model('Settings', SettingsSchema);


/* ==========================================================
   KICSERÉLT FÜGGVÉNYEK (MONGODB ALAPON)
   ========================================================== */

async function isIpBanned(ip) { 
    const result = await Ban.findOne({ ip, type: '24h' });
    return !!result; 
}

async function banIp(ip) { 
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000); 
    await Ban.findOneAndUpdate(
        { ip }, 
        { type: '24h', expireAt }, 
        { upsert: true }
    ); 
}

async function unbanIp(ip) { 
    await Ban.deleteOne({ ip, type: '24h' }); 
}

const MAX_BAD_ATTEMPTS = 10;

async function recordBadAttempt(ip) {
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const doc = await Attempt.findOneAndUpdate(
        { ip },
        { $inc: { count: 1 }, $setOnInsert: { expireAt } },
        { upsert: true, new: true }
    );
    return doc.count;
}

async function isPermanentBanned(ip) {
    const result = await Ban.findOne({ ip, type: 'permanent' });
    return !!result;
}

async function banPermanentIp(ip) {
    await Ban.findOneAndUpdate(
        { ip }, 
        { type: 'permanent', expireAt: null }, 
        { upsert: true }
    );
}

async function unbanPermanentIp(ip) {
    await Ban.deleteOne({ ip, type: 'permanent' });
}

/* ==========================================================
   DDoS VÉDELEM (MONGODB ALAPON)
   ========================================================== */
async function ddosProtection(req, res, next) {
    const ip = getClientIp(req);
    if (MY_IPS.includes(ip) || WHITELISTED_IPS.includes(ip)) return next();

    const expireAt = new Date(Date.now() + 60 * 1000); // 1 perces ablak
    const rate = await RateLimit.findOneAndUpdate(
        { ip },
        { $inc: { count: 1 }, $setOnInsert: { expireAt } },
        { upsert: true, new: true }
    );

    if (rate.count > 60) {
        if (!(await isPermanentBanned(ip))) {
            await banPermanentIp(ip); 
            const geo = await getGeo(ip);
            axios.post(REPORT_WEBHOOK || ALERT_WEBHOOK, { 
                username: "DDoS Elhárító Rendszer", 
                embeds: [{ 
                    title: '🚨 BRUTE FORCE / DDOS ÉSZLELVE!', 
                    description: `**Támadó IP:** ${ip}\n**Akció:** Automatikus VÉGLEGES BAN (MongoDB).\n\n` + formatGeoDataReport(geo, req.originalUrl), 
                    color: 0xff0000 
                }] 
            }).catch(()=>{});
        }
        return res.status(429).sendFile(path.join(__dirname, 'public', 'banned-permanent.html'));
    }
    next();
}

app.use(ddosProtection);

// Proxy lekérés módosítása MongoDB-re a getGeo-ban (Ezt a getGeo elején cseréld le):
// let masterDoc = await Settings.findOne({ key: 'current_master_proxy' });
// let CURRENT_MASTER_PROXY = masterDoc ? masterDoc.value : null;

async function isVpnProxy(ip) {
  try {
    const url = `https://proxycheck.io/v2/${ip}?key=${PROXYCHECK_API_KEY}&vpn=1&asn=1&node=1`;
    const res = await axios.get(url, { timeout: 5000 });
    if (res.data && res.data[ip]) {
        return res.data[ip].proxy === "yes" || res.data[ip].type === "VPN";
    }
    return false;
  } catch { return false; }
}

// ÚTVONALAK (Ugyanaz marad...)
app.get('/banned-ip.html', (req, res) => { 
    const p = path.join(__dirname, 'public', 'banned-ip.html'); 
    if (fs.existsSync(p)) return res.sendFile(p); 
    res.status(404).send('banned-ip.html hiányzik'); 
});

app.get('/banned-vpn.html', (req, res) => { 
    const p = path.join(__dirname, 'public', 'banned-vpn.html'); 
    if (fs.existsSync(p)) return res.sendFile(p); 
    res.status(404).send('banned-vpn.html hiányzik'); 
});

app.get('/banned-permanent.html', (req, res) => { 
    const p = path.join(__dirname, 'public', 'banned-permanent.html'); 
    if (fs.existsSync(p)) return res.sendFile(p); 
    res.status(404).send('banned-permanent.html hiányzik'); 
});

// GLOBAL BAN MIDDLEWARE (MongoDB aszinkron hívásokkal)
app.use(async (req, res, next) => {
  const ip = getClientIp(req);  
  if (!MY_IPS.includes(ip) && !WHITELISTED_IPS.includes(ip)) {
    if (await isIpBanned(ip)) {
        return res.status(403).sendFile(path.join(__dirname, 'public', 'banned-ip.html'));
    }
    if (await isPermanentBanned(ip)) {
        return res.status(403).sendFile(path.join(__dirname, 'public', 'banned-permanent.html'));
    }
  }
  next();  
});

// HTML NAPLÓZÓ MIDDLEWARE (Aszinkronizálva)
app.use(async (req, res, next) => {
  const publicDir = path.join(__dirname, 'public');
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const cleanPath = decodeURIComponent(req.path).replace(/^\/+/, '');
  let servesHtml = false;
  
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.path === '/') servesHtml = true;
    else if (cleanPath.toLowerCase().endsWith('.html')) {
        servesHtml = fs.existsSync(path.join(publicDir, cleanPath));
    } else if (!path.extname(cleanPath)) {
        servesHtml = fs.existsSync(path.join(publicDir, cleanPath, 'index.html'));
    }
  }
  
  if (!servesHtml) return next();

  const ip = getClientIp(req);
  if (!MY_IPS.includes(ip) && !WHITELISTED_IPS.includes(ip)) {
    if (await isPermanentBanned(ip)) {
        return res.status(403).sendFile(path.join(__dirname, 'public', 'banned-permanent.html'));
    }
  }

  const geoData = await getGeo(ip);
  const vpnCheck = await isVpnProxy(ip);
  
  if (vpnCheck) {
    if (!WHITELISTED_IPS.includes(ip)) {
      axios.post(ALERT_WEBHOOK, { 
          username: "VPN Figyelő", 
          embeds: [{ 
              title: 'VPN/proxy vagy TOR!', 
              description: `**Oldal:** ${fullUrl}\n` + formatGeoDataVpn(geoData), 
              color: 0xff0000 
          }] 
      }).catch(() => {});
      return res.status(403).sendFile(path.join(__dirname, 'public', 'banned-vpn.html'));
    }
  } else {
    if (!MY_IPS.includes(ip)) {
      axios.post(MAIN_WEBHOOK, { 
          username: "Látogató Naplózó", 
          embeds: [{ 
              title: 'Új látogató (HTML)', 
              description: EGYEDI_UZENET + `\n\n**Oldal:** ${fullUrl}\n` + formatGeoDataTeljes(geoData), 
              color: 0x800080 
          }] 
      }).catch(() => {});
    }
  }
  next();
});

// ==========================================
// ADMIN FELÜLET
// ==========================================
app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin – IP Ban/Unban</title>
  <style>
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu;
      background: #0f1115;
      color: #e8eaf0;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #151922;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 6px 30px rgba(0, 0, 0, .4);
      max-width: 440px;
      width: 100%;
    }
    h1 {
      font-size: 18px;
      margin: 0 0 12px;
    }
    label {
      display: block;
      margin: 10px 0 4px;
      font-size: 14px;
      color: #b6bdd1;
    }
    input {
      width: 100%;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #2a3142;
      background: #0f131b;
      color: #e8eaf0;
      box-sizing: border-box; 
    }
    button {
      margin-top: 12px;
      width: 100%;
      padding: 10px;
      border: 0;
      border-radius: 10px;
      background: #5865F2;
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row>button {
      flex: 1;
    }
    .msg {
      margin-top: 10px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin – IP Ban / Unban</h1>
    <form id="adminForm">
      <label>Admin jelszó</label>
      <input name="password" type="password" placeholder="Admin jelszó" required>
      <label>IP cím</label>
      <input name="ip" placeholder="1.2.3.4" required>
      <div class="row">
        <button type="submit" data-action="ban">IP BAN 24h</button>
        <button type="submit" data-action="unban">IP UNBAN 24h</button>
      </div>
      <div class="row">
        <button type="submit" data-action="permanent-ban" style="background-color: #d83c3e;">IP VÉGLEGES BAN</button>
        <button type="submit" data-action="permanent-unban" style="background-color: #2d7d46;">IP VÉGLEGES FELOLDÁS</button> 
      </div>
    </form>
    <div class="msg" id="msg"></div>
    <script>
      const form = document.getElementById('adminForm');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const action = e.submitter?.dataset?.action || 'ban';
        msg.textContent = 'Küldés...';
        const fd = new FormData(form);
        const body = new URLSearchParams();
        for (const [k, v] of fd) body.append(k, v);
        
        const url = action === 'ban' ? '/admin/ban/form' :
          action === 'unban' ? '/admin/unban/form' :
          action === 'permanent-ban' ? '/admin/permanent-ban/form' : '/admin/permanent-unban/form';
          
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        
        const t = await r.text();
        msg.textContent = t;
        if (r.ok) form.reset();
      });
    </script>
  </div>
</body>
</html>`);
});

// Admin végpontok Aszinkronizálva a Redis miatt!
app.post('/admin/ban/form', express.urlencoded({ extended: true }), async (req, res) => { 
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).send('Hibás jelszó'); 
    await banIp(normalizeIp(req.body.ip)); 
    res.send('✅ IP tiltva 24 órára.'); 
});

app.post('/admin/unban/form', express.urlencoded({ extended: true }), async (req, res) => { 
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).send('Hibás jelszó'); 
    await unbanIp(normalizeIp(req.body.ip)); 
    res.send('✅ IP feloldva.'); 
});

app.post('/admin/permanent-ban/form', express.urlencoded({ extended: true }), async (req, res) => { 
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).send('Hibás jelszó'); 
    await banPermanentIp(normalizeIp(req.body.ip)); 
    res.send('✅ IP véglegesen tiltva.'); 
});

app.post('/admin/permanent-unban/form', express.urlencoded({ extended: true }), async (req, res) => { 
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).send('Hibás jelszó'); 
    await unbanPermanentIp(normalizeIp(req.body.ip)); 
    res.send('✅ IP véglegesen feloldva.'); 
});


/* ====================================================================
   API VÉGPONTOK (REPORT & COUNTER)
   ==================================================================== */
app.post('/api/biztonsagi-naplo-v1', express.json(), async (req, res) => {
  const ip = getClientIp(req);
  const { reason, page } = req.body || {};
  
  const origin = req.get('origin') || ''; 
  const referer = req.get('referer') || '';
  
  const engedelyezettDomainek = [
      'weboldalam-1hp6.onrender.com', 
      'szaby.is-a.dev', 
      'localhost', 
      '127.0.0.1'
  ];
  
  const originHelyes = !origin || engedelyezettDomainek.some(domain => origin.includes(domain));
  const refererHelyes = !referer || engedelyezettDomainek.some(domain => referer.includes(domain));

  // 1. GEO adatok lekérése az elején
  const geo = await getGeo(ip); 

  // 2. Külső támadás ellenőrzése
  if (!originHelyes || !refererHelyes) {
      await banIp(ip); 
      
      axios.post(REPORT_WEBHOOK || ALERT_WEBHOOK, { 
          username: "API Védelmi Rendszer", 
          embeds: [{ 
              title: '🚨 KÜLSŐ TÁMADÁS BLOKKOLVA!', 
              description: `**Valaki terminálból vagy külső oldalról próbálkozott!**\n\n` +
                           `**Támadó IP:** ${ip}\n` +
                           `**Forrás:** ${origin || referer || 'Ismeretlen'}\n` +
                           `**Cél domain:** weboldalam-1hp6.onrender.com\n` +
                           `**Akció:** 24 órás kitiltás.\n\n` +
                           `**Részletes adatok:**\n` +
                           `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n` +
                           `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n` +
                           `**Típus:** ${geo.type || 'Ismeretlen'}\n` +
                           `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n` +
                           `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n` +
                           `**Ország:** ${geo.country || 'Ismeretlen'}\n` +
                           `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n` +
                           `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n` +
                           `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n` +
                           `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n` +
                           `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n` +
                           `**Régió:** ${geo.region || 'Ismeretlen'}\n` +
                           `**Város:** ${geo.city || 'Ismeretlen'}\n` +
                           `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n` +
                           `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n` +
                           `**ASN:** ${geo.asn || 'Ismeretlen'}\n` +
                           `**Szervezet:** ${geo.org || 'Ismeretlen'}\n` +
                           `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n` +
                           `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n` +
                           `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n` +
                           `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n` +
                           `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n` +
                           `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n` +
                           `**Valuta:** ${geo.currency || 'Ismeretlen'}\n` +
                           `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n` +
                           `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n` +
                           `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n` +
                           `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`,
              color: 0xff0000 
          }] 
      }).catch(()=>{});

      return res.status(403).json({ 
          error: "EXTERNAL_REQUEST_BLOCKED", 
          message: "Az IP-det 24 órára kitiltottuk külső hívás miatt!" 
      });
  }

  // Érvényes indokok listája
  const validReasons = [
      'Ctrl+U kombináció blokkolva (forráskód megtekintés)',
      'Ctrl+Shift+I kombináció blokkolva (fejlesztői eszközök)',
      'Ctrl+Shift+J kombináció blokkolva (fejlesztői konzol)',
      'F12 gomb blokkolva (fejlesztői eszközök)',
      'Ctrl+S kombináció blokkolva (oldal mentése)',
      'Ctrl+P kombináció blokkolva (oldal nyomtatása)',
      'Jobb kattintás blokkolva (kontextus menü)'
  ];

  // Ha az üzenet nincs a listában -> Manipuláció gyanúja
  if (!validReasons.includes(reason)) {
      if (!MY_IPS.includes(ip) && !WHITELISTED_IPS.includes(ip)) {
           // Végleges tiltás aktiválása
           await banPermanentIp(ip);
           
           axios.post(REPORT_WEBHOOK, { 
               username: "Spam / Manipuláció Észlelő", 
               embeds: [{ 
                   title: '⚠️ MANIPULÁLT ÜZENET - AZONNALI ÖRÖK BAN! ⛔', 
                   description: `**Valaki hamis adatot küldött az API-nak!**\n\n**IP-cím:** ${ip}\n**Küldött üzenet:** "${reason}"\n**BÜNTETÉS:** Végleges kitiltás aktiválva.\n` + formatGeoDataReport(geoData, page), 
                   color: 0xff0000 
               }] 
           }).catch(() => {});
      }
      return res.status(403).json({ error: "PERMANENTLY_BANNED", message: "Manipulált kérés észlelve. Véglegesen ki lettél tiltva." });
  }

  if (MY_IPS.includes(ip)) return res.json({ ok: true });
  
  const count = await recordBadAttempt(ip);
  
  // Riasztás küldése
  axios.post(ALERT_WEBHOOK, { 
      username: "Kombináció figyelő", 
      embeds: [{ 
          title: count >= MAX_BAD_ATTEMPTS ? 'IP TILTVA (Sok próbálkozás)' : `Rossz kombináció (${count}/${MAX_BAD_ATTEMPTS})`, 
          description: `**IP:** ${ip}\n**Ok:** ${reason || 'Ismeretlen'}\n` + formatGeoDataReport(geoData, page), 
          color: count >= MAX_BAD_ATTEMPTS ? 0xff0000 : 0xffa500 
      }] 
  }).catch(() => {});
  
  // Ha túl sokszor próbálkozott, tiltjuk
  if (count >= MAX_BAD_ATTEMPTS && !WHITELISTED_IPS.includes(ip)) {
      await banIp(ip);
  }
  
  res.json({ ok: true });
});


// Statikus fájlok kiszolgálása
app.use(express.static(path.join(__dirname, 'public')));

// Számláló API
app.get('/api/counter', async (req, res) => { 
    try { 
        if (!COUNTER_API_URL) return res.status(500).json({error: 'Config error'});
        const r = await axios.get(COUNTER_API_URL);
        res.json(r.data); 
    } catch { 
        res.status(500).json({error:'Hiba'}); 
    } 
});

// Főoldal kiszolgálása
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname,'public','szaby','index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    } else {
        return res.sendStatus(404);
    }
});

// 404 Kezelés
app.use((req, res) => res.status(404).send('404 Not Found'));

// ==========================================
// SZERVER INDÍTÁSA - VERCEL EXPORT
// A Vercel architektúra miatt az app.listen() nem kell
// ==========================================
// app.listen(PORT, () => console.log(`Szerver elindult: http://localhost:${PORT}`));

module.exports = app;
