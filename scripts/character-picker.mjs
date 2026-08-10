function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

export async function selectCharacters({ selectedIds = [], title = "Charaktere auswählen", hint = "" } = {}) {
  const selected = new Set(selectedIds);
  const actors = game.actors.filter(actor => actor.type === "pc")
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
  const players = game.users.filter(user => !user.isGM && actors.some(actor => actor.testUserPermission(user, "OWNER")));
  const folders = [...new Map(actors.map(actor => [actor.folder?.id ?? "", actor.folder?.name ?? "Ohne Ordner"])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1], game.i18n.lang));
  const connectedIds = new Set(actors.filter(actor => game.users.some(user => user.active && !user.isGM
    && actor.testUserPermission(user, "OWNER"))).map(actor => actor.id));
  const tokenIds = new Set((canvas?.tokens?.controlled ?? []).map(token => token.actor?.id).filter(Boolean));
  const rows = actors.map(actor => {
    const ownerIds = players.filter(user => actor.testUserPermission(user, "OWNER")).map(user => user.id);
    return `<label data-character-picker-entry data-search="${escapeHtml(actor.name.toLocaleLowerCase())}" data-folder="${actor.folder?.id ?? ""}" data-owners="${ownerIds.join(",")}" data-connected="${connectedIds.has(actor.id)}"><input type="checkbox" name="actors" value="${actor.id}" ${selected.has(actor.id) ? "checked" : ""}><img src="${escapeHtml(actor.img)}" alt=""><span><strong>${escapeHtml(actor.name)}</strong><small>${escapeHtml(actor.folder?.name ?? "Ohne Ordner")}</small></span></label>`;
  }).join("");
  const content = `<div class="tovf-trigger-character-picker"><div class="tovf-trigger-character-filters"><label><i class="fa-solid fa-magnifying-glass"></i><input type="search" data-character-picker-search placeholder="Charaktere durchsuchen …" autocomplete="off"></label><select data-character-picker-player><option value="">Alle Spieler</option>${players.map(user => `<option value="${user.id}">${escapeHtml(user.name)}</option>`).join("")}</select><select data-character-picker-folder><option value="*">Alle Ordner</option>${folders.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("")}</select></div><div class="tovf-actor-selection-actions"><button type="button" data-picker-mode="all"><i class="fa-solid fa-check-double"></i> Alle</button><button type="button" data-picker-mode="none"><i class="fa-solid fa-xmark"></i> Keine</button><button type="button" data-picker-mode="connected"><i class="fa-solid fa-users"></i> Verbundene Spieler</button><button type="button" data-picker-mode="tokens"><i class="fa-solid fa-location-dot"></i> Ausgewählte Token</button></div>${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}<div class="tovf-actor-list">${rows || "<p>Keine Spielercharaktere vorhanden.</p>"}</div></div>`;
  return foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog", "tovf-trigger-character-dialog"], window: { title }, position: { width: 700, height: 650 }, content,
    render: (_event, dialog) => {
      const root = dialog.element.querySelector(".tovf-trigger-character-picker");
      const visibleRows = () => [...root.querySelectorAll("[data-character-picker-entry]")].filter(row => !row.hidden);
      const filter = () => {
        const search = root.querySelector("[data-character-picker-search]").value.trim().toLocaleLowerCase();
        const player = root.querySelector("[data-character-picker-player]").value;
        const folder = root.querySelector("[data-character-picker-folder]").value;
        for (const row of root.querySelectorAll("[data-character-picker-entry]")) {
          const owners = row.dataset.owners.split(",").filter(Boolean);
          row.hidden = (!!search && !row.dataset.search.includes(search))
            || (!!player && !owners.includes(player)) || (folder !== "*" && row.dataset.folder !== folder);
        }
      };
      root.querySelector("[data-character-picker-search]").addEventListener("input", filter);
      root.querySelector("[data-character-picker-player]").addEventListener("change", filter);
      root.querySelector("[data-character-picker-folder]").addEventListener("change", filter);
      root.addEventListener("click", event => {
        const mode = event.target.closest("[data-picker-mode]")?.dataset.pickerMode; if (!mode) return;
        let targets = visibleRows();
        if (mode === "connected") targets = targets.filter(row => row.dataset.connected === "true");
        if (mode === "tokens") targets = targets.filter(row => tokenIds.has(row.querySelector('[name="actors"]')?.value));
        if (["connected", "tokens"].includes(mode)) for (const input of root.querySelectorAll('[name="actors"]')) input.checked = false;
        for (const row of targets) row.querySelector('[name="actors"]').checked = mode !== "none";
      });
    },
    ok: { label: "Auswahl übernehmen", icon: "fa-solid fa-check", callback: (_event, button) => [...button.form.querySelectorAll('[name="actors"]:checked')].map(input => input.value) },
    rejectClose: false });
}
