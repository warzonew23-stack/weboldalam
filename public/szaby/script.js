// ==========================================
// 1. EGYEDI EGÉRKURZOR BEÁLLÍTÁSAI
// ==========================================
const cursor = document.getElementById("custom-cursor");

// Kurzor mozgatása az egérrel
document.addEventListener("mousemove", event => {
  cursor.style.left = event.clientX + "px";
  cursor.style.top = event.clientY + "px";
});

// Kattintás effektus
document.addEventListener("mousedown", () => cursor.classList.add("clicking"));
document.addEventListener("mouseup", () => cursor.classList.remove("clicking"));

// Kurzor stílusának megváltoztatása, ha gombra vagy linkre viszed
document.querySelectorAll("a, button, input").forEach(element => {
  element.addEventListener("mouseenter", () => cursor.classList.add("hovering"));
  element.addEventListener("mouseleave", () => cursor.classList.remove("hovering"));
});

// ==========================================
// 2. BIZTONSÁG ÉS VÉDELEM (Lopásgátló)
// ==========================================
// Jobb klikk tiltása
document.addEventListener("contextmenu", event => event.preventDefault());

// F12, Ctrl+Shift+I, Ctrl+U stb. tiltása
document.addEventListener("keydown", event => {
  if (event.key === "F12" || (event.ctrlKey && event.shiftKey && (event.key === "I" || event.key === "J")) || (event.ctrlKey && event.key === "u")) {
    event.preventDefault();
  }
});

// Képek és elemek "húzásának" (drag) tiltása
document.addEventListener("dragstart", function (event) {
  event.preventDefault();
  return false;
});

// ==========================================
// 3. 3D CSILLAGOS HÁTTÉR (THREE.JS)
// ==========================================
const initSpace = () => {
  const canvasContainer = document.getElementById("starfield-canvas");
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x50505, 0.002); // Köd effekt

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 10;

  const renderer = new THREE.WebGLRenderer({ alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvasContainer.appendChild(renderer.domElement);

  const geometry = new THREE.BufferGeometry();
  const vertices = [];

  // Csillagok generálása
  for (let i = 0; i < 18000; i++) {
    vertices.push((Math.random() - 0.5) * 600);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));

  const material = new THREE.PointsMaterial({
    color: 0xaaaaaa,
    size: 0.7
  });

  const stars = new THREE.Points(geometry, material);
  scene.add(stars);

  // Animáció ciklus
  function animate() {
    requestAnimationFrame(animate);
    const positions = geometry.attributes.position.array;
    
    // Csillagok mozgatása közeledő hatás eléréséhez
    for (let i = 0; i < 6000; i++) {
      positions[i * 3 + 2] += 2; // Z tengelyen mozog
      if (positions[i * 3 + 2] > 50) {
        positions[i * 3 + 2] = -400; // Ha kimegy a képből, visszateszi hátra
      }
    }
    geometry.attributes.position.needsUpdate = true;
    stars.rotation.z += 0.002; // Enyhe forgás
    
    renderer.render(scene, camera);
  }
  animate();

  // Reszponzív ablakméret
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
};

// ==========================================
// 4. SEGÉDFÜGGVÉNYEK (Idő formázó)
// ==========================================
function formatTime(seconds) {
  if (isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

// ==========================================
// 5. DISCORD / LANYARD API (Élő státusz)
// ==========================================
const DISCORD_ID = "1095731086513930260"; // IDE ÍRD A SAJÁT DISCORD ID-DAT!
let discordHandle = "Szaby";
let gameStartTime = null;
let spotifyData = null;
let lastKnownActivityHTML = "";

async function updateData() {
  try {
    const response = await fetch("https://api.lanyard.rest/v1/users/" + DISCORD_ID);
    const data = await response.json();
    
    if (data.success) {
      const lanyardData = data.data;
      const discordUser = lanyardData.discord_user;
      
      // Név és Avatar beállítása
      discordHandle = discordUser.username + (discordUser.discriminator !== "0" ? "#" + discordUser.discriminator : "");
      document.getElementById("d-name").innerText = discordUser.global_name || discordUser.username;
      document.getElementById("d-avatar").src = "https://cdn.discordapp.com/avatars/" + DISCORD_ID + "/" + discordUser.avatar + ".png";
      
      // Állapot (Online, Idle, Dnd, Offline) színei
      const statusColors = {
        online: "#22c55e",
        idle: "#eab308",
        dnd: "#ef4444",
        offline: "#6b7280"
      };
      document.getElementById("d-status-dot").style.backgroundColor = statusColors[lanyardData.discord_status] || "#6b7280";
      
      // Egyedi státusz (Custom status)
      const customStatusActivity = lanyardData.activities.find(activity => activity.type === 4);
      let customStatusText = customStatusActivity ? customStatusActivity.state || "Online" : lanyardData.discord_status.toUpperCase();
      document.getElementById("d-custom-status").innerText = customStatusText;
      
      // Aktivitások (Játék és Spotify) HTML generálása
      let activityHTML = "";
      
      // Játék figyelése
      const gameActivity = lanyardData.activities.find(activity => activity.type === 0 || activity.type === 1);
      if (gameActivity) {
        if (!gameStartTime || (gameActivity.timestamps?.start && gameActivity.timestamps.start !== gameStartTime)) {
          gameStartTime = gameActivity.timestamps?.start || null;
        }
        let gameImage = gameActivity.assets?.large_image ? 
                        gameActivity.assets.large_image.startsWith("mp:") ? 
                        gameActivity.assets.large_image.replace(/mp:external\/([^\/]*)\/(https?)(:|\/)/, "$2:/") : 
                        "https://cdn.discordapp.com/app-assets/" + gameActivity.application_id + "/" + gameActivity.assets.large_image + ".png" : 
                        "https://placehold.co/50x50/000/fff?text=GAME";
                        
        activityHTML += `
                <div class="activity-item game">
                    <img src="${gameImage}" class="w-10 h-10 rounded bg-gray-800 object-cover">
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-white truncate">${gameActivity.name}</p>
                        <p class="text-[10px] text-[#00f3ff] truncate">${gameActivity.state || "Játékban"}</p>
                        <p id="game-timer-display" class="text-[10px] text-gray-400 font-mono mt-1">...</p>
                    </div>
                    <i class="fas fa-gamepad text-[#00f3ff]"></i>
                </div>`;
      } else {
        gameStartTime = null;
      }
      
      // Spotify figyelése
      if (lanyardData.listening_to_spotify) {
        spotifyData = lanyardData.spotify;
        activityHTML += `
                <div class="activity-item spotify" data-song-id="${spotifyData.track_id}">
                    <div class="flex items-center gap-3">
                        <img src="${spotifyData.album_art_url}" class="w-10 h-10 rounded bg-gray-800 object-cover">
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-white truncate">${spotifyData.song}</p>
                            <p class="text-[10px] text-[#1db954] truncate">${spotifyData.artist}</p>
                        </div>
                        <i class="fab fa-spotify text-[#1db954]"></i>
                    </div>
                    <div class="spotify-bar-container">
                        <div id="discord-spotify-bar" class="spotify-bar-fill"></div>
                    </div>
                    <div class="spotify-time-labels">
                        <span id="discord-spotify-curr">0:00</span>
                        <span id="discord-spotify-end">0:00</span>
                    </div>
                </div>`;
      } else {
        spotifyData = null;
      }
      
      // Ha nincs semmilyen aktivitás
      if (activityHTML === "") {
        activityHTML = '<div class="py-2 text-center text-xs text-gray-500 italic">Jelenleg inaktív...</div>';
      }
      
      // Csak akkor frissítjük a HTML-t, ha változott valami (hogy ne villogjon)
      let shouldUpdateHTML = true;
      if (lastKnownActivityHTML === activityHTML) shouldUpdateHTML = false;
      
      const existingSpotifyElement = document.querySelector(".activity-item.spotify");
      if (existingSpotifyElement && lanyardData.listening_to_spotify && existingSpotifyElement.getAttribute("data-song-id") === lanyardData.spotify.track_id && lastKnownActivityHTML === activityHTML) {
        shouldUpdateHTML = false;
      }
      
      if (shouldUpdateHTML) {
        document.getElementById("activity-list").innerHTML = activityHTML;
        lastKnownActivityHTML = activityHTML;
      }
    }
  } catch (error) {
    console.log(error);
  }
}

// 1 Másodperces frissítő ciklus (Óra, Játék idő, Spotify csík)
setInterval(() => {
  // Helyi idő
  document.getElementById("local-clock").innerText = new Date().toLocaleTimeString("hu-HU");
  
  // Játék időzítő frissítése
  if (gameStartTime) {
    const elapsedSeconds = Math.floor((Date.now() - gameStartTime) / 1000);
    const gameTimerElement = document.getElementById("game-timer-display");
    if (gameTimerElement) {
      gameTimerElement.innerText = formatTime(elapsedSeconds) + " ideje";
    }
  }
  
  // Spotify folyamatjelző frissítése
  if (spotifyData) {
    const spotifyStart = spotifyData.timestamps.start;
    const spotifyEnd = spotifyData.timestamps.end;
    const now = Date.now();
    
    if (spotifyEnd > spotifyStart) {
      const totalDuration = spotifyEnd - spotifyStart;
      const currentProgress = now - spotifyStart;
      const progressPercent = Math.min((currentProgress / totalDuration) * 100, 100);
      
      const progressBar = document.getElementById("discord-spotify-bar");
      const currTimeEl = document.getElementById("discord-spotify-curr");
      const endTimeEl = document.getElementById("discord-spotify-end");
      
      if (progressBar) progressBar.style.width = progressPercent + "%";
      if (currTimeEl) currTimeEl.innerText = formatTime(currentProgress / 1000);
      if (endTimeEl) endTimeEl.innerText = formatTime(totalDuration / 1000);
    }
  }
}, 1000);

// Discord név másolása gombnyomásra
function copyDiscord() {
  navigator.clipboard.writeText(discordHandle).then(() => alert("Discord név másolva!")).catch(() => {});
}

// ==========================================
// 6. ZENELEJÁTSZÓ
// ==========================================
const playlist = [
  { title: "UP DOWN", artist: "Dyce", src: "https://files.catbox.moe/o0rcu1.mp3" },
  { title: "Night Drift", artist: "SYSTEM", src: "https://commondatastorage.googleapis.com/codeskulptor-demos/riceracer_assets/music/race2.ogg" },
  { title: "Ambient Core", artist: "LOFI", src: "https://commondatastorage.googleapis.com/codeskulptor-demos/pyman_assets/ateapill.ogg" }
];
let trackIdx = 0;
const audio = document.getElementById("bg-music");

function loadTrack(index) {
  const track = playlist[index];
  audio.src = track.src;
  document.getElementById("track-title").innerText = track.title;
  document.getElementById("track-artist").innerText = track.artist;
}

// Lejátszás / Szünet
document.getElementById("play-btn").addEventListener("click", () => {
  const playBtn = document.getElementById("play-btn");
  if (audio.paused) {
    audio.play();
    playBtn.innerHTML = '<i class="fas fa-pause"></i>';
  } else {
    audio.pause();
    playBtn.innerHTML = '<i class="fas fa-play"></i>';
  }
});

// Következő zeneszám
document.getElementById("next-btn").addEventListener("click", () => {
  trackIdx = (trackIdx + 1) % playlist.length;
  loadTrack(trackIdx);
  audio.play();
});

// Előző zeneszám
document.getElementById("prev-btn").addEventListener("click", () => {
  trackIdx = (trackIdx - 1 + playlist.length) % playlist.length;
  loadTrack(trackIdx);
  audio.play();
});

// Zene folyamatjelző frissítése
audio.addEventListener("timeupdate", () => {
  if (audio.duration) {
    const progressPercent = (audio.currentTime / audio.duration) * 100;
    document.getElementById("music-bar").style.width = progressPercent + "%";
    document.getElementById("current-time").innerText = formatTime(audio.currentTime);
    document.getElementById("total-time").innerText = formatTime(audio.duration);
  }
});

// Hangerőszabályzó
audio.volume = 0.2;
document.getElementById("volume-slider").addEventListener("input", event => audio.volume = event.target.value);

// ==========================================
// 7. LÁTOGATÓ SZÁMLÁLÓ (KAPCSOLAT A SERVER.JS-EL)
// ==========================================
function countVisitor() {
  fetch("/api/counter")
    .then(response => response.json())
    .then(data => document.getElementById("visit-count").innerText = data.count)
    .catch(() => {});
}

// ==========================================
// 8. OLDAL INDÍTÁSA (BELÉPÉS KÉPERNYŐ)
// ==========================================
window.onload = () => {
  initSpace(); // 3D Háttér indítása
  updateData(); // Discord adatok lekérése
  setInterval(updateData, 5000); // Discord adatok frissítése 5 másodpercenként
  loadTrack(0); // Első zene betöltése
  
  // Kattintás a belépéshez gombra
  document.getElementById("start-btn").addEventListener("click", () => {
    const welcomeOverlay = document.getElementById("welcome-overlay");
    welcomeOverlay.style.opacity = "0";
    setTimeout(() => welcomeOverlay.remove(), 500); // 0.5mp múlva eltűnik
    
    countVisitor(); // Számláló növelése
    
    audio.play().then(() => {
      document.getElementById("play-btn").innerHTML = '<i class="fas fa-pause"></i>';
    });
  });
};
