var vsRecorderStatus = 0; // 1 = connected, -1 = disconnected
var pingsWithoutResponse = 0;
var outstandingPingTimeout;

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

        if (b < 0 || b > 255) {
            console.warn("Invalid box index", b, "at", start + i);
            continue;
        }

        var p = banks[i] ? db2 : db1;
        p += b * 0x2F;

        // Egg check
        if (bytes[p + 0x1D] === 0xFD) continue;

        const speciesId = bytes[p];
        const dexEntry = pokemonByPokedex.get(speciesId);

        if (!dexEntry) {
            console.warn(
                "Invalid box species",
                speciesId,
                "slot",
                i,
                "struct",
                p,
                "table",
                start
            );
            continue;
        }

        var item = bytes[p + 0x01];
        item = itemsById.has(item) ? itemsById.get(item) : "";

        var atk = (bytes[p + 0x15] & 0xF0) >> 4;
        var def = (bytes[p + 0x15] & 0x0F);
        var spe = (bytes[p + 0x16] & 0xF0) >> 4;
        var spa = (bytes[p + 0x16] & 0x0F);
        var spd = spa;
        var hp = 8 * (atk & 1) + 4 * (def & 1) + 2 * (spe & 1) + (spa & 1);

        var moves = [];
        for (var j = 0; j < 4; j++) {
            var move = bytes[p + 0x02 + j];
            if (movesByIndex.has(move)) {
                moves.push(movesByIndex.get(move).name);
            }
        }

        var caught = bytes[p + 0x1B] & 0x7F;
        var landmark = landmarksByIndex.get(caught);
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

function expToLevel(exp) {
    return Math.min(100, Math.floor(Math.cbrt(exp)));
}

function readInlineBox(bytes, start, maxSlots, structSize) {
    const pokemon = [];
    const count = bytes[start];

    if (count <= 0 || count > maxSlots) {
        console.warn("Invalid box count", count, "at", start);
        return pokemon;
    }

    let p = start + 1;

    for (let i = 0; i < count; i++) {
        const speciesId = bytes[p];
        const dexEntry = pokemonByPokedex.get(speciesId);

        if (!dexEntry) {
            console.warn("Invalid species", speciesId, "at", p);
            p += structSize;
            continue;
        }

        const item = itemsById.get(bytes[p + 0x01]) || "";

        const atk = (bytes[p + 0x15] & 0xF0) >> 4;
        const def = (bytes[p + 0x15] & 0x0F);
        const spe = (bytes[p + 0x16] & 0xF0) >> 4;
        const spa = (bytes[p + 0x16] & 0x0F);
        const spd = spa;
        const hp = 8 * (atk & 1) + 4 * (def & 1) + 2 * (spe & 1) + (spa & 1);

        const moves = [];
        for (let j = 0; j < 4; j++) {
            const m = bytes[p + 0x02 + j];
            if (movesByIndex.has(m)) {
                moves.push(movesByIndex.get(m).name);
            }
        }

        pokemon.push({
            name: dexEntry.name,
            level: expToLevel(
				(bytes[p + 0x08] << 16) |
				(bytes[p + 0x09] << 8) |
				(bytes[p + 0x0A])
			),
            dvs: { hp, atk, def, spa, spd, spe },
            moves,
            item
        });

        p += structSize;
    }

    return pokemon;
}

function probeInlineStruct(bytes, base) {
    console.group("🔍 Inline struct probe at " + base.toString(16));

    for (const size of [0x2F, 0x30, 0x31, 0x32]) {
        let species = bytes[base + 1]; // first struct
        if (pokemonByPokedex.has(species)) {
            console.log(
                "Possible struct size",
                "0x" + size.toString(16),
                "species",
                species
            );
        }
    }

    console.groupEnd();
}

function probeBoxLayout(bytes, boxTableStart, dbCandidates, structSizes) {
    console.group("📦 Probing box layout");

    for (const db of dbCandidates) {
        for (const size of structSizes) {
            let hits = 0;

            for (let i = 0; i < 5; i++) { // test first 5 slots
                const b = bytes[boxTableStart + i];
                if (!b) continue;

                const index = b - 1;
                const p = db + index * size;
                const species = bytes[p];

                if (pokemonByPokedex.has(species)) {
                    hits++;
                }
            }

            if (hits >= 2) {
                console.log(
                    "✅ Possible layout:",
                    "DB =", "0x" + db.toString(16),
                    "STRUCT =", "0x" + size.toString(16),
                    "hits =", hits
                );
            }
        }
    }

    console.groupEnd();
}

function findNextBox(bytes, start) {
    for (let i = start; i < bytes.length - 0x200; i++) {
        const count = bytes[i];
        if (count > 0 && count <= 20) {
            const species = bytes[i + 1];
            if (pokemonByPokedex.has(species)) {
                return i;
            }
        }
    }
    return -1;
}

function readPokemonList(bytes, start, capacity, increment) {
    var count = bytes[start];

    // Sanity check
    if (count < 0 || count > capacity) {
        console.warn("Invalid party count:", count, "at", start);
        return [];
    }

    var p = start + 1;

    // Read species list
    var species = [];
    for (var i = 0; i < count; i++) {
        species.push(bytes[p + i]);
    }

    // Move pointer to struct list
    p += capacity + 1;

    var pokemon = [];

    for (var i = 0; i < count; i++) {

        const speciesId = bytes[p];
        const dexEntry = pokemonByPokedex.get(speciesId);

        if (!dexEntry) {
            console.warn(
                "Invalid species ID",
                speciesId,
                "at struct offset",
                p
            );
            p += increment;
            continue;
        }

        // Mismatch check (eggs / corruption)
        if (speciesId !== species[i]) {
            console.warn(
                "Species mismatch:",
                speciesId,
                "vs",
                species[i],
                "at",
                p
            );
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
        var hp = 8 * (atk & 1) + 4 * (def & 1) + 2 * (spe & 1) + (spa & 1);

        var moves = [];
        for (var j = 0; j < 4; j++) {
            var move = bytes[p + 0x02 + j];
            if (movesByIndex.has(move)) {
                moves.push(movesByIndex.get(move).name);
            }
        }

        var caught = bytes[p + 0x1E] & 0x7F;
        var landmark = landmarksByIndex.get(caught);
        landmark = landmark ? landmark.name : "unknown";

        pokemon.push({
            name: dexEntry.name,
            level: bytes[p + 0x1F],
            dvs: {
                hp, atk, def, spa, spd, spe
            },
            moves: moves,
            item: item,
            caught: landmark
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

		probeBoxLayout(
			bytes,
			0x2D0C,                // your current box table start
			[0x4000, 0x4800, 0x5000, 0x6000, 0x6800],
			[0x2F, 0x30, 0x31]
		);
		console.log("BOX TABLE RAW:", Array.from(bytes.slice(0x2D0C, 0x2D0C + 0x40)));

		probeInlineStruct(bytes, 0x2D0C);

        // Safer validation: size + non-empty data
        if (bytes.length > 32000) {
            try {
                var pokemon = [];
                var deadPokemon = [];

                // Party Pokémon (NEW OFFSET)
                pokemon = pokemon.concat(
                    readPokemonList(bytes, 0x2456, 6, 48)
                );

                const BOX_STRUCT_SIZE = 0x30; // likely, based on patterns

				let boxPtr = 0x2D0C;

				for (let i = 0; i < 16; i++) {
					boxPtr = findNextBox(bytes, boxPtr);
					if (boxPtr === -1) {
						console.warn("No more boxes found");
						break;
					}

					const l = readInlineBox(bytes, boxPtr, 20, 0x30);

					if (i >= 12) {
						deadPokemon = deadPokemon.concat(l);
					} else {
						pokemon = pokemon.concat(l);
					}

					// advance pointer past this box
					boxPtr += 1 + l.length * 0x30;
				}


                box = pokemon;
                deadBox = deadPokemon;

                // Badge flags (NEW OFFSET)
                parseBadges(
                    (bytes[0x2057] << 8) | bytes[0x2058]
                );

                finishParse("Successfully parsed save!", pokemon, deadPokemon);

            } catch (e) {
                console.log(e);
                document.getElementById("info-popup").innerHTML =
                    '<div onclick="closePopup()" class="save-error">' +
                    'Error while parsing save!<lb></lb>See console for details</div>';
            }
        } else {
            document.getElementById("info-popup").innerHTML =
                '<div onclick="closePopup()" class="save-error">' +
                'File doesn\'t appear to be a save file!</div>';
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