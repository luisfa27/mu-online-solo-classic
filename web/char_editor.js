/**
 * MU Online Solo Classic - Character IDE & Save Studio (.musav)
 * Visual Save Editor directly integrated into the game interface.
 */

(function () {
  'use strict';

  var VAULT_MAGIC = "MUSAV1";
  var VAULT_SECRET = "MU_ONLINE_SOLO_CLASSIC_097K_WASM_VAULT_KEY";
  var VAULT_SALT = new Uint8Array([
    0x4D, 0x55, 0x5F, 0x53, 0x4F, 0x4C, 0x4F, 0x5F,
    0x53, 0x41, 0x4C, 0x54, 0x30, 0x39, 0x37, 0x4B
  ]);

  var cachedCryptoKey = null;
  var currentRawFiles = null;   // Decrypted files map { filename: base64 }
  var currentContainer = null;  // Outer vault container metadata
  var currentActiveChar = null; // Currently selected character name
  var currentRealm = 0;

  var MAP_PRESETS = [
    { id: 0, name: "Lorencia", x: 125, y: 125 },
    { id: 1, name: "Dungeon", x: 108, y: 247 },
    { id: 2, name: "Devias", x: 220, y: 25 },
    { id: 3, name: "Noria", x: 175, y: 115 },
    { id: 4, name: "Lost Tower", x: 208, y: 75 },
    { id: 7, name: "Atlans", x: 24, y: 19 },
    { id: 8, name: "Tarkan", x: 187, y: 58 },
    { id: 10, name: "Icarus", x: 15, y: 13 }
  ];

  var CLASS_MAP = {
    0:  { name: "Dark Wizard (DW)", tier: 1, baseClass: "DW" },
    1:  { name: "Soul Master (SM)", tier: 2, baseClass: "DW" },
    16: { name: "Dark Knight (DK)", tier: 1, baseClass: "DK" },
    17: { name: "Blade Knight (BK)", tier: 2, baseClass: "DK" },
    32: { name: "Fairy Elf (FE)", tier: 1, baseClass: "Elf" },
    33: { name: "Muse Elf (ME)", tier: 2, baseClass: "Elf" },
    48: { name: "Magic Gladiator (MG)", tier: 2, baseClass: "MG" }
  };

  // =========================================================================
  // Cryptography Engine (Native Web Crypto API)
  // =========================================================================

  async function getVaultKey() {
    if (cachedCryptoKey) return cachedCryptoKey;
    var enc = new TextEncoder();
    var keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(VAULT_SECRET),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    cachedCryptoKey = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: VAULT_SALT,
        iterations: 10000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    return cachedCryptoKey;
  }

  async function decryptSaveContainer(container) {
    if (!container) throw new Error("Container de save vazio ou inválido.");

    // Formato legado cru
    if (!container.magic && typeof container === 'object') {
      return container;
    }

    if (container.magic !== VAULT_MAGIC) {
      throw new Error("Formato inválido (magic header incompatível: " + container.magic + ")");
    }

    // Não criptografado (salvo em contexto sem SSL/HTTP)
    if (container.encrypted === false) {
      var binary = atob(container.payload);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    }

    // Criptografia AES-GCM
    var key = await getVaultKey();
    var cipherBinary = atob(container.payload);
    var cipherBytes = new Uint8Array(cipherBinary.length);
    for (var j = 0; j < cipherBinary.length; j++) {
      cipherBytes[j] = cipherBinary.charCodeAt(j);
    }

    var ivBinary = atob(container.iv);
    var iv = new Uint8Array(ivBinary.length);
    for (var k = 0; k < ivBinary.length; k++) {
      iv[k] = ivBinary.charCodeAt(k);
    }

    var decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      key,
      cipherBytes
    );

    var jsonStr = new TextDecoder().decode(decryptedBuffer);
    return JSON.parse(jsonStr);
  }

  async function encryptSaveFiles(rawFiles) {
    var fileCount = Object.keys(rawFiles).length;
    var hasSubtle = typeof window !== 'undefined' && window.crypto && window.crypto.subtle;

    if (!hasSubtle) {
      var jsonStrPlain = JSON.stringify(rawFiles);
      var encPlain = new TextEncoder().encode(jsonStrPlain);
      var binPlain = '';
      for (var p = 0; p < encPlain.length; p++) binPlain += String.fromCharCode(encPlain[p]);
      return {
        magic: VAULT_MAGIC,
        version: 1,
        encrypted: false,
        algorithm: "plain-base64",
        timestamp: Date.now(),
        filesCount: fileCount,
        payload: btoa(binPlain)
      };
    }

    var key = await getVaultKey();
    var jsonStr = JSON.stringify(rawFiles);
    var encoded = new TextEncoder().encode(jsonStr);
    var iv = window.crypto.getRandomValues(new Uint8Array(12));

    var ciphertextBuffer = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      key,
      encoded
    );

    var cipherBytes = new Uint8Array(ciphertextBuffer);
    var hashBuffer = await window.crypto.subtle.digest("SHA-256", cipherBytes);
    var hashHex = Array.from(new Uint8Array(hashBuffer))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');

    var cipherBinary = '';
    for (var i = 0; i < cipherBytes.length; i++) cipherBinary += String.fromCharCode(cipherBytes[i]);

    var ivBinary = '';
    for (var k = 0; k < iv.length; k++) ivBinary += String.fromCharCode(iv[k]);

    return {
      magic: VAULT_MAGIC,
      version: 1,
      encrypted: true,
      algorithm: "AES-GCM-256",
      timestamp: Date.now(),
      filesCount: fileCount,
      iv: btoa(ivBinary),
      checksum: hashHex,
      payload: btoa(cipherBinary)
    };
  }

  function b64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    var binary = '';
    var len = bytes.length;
    for (var i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // =========================================================================
  // Character Binary Parser & Writer
  // Struct: SDHP_CHARACTER_INFO_SAVE_SEND (1308 bytes) + SOLO_CHARACTER_EXTENSION (8 bytes)
  // =========================================================================

  function parseCharData(bytes) {
    if (!bytes || bytes.length < 100) return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Read Character Name (offset 19, 11 bytes)
    var nameBytes = [];
    for (var i = 0; i < 11; i++) {
      var b = bytes[19 + i];
      if (b === 0) break;
      nameBytes.push(b);
    }
    var name = String.fromCharCode.apply(null, nameBytes) || "Character";

    var level = view.getUint16(30, true);
    var classCode = view.getUint8(32);
    // Auto-normalize legacy/glitched class codes
    if (classCode === 2) classCode = 32;
    if (classCode === 18) classCode = 33;
    var levelUpPoint = view.getUint32(36, true);
    var experience = view.getUint32(40, true);
    var money = view.getUint32(44, true);

    var strength = view.getUint32(48, true);
    var dexterity = view.getUint32(52, true);
    var vitality = view.getUint32(56, true);
    var energy = view.getUint32(60, true);

    var life = view.getUint32(64, true);
    var maxLife = view.getUint32(68, true);
    var mana = view.getUint32(72, true);
    var maxMana = view.getUint32(76, true);
    var bp = view.getUint32(80, true);
    var maxBp = view.getUint32(84, true);

    var map = view.getUint8(1028);
    var x = view.getUint8(1029);
    var y = view.getUint8(1030);
    var dir = view.getUint8(1031);

    var pkCount = view.getUint32(1032, true);
    var pkLevel = view.getUint32(1036, true);
    var pkTime = view.getUint32(1040, true);

    var reset = 0;
    var grandReset = 0;
    if (bytes.length >= 1312) {
      reset = view.getUint32(1308, true);
    }
    if (bytes.length >= 1316) {
      grandReset = view.getUint32(1312, true);
    }

    return {
      rawBytes: bytes,
      name: name,
      level: level,
      classCode: classCode,
      levelUpPoint: levelUpPoint,
      experience: experience,
      money: money,
      strength: strength,
      dexterity: dexterity,
      vitality: vitality,
      energy: energy,
      life: life,
      maxLife: maxLife,
      mana: mana,
      maxMana: maxMana,
      bp: bp,
      maxBp: maxBp,
      map: map,
      x: x,
      y: y,
      dir: dir,
      pkCount: pkCount,
      pkLevel: pkLevel,
      pkTime: pkTime,
      reset: reset,
      grandReset: grandReset
    };
  }

  function serializeCharData(charObj) {
    var raw = charObj.rawBytes;
    // Ensure buffer has at least 1316 bytes for extension
    if (raw.length < 1316) {
      var expanded = new Uint8Array(1316);
      expanded.set(raw);
      raw = expanded;
    }

    var view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    view.setUint16(30, charObj.level, true);
    view.setUint8(32, charObj.classCode);
    view.setUint32(36, charObj.levelUpPoint, true);
    view.setUint32(40, charObj.experience, true);
    view.setUint32(44, charObj.money, true);

    view.setUint32(48, charObj.strength, true);
    view.setUint32(52, charObj.dexterity, true);
    view.setUint32(56, charObj.vitality, true);
    view.setUint32(60, charObj.energy, true);

    view.setUint32(64, charObj.life, true);
    view.setUint32(68, charObj.maxLife, true);
    view.setUint32(72, charObj.mana, true);
    view.setUint32(76, charObj.maxMana, true);
    view.setUint32(80, charObj.bp, true);
    view.setUint32(84, charObj.maxBp, true);

    view.setUint8(1028, charObj.map);
    view.setUint8(1029, charObj.x);
    view.setUint8(1030, charObj.y);
    view.setUint8(1031, charObj.dir);

    view.setUint32(1032, charObj.pkCount, true);
    view.setUint32(1036, charObj.pkLevel, true);
    view.setUint32(1040, charObj.pkTime, true);

    // Extension: Reset & GrandReset
    view.setUint32(1308, charObj.reset, true);
    view.setUint32(1312, charObj.grandReset, true);

    return raw;
  }

  function syncAccountCharacterHeader(rawFiles, charName, level, classCode) {
    for (var fname in rawFiles) {
      if (fname.startsWith("account_") && fname.endsWith(".dat")) {
        var accBytes = b64ToBytes(rawFiles[fname]);
        var accView = new DataView(accBytes.buffer, accBytes.byteOffset, accBytes.byteLength);
        var charCount = accBytes[11] || 0;
        if (charCount > 5) charCount = 5;

        for (var i = 0; i < charCount; i++) {
          var charOffset = 12 + i * 76;
          var nameArr = [];
          for (var j = 0; j < 11; j++) {
            var b = accBytes[charOffset + j];
            if (b === 0) break;
            nameArr.push(b);
          }
          var entryName = String.fromCharCode.apply(null, nameArr);
          if (entryName === charName) {
            accView.setUint16(charOffset + 12, level, true);
            accBytes[charOffset + 14] = classCode;
            break;
          }
        }
        rawFiles[fname] = bytesToB64(accBytes);
      }
    }
  }

  // =========================================================================
  // UI Controller & Modal View
  // =========================================================================

  function getActiveRealmKey() {
    var r = 0;
    try {
      if (typeof window.currentRealm !== 'undefined') r = window.currentRealm;
    } catch (e) {}
    return "mu_solo_realm_" + r + "_vault";
  }

  function listCharactersInSaves(rawFiles) {
    var list = [];
    if (!rawFiles) return list;
    for (var fname in rawFiles) {
      if (fname.startsWith("char_") && fname.endsWith(".dat")) {
        var charBytes = b64ToBytes(rawFiles[fname]);
        var parsed = parseCharData(charBytes);
        if (parsed) {
          list.push({
            filename: fname,
            name: parsed.name,
            level: parsed.level,
            classCode: parsed.classCode,
            parsed: parsed
          });
        }
      }
    }
    return list;
  }

  window.muOpenCharEditor = async function () {
    var modal = document.getElementById('muEditorModal');
    if (!modal) return;

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    await window.muLoadEditorActiveSave();
  };

  window.muCloseCharEditor = function () {
    var modal = document.getElementById('muEditorModal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  };

  window.muLoadEditorActiveSave = async function () {
    setEditorStatus("Carregando dados do save ativo...", "#60a5fa");
    try {
      var key = getActiveRealmKey();
      var rawJson = localStorage.getItem(key);
      if (!rawJson) {
        setEditorStatus("Nenhum save encontrado para o reino ativo. Crie um char no jogo primeiro!", "#f59e0b");
        return;
      }
      var container = JSON.parse(rawJson);
      currentContainer = container;
      currentRawFiles = await decryptSaveContainer(container);

      var charList = listCharactersInSaves(currentRawFiles);
      populateCharSelector(charList);

      if (charList.length > 0) {
        selectCharacterForEdit(charList[0].name);
        setEditorStatus("Save carregado com sucesso (" + charList.length + " personagem(ns))", "#34d399");
      } else {
        setEditorStatus("Save carregado, mas nenhum personagem foi criado ainda.", "#fbbf24");
      }
    } catch (err) {
      console.error("[CharEditor] Load error:", err);
      setEditorStatus("Erro ao abrir save: " + err.message, "#ef4444");
    }
  };

  function setEditorStatus(msg, color) {
    var el = document.getElementById('muEditorStatus');
    if (el) {
      el.textContent = msg;
      el.style.color = color || '#94a3b8';
    }
  }

  function populateCharSelector(charList) {
    var sel = document.getElementById('muEditCharSelect');
    if (!sel) return;
    sel.innerHTML = '';

    if (charList.length === 0) {
      var optEmpty = document.createElement('option');
      optEmpty.textContent = "Nenhum char encontrado";
      sel.appendChild(optEmpty);
      return;
    }

    charList.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.name;
      var className = (CLASS_MAP[c.classCode] && CLASS_MAP[c.classCode].name) || "Classe " + c.classCode;
      opt.textContent = c.name + " (Lv " + c.level + " - " + className + ")";
      sel.appendChild(opt);
    });
  }

  function selectCharacterForEdit(charName) {
    if (!currentRawFiles) return;
    var fname = "char_" + charName + ".dat";
    if (!currentRawFiles[fname]) return;

    currentActiveChar = charName;
    var bytes = b64ToBytes(currentRawFiles[fname]);
    var c = parseCharData(bytes);
    if (!c) return;

    // Fill UI inputs
    setValue('muEdName', c.name);
    setValue('muEdLevel', c.level);
    setValue('muEdClass', c.classCode);
    setValue('muEdPoints', c.levelUpPoint);
    setValue('muEdExp', c.experience);
    setValue('muEdZen', c.money);

    setValue('muEdStr', c.strength);
    setValue('muEdAgi', c.dexterity);
    setValue('muEdVit', c.vitality);
    setValue('muEdEne', c.energy);

    setValue('muEdLife', c.life);
    setValue('muEdMaxLife', c.maxLife);
    setValue('muEdMana', c.mana);
    setValue('muEdMaxMana', c.maxMana);

    setValue('muEdResets', c.reset);
    setValue('muEdGrandResets', c.grandReset);
    setValue('muEdPKLevel', c.pkLevel);
    setValue('muEdMap', c.map);
    setValue('muEdCoordX', c.x);
    setValue('muEdCoordY', c.y);

    updateClassBadge(c.classCode);
  }

  function setValue(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val !== undefined ? val : '';
  }

  function getValue(id, defaultVal) {
    var el = document.getElementById(id);
    if (!el) return defaultVal;
    var n = parseInt(el.value, 10);
    return isNaN(n) ? defaultVal : n;
  }

  function updateClassBadge(code) {
    var badge = document.getElementById('muEdClassBadge');
    var info = CLASS_MAP[code];
    if (badge) {
      badge.textContent = info ? info.name : "Desconhecido";
    }
  }

  // =========================================================================
  // Saving, Applying & Exporting
  // =========================================================================

  window.muApplyAndSaveCharEditor = async function () {
    if (!currentRawFiles || !currentActiveChar) {
      setEditorStatus("Nenhum personagem selecionado para salvar.", "#ef4444");
      return;
    }

    setEditorStatus("Aplicando alterações e criptografando...", "#60a5fa");
    try {
      var fname = "char_" + currentActiveChar + ".dat";
      var bytes = b64ToBytes(currentRawFiles[fname]);
      var c = parseCharData(bytes);

      // Collect values from UI
      c.level = Math.max(1, Math.min(400, getValue('muEdLevel', 1)));
      c.classCode = getValue('muEdClass', c.classCode);
      c.levelUpPoint = Math.max(0, getValue('muEdPoints', 0));
      c.experience = Math.max(0, getValue('muEdExp', 0));
      c.money = Math.max(0, Math.min(2000000000, getValue('muEdZen', 0)));

      c.strength = Math.max(1, Math.min(65535, getValue('muEdStr', 18)));
      c.dexterity = Math.max(1, Math.min(65535, getValue('muEdAgi', 18)));
      c.vitality = Math.max(1, Math.min(65535, getValue('muEdVit', 15)));
      c.energy = Math.max(1, Math.min(65535, getValue('muEdEne', 15)));

      c.life = Math.max(1, getValue('muEdLife', 100));
      c.maxLife = Math.max(1, getValue('muEdMaxLife', 100));
      c.mana = Math.max(1, getValue('muEdMana', 50));
      c.maxMana = Math.max(1, getValue('muEdMaxMana', 50));

      c.reset = Math.max(0, getValue('muEdResets', 0));
      c.grandReset = Math.max(0, getValue('muEdGrandResets', 0));
      c.pkLevel = getValue('muEdPKLevel', 3);
      if (c.pkLevel === 3) c.pkCount = 0; // Se normal/limpo, zera mortes

      c.map = Math.max(0, Math.min(30, getValue('muEdMap', 0)));
      c.x = Math.max(0, Math.min(255, getValue('muEdCoordX', 125)));
      c.y = Math.max(0, Math.min(255, getValue('muEdCoordY', 125)));

      // Serialize back to binary
      var updatedBytes = serializeCharData(c);
      currentRawFiles[fname] = bytesToB64(updatedBytes);

      // Sync account header (level & class) for character select screen preview
      syncAccountCharacterHeader(currentRawFiles, currentActiveChar, c.level, c.classCode);

      // Re-encrypt package with AES-256-GCM + SHA-256
      var newContainer = await encryptSaveFiles(currentRawFiles);
      var key = getActiveRealmKey();
      localStorage.setItem(key, JSON.stringify(newContainer));

      setEditorStatus("✅ Salvo com sucesso no navegador! Recarregando jogo...", "#34d399");

      if (window.muShowToast) {
        window.muShowToast("Personagem editado com sucesso! Recarregando...");
      }

      setTimeout(function () {
        window.location.reload();
      }, 1200);

    } catch (err) {
      console.error("[CharEditor] Save error:", err);
      setEditorStatus("Erro ao salvar: " + err.message, "#ef4444");
    }
  };

  window.muDownloadEditedSave = async function () {
    if (!currentRawFiles) {
      setEditorStatus("Nenhum save carregado para baixar.", "#ef4444");
      return;
    }
    setEditorStatus("Gerando arquivo .musav...", "#60a5fa");
    try {
      var newContainer = await encryptSaveFiles(currentRawFiles);
      var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(newContainer, null, 2));
      var dlAnchor = document.createElement('a');
      dlAnchor.setAttribute("href", dataStr);
      dlAnchor.setAttribute("download", "mu_solo_edited_save.musav");
      document.body.appendChild(dlAnchor);
      dlAnchor.click();
      dlAnchor.remove();
      setEditorStatus("✅ Arquivo .musav baixado com sucesso!", "#34d399");
    } catch (err) {
      setEditorStatus("Erro ao baixar: " + err.message, "#ef4444");
    }
  };

  window.muHandleEditorFileUpload = function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = async function (evt) {
      try {
        var parsed = JSON.parse(evt.target.result);
        currentContainer = parsed;
        currentRawFiles = await decryptSaveContainer(parsed);
        var charList = listCharactersInSaves(currentRawFiles);
        populateCharSelector(charList);
        if (charList.length > 0) {
          selectCharacterForEdit(charList[0].name);
          setEditorStatus("Arquivo importado: " + file.name + " (" + charList.length + " chars)", "#34d399");
        }
      } catch (err) {
        setEditorStatus("Erro ao ler arquivo: " + err.message, "#ef4444");
      }
    };
    reader.readAsText(file);
  };

  // Quick stat helpers
  window.muEdAddStat = function (id, amount) {
    var val = getValue(id, 0);
    setValue(id, Math.min(65535, val + amount));
  };

  window.muEdSetMax = function (id, maxVal) {
    setValue(id, maxVal);
  };

  window.muEdApplyPresetMap = function (presetIdx) {
    var p = MAP_PRESETS[presetIdx];
    if (p) {
      setValue('muEdMap', p.id);
      setValue('muEdCoordX', p.x);
      setValue('muEdCoordY', p.y);
    }
  };

  // Setup DOM Event Listeners when DOM is ready
  function initEvents() {
    var btnEditor = document.getElementById('muBtnEditor');
    if (btnEditor) {
      btnEditor.addEventListener('click', function (e) {
        e.preventDefault();
        window.muOpenCharEditor();
      });
    }

    var closeBtn = document.getElementById('muEditorCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', window.muCloseCharEditor);
    }

    var backdrop = document.getElementById('muEditorBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', window.muCloseCharEditor);
    }

    var selChar = document.getElementById('muEditCharSelect');
    if (selChar) {
      selChar.addEventListener('change', function () {
        selectCharacterForEdit(this.value);
      });
    }

    var selClass = document.getElementById('muEdClass');
    if (selClass) {
      selClass.addEventListener('change', function () {
        updateClassBadge(parseInt(this.value, 10));
      });
    }

    var fileInput = document.getElementById('muEditorFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', window.muHandleEditorFileUpload);
    }

    var btnUpload = document.getElementById('muBtnEditorUpload');
    if (btnUpload && fileInput) {
      btnUpload.addEventListener('click', function (e) {
        e.preventDefault();
        fileInput.value = '';
        fileInput.click();
      });
    }

    var btnReload = document.getElementById('muBtnEditorReload');
    if (btnReload) {
      btnReload.addEventListener('click', function (e) {
        e.preventDefault();
        window.muLoadEditorActiveSave();
      });
    }

    var btnSave = document.getElementById('muBtnEditorSave');
    if (btnSave) {
      btnSave.addEventListener('click', function (e) {
        e.preventDefault();
        window.muApplyAndSaveCharEditor();
      });
    }

    var btnDownload = document.getElementById('muBtnEditorDownload');
    if (btnDownload) {
      btnDownload.addEventListener('click', function (e) {
        e.preventDefault();
        window.muDownloadEditedSave();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEvents);
  } else {
    initEvents();
  }

})();
