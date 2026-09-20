import { uiText } from "../core/localization.mjs";
import { MODULE_ID } from "../downtime/constants.mjs";
import { campaignState, campaignAction, fullGM, redemptionPreview, isCampaignWorld } from "./service.mjs";
import { compareSnapshots, validateSnapshot, sessionMonth } from "./data.mjs";
import { defaultRules, settlementPreview, ruleForDate } from "./rules.mjs";
import { playerCharacters, sessionProgress, milestoneEntries, levelFromMilestones, SessionService } from "../downtime/session-service.mjs";
import { reconciliationPlan } from "./reconciliation.mjs";
import { sessionLinkPreview } from "./session-links.mjs";
import { weeklyPreview } from "./weekly.mjs";
import { activeServerteam } from "./serverteam.mjs";
import { GoldService } from "../downtime/gold-service.mjs";
import { linkedPerson, personName as nameOfPerson, charactersForPerson, personAccountIds, detectCampaignLinks } from "./identities.mjs";
import { UserTransferApp } from "../transfer/user-transfer-app.mjs";
import { rewardSourceLabel } from "./reward-label.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const copy = value => foundry.utils.deepClone(value);
const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
const sourceNames = () => ({ gm: uiText("TOVF.Interface.GM_fa2c48", "Spielleitung"), community: uiText("TOVF.Interface.ServerTeam_d71b1b", "Serverteam") });
const statusNames = () => ({ "needs-review": uiText("TOVF.Interface.PlayedNotConfirmedYet_b6d0f3", "Gespielt? Noch nicht bestätigt"), cancelled: uiText("TOVF.Interface.Cancelled_435f42", "Abgesagt"), scheduled: uiText("TOVF.Interface.Scheduled_08c48a", "Geplant"), unknown: uiText("TOVF.Interface.Unknown_d0b00a", "Unbekannt"), played: uiText("TOVF.Interface.Played_7701f7", "Gespielt"), excluded: uiText("TOVF.Interface.Excluded_139af0", "Ausgeschlossen"), redeemed: uiText("TOVF.Interface.Redeemed_5dd6ca", "Eingelöst"), processing: uiText("TOVF.Interface.ReservedReviewRequired_e01f29", "Reserviert – Prüfung erforderlich"), review: uiText("TOVF.Interface.InterruptedReviewRequired_add627", "Unterbrochen – Prüfung erforderlich"), void: uiText("TOVF.Interface.Released_6a9b36", "Freigegeben") });

export class CampaignApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-campaign", tag: "form", classes: ["downtime-manager", "tovf-campaign"],
    position: { width: 1060, height: 850 },
    window: { title: "TOVF.Help.Campaign.Title", icon: "fa-solid fa-gift", resizable: true },
    actions: { command: this.#command }
  };
  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/campaign/overview.hbs" } };
  _tab = "rewards";
  _month = new Date().toISOString().slice(0, 7);
  _draft = null;
  _import = null;
  _rewardPerson = null;
  _autoLinksChecked = false;

  async _prepareContext() {
    if (!isCampaignWorld()) throw new Error(uiText("TOVF.Interface.RewardManagementIsOnlyAvailableInThe_62a9e7", "Belohnungsverwaltung ist nur in der Hauptwelt verfügbar."));
    let state = campaignState();
    if (fullGM() && !this._autoLinksChecked) {
      this._autoLinksChecked = true;
      const detected = detectCampaignLinks(state);
      if (detected.newCharacters.length || detected.newPeople.length) {
        try {
          await campaignAction("autoLinks", { revision: state.revision });
          state = campaignState();
        } catch (error) { ui.notifications.warn(uiText("TOVF.Interface.AutomaticAssignmentP0_73a517", "Automatische Zuordnung: {p0}", { p0: (error.message) })); }
      }
    }
    this._revision = state.revision;
    const admin = fullGM();
    const assistant = game.user.role === CONST.USER_ROLES.ASSISTANT;
    const tabs = [["rewards", uiText("TOVF.Interface.Rewards_98ebf6", "Belohnungen")], ...(!assistant ? [["characters", uiText("TOVF.Interface.Characters_346a51", "Charaktere")]] : []), ...(admin ? [["sessions", uiText("TOVF.Interface.SessionsSettlement_a957b1", "Sessions & Abrechnung")], ["people", uiText("TOVF.Interface.PlayerAssignments_d286e7", "Spielerzuordnung")], ["rules", "Regeln"], ["import", uiText("TOVF.Interface.DataValidationImport_9fcece", "Datenprüfung & Import")]] : [])];
    if (!tabs.some(([id]) => id === this._tab)) this._tab = "rewards";
    const snapshot = state.snapshot;
    const personName = id => nameOfPerson(state, id);
    const unlinkedGms = game.users.filter(u => [CONST.USER_ROLES.GAMEMASTER, CONST.USER_ROLES.ASSISTANT].includes(u.role) && !linkedPerson(state, u))
      .map(u => ({ id: `unlinked-user:${u.id}`, userId: u.id, name: uiText("TOVF.Interface.P0NotAssignedYet_579fdc", "{p0} (noch nicht zugeordnet)", { p0: (u.name) }) }));
    const ownPerson = linkedPerson(state, game.user) ?? unlinkedGms.find(p => p.userId === game.user.id)?.id;
    const teamPeople = new Set([...activeServerteam(state), ...Object.values(state.recipients).flat(), ...Object.values(state.weeklySettlements ?? {}).flatMap(w => w.recipients)]);
    const eligiblePeople = (snapshot?.people ?? []).filter(p => teamPeople.has(p.id) || personAccountIds(state, p.id).some(id => {
      const role = game.users.get(id)?.role;
      return role === CONST.USER_ROLES.GAMEMASTER || role === CONST.USER_ROLES.ASSISTANT;
    })).concat(unlinkedGms);
    const rewardPerson = admin ? [this._rewardPerson, ownPerson, ...eligiblePeople.map(p => p.id)].find(id => eligiblePeople.some(p => p.id === id)) : ownPerson;
    const characters = (snapshot?.characters ?? []).filter(c => admin || c.userId === ownPerson)
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang)).map(c => {
      const actor = game.actors.find(a => a.uuid === state.characterLinks[c.id]);
      const progress = actor ? sessionProgress(actor) : null;
      return { ...c, foundryGold: actor ? GoldService.getGold(actor) : null, personName: personName(c.userId), actorUuid: actor?.uuid, actorName: actor?.name, foundryMilestones: progress?.milestones, expectedLevel: progress ? levelFromMilestones(progress.milestones) : null, mismatch: !!progress && progress.milestones !== c.milestones,
        actorOptions: playerCharacters().map(a => ({ id: a.uuid, name: a.name, selected: a.uuid === actor?.uuid })) };
    });
    const people = (snapshot?.people ?? []).map(p => ({ ...p, name: personName(p.id), displayName: state.personNames[p.id] ?? "", characterNames: snapshot.characters.filter(c => c.userId === p.id).map(c => c.name).join(", "), rewardSelected: p.id === rewardPerson,
      recipient: activeServerteam(state).includes(p.id), allocation: state.allocations[this._month]?.[p.id] ?? 0,
      users: game.users.map(u => ({ id: u.id, name: u.name, selected: state.personLinks[p.id] === u.id })) }));
    this._reconciliation = admin && this._tab === "characters" ? characters.filter(c => c.actorUuid).map(c => reconciliationPlan(state, c, milestoneEntries(game.actors.find(a => a.uuid === c.actorUuid)))) : [];
    const claims = state.claims.filter(c => c.personId === rewardPerson && (c.count || admin)).map(c => {
      const used = state.redemptions.filter(r => r.claimId === c.id && r.status !== "void").length;
      const corrections = admin ? (state.claimCorrections ?? []).filter(row => row.claimId === c.id).slice().reverse().map(row => ({ ...row, date: new Date(row.at).toLocaleString(game.i18n.lang), userName: game.users.get(row.userId)?.name ?? row.userId })) : [];
      return { ...c, corrections, historicalUsed: state.redemptions.filter(r => r.claimId === c.id && r.historical && r.status !== "void").length, sourceLabel: snapshot?.sessions.find(s => s.id === c.sourceId)?.title ?? c.sourceId, name: personName(c.personId), kindLabel: sourceNames()[c.kind], remaining: c.count - used, used, canRedeem: (admin || c.personId === ownPerson) && used < c.count,
        rewardLabel: c.reward.mode === "session" ? uiText("TOVF.Interface.1MilestoneFullSessionRewardForThe_23beaf", "1 Meilenstein + vollständige Sessionbelohnung nach Charakterlevel") : `${c.reward.milestones} Meilensteine · ${c.reward.goldMode === "level" ? uiText("TOVF.Interface.GoldByLevel_d174ae", "Gold nach Level") : c.reward.goldMode === "fixed" ? uiText("TOVF.Interface.P0Gold_6359a8", "{p0} Gold", { p0: (c.reward.gold) }) : uiText("TOVF.Interface.NoGold_a7b8cb", "kein Gold")} · Faktor ${c.reward.goldFactor}` };
    });
    const rewardTotals = claims.reduce((totals, claim) => {
      totals.total += Number(claim.count) || 0;
      totals.open += Math.max(0, claim.remaining);
      for (const redemption of state.redemptions.filter(r => r.claimId === claim.id && r.status !== "void")) {
        if (redemption.status === "redeemed") totals.used++;
        else totals.reserved++;
      }
      return totals;
    }, { total: 0, open: 0, used: 0, reserved: 0 });
    const history = SessionService.historyEntries();
    let preview = null; let previewError = null;
    try { preview = settlementPreview(state, this._month, history); } catch (e) { previewError = e.message; }
    if (preview) preview.claims = preview.claims.filter(c => c.kind === "community").map(c => ({ ...c, sourceLabel: snapshot?.sessions.find(s => s.id === c.sourceId)?.title ?? c.sourceId, personName: personName(c.personId), kindLabel: sourceNames()[c.kind], booked: state.claims.some(old => old.key === c.key) }));
    this._draft ??= copy(ruleForDate(state.rules, `${this._month}-01`) ?? defaultRules());
    const rules = this._draft;
    const sessions = history.filter(record => Number.isFinite(Number(record.awardedAt))
      && sessionMonth(record.awardedAt, rules.timeZone) === this._month)
      .map(record => {
      const id = String(record.id);
      const gm = state.historyGms?.[id] || record.gmPersonId
        || (record.gmUserId && (snapshot?.people ?? []).find(p => state.personLinks[p.id] === record.gmUserId)?.id);
      const legacyRemoteId = state.sessionLinks?.[id]?.westmarchesId;
      return {
        ...record, id,
        name: gm ? personName(gm) : game.users.get(record.gmUserId)?.name ?? record.gmUserId ?? uiText("TOVF.Interface.Unknown_d0b00a", "Unbekannt"),
        displayDate: new Date(record.awardedAt).toLocaleString(game.i18n.lang),
        excluded: state.sessionReviews[id]?.status === "excluded",
        gmBooked: state.claims.some(c => c.historyId === id || (legacyRemoteId && c.key === `gm:${legacyRemoteId}`)),
        gmOptions: people.map(p => ({ id: p.id, name: p.name, selected: p.id === gm }))
      };
    });
    this._historySignature = JSON.stringify(history);
    const sessionMatches = sessionLinkPreview(state, history).map(row => ({ ...row,
      dateLabel: row.awardedAt ? new Date(row.awardedAt).toLocaleString(game.i18n.lang) : uiText("TOVF.Interface.Unknown_d0b00a", "Unbekannt"),
      gmOptions: people.map(p => ({ id: p.id, name: p.name, selected: p.id === row.gm })),
      options: (snapshot?.sessions ?? []).filter(s => s.gmUserId === row.gm || s.id === row.link?.westmarchesId).map(s => ({ id: s.id, title: s.title, date: s.startTime.slice(0, 10), selected: s.id === (row.link?.westmarchesId ?? row.proposed) })),
      missingRemote: !!row.link && !snapshot?.sessions.some(s => s.id === row.link.westmarchesId)
    }));
    return {
      admin, tab: this._tab, month: this._month, hasSnapshot: !!snapshot, exportedAt: snapshot?.exportedAt,
      tabs: tabs.map(([id, label]) => ({ id, label, active: id === this._tab })),
      assistant, rewardsTab: this._tab === "rewards", charactersTab: this._tab === "characters", sessionsTab: admin && this._tab === "sessions", peopleTab: admin && this._tab === "people", rulesTab: admin && this._tab === "rules", importTab: admin && this._tab === "import",
      characters, sessionMatches, reconciliation: this._reconciliation, people, rewardTotals,
      rewardPeople: people.concat(unlinkedGms.map(p => ({ ...p, rewardSelected: p.id === rewardPerson }))).filter(p => admin ? eligiblePeople.some(e => e.id === p.id) : p.id === ownPerson),
      rewardUnlinked: unlinkedGms.some(p => p.id === rewardPerson),
      openClaims: claims.filter(claim => claim.remaining > 0), claims, weeks: admin ? weeklyPreview(state, this._month, history).map(w => ({ ...w, historical: this._month < new Date().toISOString().slice(0, 7), options: people.map(p => ({ id: p.id, name: p.name, selected: w.recipients.includes(p.id) })) })) : [], sessions, preview, previewError, settled: state.settlements[this._month],
      poolMode: ruleForDate(state.rules, `${this._month}-01`)?.community.distribution === "pool",
      localUsers: game.users.filter(u => !snapshot?.people.some(p => personAccountIds(state, p.id).includes(u.id))).map(u => ({ id: u.id, name: u.name })),
      ownCharacters: charactersForPerson(state, rewardPerson).map(actor => ({ actorUuid: actor.uuid, name: actor.name, foundryMilestones: sessionProgress(actor).milestones, expectedLevel: levelFromMilestones(sessionProgress(actor).milestones) })),
      redemptions: state.redemptions.filter(r => r.personId === rewardPerson).slice().reverse().map(r => ({ ...r, canAssignHistorical: admin && r.historical && r.status === "redeemed" && !r.actorUuid, historicalActors: charactersForPerson(state, r.personId).map(a => ({ uuid: a.uuid, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)), sourceLabel: rewardSourceLabel(state, r, history), requestedByName: game.users.get(r.requestedBy)?.name, kindLabel: sourceNames()[r.kind], statusLabel: statusNames()[r.status], needsReview: admin && ["processing", "review"].includes(r.status), date: new Date(r.createdAt).toLocaleString(game.i18n.lang), stepsLabel: r.steps.join(", ") })),
      rules, rewards: ["gm", "community"].map(kind => ({ kind, label: sourceNames()[kind], ...rules[kind].reward, sessionLinked: rules[kind].reward.mode === "session", goldModes: [["level", uiText("TOVF.Interface.FromLevelTable_47cf4e", "Nach Leveltabelle")], ["fixed", uiText("TOVF.Interface.FixedGoldAmount_acfaa5", "Fester Goldbetrag")], ["none", uiText("TOVF.Interface.NoGold_6ec9ab", "Kein Gold")]].map(([id, label]) => ({ id, label, selected: rules[kind].reward.goldMode === id })) })),
      modes: [["activeWeeks", uiText("TOVF.Interface.WeeksWithAtLeastOnePlayedGuild_20c36d", "Wochen mit mindestens einer gespielten Gildensession")], ["ratio", uiText("TOVF.Interface.SessionsActiveGMs_8317b6", "Sessions / aktive Spielleiter")], ["fixed", uiText("TOVF.Interface.FixedCount_49ac63", "Feste Anzahl")], ["sessions", uiText("TOVF.Interface.NumberOfPlayedSessions_8fb686", "Anzahl gespielter Sessions")]].map(([id, label]) => ({ id, label, selected: rules.community.mode === id })),
      roundings: [["ceil", uiText("TOVF.Interface.RoundUp_c185dc", "Aufrunden")], ["floor", uiText("TOVF.Interface.RoundDown_878aed", "Abrunden")], ["round", uiText("TOVF.Interface.RoundToNearest_75d9bb", "Kaufmännisch runden")]].map(([id, label]) => ({ id, label, selected: rules.community.rounding === id })),
      distributions: [["each", uiText("TOVF.Interface.CountPerRecipient_2f9a08", "Anzahl je Empfänger")], ["pool", uiText("TOVF.Interface.SharedPool_84ef5c", "Gemeinsamer Pool")]].map(([id, label]) => ({ id, label, selected: rules.community.distribution === id })),
      versions: state.rules.map(r => ({ id: r.id, name: `Ab ${r.effectiveFrom}` })),
      importPreview: this._import ? { exportedAt: this._import.exportedAt, ...compareSnapshots(snapshot, this._import) } : null,
      issues: (this._import ?? snapshot)?.issues ?? [],
      summary: snapshot ? `${snapshot.characters.length} Charaktere · ${snapshot.people.length} Personen · ${snapshot.sessions.length} Sessions` : uiText("TOVF.Interface.NoCampaignDataImportedYet_f9fbfe", "Noch keine Kampagnendaten importiert.")
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.addEventListener("submit", e => e.preventDefault());
    for (const select of this.element.querySelectorAll("[data-reward-mode]")) {
      select.addEventListener("change", () => { select.closest("fieldset").querySelector("[data-custom-reward]").hidden = select.value === "session"; });
    }
    this.element.querySelector('[name="rewardPerson"]')?.addEventListener("change", e => { this._rewardPerson = e.target.value; this.render({ force: true }); });
    this.element.querySelector('[name="month"]')?.addEventListener("change", e => { this._month = e.target.value; this._draft = null; this.render({ force: true }); });
    for (const select of this.element.querySelectorAll("[data-session-review]")) {
      select.addEventListener("change", async () => {
        const previous = select.dataset.savedValue ?? "";
        select.disabled = true;
        try {
          await campaignAction("review", { revision: this._revision, reviews: { [select.dataset.sessionReview]: select.value } });
          this._revision = campaignState().revision;
          await this._renderPreservingView();
        } catch (error) {
          select.value = previous;
          select.disabled = false;
          ui.notifications.error(error.message);
        }
      });
    }
    this.element.querySelector('[name="search"]')?.addEventListener("input", e => {
      const query = e.target.value.toLocaleLowerCase();
      for (const row of this.element.querySelectorAll("[data-search]")) row.hidden = !row.dataset.search.toLocaleLowerCase().includes(query);
    });
    this.element.addEventListener("dragover", e => { if (e.target.closest("[data-reward-drop]")) e.preventDefault(); });
    this.element.addEventListener("drop", async e => {
      const zone = e.target.closest("[data-reward-drop]"); if (!zone) return;
      e.preventDefault();
      try {
        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(e);
        if (zone.querySelector("[data-reward-mode]")?.value === "session") throw new Error(uiText("TOVF.Interface.SwitchToCustomRewardContentsBeforeAdding_57bc23", "Für eigene Gegenstände zuerst auf eigenen Belohnungsinhalt umstellen."));
        const item = data.uuid ? await fromUuid(data.uuid) : null;
        if (item?.documentName !== "Item") throw new Error(uiText("TOVF.Interface.PleaseDropAnItemHere_286ef7", "Bitte einen Gegenstand hineinziehen."));
        this.#readRules();
        this._draft[zone.dataset.rewardDrop].reward.items.push({ uuid: item.uuid, name: item.name, quantity: 1 });
        await this.render({ force: true });
      } catch (error) { ui.notifications.error(error.message); }
    });
  }

  async _renderPreservingView() {
    const current = this.element.matches?.(".tovf-campaign-body") ? this.element : this.element.querySelector(".tovf-campaign-body");
    const scrollTop = current?.scrollTop ?? 0;
    const openDetails = [...this.element.querySelectorAll("details")].map((details, index) => details.open ? index : -1).filter(index => index >= 0);
    await this.render({ force: true });
    const updated = this.element.matches?.(".tovf-campaign-body") ? this.element : this.element.querySelector(".tovf-campaign-body");
    const details = [...this.element.querySelectorAll("details")];
    for (const index of openDetails) if (details[index]) details[index].open = true;
    if (updated) updated.scrollTop = scrollTop;
  }

  #readRules() {
    const form = new FormData(this.element);
    const r = this._draft;
    r.effectiveFrom = form.get("effectiveFrom");
    r.gm.enabled = form.has("gm.enabled"); r.gm.count = Number(form.get("gm.count"));
    const c = r.community;
    c.enabled = form.has("community.enabled");
    for (const key of ["mode", "rounding", "distribution"]) c[key] = form.get(`community.${key}`);
    for (const key of ["fixed", "factor", "minimum"]) c[key] = Number(form.get(`community.${key}`));
    c.maximum = form.get("community.maximum") === "" ? null : Number(form.get("community.maximum"));
    for (const kind of ["gm", "community"]) {
      const reward = r[kind].reward;
      reward.mode = form.get(`${kind}.rewardMode`);
      reward.goldMode = form.get(`${kind}.goldMode`);
      for (const key of ["milestones", "gold", "goldFactor"]) reward[key] = Number(form.get(`${kind}.${key}`));
      reward.items.forEach((item, index) => { item.quantity = Number(form.get(`${kind}.item.${index}`)); });
    }
    return r;
  }

  async #confirm(title, content) {
    return foundry.applications.api.DialogV2.confirm({ window: { title }, content, rejectClose: false });
  }

  static async #command(event, target) {
    event.preventDefault();
    const command = target.dataset.command;
    try {
      if (command === "tab") { this._tab = target.dataset.tab; return this.render({ force: true }); }
      if (command === "refresh") return this.render({ force: true });
      if (command === "autoLinks") { this._autoLinksChecked = false; return this.render({ force: true }); }
      if (command === "userTransfer") return new UserTransferApp().render({ force: true });
      const form = new FormData(this.element);
      const state = campaignState();
      const base = { revision: this._revision };
      if (command === "loadImport") {
        const file = this.element.querySelector('[name="snapshot"]')?.files?.[0];
        if (!file) throw new Error(uiText("TOVF.Interface.PleaseSelectCampaignJson_28cdf9", "Bitte campaign.json auswählen."));
        const snapshot = validateSnapshot(JSON.parse(await file.text()));
        delete snapshot.raw;
        this._import = snapshot;
      } else if (command === "import") {
        if (!this._import) throw new Error(uiText("TOVF.Interface.ReviewAnExportFirst_a947b5", "Zuerst einen Export prüfen."));
        await campaignAction("import", { ...base, snapshot: this._import }); this._import = null;
      } else if (command === "links") {
        const people = {}; const characters = {}; const names = {};
        for (const [key, value] of form) {
          if (value && key.startsWith("person.")) people[key.slice(7)] = value;
          if (value && key.startsWith("character.")) characters[key.slice(10)] = value;
          if (key.startsWith("personName.")) names[key.slice(11)] = String(value).trim();
        }
        const recipients = form.getAll("recipients");
        const serverteam = this._tab === "people" ? { month: this._month, people: recipients, localUsers: form.getAll("localUsers"), allocations: Object.fromEntries(recipients.map(id => [id, Number(form.get(`allocation.${id}`) ?? state.allocations[this._month]?.[id] ?? 0)])) } : undefined;
        await campaignAction("links", { ...base, people: this._tab === "people" ? people : state.personLinks, accounts: {}, names: this._tab === "people" ? names : state.personNames, characters: this._tab === "characters" ? characters : state.characterLinks, serverteam });
        if (serverteam) ui.notifications.info(uiText("TOVF.Interface.PlayerAssignmentsAndPermanentServerTeamSaved_50b302", "Spielerzuordnung und dauerhaftes Serverteam gespeichert."));
      } else if (command === "completedGM") {
        const personId = form.get(`backfillGm.${target.dataset.id}`);
        await campaignAction("completedGM", { ...base, historyId: target.dataset.id, personId });
        this._revision = campaignState().revision;
        const session = target.closest("details");
        const selectedName = session?.querySelector(`[name="backfillGm.${CSS.escape(target.dataset.id)}"] option:checked`)?.textContent;
        const gmName = session?.querySelector("[data-session-gm-name]");
        if (gmName && selectedName) gmName.textContent = selectedName;
        const result = target.closest("[data-gm-backfill]");
        if (result) result.innerHTML = `<p>${uiText("TOVF.Interface.GMRewardAlreadyBooked_98380d", "SL-Belohnung bereits gebucht.")}</p>`;
        return;
      } else if (command === "autoSessionLinks") {
        await campaignAction("autoSessionLinks", base);
      } else if (command === "sessionGms" || command === "sessionLinks") {
        const gms = Object.fromEntries([...form].filter(([k]) => k.startsWith("historyGm.")).map(([k,v]) => [k.slice(10),v]));
        const links = command === "sessionLinks" ? Object.fromEntries([...form].filter(([k]) => k.startsWith("historyLink.")).map(([k,v]) => [k.slice(12),v])) : {};
        if (command === "sessionLinks" && !await this.#confirm(uiText("TOVF.Interface.SaveSessionLinks_c0796c", "Sessionverbindungen speichern"), `<p>${uiText("TOVF.Interface.PermanentlyLinkTheSelectedSessionPairsPay_d50263", "Die ausgewählten Sessionpaare dauerhaft verbinden? Prüfe besonders Mehrteiler und ihre Reihenfolge. Leere Auswahlen lösen bestehende Verbindungen. Es werden keine Belohnungen vergeben.")}</p>`)) return;
        await campaignAction("sessionLinks", { ...base, gms, links, historySignature: this._historySignature });
      } else if (command === "reconcile") {
        const plan = this._reconciliation?.find(p => p.characterId === target.dataset.id);
        if (!plan) throw new Error(uiText("TOVF.Interface.ReopenThePreview_7102e4", "Vorschau neu öffnen."));
        const sessionIds = form.getAll(`evidence.${plan.characterId}`).filter(Boolean);
        if (!sessionIds.length) throw new Error(uiText("TOVF.Interface.PleaseSelectSessions_b60ddf", "Bitte Sessions auswählen."));
        const selected = plan.groups.flatMap(g => g.candidates).filter(s => sessionIds.includes(s.id));
        if (!await this.#confirm(uiText("TOVF.Interface.ApplyMilestoneEvidence_b39c93", "Meilensteinnachweise übernehmen"), `<p>${escape(plan.name)}: ${sessionIds.length} vorhandene Meilensteine dokumentieren.</p><ul>${selected.map(s => `<li>${escape(s.date)} · ${escape(s.title)}</li>`).join("")}</ul><p>${uiText("TOVF.Interface.ConfirmThatTheCharacterAttendedTheseSessions_b89fe6", "Bestätige, dass der Charakter an diesen Sessions teilgenommen und dafür jeweils einen der vorhandenen Meilensteine erhalten hat. Meilensteinanzahl und Belohnungsguthaben bleiben unverändert.")}</p>`)) return;
        await campaignAction("reconcile", { ...base, characterId: plan.characterId, sessionIds, signature: plan.signature });
      } else if (command === "review") {
        const reviews = Object.fromEntries([...form].filter(([k]) => k.startsWith("session.")).map(([k, v]) => [k.slice(8), v]));
        await campaignAction("review", { ...base, reviews });
      } else if (command === "recipients") {
        const people = form.getAll("recipients");
        const allocations = Object.fromEntries(people.map(id => [id, Number(form.get(`allocation.${id}`) ?? state.allocations[this._month]?.[id] ?? 0)]));
        await campaignAction("recipients", { ...base, month: this._month, people, allocations, localUsers: form.getAll("localUsers") });
      } else if (command === "rules") {
        await campaignAction("rules", { ...base, rules: this.#readRules() }); this._draft = null;
      } else if (command === "removeItem") {
        this.#readRules(); this._draft[target.dataset.kind].reward.items.splice(Number(target.dataset.index), 1);
      } else if (command === "assignHistorical") {
        await campaignAction("assignHistorical", { ...base, redemptionId: target.dataset.id,
          actorUuid: form.get(`historicalActor.${target.dataset.id}`),
          milestones: Number(form.get(`historicalMilestones.${target.dataset.id}`)) });
      } else if (command === "correctClaim") {
        const claimId = target.dataset.id;
        await campaignAction("correctClaim", { ...base, claimId, total: Number(form.get(`claimTotal.${claimId}`)), historicalUsed: Number(form.get(`claimUsed.${claimId}`)), reason: form.get(`claimReason.${claimId}`) });
      } else if (command === "settleWeek") {
        const recipients = form.getAll(`weekRecipients.${target.dataset.week}`);
        if (!await this.#confirm(uiText("TOVF.Interface.BookServerTeamWeek_ba476e", "Serverteam-Woche buchen"), `<p>${uiText("TOVF.Interface.P0BookRewardsForTheseP1People_310305", "{p0}: Belohnungen für diese {p1} Personen buchen?", { p0: (escape(target.dataset.week)), p1: (recipients.length) })}</p><ul>${recipients.map(id => `<li>${escape(nameOfPerson(state, id))}</li>`).join("")}</ul><p>${uiText("TOVF.Interface.ForHistoricalBookingsCheckParticipationAtThat_cda1b7", "Bei Nachträgen bitte die damalige Mitarbeit prüfen. Diese Auswahl gilt nur für diese Buchung.")}</p>`)) return;
        await campaignAction("settleWeek", { ...base, month: this._month, week: target.dataset.week, recipients });
      } else if (command === "grantGM") {
        if (!await this.#confirm(uiText("TOVF.Interface.BookGMReward_f692da", "SL-Belohnung buchen"), `<p>${uiText("TOVF.Interface.RecordTheSessionClaimAndSubtractThe_81dd63", "Sessionanspruch erfassen und den eingetragenen historischen Verbrauch abziehen? Es werden keine Charakterwerte verändert.")}</p>`)) return;
        await campaignAction("grantGM", { ...base, sessionId: target.dataset.id, baselineReviewed: true, alreadyUsed: Number(form.get(`gmUsed.${target.dataset.id}`) ?? 0) });
      } else if (command === "settle") {
        const p = settlementPreview(state, this._month, SessionService.historyEntries());
        const count = p.claims.filter(c => c.kind === "community" && !state.claims.some(old => old.key === c.key)).reduce((sum, c) => sum + c.count, 0);
        if (!await this.#confirm(uiText("TOVF.Interface.BookMonth_72de22", "Monat buchen"), `<p>${uiText("TOVF.Interface.P0P1PlayedSessionsP2ActiveGMs_0b936c", "{p0}: {p1} gespielte Sessions, {p2} aktive Spielleiter. Insgesamt {p3} neue Belohnungsansprüche laut Vorschau.", { p0: (escape(this._month)), p1: (p.sessions), p2: (p.gms), p3: (count) })}</p><p>${uiText("TOVF.Interface.ConfirmThatTheseClaimsHaveNotAlready_6bc2fc", "Bestätige, dass diese Ansprüche noch nicht anderweitig vergeben wurden. Importierte Charakterstände werden nicht verändert. Die Monatsabrechnung wird anschließend festgeschrieben.")}</p>`)) return;
        await campaignAction("settle", { ...base, month: this._month, baselineReviewed: true });
      } else if (command === "redeem") {
        const actorUuid = form.get("redeemActor");
        const p = await redemptionPreview(state, game.user, target.dataset.id, actorUuid);
        const itemList = p.reward.items.map(i => `<li>${escape(i.name ?? i.uuid)} × ${escape(i.quantity)}</li>`).join("");
        const contents = p.reward.mode === "session"
          ? uiText("TOVF.Interface.P0MilestonesAndTheFollowingSessionItems_2105a1", "+{p0} Meilensteine und die folgenden Sessiongegenstände (einschließlich {p1} Gold):", { p0: (p.reward.milestones), p1: (p.gold) })
          : uiText("TOVF.Interface.P0MilestonesP1GoldAdditionalItems_92b1aa", "+{p0} Meilensteine, +{p1} Gold. Zusätzliche Gegenstände:", { p0: (p.reward.milestones), p1: (p.gold) });
        if (!await this.#confirm(uiText("TOVF.Interface.RedeemOneReward_6568b4", "Eine Belohnung einlösen"), `<p>${uiText("TOVF.Interface.P0LevelP1BeforeRedemption_778be2", "{p0}: Level {p1} vor der Einlösung.", { p0: (escape(p.actor.name)), p1: (p.level) })}</p><p>${contents}</p><ul>${itemList}</ul>`)) return;
        await campaignAction("redeem", { claimId: p.claim.id, actorUuid, level: p.level, gold: p.gold, milestonesBefore: p.milestonesBefore, rewardSignature: JSON.stringify(p.reward) });
      } else if (command === "milestoneEditor") {
        if (!fullGM()) throw new Error(uiText("TOVF.Interface.OnlyTheFullGMRoleCanOpen_968161", "Nur die Rolle Spielleiter darf diesen Editor öffnen."));
        const { GMToolsApp } = await import("../downtime/gm-tools-app.mjs");
        const editor = new GMToolsApp(); editor.actorUuid = target.dataset.uuid; editor.tab = "characters";
        return editor.render({ force: true });
      } else if (command === "history") return SessionService.openMilestoneHistory(target.dataset.uuid);
      else if (command === "openRewards") {
        const ruleId = form.get("applyRule"); const kind = form.get("applyKind");
        const count = state.claims.filter(c => c.kind === kind && c.ruleId !== ruleId).reduce((sum, c) => sum + c.count - state.redemptions.filter(r => r.claimId === c.id && r.status !== "void").length, 0);
        if (!await this.#confirm(uiText("TOVF.Interface.UpdateOpenBalances_e41335", "Offene Guthaben umstellen"), `<p>${uiText("TOVF.Interface.UpdateTheContentsOfP0OpenP1_86141d", "Inhalt von {p0} offenen {p1}-Belohnungen auf die gewählte Regelversion umstellen? Bereits eingelöste und reservierte Belohnungen behalten ihre bisherigen Werte.", { p0: (count), p1: (escape(sourceNames()[kind])) })}</p>`)) return;
        await campaignAction("openRewards", { ...base, ruleId, kind });
      } else if (command === "resolve") {
        const status = form.get(`resolveStatus.${target.dataset.id}`); const reason = form.get(`resolveReason.${target.dataset.id}`);
        if (!await this.#confirm(uiText("TOVF.Interface.CompleteRedemptionAfterReview_5a0ca8", "Einlösung nach Prüfung abschließen"), `<p>${uiText("TOVF.Interface.CheckTheCharacterAndRecordedStepsAnd_169e1e", "Charakter und dokumentierte Schritte prüfen und fehlende Vergaben beziehungsweise Rücknahmen vorher manuell durchführen. Diese Aktion verändert ausschließlich den Buchungsstatus.")}</p>`)) return;
        await campaignAction("resolve", { ...base, redemptionId: target.dataset.id, status, reason });
      }
      await this._renderPreservingView();
    } catch (error) { ui.notifications.error(error.message); }
  }
}

export const openCampaign = () => {
  if (!isCampaignWorld()) return ui.notifications.warn(uiText("TOVF.Interface.RewardManagementIsOnlyAvailableInThe_62a9e7", "Belohnungsverwaltung ist nur in der Hauptwelt verfügbar."));
  return new CampaignApp().render({ force: true });
};
