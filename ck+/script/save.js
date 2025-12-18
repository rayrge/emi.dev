var vsRecorderStatus = 0; // 1 = connected, -1 = disconnected
var pingsWithoutResponse = 0;
var outstandingPingTimeout;

function popcount8(x) {
  x &= 0xFF;
  x = x - ((x >>> 1) & 0x55);
  x = (x & 0x33) + ((x >>> 2) & 0x33);
  return (((x + (x >>> 4)) & 0x0F) * 0x01) & 0xFF;
}

function looksLikeMon(bytes, p) {
  if (p < 0 || p + 0x20 >= bytes.length) return -10;

  const species = bytes[p];
  const lvl = bytes[p + 0x1F];
  const m0 = bytes[p + 0x02], m1 = bytes[p + 0x03], m2 = bytes[p + 0x04], m3 = bytes[p + 0x05];

  let score = 0;

  if (species !== 0) score += 2; else score -= 3;

  if (lvl >= 1 && lvl <= 100) score += 3;
  else if (lvl === 0) score -= 1;
  else score -= 3;

  const nz = (m0 !== 0) + (m1 !== 0) + (m2 !== 0) + (m3 !== 0);
  if (nz >= 1) score += 1;
  if (nz >= 2) score += 1;
  if (nz === 0) score -= 2;

  // “moves in a sane range” heuristic (tweak if your hack uses >250 move ids)
  const okMoves =
    (m0 === 0 || (m0 >= 1 && m0 <= 250)) &&
    (m1 === 0 || (m1 >= 1 && m1 <= 250)) &&
    (m2 === 0 || (m2 >= 1 && m2 <= 250)) &&
    (m3 === 0 || (m3 >= 1 && m3 <= 250));
  score += okMoves ? 1 : -2;

  return score;
}

function readBankBit(bytes, boxMetaStart, slotIndex) {
  // banks are 3 bytes at +0x14, least-significant-bit first, exactly like your code
  const b = bytes[boxMetaStart + 0x14 + ((slotIndex / 8) | 0)];
  return ((b >>> (slotIndex & 7)) & 1) === 1;
}

function scoreLayout(bytes, metaStart, db1, db2, stride) {
  // sample a subset for speed; you can expand once it finds a top candidate
  const boxesToCheck = 8;      // 0..7 (first half)
  const slotsToCheck = 20;     // all slots
  let score = 0;
  let refs = 0;

  for (let bi = 0; bi < boxesToCheck; bi++) {
    const boxStart = metaStart + bi * 0x21;

    // quick bounds
    if (boxStart + 0x21 >= bytes.length) return -1e9;

    // bank bit sanity: number of set bits should roughly match number of nonzero indices
    let nonzero = 0;
    const bank0 = bytes[boxStart + 0x14], bank1 = bytes[boxStart + 0x15], bank2 = bytes[boxStart + 0x16];
    const bankBits = popcount8(bank0) + popcount8(bank1) + popcount8(bank2);

    for (let si = 0; si < slotsToCheck; si++) {
      const idx = bytes[boxStart + si];
      if (idx === 0) continue;
      nonzero++;

      const inDb2 = readBankBit(bytes, boxStart, si);
      const base = inDb2 ? db2 : db1;
      const p = base + (idx - 1) * stride;

      score += looksLikeMon(bytes, p);
      refs++;
    }

    // Encourage bank bitfield that matches occupancy
    score -= Math.abs(bankBits - nonzero);
  }

  // normalize (avoid preferring layouts that only “explain” 1 mon)
  if (refs < 8) return -1e9;
  return score / refs;
}

function findNewboxLayout(bytes) {
  const strides = [0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32];
  let best = { score: -1e9, metaStart: 0, db1: 0, db2: 0, stride: 0 };

  // Coarse scan (fast-ish). Adjust ranges if you know your hack’s SRAM regions.
  for (let metaStart = 0; metaStart < bytes.length - 16 * 0x21; metaStart += 1) {
    // quick reject: first box should have at least 2 nonzero indices usually
    let nz = 0;
    for (let i = 0; i < 20; i++) if (bytes[metaStart + i] !== 0) nz++;
    if (nz < 2) continue;

    for (const stride of strides) {
      // db bases: aligned guesses (0x20). You can widen or narrow.
      for (let db1 = 0; db1 < bytes.length - 0x400; db1 += 0x20) {
        for (let db2 = 0; db2 < bytes.length - 0x400; db2 += 0x20) {
          const s = scoreLayout(bytes, metaStart, db1, db2, stride);
          if (s > best.score) best = { score: s, metaStart, db1, db2, stride };
        }
      }
    }
  }

  return best;
}


function readNewbox(bytes, start, db1, db2) {
	var pokemon = [];
	var banks = [];
	for (var i = 0; i < 3; i++) {
		var b = bytes[start + 0x14 + i];
		for (var j = 0; j < 8; j++) {
			banks.push((b & 1) == 1);
			b >>= 1;
		}
	}
	for (var i = 0; i < 20; i++) {
		var b = bytes[start + i];
		if (b == 0) {
			continue;
		}
		b--;
		var p = db1;
		if (banks[i]) {
			p = db2;
		}
		p += b * stride;
		if (bytes[p + 0x1d] == 0xfd) { // Egg
			continue;
		}
		var item = bytes[p + 0x01];
		if (itemsById.has(item)) {
			item = itemsById.get(item);
		} else {
			item = "";
		}
		var atk = (bytes[p + 0x15] & 0xf0) >> 4;
		var def = (bytes[p + 0x15] & 0x0f);
		var spe = (bytes[p + 0x16] & 0xf0) >> 4;
		var spa = (bytes[p + 0x16] & 0x0f);
		var spd = spa
		var hp = 8 * (atk & 0b1) + 4 * (def & 0b1) + 2 * (spe & 0b1) + (spa & 0b1);
		var moves = [];
		for (var j = 0; j < 4; j++) {
			var move = bytes[p + 0x02 + j];
			if (movesByIndex.has(move)) {
				moves.push(movesByIndex.get(move).name);
			}
		}
		var caught = bytes[p + 0x1B] & 0b0111_1111;
		var landmark = landmarksByIndex.get(caught);
		if (!landmark) {
			landmark = "unknown";
		} else {
			landmark = landmark.name;
		}
		pokemon.push({
			name: pokemonByPokedex.get(bytes[p]).name,
			level: bytes[p + 0x1f],
			dvs: {
				"hp": hp,
				"atk": atk,
				"def": def,
				"spa": spa,
				"spd": spd,
				"spe": spe
			},
			"moves": moves,
			"item": item,
			"caught": landmark
		});
	}
	return pokemon;
}


function findPartyOffset(bytes) {
  const candidates = [];
  for (let off = 0; off < Math.min(bytes.length, 0x8000) - 400; off++) {
    const count = bytes[off];
    if (count < 1 || count > 6) continue;

    // species list sanity
    let ok = true;
    for (let i = 0; i < count; i++) {
      const s = bytes[off + 1 + i];
      if (s === 0 || s === 0xFF) { ok = false; break; }
    }
    if (!ok) continue;

    const monStart = off + 1 + 6 + 1;
    for (let i = 0; i < count; i++) {
      const s = bytes[off + 1 + i];
      if (bytes[monStart + i * 48] !== s) { ok = false; break; }
    }
    if (ok) candidates.push(off);
  }

  if (candidates.length === 0) return -1;

  // In your saves, the active one consistently shows up at the higher address (e.g. 0x286B)
  return Math.max(...candidates);
}

function readPokemonList(bytes, start, capacity, increment) {
	var count = bytes[start];
	var p = start + 1;
	var species = [];
	for (var i = 0; i < count; i++) {
		species.push(bytes[p + i]);
	}
	/* Terminator was broken for a patch
	if (bytes[p + count] != 0xff) {
		return;
	}*/
	p += capacity + 1;
	var pokemon = [];
	for (var i = 0; i < count; i++) {
		species[i].level = bytes[p + 0x1f];
		if (bytes[p] != species[i]) { // Mismatching species or egg
			continue;
		}
		var item = bytes[p + 0x01];
		if (itemsById.has(item)) {
			item = itemsById.get(item);
		} else {
			item = "";
		}
		var atk = (bytes[p + 0x15] & 0xf0) >> 4;
		var def = (bytes[p + 0x15] & 0x0f);
		var spe = (bytes[p + 0x16] & 0xf0) >> 4;
		var spa = (bytes[p + 0x16] & 0x0f);
		var spd = spa
		var hp = 8 * (atk & 0b1) + 4 * (def & 0b1) + 2 * (spe & 0b1) + (spa & 0b1);
		var moves = [];
		for (var j = 0; j < 4; j++) {
			var move = bytes[p + 0x02 + j];
			if (movesByIndex.has(move)) {
				moves.push(movesByIndex.get(move).name);
			}
		}
		var caught = bytes[p + 0x1E] & 0b0111_1111;
		var landmark = landmarksByIndex.get(caught);
		if (!landmark) {
			landmark = "unknown";
		} else {
			landmark = landmark.name;
		}
		pokemon.push({
			name: pokemonByPokedex.get(bytes[p]).name,
			level: bytes[p + 0x1f],
			dvs: {
				"hp": hp,
				"atk": atk,
				"def": def,
				"spa": spa,
				"spd": spd,
				"spe": spe
			},
			"moves": moves,
			"item": item,
			"caught": landmark
		});
		p += increment;
	}
	return pokemon;
}

function parseBadges(badgeMask) {
	badges = 0;
	for (var i = 0; i < 16; i++) {
		if ((badgeMask & 1) == 1) {
			badges++;
		}
		badgeMask >>= 1;
	}
	document.getElementById("badges").value = badges;
	updateBadges();
}

function finishParse(title, pokemon, deadPokemon) {
	if (box.length > 0) {
		setPlayer(0);
	}
	updateBox();
	var popup = '<div onclick="closePopup()" class="save-success">' + title;
	popup += '<lb></lb>Encounters: ' + pokemon.length;
	if (deadPokemon.length > 0) {
		popup += ' (+' + deadPokemon.length + ' fainted)';
	}
	popup += '<lb></lb>Badges: ' + badges;
	popup += '</div>';
	document.getElementById("info-popup").innerHTML = popup;
}

function readFile(file) {
	var reader = new FileReader();
	reader.onload = function (e) {
		var bytes = new Uint8Array(e.target.result);
		if (bytes.length >= 0x8000) {
			try {
				var pokemon = [];
				var deadPokemon = [];
				const partyOff = findPartyOffset(bytes);
				pokemon = pokemon.concat(readPokemonList(bytes, partyOff, 6, 48));
				const layout = findNewboxLayout(bytes);
				console.log("newbox layout", layout);

				for (let i = 0; i < 16; i++) {
					const l = readNewbox(bytes, layout.metaStart + i * 0x21, layout.db1, layout.db2, layout.stride);
					if (i >= 12) {
						deadPokemon = deadPokemon.concat(l);
					} else {
						pokemon = pokemon.concat(l);
					}
				}
				box = pokemon;
				deadBox = deadPokemon;
				parseBadges((bytes[0x23e5] << 8) | bytes[0x23e6]);
				finishParse("Successfully parsed save!", pokemon, deadPokemon);
			} catch (e) {
				console.log(e);
				document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">Error while parsing save!<lb></lb>Is this a valid file?<lb></lb>See console for details</div>';
			}
		} else {
			if (file.name.endsWith(".json")) {
				try {
					var text = new TextDecoder().decode(bytes);
					var j = JSON.parse(text);
					localStorage.setItem("calc/custom-data", text);
					document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-success">Successfully parsed JSON<lb></lb>Loaded as custom game</div>';
				} catch (e) {
					console.log(e);
					document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">Error while parsing JSON!<lb></lb>Is this a valid file?<lb></lb>See console for details</div>';
				}
				return;
			}
			console.log("File doesn't appear to be a save file!");
			console.log(bytes[0x2008]);
			console.log(bytes[0x2d0f]);
			document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">File doesn\'t appear to be a save file!<lb></lb>Name should end with .sav</div>';
		}
	};
	reader.readAsArrayBuffer(file);
}

function hexToBytes(hex) {
    var bytes = [];
    for (var c = 0; c < hex.length; c += 2) {
        bytes.push(parseInt(hex.substr(c, 2), 16));
    }
    return bytes;
}

function vsRecorderComplete(event) {
	try {
		connectToVsRecorder();
		var response = event.target.responseText;
		var values = [...response.matchAll(/(\w+)\:\s*(.+)/g)];
		var obj = {}
		for (const v of values) {
			obj[v[1]] = v[2]
		}
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
			if (i >= 12) {
				deadPokemon = deadPokemon.concat(l);
			} else {
				pokemon = pokemon.concat(l);
			}
		}
		box = pokemon;
		deadBox = deadPokemon;
		var inventoryBytes = hexToBytes(obj.InventoryData);
		parseBadges((inventoryBytes[0x0F] << 8) | inventoryBytes[0x10]);
		finishParse("Successfully read Vs. Recorder!", pokemon, deadPokemon);
	} catch (e) {
		console.log(e);
		document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">Error while parsing Vs. Recorder!<lb></lb>See console for details</div>';
	}
}

function vsRecorderFailed(event) {
	console.log(event);
	document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">Request for data failed!<lb></lb>Is Vs. Recorder running?</div>';
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
	if (vsRecorderStatus != 1) {
		vsRecorderStatus = 1;
		document.getElementById("update-vs-recorder").classList.remove("vs-recorder-polling");
		document.getElementById("update-vs-recorder").classList.remove("vs-recorder-disconnected");
	}
}

setInterval(function() {
	if (!settings.enableVsRecorder) {
		return;
	}
	if ((pingsWithoutResponse & (pingsWithoutResponse - 1)) == 0) {
		pingVsRecorder();
	}
	pingsWithoutResponse++;
	if (pingsWithoutResponse >= 3) {
		if (vsRecorderStatus != -1) {
			vsRecorderStatus = -1;
			document.getElementById("update-vs-recorder").classList.remove("vs-recorder-polling");
			document.getElementById("update-vs-recorder").classList.add("vs-recorder-disconnected");
		}
	}
}, 1000);
connectToVsRecorder();