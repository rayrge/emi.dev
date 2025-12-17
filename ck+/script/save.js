
// save.js (cleaned + auto-layout probing)
// Notes:
// - Uses robust party auto-detection (Chikorita + Sandshrew) and standard Gen2-style box parsing.
// - Keeps the original readNewbox() ONLY for Vs. Recorder mode (custom metadata+DB format).
// - Assumes global Maps exist: pokemonByPokedex, movesByIndex, itemsById, landmarksByIndex
// - Assumes global UI helpers exist: closePopup, updateBadges, updateBox, setPlayer
// - Assumes globals: box, deadBox, badges, settings

var vsRecorderStatus = 0; // 1 = connected, -1 = disconnected
var pingsWithoutResponse = 0;
var outstandingPingTimeout;

// ---------------------------
// Species IDs (standard Gen 2)
// ---------------------------
const SPEC_CHIKORITA = 0x98; // #152 (party)
const SPEC_SANDSHREW = 0x1B; // #27  (party)
const SPEC_SENTRET   = 0xA1; // #161 (box 1)

// ---------------------------
// Helpers
// ---------------------------
function arrayHas(arr, v) { return arr.indexOf(v) !== -1; }

// Find party block by matching party species list contains both species.
// Layout assumed: [count][species...][padding up to capacity][terminator?][structs...]
// This matches readPokemonList()'s expectation.
function findPartyStartBySpecies(bytes, needA, needB, capacity = 6) {
  const scanStart = 0x2000;
  const scanEnd   = Math.min(bytes.length, 0x5000);

  for (let start = scanStart; start < scanEnd; start++) {
    const count = bytes[start];
    if (count < 1 || count > capacity) continue;

    const speciesList = [];
    for (let i = 0; i < count; i++) speciesList.push(bytes[start + 1 + i]);

    if (!arrayHas(speciesList, needA) || !arrayHas(speciesList, needB)) continue;

    // Validate: first struct species should match first species in list
    const structStart = start + 1 + capacity + 1; // same as readPokemonList
    const firstStructSpecies = bytes[structStart];

    if (firstStructSpecies === speciesList[0] && pokemonByPokedex && pokemonByPokedex.has(firstStructSpecies)) {
      console.log("✅ Party start detected at", "0x" + start.toString(16), "count", count, "species", speciesList);
      return start;
    }
  }

  console.warn("❌ Party start not found (species IDs may be remapped).");
  return -1;
}

// Is a plausible Gen2-ish box header:
// [count 0..20][species list 20 bytes][optional 0xFF terminator][structs...]
function isPlausibleBoxHeader(bytes, start, capacity = 20) {
  if (start < 0 || start + 1 + capacity >= bytes.length) return false;

  const count = bytes[start];
  if (count < 0 || count > capacity) return false;

  // If count > 0, at least one of first `count` species should be valid & non-zero
  if (count > 0) {
    let validSeen = 0;
    for (let i = 0; i < count; i++) {
      const s = bytes[start + 1 + i];
      if (s !== 0 && pokemonByPokedex && pokemonByPokedex.has(s)) validSeen++;
    }
    if (validSeen === 0) return false;
  }
  return true;
}

// Find next plausible box header after `from`.
function findNextBoxHeader(bytes, from, capacity = 20, maxScan = 0x8000) {
  const end = Math.min(bytes.length - (1 + capacity), from + maxScan);
  for (let i = from; i < end; i++) {
    if (isPlausibleBoxHeader(bytes, i, capacity)) return i;
  }
  return -1;
}

// Read standard Gen2-ish PC box.
// Returns { pokemon, ok, mismatches, hasTerminator }.
function readStandardBox(bytes, start, capacity, structSize) {
  const pokemon = [];
  const count = bytes[start];

  if (count < 0 || count > capacity) {
    return { pokemon, ok: false, mismatches: count > 0 ? count : 0, hasTerminator: false };
  }

  const speciesListStart = start + 1;
  const afterSpeciesList = start + 1 + capacity;

  const hasTerminator = (bytes[afterSpeciesList] === 0xFF);
  let p = afterSpeciesList + (hasTerminator ? 1 : 0);

  let mismatches = 0;

  for (let i = 0; i < count; i++) {
    const expected = bytes[speciesListStart + i];
    const speciesId = bytes[p];
    const dexEntry = pokemonByPokedex ? pokemonByPokedex.get(speciesId) : null;

    if (!dexEntry) { mismatches++; p += structSize; continue; }
    if (expected !== 0 && expected !== speciesId) { mismatches++; p += structSize; continue; }

    // Egg check (common marker)
    if (bytes[p + 0x1D] === 0xFD) { p += structSize; continue; }

    const item = (itemsById && itemsById.has(bytes[p + 0x01])) ? itemsById.get(bytes[p + 0x01]) : "";

    const atk = (bytes[p + 0x15] & 0xF0) >> 4;
    const def = (bytes[p + 0x15] & 0x0F);
    const spe = (bytes[p + 0x16] & 0xF0) >> 4;
    const spa = (bytes[p + 0x16] & 0x0F);
    const spd = spa;
    const hp = 8 * (atk & 1) + 4 * (def & 1) + 2 * (spe & 1) + (spa & 1);

    const moves = [];
    for (let j = 0; j < 4; j++) {
      const m = bytes[p + 0x02 + j];
      if (movesByIndex && movesByIndex.has(m)) moves.push(movesByIndex.get(m).name);
    }

    const caught = bytes[p + 0x1B] & 0x7F;
    const lm = landmarksByIndex ? landmarksByIndex.get(caught) : null;
    const landmark = lm ? lm.name : "unknown";

    pokemon.push({
      name: dexEntry.name,
      // Box level is tricky in Gen2; keep legacy byte for now.
      level: bytes[p + 0x1C],
      dvs: { hp, atk, def, spa, spd, spe },
      moves,
      item,
      caught: landmark
    });

    p += structSize;
  }

  const ok = (pokemon.length > 0 && mismatches <= Math.max(2, Math.floor(count / 2)));
  return { pokemon, ok, mismatches, hasTerminator };
}

// Parse up to 16 boxes by scanning headers and selecting best structSize.
// Strong bonus if Sentret appears in parsed result (you said it's in Box 1).
function parseBoxesAuto(bytes, hintStart = 0x2000) {
  const capacity = 20;
  const structSizes = [0x2F, 0x30, 0x31]; // candidates

  const headers = [];
  let ptr = hintStart;

  for (let i = 0; i < 16; i++) {
    const h = findNextBoxHeader(bytes, ptr, capacity, 0xA000);
    if (h === -1) break;
    headers.push(h);
    ptr = h + 1;
  }

  if (headers.length === 0) {
    console.warn("❌ No box headers found.");
    return { live: [], dead: [], layout: null };
  }

  let best = { score: -1, structSize: null, live: [], dead: [] };

  for (const structSize of structSizes) {
    let live = [];
    let dead = [];
    let score = 0;
    let foundSentret = false;

    for (let i = 0; i < headers.length; i++) {
      const res = readStandardBox(bytes, headers[i], capacity, structSize);
      if (res.ok) score += 10;
      score -= res.mismatches;

      for (const p of res.pokemon) {
        if (p && p.name && p.name.toLowerCase() === "sentret") foundSentret = true;
      }

      if (i >= 12) dead = dead.concat(res.pokemon);
      else live = live.concat(res.pokemon);
    }

    if (foundSentret) score += 25;

    const uniq = new Set(live.map(p => p.name)).size;
    if (uniq >= 3) score += 10;
    if (live.length >= 10) score += 5;

    if (score > best.score) best = { score, structSize, live, dead };
  }

  console.log("📦 Box parse chosen:", { structSize: best.structSize, score: best.score, boxesFound: headers.length });
  return { live: best.live, dead: best.dead, layout: { structSize: best.structSize, headers } };
}

// ---------------------------
// Original custom "Newbox" parser (kept for Vs. Recorder mode)
// ---------------------------
function readNewbox(bytes, start, db1, db2) {
  var pokemon = [];
  var banks = [];

  // Read bank bitfield (24 bits)
  for (var i = 0; i < 3; i++) {
    var b = bytes[start + 0x15 + i];
    for (var j = 0; j < 8; j++) {
      banks.push((b & 1) === 1);
      b >>= 1;
    }
  }

  for (var i = 0; i < 20; i++) {
    var b = bytes[start + i];
    if (b === 0) continue;
    b--; // Convert 1-based index to 0-based

    var p = banks[i] ? db2 : db1;
    p += b * 0x2F;

    if (bytes[p + 0x1D] === 0xFD) continue; // Egg

    const speciesId = bytes[p];
    const dexEntry = pokemonByPokedex ? pokemonByPokedex.get(speciesId) : null;
    if (!dexEntry) continue;

    var item = (itemsById && itemsById.has(bytes[p + 0x01])) ? itemsById.get(bytes[p + 0x01]) : "";

    var atk = (bytes[p + 0x15] & 0xF0) >> 4;
    var def = (bytes[p + 0x15] & 0x0F);
    var spe = (bytes[p + 0x16] & 0xF0) >> 4;
    var spa = (bytes[p + 0x16] & 0x0F);
    var spd = spa;
    var hp = 8 * (atk & 1) + 4 * (def & 1) + 2 * (spe & 1) + (spa & 1);

    var moves = [];
    for (var j = 0; j < 4; j++) {
      var move = bytes[p + 0x02 + j];
      if (movesByIndex && movesByIndex.has(move)) moves.push(movesByIndex.get(move).name);
    }

    var caught = bytes[p + 0x1B] & 0x7F;
    var landmark = landmarksByIndex ? landmarksByIndex.get(caught) : null;
    landmark = landmark ? landmark.name : "unknown";

    pokemon.push({
      name: dexEntry.name,
      level: bytes[p + 0x1C],
      dvs: { hp, atk, def, spa, spd, spe },
      moves: moves,
      item: item,
      caught: landmark
    });
  }

  return pokemon;
}

// ---------------------------
// Party parser (your existing logic, with guards)
// ---------------------------
function readPokemonList(bytes, start, capacity, increment) {
  var count = bytes[start];

  if (count < 0 || count > capacity) {
    console.warn("Invalid party count:", count, "at", start);
    return [];
  }

  var p = start + 1;

  var species = [];
  for (var i = 0; i < count; i++) {
    species.push(bytes[p + i]);
  }

  // Move pointer to struct list
  p += capacity + 1;

  var pokemon = [];

  for (var i = 0; i < count; i++) {
    const speciesId = bytes[p];
    const dexEntry = pokemonByPokedex ? pokemonByPokedex.get(speciesId) : null;

    if (!dexEntry) { p += increment; continue; }
    if (speciesId !== species[i]) { p += increment; continue; }

    var item = (itemsById && itemsById.has(bytes[p + 0x01])) ? itemsById.get(bytes[p + 0x01]) : "";

    var atk = (bytes[p + 0x15] & 0xF0) >> 4;
    var def = (bytes[p + 0x15] & 0x0F);
    var spe = (bytes[p + 0x16] & 0xF0) >> 4;
    var spa = (bytes[p + 0x16] & 0x0F);
    var spd = spa;
    var hp = 8 * (atk & 1) + 4 * (def & 1) + 2 * (spe & 1) + (spa & 1);

    var moves = [];
    for (var j = 0; j < 4; j++) {
      var move = bytes[p + 0x02 + j];
      if (movesByIndex && movesByIndex.has(move)) moves.push(movesByIndex.get(move).name);
    }

    var caught = bytes[p + 0x1E] & 0x7F;
    var landmark = landmarksByIndex ? landmarksByIndex.get(caught) : null;
    landmark = landmark ? landmark.name : "unknown";

    pokemon.push({
      name: dexEntry.name,
      level: bytes[p + 0x1F],
      dvs: { hp, atk, def, spa, spd, spe },
      moves: moves,
      item: item,
      caught: landmark
    });

    p += increment;
  }

  return pokemon;
}

// ---------------------------
// Badge + UI helpers (unchanged)
// ---------------------------
function parseBadges(badgeMask) {
  badges = 0;
  for (var i = 0; i < 16; i++) {
    if ((badgeMask & 1) === 1) badges++;
    badgeMask >>= 1;
  }
  document.getElementById("badges").value = badges;
  updateBadges();
}

function finishParse(title, pokemon, deadPokemon) {
  if (box.length > 0) setPlayer(0);
  updateBox();

  var popup = '<div onclick="closePopup()" class="save-success">' + title;
  popup += '<lb></lb>Encounters: ' + pokemon.length;
  if (deadPokemon.length > 0) popup += ' (+' + deadPokemon.length + ' fainted)';
  popup += '<lb></lb>Badges: ' + badges;
  popup += '</div>';

  document.getElementById("info-popup").innerHTML = popup;
}

// ---------------------------
// File reader (main save parsing)
// ---------------------------
function readFile(file) {
  var reader = new FileReader();
  reader.onload = function (e) {
    var bytes = new Uint8Array(e.target.result);

    // JSON support (unchanged behavior)
    if (file && file.name && file.name.endsWith(".json")) {
      try {
        var text = new TextDecoder().decode(bytes);
        JSON.parse(text);
        localStorage.setItem("calc/custom-data", text);
        document.getElementById("info-popup").innerHTML =
          '<div onclick="closePopup()" class="save-success">Successfully parsed JSON<lb></lb>Loaded as custom game</div>';
      } catch (err) {
        console.log(err);
        document.getElementById("info-popup").innerHTML =
          '<div onclick="closePopup()" class="save-error">Error while parsing JSON!<lb></lb>See console for details</div>';
      }
      return;
    }

    if (bytes.length <= 32000) {
      document.getElementById("info-popup").innerHTML =
        '<div onclick="closePopup()" class="save-error">File doesn\\'t appear to be a save file!<lb></lb>Name should end with .sav</div>';
      return;
    }

    try {
      var pokemon = [];
      var deadPokemon = [];

      // 1) Party auto-detect (Chikorita + Sandshrew are in party)
      const partyStart = findPartyStartBySpecies(bytes, SPEC_CHIKORITA, SPEC_SANDSHREW, 6);
      if (partyStart === -1) {
        document.getElementById("info-popup").innerHTML =
          '<div onclick="closePopup()" class="save-error">Could not locate party data automatically.<lb></lb>(If species IDs are remapped, update SPEC_* constants.)</div>';
        return;
      }
      pokemon = pokemon.concat(readPokemonList(bytes, partyStart, 6, 48));

      // 2) Boxes auto-parse (Sentret is in box 1; used as a scoring bonus)
      const boxes = parseBoxesAuto(bytes, 0x2D0C);
      pokemon = pokemon.concat(boxes.live);
      deadPokemon = deadPokemon.concat(boxes.dead);

      box = pokemon;
      deadBox = deadPokemon;

      // 3) Badges (still uses your current guess; adjust later if needed)
      parseBadges((bytes[0x2057] << 8) | bytes[0x2058]);

      finishParse("Successfully parsed save!", pokemon, deadPokemon);
    } catch (err) {
      console.log(err);
      document.getElementById("info-popup").innerHTML =
        '<div onclick="closePopup()" class="save-error">Error while parsing save!<lb></lb>See console for details</div>';
    }
  };
  reader.readAsArrayBuffer(file);
}

// ---------------------------
// Vs. Recorder helpers (unchanged)
// ---------------------------
function hexToBytes(hex) {
  var bytes = [];
  for (var c = 0; c < hex.length; c += 2) bytes.push(parseInt(hex.substr(c, 2), 16));
  return bytes;
}

function vsRecorderComplete(event) {
  try {
    connectToVsRecorder();
    var response = event.target.responseText;
    var values = [...response.matchAll(/(\w+)\:\s*(.+)/g)];
    var obj = {};
    for (const v of values) obj[v[1]] = v[2];

    var pokemon = [];
    var deadPokemon = [];

    pokemon = pokemon.concat(readPokemonList(hexToBytes(obj.Party), 0, 6, 48));

    var newboxBytes = hexToBytes(obj.NewboxMetadata);
    var db1 = newboxBytes.length;
    newboxBytes = newboxBytes.concat(hexToBytes(obj.NewboxDatabase1));
    var db2 = newboxBytes.length;
    newboxBytes = newboxBytes.concat(hexToBytes(obj.NewboxDatabase2));

    for (var i = 0; i < 16; i++) {
      var l = readNewbox(newboxBytes, 0x00 + i * 0x21, db1, db2);
      if (i >= 12) deadPokemon = deadPokemon.concat(l);
      else pokemon = pokemon.concat(l);
    }

    box = pokemon;
    deadBox = deadPokemon;

    var inventoryBytes = hexToBytes(obj.InventoryData);
    parseBadges((inventoryBytes[0x0F] << 8) | inventoryBytes[0x10]);

    finishParse("Successfully read Vs. Recorder!", pokemon, deadPokemon);
  } catch (e) {
    console.log(e);
    document.getElementById("info-popup").innerHTML =
      '<div onclick="closePopup()" class="save-error">Error while parsing Vs. Recorder!<lb></lb>See console for details</div>';
  }
}

function vsRecorderFailed(event) {
  console.log(event);
  document.getElementById("info-popup").innerHTML =
    '<div onclick="closePopup()" class="save-error">Request for data failed!<lb></lb>Is Vs. Recorder running?</div>';
}

function updateVsRecorder() {
  var req = new XMLHttpRequest();
  req.addEventListener("load", vsRecorderComplete);
  req.addEventListener("error", vsRecorderFailed);
  req.addEventListener("abort", vsRecorderFailed);
  req.open("GET", "http://localhost:31123/update");
  req.send();
}

function vsRecorderPingComplete(event) {
  connectToVsRecorder();
  clearTimeout(outstandingPingTimeout);
}

function vsRecorderPingFailed(event) {
  clearTimeout(outstandingPingTimeout);
}

function pingVsRecorder() {
  var req = new XMLHttpRequest();
  req.addEventListener("load", vsRecorderPingComplete);
  req.addEventListener("error", vsRecorderPingFailed);
  req.addEventListener("abort", vsRecorderPingFailed);
  req.open("GET", "http://localhost:31123/ping");
  req.send();
  outstandingPingTimeout = setTimeout(function() {
    vsRecorderPingFailed(null);
    req.abort();
  }, 1000);
}

function connectToVsRecorder() {
  pingsWithoutResponse = 0;
  if (vsRecorderStatus !== 1) {
    vsRecorderStatus = 1;
    document.getElementById("update-vs-recorder").classList.remove("vs-recorder-polling");
    document.getElementById("update-vs-recorder").classList.remove("vs-recorder-disconnected");
  }
}

setInterval(function() {
  if (!settings.enableVsRecorder) return;
  if ((pingsWithoutResponse & (pingsWithoutResponse - 1)) === 0) pingVsRecorder();
  pingsWithoutResponse++;
  if (pingsWithoutResponse >= 3) {
    if (vsRecorderStatus !== -1) {
      vsRecorderStatus = -1;
      document.getElementById("update-vs-recorder").classList.remove("vs-recorder-polling");
      document.getElementById("update-vs-recorder").classList.add("vs-recorder-disconnected");
    }
  }
}, 1000);

connectToVsRecorder();
