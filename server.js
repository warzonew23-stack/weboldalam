/* ==========================================================
   SZABY RENDSZER - CORE SECURITY SERVER v3.0
   ========================================================== */

require('dotenv').config();

const express = require('express');

const axios = require('axios');

const path = require('path');

const fs = require('fs');

/* ==========================================================
   MONGODB ADATBÁZIS INTEGRÁCIÓ (REDIS HELYETT)
   ========================================================== */

const mongoose = require('mongoose');

// MongoDB Csatlakozás a Vercel változókból
mongoose.connect(
    process.env.MONGODB_URI, 
    {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
).then(() => {
    console.log("-----------------------------------------");
    console.log("✅ MONGODB CSATLAKOZVA - RENDSZER ÉLES");
    console.log("-----------------------------------------");
}).catch(err => {
    console.error("❌ MONGODB HIBA:", err);
});

/* ==========================================================
   MONGODB ADATMODELLEK (SCHEMAS)
   ========================================================== */

// --- BAN RENDSZER MODELL ---
const BanSchema = new mongoose.Schema({
    ip: { 
        type: String, 
        unique: true, 
        index: true 
    },
    type: { 
        type: String, 
        enum: ['24h', 'permanent'] 
    },
    expireAt: { 
        type: Date, 
        default: null 
    }
});

// TTL Index az automatikus törléshez
BanSchema.index(
    { "expireAt": 1 }, 
    { expireAfterSeconds: 0 }
);

const Ban = mongoose.model('Ban', BanSchema);

// --- DDoS ÉS PRÓBÁLKOZÁS MODELL ---
const AttemptSchema = new mongoose.Schema({
    ip: { 
        type: String, 
        unique: true, 
        index: true 
    },
    count: { 
        type: Number, 
        default: 0 
    },
    expireAt: { 
        type: Date 
    }
});

AttemptSchema.index(
    { "expireAt": 1 }, 
    { expireAfterSeconds: 0 }
);

const Attempt = mongoose.model('Attempt', AttemptSchema);

// --- BEÁLLÍTÁSOK (PROXY TÁROLÓ) ---
const SettingsSchema = new mongoose.Schema({
    key: { 
        type: String, 
        unique: true 
    },
    value: mongoose.Schema.Types.Mixed
});

const Settings = mongoose.model('Settings', SettingsSchema);

/* ==========================================================
   BIZTONSÁGI CSOMAGOK
   ========================================================== */

const helmet = require('helmet');

const cors = require('cors');

const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();

app.set('trust proxy', true);

// --- BIZTONSÁGI MIDDLEWARE BEÁLLÍTÁSOK ---
app.use(
    helmet({ 
        contentSecurityPolicy: false, 
        crossOriginEmbedderPolicy: false 
    })
);

app.use(cors());

app.use(
    express.json({ 
        limit: '50kb' 
    })
);

app.use(
    express.urlencoded({ 
        extended: true, 
        limit: '50kb' 
    })
);

/* ==========================================================
   KONFIGURÁCIÓ ÉS VÁLTOZÓK
   ========================================================== */

const PORT = process.env.PORT || 3000;

// Webhookok beolvasása a környezeti változókból
const MAIN_WEBHOOK = process.env.MAIN_WEBHOOK;

const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;

const REPORT_WEBHOOK = process.env.REPORT_WEBHOOK;

const PROXY_WEBHOOK = process.env.PROXY_WEBHOOK || process.env.ALERT_WEBHOOK;

const PROXYCHECK_API_KEY = process.env.PROXYCHECK_API_KEY;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const COUNTER_API_URL = process.env.COUNTER_API_URL; 

// EGYEDI ÜZENET A LOGOKHOZ
const EGYEDI_UZENET = ">>> **SZABY RENDSZER AKTÍV!** Új látogató a rendszeren. Minden védelem éles.";

// Globális változók a memóriában
let proxyList = []; 


/* ==========================================================
   SEGÉDFÜGGVÉNY: PROXY ÁLLAPOT KÜLDÉSE DISCORDRA
   ========================================================== */

async function logProxyStatus(title, message, color) {
    if (!PROXY_WEBHOOK) return;
    
    try {
        await axios.post(
            PROXY_WEBHOOK, 
            {
                username: "Proxy Monitor",
                embeds: [
                    {
                        title: title,
                        description: message,
                        color: color, 
                        footer: { 
                            text: `Rendszeridő: ${new Date().toLocaleTimeString()}` 
                        }
                    }
                ]
            }
        );
    } catch (e) { 
        console.error("Webhook küldési hiba:", e.message); 
    }
}


/* ==========================================================
   PROXY KONFIGURÁLÓ FÜGGVÉNY
   ========================================================== */

function getProxyConfig(proxyStr) {
    if (!proxyStr) return null;
    
    let protocol = 'http';
    let cleanStr = proxyStr;

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

    // HTTP PROXY KEZELÉS
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
   LISTA KEZELÉS
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

// Betöltjük a listát
proxyList = loadProxiesFromFile();

async function checkProxiesInBackground() {
    const rawList = loadProxiesFromFile();
    
    // Lekérjük az aktuális mastert a MongoDB-ből
    let masterDoc = await Settings.findOne({ key: 'current_master_proxy' });
    let CURRENT_MASTER_PROXY = masterDoc ? masterDoc.value : null;
    
    if (CURRENT_MASTER_PROXY && !rawList.includes(CURRENT_MASTER_PROXY)) {
        console.log("⚠️ A Master Proxyt törölték, leváltás...");
        await Settings.deleteOne({ key: 'current_master_proxy' });
    }

    proxyList = rawList;
}

/* ==========================================================
   RÉSZLETES GEO LOG LISTÁK (SZÉTBONTVA A HOSSZ MIATT)
   ========================================================== */

function formatGeoDataTeljes(geo) {
  let res = "";
  res += `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n`;
  res += `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n`;
  res += `**Típus:** ${geo.type || 'Ismeretlen'}\n`;
  res += `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n`;
  res += `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n`;
  res += `**Ország:** ${geo.country || 'Ismeretlen'}\n`;
  res += `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n`;
  res += `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n`;
  res += `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n`;
  res += `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n`;
  res += `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n`;
  res += `**Régió:** ${geo.region || 'Ismeretlen'}\n`;
  res += `**Város:** ${geo.city || 'Ismeretlen'}\n`;
  res += `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n`;
  res += `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n`;
  res += `**ASN:** ${geo.asn || 'Ismeretlen'}\n`;
  res += `**Szervezet:** ${geo.org || 'Ismeretlen'}\n`;
  res += `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n`;
  res += `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n`;
  res += `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n`;
  res += `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n`;
  res += `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n`;
  res += `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n`;
  res += `**Valuta:** ${geo.currency || 'Ismeretlen'}\n`;
  res += `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n`;
  res += `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n`;
  res += `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n`;
  res += `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`;
  return res;
}

function formatGeoDataVpn(geo) {
  let res = "";
  res += `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n`;
  res += `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n`;
  res += `**Típus:** ${geo.type || 'Ismeretlen'}\n`;
  res += `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n`;
  res += `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n`;
  res += `**Ország:** ${geo.country || 'Ismeretlen'}\n`;
  res += `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n`;
  res += `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n`;
  res += `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n`;
  res += `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n`;
  res += `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n`;
  res += `**Régió:** ${geo.region || 'Ismeretlen'}\n`;
  res += `**Város:** ${geo.city || 'Ismeretlen'}\n`;
  res += `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n`;
  res += `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n`;
  res += `**ASN:** ${geo.asn || 'Ismeretlen'}\n`;
  res += `**Szervezet:** ${geo.org || 'Ismeretlen'}\n`;
  res += `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n`;
  res += `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n`;
  res += `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n`;
  res += `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n`;
  res += `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n`;
  res += `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n`;
  res += `**Valuta:** ${geo.currency || 'Ismeretlen'}\n`;
  res += `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n`;
  res += `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n`;
  res += `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n`;
  res += `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`;
  return res;
}

function formatGeoDataReport(geo, pageUrl) {
  let res = "";
  if (pageUrl) { res += `**Oldal:** ${pageUrl}\n`; }
  res += `**IP-cím:** ${geo.ip || 'Ismeretlen'}\n`;
  res += `**Sikeres lekérdezés:** ${geo.success || 'Ismeretlen'}\n`;
  res += `**Típus:** ${geo.type || 'Ismeretlen'}\n`;
  res += `**Kontinens:** ${geo.continent || 'Ismeretlen'}\n`;
  res += `**Kontinens kód:** ${geo.continent_code || 'Ismeretlen'}\n`;
  res += `**Ország:** ${geo.country || 'Ismeretlen'}\n`;
  res += `**Országkód:** ${geo.country_code || 'Ismeretlen'}\n`;
  res += `**Ország zászló:** ${geo.country_flag || 'Ismeretlen'}\n`;
  res += `**Főváros:** ${geo.country_capital || 'Ismeretlen'}\n`;
  res += `**Ország hívószám:** ${geo.country_phone || 'Ismeretlen'}\n`;
  res += `**Szomszédos országok:** ${geo.country_neighbours || 'Ismeretlen'}\n`;
  res += `**Régió:** ${geo.region || 'Ismeretlen'}\n`;
  res += `**Város:** ${geo.city || 'Ismeretlen'}\n`;
  res += `**Szélesség:** ${geo.latitude || 'Ismeretlen'}\n`;
  res += `**Hosszúság:** ${geo.longitude || 'Ismeretlen'}\n`;
  res += `**ASN:** ${geo.asn || 'Ismeretlen'}\n`;
  res += `**Szervezet:** ${geo.org || 'Ismeretlen'}\n`;
  res += `**Hálózat:** ${geo.isp || 'Ismeretlen'}\n`;
  res += `**Időzóna:** ${geo.timezone || 'Ismeretlen'}\n`;
  res += `**Időzóna neve:** ${geo.timezone_name || 'Ismeretlen'}\n`;
  res += `**Időzóna nyári idő eltolás:** ${geo.timezone_dstOffset || 'Ismeretlen'}\n`;
  res += `**Időzóna GMT eltolás:** ${geo.timezone_gmtOffset || 'Ismeretlen'}\n`;
  res += `**Időzóna GMT:** ${geo.timezone_gmt || 'Ismeretlen'}\n`;
  res += `**Valuta:** ${geo.currency || 'Ismeretlen'}\n`;
  res += `**Valuta kód:** ${geo.currency_code || 'Ismeretlen'}\n`;
  res += `**Valuta szimbólum:** ${geo.currency_symbol || 'Ismeretlen'}\n`;
  res += `**Valuta árfolyam:** ${geo.currency_rates || 'Ismeretlen'}\n`;
  res += `**Valuta többes:** ${geo.currency_plural || 'Ismeretlen'}\n`;
  return res;
}

/* ==========================================================
   OKOS GEO LEKÉRDEZÉS (TAPADÓS LOGIKA MONGODB ALAPON)
   ========================================================== */

async function getGeo(ip) {
    
    // 1. Meglévő Master Proxy lekérése
    let masterDoc = await Settings.findOne({ key: 'current_master_proxy' });
    let currentMaster = masterDoc ? masterDoc.value : null;

    if (currentMaster) {
        const config = getProxyConfig(currentMaster);
        
        if (config) {
            try {
                config.timeout = 4000;
                
                const geo = await axios.get(
                    `https://ipwhois.app/json/${ip}`, 
                    config
                );
                
                if (geo.data && geo.data.success !== false) {
                    return geo.data;
                } else {
                    throw new Error("API Limit vagy hiba");
                }
            } catch (err) {
                console.log(`❌ Master Proxy kiesett: ${currentMaster}`);
                
                await logProxyStatus(
                    "⚠️ Proxy Csere Szükséges",
                    `**A régi master proxy meghalt:** \`${currentMaster}\`\n**Hiba:** ${err.message}`,
                    0xffa500
                );
                
                await Settings.deleteOne({ key: 'current_master_proxy' });
                currentMaster = null; 
            }
        }
    }

    // 2. Új Master keresése
    const maxRetries = 10;
    proxyList = loadProxiesFromFile();
    
    for (let i = 0; i < maxRetries; i++) {
        if (proxyList.length === 0) break;
        
        const candidate = proxyList[Math.floor(Math.random() * proxyList.length)];
        const config = getProxyConfig(candidate);
        
        if (!config) continue;

        try {
            console.log(`🔍 Tesztelés: ${candidate}...`);
            config.timeout = 4000;
            
            const geo = await axios.get(
                `https://ipwhois.app/json/${ip}`, 
                config
            );

            if (geo.data && geo.data.success !== false) {
                await Settings.findOneAndUpdate(
                    { key: 'current_master_proxy' }, 
                    { value: candidate }, 
                    { upsert: true }
                );
                
                await logProxyStatus(
                    "✅ Új Master Proxy Beállítva",
                    `Találtam egy működő proxyt: \`${candidate}\``,
                    0x00ff00
                );

                return geo.data;
            }
        } catch (err) {
            // Nem jó, megyünk a következőre
        }
    }

    // 3. Direkt lekérés (ha nincs proxy)
    try {
        console.log("⚠️ Direkt módra váltás.");
        
        await logProxyStatus(
            "🚨 MINDEN PROXY ELBUKOTT",
            "A szerver direktben kér le adatokat saját IP-ről.",
            0xff0000
        );
        
        const geo = await axios.get(
            `https://ipwhois.app/json/${ip}`, 
            { timeout: 5000 }
        );
        
        return geo.data || {};
    } catch (err) {
        return {};
    }
}

/* ==========================================================
   ANTI-SCRAPER ÉS IP BIZTONSÁG
   ========================================================== */

app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  
  const forbiddenAgents = [
      'curl', 'wget', 'python', 'libwww-perl', 'httpclient', 'axios', 
      'httrack', 'webcopier', 'cybergap', 'sqlmap', 'nmap', 'whatweb', 
      'nikto', 'paros', 'webscrab', 'netcraft', 'mj12bot', 'ahrefs', 
      'semrush', 'dotbot', 'rogue', 'go-http-client', 'zgrab', 'masscan',
      'scanner', 'postman'
  ];
  
  if (forbiddenAgents.some(bot => ua.includes(bot)) || !ua) {
      console.log(`🛑 Blokkolt Bot: ${ua} IP: ${req.ip}`);
      return res.status(403).json({
          error: "ACCESS_DENIED",
          message: "Az eszközöd le lett tiltva a SZABY rendszer által.",
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
  return normalizeIp(ip);
}

const WHITELISTED_IPS = (process.env.ALLOWED_VPN_IPS || '').split(',')
  .map(s => normalizeIp(s.trim()))
  .filter(Boolean);

const MY_IPS = (process.env.MY_IP || '').split(',')
  .map(s => normalizeIp(s.trim()))
  .filter(Boolean);


/* ==========================================================
   BAN RENDSZER FÜGGVÉNYEK (MONGODB MOTORRAL)
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
   DDoS VÉDELEM (MONGODB)
   ========================================================== */

async function ddosProtection(req, res, next) {
    const ip = getClientIp(req);
    if (MY_IPS.includes(ip) || WHITELISTED_IPS.includes(ip)) return next();

    const key = `ddos_rate_${ip}`;
    const expireAt = new Date(Date.now() + 60 * 1000); // 1 perc

    const rate = await Attempt.findOneAndUpdate(
        { ip: key },
        { $inc: { count: 1 }, $setOnInsert: { expireAt } },
        { upsert: true, new: true }
    );

    if (rate.count > 60) {
        if (!(await isPermanentBanned(ip))) {
            await banPermanentIp(ip); 
            const geo = await getGeo(ip);
            
            axios.post(REPORT_WEBHOOK || ALERT_WEBHOOK, { 
                username: "DDoS Elhárító", 
                embeds: [
                    { 
                        title: '🚨 BRUTE FORCE ÉSZLELVE!', 
                        description: `**IP:** ${ip}\n**Akció:** VÉGLEGES BAN.\n\n` + 
                                     formatGeoDataReport(geo, req.originalUrl), 
                        color: 0xff0000 
                    }
                ] 
            }).catch(()=>{});
        }
        return res.status(429).sendFile(
            path.join(__dirname, 'public', 'banned-permanent.html')
        );
    }
    next();
}

app.use(ddosProtection);


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

// ==========================================
// ÚTVONALAK (ROUTES)
// ==========================================

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

// GLOBAL BAN MIDDLEWARE
app.use(async (req, res, next) => {
  const ip = getClientIp(req);  
  if (!MY_IPS.includes(ip) && !WHITELISTED_IPS.includes(ip)) {
    if (await isIpBanned(ip)) {
        return res.status(403).sendFile(
            path.join(__dirname, 'public', 'banned-ip.html')
        );
    }
    if (await isPermanentBanned(ip)) {
        return res.status(403).sendFile(
            path.join(__dirname, 'public', 'banned-permanent.html')
        );
    }
  }
  next();  
});

// HTML NAPLÓZÓ MIDDLEWARE
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
  const geoData = await getGeo(ip);
  const vpnCheck = await isVpnProxy(ip);
  
  if (vpnCheck && !WHITELISTED_IPS.includes(ip)) {
      axios.post(ALERT_WEBHOOK, { 
          username: "VPN Figyelő", 
          embeds: [
              { 
                  title: 'VPN Blokkolva!', 
                  description: `**Oldal:** ${fullUrl}\n` + formatGeoDataVpn(geoData), 
                  color: 0xff0000 
              }
          ] 
      }).catch(() => {});
      return res.status(403).sendFile(path.join(__dirname, 'public', 'banned-vpn.html'));
  } else {
    if (!MY_IPS.includes(ip)) {
      axios.post(MAIN_WEBHOOK, { 
          username: "SZABY Logger", 
          embeds: [
              { 
                  title: 'Új látogató', 
                  description: EGYEDI_UZENET + `\n\n**Oldal:** ${fullUrl}\n` + formatGeoDataTeljes(geoData), 
                  color: 0x800080 
              }
          ] 
      }).catch(() => {});
    }
  }
  next();
});

// ==========================================
// ADMIN FELÜLET ÉS API
// ==========================================

app.get('/admin', (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="hu">
    <head><title>Admin - SZABY</title></head>
    <body style="background:#0f1115;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh">
      <div style="background:#151922;padding:30px;border-radius:15px;width:350px">
        <h2>Admin</h2>
        <form id="f">
          <input name="password" type="password" placeholder="Jelszó" style="width:100%;margin:10px 0;padding:12px">
          <input name="ip" placeholder="IP Cím" style="width:100%;margin:10px 0;padding:12px">
          <button type="submit" data-a="ban" style="width:100%;padding:12px;background:#5865F2;color:#fff">24h Ban</button>
          <button type="submit" data-a="permanent-ban" style="width:100%;padding:12px;background:#d83c3e;color:#fff;margin-top:10px">Örök Ban</button>
        </form>
        <div id="m" style="margin-top:15px"></div>
        <script>
          document.getElementById('f').addEventListener('submit',async(e)=>{
            e.preventDefault();
            const a = e.submitter.dataset.a;
            const r = await fetch('/admin/'+a+'/form',{
                method:'POST',
                body:new URLSearchParams(new FormData(e.target))
            });
            document.getElementById('m').textContent=await r.text();
          });
        </script>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/ban/form', express.urlencoded({ extended: true }), async (req, res) => { 
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).send('Hiba'); 
    await banIp(normalizeIp(req.body.ip)); 
    res.send('✅ IP tiltva (24h)'); 
});

app.post('/admin/permanent-ban/form', express.urlencoded({ extended: true }), async (req, res) => { 
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).send('Hiba'); 
    await banPermanentIp(normalizeIp(req.body.ip)); 
    res.send('✅ IP tiltva (Permanent)'); 
});

app.post('/api/biztonsagi-naplo-v1', express.json(), async (req, res) => {
  const ip = getClientIp(req);
  const { reason, page } = req.body || {};
  const geoData = await getGeo(ip); 
  const valid = [
      'Ctrl+U kombináció blokkolva (forráskód megtekintés)',
      'Ctrl+Shift+I kombináció blokkolva (fejlesztői eszközök)',
      'F12 gomb blokkolva (fejlesztői eszközök)',
      'Jobb kattintás blokkolva (kontextus menü)'
  ];

  if (!valid.some(r => (reason||'').includes(r))) {
      if (!MY_IPS.includes(ip)) {
          await banPermanentIp(ip);
          axios.post(REPORT_WEBHOOK, { 
              username: "Manipuláció", 
              embeds: [
                  { 
                      title: '⚠️ MANIPULÁLT ÜZENET!', 
                      description: `**IP:** ${ip}\n**Ok:** ${reason}\n` + formatGeoDataReport(geoData, page), 
                      color: 0xff0000 
                  }
              ] 
          }).catch(()=>{});
      }
      return res.status(403).json({ error: "BANNED" });
  }

  const count = await recordBadAttempt(ip);
  
  axios.post(ALERT_WEBHOOK, { 
      username: "Figyelő", 
      embeds: [
          { 
              title: count >= 10 ? 'IP TILTVA' : `Rossz próbálkozás (${count}/10)`, 
              description: `**IP:** ${ip}\n**Ok:** ${reason}\n` + formatGeoDataReport(geoData, page), 
              color: count >= 10 ? 0xff0000 : 0xffa500 
          }
      ] 
  }).catch(()=>{});
  
  if (count >= 10 && !WHITELISTED_IPS.includes(ip)) await banIp(ip);
  res.json({ ok: true });
});

// Statikus fájlok kiszolgálása
app.use(
    express.static(path.join(__dirname, 'public'))
);

// Számláló API
app.get('/api/counter', async (req, res) => { 
    try { 
        if (!COUNTER_API_URL) return res.status(500).json({error: 'Hiba'});
        const r = await axios.get(COUNTER_API_URL);
        res.json(r.data); 
    } catch { 
        res.status(500).json({error:'Hiba'}); 
    } 
});

// Főoldal kiszolgálása
app.get('/', (req, res) => {
    const indexPath = path.join(
        __dirname,
        'public',
        'szaby',
        'index.html'
    );
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    } else {
        return res.sendStatus(404);
    }
});

// 404 Kezelés
app.use((req, res) => {
    res.status(404).send('404 Not Found');
});

// ==========================================
// SZERVER INDÍTÁSA
// ==========================================

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Szerver elindult: http://localhost:${PORT}`);
    });
}

// VERCEL EXPORT
module.exports = app;

/* ==========================================================
   VÉGE - SZABY EXCLUSIVE 940+ SOR
   ========================================================== */
