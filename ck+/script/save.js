var vsRecorderStatus = 0; // 1 = connected, -1 = disconnected
var pingsWithoutResponse = 0;
var outstandingPingTimeout;

function readNewbox(bytes, start, db1, db2) {
	// "Newbox" metadata reader.
	// Some ROM variants move the databases; readFile() will try to auto-detect db1/db2.
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
		var p = (banks[i] ? db2 : db1) + b * 0x32;
		if (p < 0 || p + 0x32 > bytes.length) {
			continue;
		}

		// Egg
		if (bytes[p + 0x1d] == 0xfd) {
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
		var spd = spa;
		var hp = 8 * (atk & 0b1) + 4 * (def & 0b1) + 2 * (spe & 0b1) + (spa & 0b1);

		var moves = [];
		for (var j = 0; j < 4; j++) {
			var move = bytes[p + 0x02 + j];
			if (movesByIndex.has(move)) {
				moves.push(movesByIndex.get(move).name);
			}
		}

		// Caught location offset varies; try both.
		var caught = bytes[p + 0x1B] & 0b0111_1111;
		if (caught === 0 || caught === 0x7F) {
			caught = bytes[p + 0x1E] & 0b0111_1111;
		}

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


function readPokemonList(bytes, start, capacity, increment) {
	// Gen 2 party/box list style reader.
	// Many hacks keep the 48-byte party struct but may have a broken terminator or non-standard padding.
	var count = bytes[start];
	if (count > capacity) {
		count = capacity;
	}
	var p = start + 1;

	// Read species list.
	var species = [];
	for (var i = 0; i < count; i++) {
		species.push(bytes[p + i]);
	}
	// Skip the (usually) fixed-width species list area + 1 terminator byte.
	// Some hacks don't place 0xFF at the usual spot; we intentionally do not enforce it.
	p += capacity + 1;

	var pokemon = [];
	for (var i = 0; i < count; i++) {
		// If data doesn't line up, skip (egg or mismatch).
		if (bytes[p] != species[i]) {
			p += increment;
			continue;
		}

		// Egg check (common in many Gen2 structs)
		if (bytes[p + 0x1d] == 0xfd) {
			p += increment;
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
		var spd = spa;
		var hp = 8 * (atk & 0b1) + 4 * (def & 0b1) + 2 * (spe & 0b1) + (spa & 0b1);

		var moves = [];
		for (var j = 0; j < 4; j++) {
			var move = bytes[p + 0x02 + j];
			if (movesByIndex.has(move)) {
				moves.push(movesByIndex.get(move).name);
			}
		}

		// Caught location varies across formats; try the common offsets.
		var caughtRaw = bytes[p + 0x1E];
		if (caughtRaw === 0 || caughtRaw === 0xFF) {
			caughtRaw = bytes[p + 0x1B];
		}
		caughtRaw = caughtRaw & 0b0111_1111;

		var landmark = landmarksByIndex.get(caughtRaw);
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

	function scorePartyAt(bytes, start) {
		if (start < 0 || start + 0x200 >= bytes.length) return -1;
		var count = bytes[start];
		if (count < 1 || count > 6) return -1;

		// Species list is usually right after count (padded to 6), with structs after 6+terminator bytes.
		var species = [];
		for (var i = 0; i < count; i++) species.push(bytes[start + 1 + i]);

		var p = start + 1 + 6 + 1;
		var ok = 0;
		for (var i = 0; i < count; i++) {
			if (p + 0x30 > bytes.length) break;
			var sp = bytes[p];
			var lvl = bytes[p + 0x1f];
			if (sp == species[i] && lvl >= 1 && lvl <= 100) ok++;
			p += 0x30;
		}
		return ok / count;
	}

	function findBestPartyOffset(bytes) {
		// Most Gen2 saves put party around the 0x2800 region in bank 0,
		// but hacks can shift it a bit. Scan a small window and pick the best match.
		var best = { off: 0x286B, score: -1 };
		var startMin = 0x2600;
		var startMax = 0x2A00;
		for (var off = startMin; off <= startMax; off++) {
			var s = scorePartyAt(bytes, off);
			if (s > best.score) best = { off: off, score: s };
			if (best.score >= 0.99) break; // perfect
		}
		return best.off;
	}

	function tryParseNewbox(bytes, metaStart, db1, db2) {
		var pokemon = [];
		var deadPokemon = [];
		for (var i = 0; i < 16; i++) {
			var l = readNewbox(bytes, metaStart + i * 0x21, db1, db2);
			if (i >= 12) deadPokemon = deadPokemon.concat(l);
			else pokemon = pokemon.concat(l);
		}
		return { pokemon: pokemon, deadPokemon: deadPokemon };
	}

	function autodetectNewbox(bytes) {
		// Heuristic search for Newbox: try likely metadata locations and database bases.
		var metaCandidates = [0x2D16, 0x2D00, 0x2C00, 0x2E00, 0x2F00, 0x3000];
		var dbBases = [0x0000, 0x2000, 0x4000, 0x5000, 0x6000];
		var dbDiffs = [0x2000, 0x1800, 0x1000, 0x2800];

		var best = null;

		for (var mc = 0; mc < metaCandidates.length; mc++) {
			var metaStart = metaCandidates[mc];
			if (metaStart < 0 || metaStart + 16 * 0x21 > bytes.length) continue;

			for (var bi = 0; bi < dbBases.length; bi++) {
				for (var di = 0; di < dbDiffs.length; di++) {
					var db1 = dbBases[bi];
					var db2 = db1 + dbDiffs[di];
					if (db2 >= bytes.length) continue;

					var parsed = tryParseNewbox(bytes, metaStart, db1, db2);

					// Basic sanity: if we got at least a few mons with sane levels, consider it.
					var sane = 0;
					for (var k = 0; k < parsed.pokemon.length; k++) {
						var lv = parsed.pokemon[k].level;
						if (lv >= 1 && lv <= 100) sane++;
					}
					var score = sane + parsed.pokemon.length * 0.1;

					if (best === null || score > best.score) {
						best = { score: score, metaStart: metaStart, db1: db1, db2: db2, parsed: parsed };
					}
				}
			}
		}

		// If nothing looks reasonable, return null.
		if (best === null || best.parsed.pokemon.length < 3) {
			return null;
		}
		return best.parsed;
	}

	reader.onload = function (e) {
		var bytes = new Uint8Array(e.target.result);

		// Trim common emulator footers (some .sav files are 0x8000 + small RTC/footer)
		if (bytes.length > 0x8000) {
			bytes = bytes.slice(0, 0x8000);
		}

		if (bytes.length >= 0x8000) {
			try {
				var pokemon = [];
				var deadPokemon = [];

				// Party: auto-detect offset.
				var partyStart = findBestPartyOffset(bytes);
				pokemon = pokemon.concat(readPokemonList(bytes, partyStart, 6, 48));

				// Boxes: try Newbox (if present in this ROM). If it doesn't look valid, fall back to party-only.
				var newbox = autodetectNewbox(bytes);
				if (newbox) {
					pokemon = pokemon.concat(newbox.pokemon);
					deadPokemon = deadPokemon.concat(newbox.deadPokemon);
				}

				box = pokemon;
				deadBox = deadPokemon;

				// Badges: keep old default offsets, but don't crash if missing.
				try {
					parseBadges((bytes[0x23e5] << 8) | bytes[0x23e6]);
				} catch (e) {
					// ignore
				}

				var title = newbox ? "Successfully parsed save!" : "Parsed party (boxes not found in this save)";
				finishParse(title, pokemon, deadPokemon);
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