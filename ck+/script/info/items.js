function displayItemsMap() {

    const list = document.getElementById("items");

    itemsMap.forEach((entry) => {
        const item = document.createElement("div");
        item.classList.add("entry", `entry-${entry.type}`);

        if (entry.type == "item") {
            item.innerHTML = `
                <div class="item-location">${entry.location}</div>
                <div class="item-name">${itemLink(entry.name)} ${entry.amount}</div>
                <div class="item-description">${entry.description}</div>
            `;
        } else if (entry.type == "roadblock") {
            item.innerHTML = `
                <div>
                    ${getTrainerName(entry.name)}
                    ${createLink(`#/trainer/${entry.name}/`, '<button style="float:right;">Info</button>')}
			    </div>
            `;
        }

        list.appendChild(item);
    });

    loadCheckbox();
}

function saveCheckbox() {
    const state = {};

    document.querySelectorAll("#items input[type='checkbox']").forEach(c => {
        state[c.id] = c.checked;
    });

    savedData["checkbox-state"] = state;
    writeLocalStorage()
}

function loadCheckbox() {
    const state = checkboxState;

    document.querySelectorAll("#items input[type='checkbox']").forEach(c => {
        var checked = state[c.id];
        document.getElementById(c.id).checked = checked;
        if (checked) itemObtained(c);
    });
}

function itemObtained(checkbox) {
    const div = checkbox.closest(".entry");
    div.style.backgroundColor = checkbox.checked ? '#536878' : '#728370';
    div.classList.toggle("obtained", checkbox.checked);

    saveCheckbox();
}

function resetCheckboxState() {
    document.querySelectorAll("#items input[type='checkbox']").forEach(c => {
        document.getElementById(c.id).checked = false;
        itemObtained(c);
    });

    saveCheckbox();
}