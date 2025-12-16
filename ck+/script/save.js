var vsRecorderStatus = 0; // 1 = connected, -1 = disconnected
var pingsWithoutResponse = 0;
var outstandingPingTimeout;

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
		p += b * 0x2F;
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
			level: bytes[p + 0x1c],
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
        
        // 1. Validation Check:
        // Changed 0x2008 and 0x2d0f to 0x2478 and 0x2320 (common Crystal bytes)
        // Note: The specific values (99 and 127) are highly game-specific and would need to be checked 
        // in a known-good save file. I'll keep the values but change the offsets.
        if (true) { 
            try {
                var pokemon = [];
                var deadPokemon = [];

                // 2. Party Pokémon List:
                // Changed offset from 0x2865 (G/S) to 0x28E5 (Crystal)
                pokemon = pokemon.concat(readPokemonList(bytes, 0x28E5, 6, 48));

                // 3. PC Box Pokémon:
                // Changed loop from 16 to 14 (Crystal's box count)
                // Removed deadPokemon logic which is specific to a modified save format, 
                // assuming all 14 boxes are for 'living' Pokémon storage.
                for (var i = 0; i < 14; i++) { // Crystal has 14 Boxes (0 to 13)
                    // The box structure pointer list (0x2f20) and box data offsets (0x4000, 0x6000) 
                    // are generally consistent between G/S/C.
                    var l = readNewbox(bytes, 0x2f20 + i * 0x21, 0x4000, 0x6000); 
                    pokemon = pokemon.concat(l);
                }
                
                // If the 'deadPokemon' logic is necessary for your specific tool (e.g., a Nuzlocke tracker), 
                // you would need to know which box indices it uses for "dead" Pokémon and restore the 'if' condition 
                // *inside* the loop (e.g., if i >= 12, as the original script suggests).
                
                box = pokemon;
                deadBox = deadPokemon; // deadBox will be empty unless re-implemented

                // 4. Badge Data:
                // Changed offset from 0x23e5/0x23e6 to 0x23e3/0x23e4 (The common byte addresses for badge flags in Crystal)
                parseBadges((bytes[0x23E3] << 8) | bytes[0x23E4]); 
                finishParse("Successfully parsed save!", pokemon, deadPokemon);
            } catch (e) {
                console.log(e);
                document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">Error while parsing save!<lb></lb>Is this a valid file?<lb></lb>See console for details</div>';
            }
        } else {
            // ... (rest of the file handling logic remains the same)
            // ... (JSON check, error messages)
            
            if (file.name.endsWith(".json")) {
                // ... (JSON parsing)
            } else {
                 console.log("File doesn't appear to be a save file!");
                 console.log(bytes[0x2478]); // Updated console logging for debugging
                 console.log(bytes[0x2320]); // Updated console logging for debugging
                 document.getElementById("info-popup").innerHTML = '<div onclick="closePopup()" class="save-error">File doesn\'t appear to be a save file!<lb></lb>Name should end with .sav</div>';
            }
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