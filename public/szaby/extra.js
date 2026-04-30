// ==========================================
// 1. BILLENTYŰKOMBINÁCIÓK ÉS JOBB KLIKK TILTÁSA
// ==========================================

// Figyeli a leütött billentyűket és blokkolja a tiltott kombinációkat
document.addEventListener("keydown", event => {
  // Forráskód megtekintése (Ctrl+U)
  if ((event.ctrlKey || event.metaKey) && event.key === "u") {
    event.preventDefault(); // Esemény megállítása
    jelentsdBiztonsagiEsemenyt("Ctrl+U kombináció blokkolva (forráskód megtekintés)");
  }
  // Fejlesztői eszközök (Ctrl+Shift+I)
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "I") {
    event.preventDefault();
    jelentsdBiztonsagiEsemenyt("Ctrl+Shift+I kombináció blokkolva (fejlesztői eszközök)");
  }
  // Fejlesztői konzol (Ctrl+Shift+J)
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "J") {
    event.preventDefault();
    jelentsdBiztonsagiEsemenyt("Ctrl+Shift+J kombináció blokkolva (fejlesztői konzol)");
  }
  // Fejlesztői eszközök (F12)
  if (event.key === "F12") {
    event.preventDefault();
    jelentsdBiztonsagiEsemenyt("F12 gomb blokkolva (fejlesztői eszközök)");
  }
  // Oldal mentése (Ctrl+S)
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    jelentsdBiztonsagiEsemenyt("Ctrl+S kombináció blokkolva (oldal mentése)");
  }
  // Oldal nyomtatása (Ctrl+P)
  if ((event.ctrlKey || event.metaKey) && event.key === "p") {
    event.preventDefault();
    jelentsdBiztonsagiEsemenyt("Ctrl+P kombináció blokkolva (oldal nyomtatása)");
  }
});

// Jobb gombos kattintás (kontextus menü) blokkolása
document.addEventListener("contextmenu", event => {
  event.preventDefault();
  jelentsdBiztonsagiEsemenyt("Jobb kattintás blokkolva (kontextus menü)");
});

// ==========================================
// 2. BIZTONSÁGI ESEMÉNYEK NAPLÓZÁSA A SZERVEREN
// ==========================================

// Ez a függvény küldi el a tiltott gombnyomásokat a server.js-nek (Discord logoláshoz)
function jelentsdBiztonsagiEsemenyt(ok) {
  const jelenlegiOldal = window.location.pathname; // Melyik aloldalon történt
  
  // Összeállítjuk az adatcsomagot
  const kuldendoAdat = {
    reason: ok,
    page: jelenlegiOldal
  };

  // Elküldjük a te saját szerverednek (POST kérés)
  fetch("/api/biztonsagi-naplo-v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(kuldendoAdat)
  })
  .then(valasz => valasz.json())
  .then(adat => {
    // Ha be vagy jelentkezve saját IP-vel, esetleg kiír valamit a konzolba
    console.log("Rendszer válasza:", adat);
  })
  .catch(hiba => {
    // Ha hiba van, csendben ignorálja, hogy a látogató ne vegye észre
  });
}

// ==========================================
// 3. ÜDVÖZLŐ / FIGYELMEZTETŐ ABLAK KEZELÉSE
// ==========================================

// Amikor a felhasználó rákattint az "Elfogadom" / "Belépés" gombra
document.getElementById("acceptBtn").onclick = function () {
  document.getElementById("blockModal").style.display = "none"; // Ablak eltüntetése
  document.getElementById("audio").play(); // Háttérzene indítása
};

// ==========================================
// 4. FEJLESZTŐI ESZKÖZÖK (DEVTOOLS) DETEKTÁLÁSA
// ==========================================

// Eldönti, hogy asztali gépről van-e szó (768px-nél szélesebb képernyő)
// Mobilon nincs értelme a DevTools detektálásnak, ott nem lehet kinyitni
function asztaliNezet() {
  return window.innerWidth > 768;
}

if (asztaliNezet()) {
  // Másodpercenként ellenőrzi a böngészőablak méreteit
  setInterval(() => {
    const turesHatar = 160; // Ha 160 pixelnél nagyobb a különbség a belső és külső méret között
    
    // Ha a böngésző teljes mérete (outer) és a weboldal látható mérete (inner) között nagy a differencia,
    // az azt jelenti, hogy a látogató megnyitotta a fejlesztői panelt oldalt vagy alul!
    if (window.outerWidth - window.innerWidth > turesHatar || window.outerHeight - window.innerHeight > turesHatar) {
      
      // Büntetés: Azonnal elnavigálja az oldalról!
      window.location.href = "https://www.google.com/hibaoldal.html"; 
      
      // TIPP: A google.com helyett átirányíthatod a saját hibaoldaladra is, például:
      // window.location.href = "/banned-ip.html";
    }
  }, 1000);
}
