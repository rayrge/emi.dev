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
}