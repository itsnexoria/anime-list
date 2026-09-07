(function(){
  "use strict";

  var STORAGE_KEY = "watchlog.entries.v1";
  var statusMeta = {
    watching:  { label: "Watching",      color: "var(--watching)" },
    completed: { label: "Completed",     color: "var(--completed)" },
    plan:      { label: "Plan to Watch", color: "var(--plan)" },
    dropped:   { label: "Dropped",       color: "var(--dropped)" }
  };
  var statusOrder = ["watching", "completed", "plan", "dropped"];

  var state = {
    entries: [],
    filterStatus: "all",
    searchQuery: "",
    searchTimer: null,
    addedApiIds: {},
    knownCardIds: {},      // ids already rendered once — used to gate the entrance animation
    lastTouchedEntryId: null,
    lastToggledEps: null,  // {entryId, eps:[...]} — used for the brief "pop" feedback
    draggedId: null,
    sortMode: "manual",
    genreFilter: "",
    tagFilter: "",
    airingInfo: {} // apiId -> { episode, airingAt } — refreshed once per session, not persisted
  };

  // ---------- helpers ----------
  // NOTE: state.entries is populated near the bottom of this file (see "loadEntries()"),
  // but it MUST happen before this point in execution — Stats/Schedule/Discover render
  // themselves once, synchronously, right after their functions are defined, and they'd
  // otherwise always see an empty list. loadEntries/normalizeEntry are plain functions
  // (hoisted), so calling it here — before they're textually defined — is safe.
  state.entries = loadEntries();
  function uid(){
    return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(str){
    if(str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function stripHtml(html){
    if(!html) return "";
    var div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").replace(/\s+\n/g, "\n").trim();
  }

  function pickTitle(titleObj){
    if(!titleObj) return "Untitled";
    return titleObj.english || titleObj.romaji || "Untitled";
  }

  // ---------- episode-tracking helpers ----------
  // Each entry is one season/part — no more nested per-card season list. Adding
  // a different season of a show just means adding it as its own entry (search
  // for it and pick a season label), which keeps things simple to reason about.

  // Keeps entry.length (how many episode cells to render) consistent with
  // entry.total (known episode count) and whatever has already been watched.
  function recomputeLength(entry){
    var maxWatched = entry.watched.length ? Math.max.apply(null, entry.watched) : 0;
    if(entry.total){
      entry.length = entry.total;
      entry.watched = entry.watched.filter(function(n){ return n <= entry.total; });
    } else {
      entry.length = Math.max(entry.length || 0, maxWatched, 12);
    }
  }

  function defaultSeasonLabel(format){
    switch(format){
      case "MOVIE": return "Movie";
      case "OVA": return "OVA";
      case "ONA": return "ONA";
      case "SPECIAL": return "Special";
      default: return "Season 1";
    }
  }

  // After episodes are toggled, gently nudge status — the person can always override manually.
  function autoStatus(entry){
    if(entry.status === "dropped") return;
    var watchedCount = entry.watched.length;
    if(entry.total && watchedCount >= entry.total){
      entry.status = "completed";
    } else if(watchedCount > 0 && entry.status === "plan"){
      entry.status = "watching";
    } else if(watchedCount === 0 && entry.status === "completed"){
      entry.status = "plan";
    }
  }

  // Finds the next episode to mark watched. Returns null once a known total is fully watched.
  function nextUnwatchedEpisode(entry){
    var maxWatched = entry.watched.length ? Math.max.apply(null, entry.watched) : 0;
    var nextEp = maxWatched + 1;
    if(entry.total && nextEp > entry.total) return null;
    return { ep: nextEp };
  }

  function aggregateProgress(entry){
    return { watchedCount: entry.watched.length, totalKnown: entry.total || 0, anyUnknown: !entry.total };
  }

  // ---------- storage & migration ----------
  // Returns an ARRAY of entries from one stored record — usually just one, but a
  // legacy record that had multiple nested seasons gets split into one standalone
  // entry per season, matching the current one-season-per-card model.
  function normalizeEntry(raw){
    var base = {
      id: raw.id || uid(),
      apiId: raw.apiId || raw.malId || null,
      title: raw.title || "Untitled",
      image: raw.image || "",
      banner: raw.banner || "",
      description: raw.description || "",
      genres: Array.isArray(raw.genres) ? raw.genres : [],
      communityScore: (typeof raw.communityScore === "number") ? raw.communityScore : null,
      status: statusMeta[raw.status] ? raw.status : "plan",
      rating: (typeof raw.rating === "number") ? raw.rating : null,
      collapsed: (typeof raw.collapsed === "boolean") ? raw.collapsed : true,
      notes: raw.notes || "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [],
      discovering: false,
      updatedAt: raw.updatedAt || Date.now()
    };

    // Legacy shape: one card held a whole array of seasons. Split each into its own card.
    if(Array.isArray(raw.seasons) && raw.seasons.length){
      return raw.seasons.map(function(s, i){
        var entry = Object.assign({}, base);
        entry.id = (i === 0) ? base.id : uid();
        entry.apiId = s.apiId || base.apiId;
        entry.seasonLabel = s.label || "Season 1";
        entry.sourceTitle = s.sourceTitle || "";
        entry.total = (typeof s.total === "number") ? s.total : null;
        entry.watched = Array.isArray(s.watched) ? s.watched.slice().filter(function(n){ return Number.isFinite(n); }) : [];
        entry.length = (typeof s.length === "number") ? s.length : null;
        entry.duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : null;
        recomputeLength(entry);
        return entry;
      });
    }

    // Even older shape: a single flat episode counter, from before seasons existed.
    if(raw.currentEpisode != null || raw.totalEpisodes != null){
      var cur = Number(raw.currentEpisode) || 0;
      var watchedArr = [];
      for(var i = 1; i <= cur; i++){ watchedArr.push(i); }
      base.seasonLabel = raw.season || "Season 1";
      base.sourceTitle = "";
      base.total = raw.totalEpisodes || null;
      base.watched = watchedArr;
      base.length = null;
      base.duration = null;
      recomputeLength(base);
      return [base];
    }

    // Current flat shape.
    base.seasonLabel = raw.seasonLabel || "Season 1";
    base.sourceTitle = raw.sourceTitle || "";
    base.total = (typeof raw.total === "number") ? raw.total : null;
    base.watched = Array.isArray(raw.watched) ? raw.watched.slice().filter(function(n){ return Number.isFinite(n); }) : [];
    base.length = (typeof raw.length === "number") ? raw.length : null;
    base.duration = (typeof raw.duration === "number" && raw.duration > 0) ? raw.duration : null;
    recomputeLength(base);
    return [base];
  }

  function loadEntries(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return [];
      var parsed = JSON.parse(raw);
      if(!Array.isArray(parsed)) return [];
      var out = [];
      parsed.forEach(function(r){ normalizeEntry(r).forEach(function(e){ out.push(e); }); });
      return out;
    }catch(e){
      console.error("Failed to load entries", e);
      return [];
    }
  }

  function saveEntries(){
    try{
      // discovery in-flight state is transient — don't persist it
      var snapshot = state.entries.map(function(e){
        var copy = Object.assign({}, e);
        delete copy.discovering;
        return copy;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    }catch(e){
      console.error("Failed to save entries", e);
      showToast("Couldn't save — your browser storage may be full.");
    }
  }

  // ---------- toast ----------
  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  function showToast(msg, opts){
    opts = opts || {};
    toastEl.querySelector(".toast-msg").textContent = msg;
    var existingAction = toastEl.querySelector(".toast-action");
    if(existingAction){ existingAction.remove(); }
    if(opts.actionLabel){
      var actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "toast-action";
      actionBtn.textContent = opts.actionLabel;
      actionBtn.addEventListener("click", function(){
        if(opts.onAction){ opts.onAction(); }
        toastEl.classList.remove("show");
        clearTimeout(toastTimer);
      });
      toastEl.appendChild(actionBtn);
    }
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, opts.duration || 2600);
  }

  // ---------- stats & tabs ----------
  var FALLBACK_EP_MINUTES = 24; // typical TV anime episode length, used when AniList has no duration on file (e.g. manual entries)

  function formatWatchTime(totalMinutes){
    if(totalMinutes < 60) return totalMinutes + "m";
    var totalHours = Math.floor(totalMinutes / 60);
    var remM = totalMinutes % 60;
    if(totalHours < 24) return totalHours + "h" + (remM ? " " + remM + "m" : "");
    var days = Math.floor(totalHours / 24);
    var remH = totalHours % 24;
    return days + "d" + (remH ? " " + remH + "h" : "");
  }

  function renderStats(){
    var statsLineEl = document.getElementById("statsLine");
    if(!statsLineEl) return;
    var totalTitles = state.entries.length;
    var totalEpisodes = 0, totalMinutes = 0;
    state.entries.forEach(function(e){
      totalEpisodes += e.watched.length;
      totalMinutes += e.watched.length * (e.duration || FALLBACK_EP_MINUTES);
    });
    statsLineEl.innerHTML =
      '<strong class="stat-pulse">' + totalTitles + "</strong> title" + (totalTitles === 1 ? "" : "s") +
      ' · <strong class="stat-pulse">' + totalEpisodes + "</strong> episode" + (totalEpisodes === 1 ? "" : "s") + " watched" +
      ' · <strong class="stat-pulse">' + formatWatchTime(totalMinutes) + "</strong> watch time";
  }

  function renderTabs(){
    var tabsEl = document.getElementById("tabs");
    if(!tabsEl) return;
    var counts = { all: state.entries.length, watching: 0, completed: 0, plan: 0, dropped: 0 };
    state.entries.forEach(function(e){ if(counts[e.status] != null) counts[e.status]++; });

    var defs = [{ key: "all", label: "All" }].concat(statusOrder.map(function(k){
      return { key: k, label: statusMeta[k].label };
    }));

    tabsEl.innerHTML = defs.map(function(d){
      var active = state.filterStatus === d.key ? " active" : "";
      return '<button class="tab' + active + '" data-filter="' + d.key + '" role="tab" aria-selected="' +
        (state.filterStatus === d.key) + '">' + d.label + " (" + counts[d.key] + ")</button>";
    }).join("");
  }

  // ---------- grid ----------
  function visibleEntries(){
    var list = state.entries.slice();
    if(state.filterStatus !== "all"){
      list = list.filter(function(e){ return e.status === state.filterStatus; });
    }
    if(state.searchQuery){
      var q = state.searchQuery.toLowerCase();
      list = list.filter(function(e){ return e.title.toLowerCase().indexOf(q) !== -1; });
    }
    if(state.genreFilter){
      list = list.filter(function(e){ return (e.genres || []).indexOf(state.genreFilter) !== -1; });
    }
    if(state.tagFilter){
      list = list.filter(function(e){ return (e.tags || []).indexOf(state.tagFilter) !== -1; });
    }
    if(state.sortMode === "title"){
      list.sort(function(a, b){ return a.title.toLowerCase().localeCompare(b.title.toLowerCase()); });
    } else if(state.sortMode === "rating"){
      list.sort(function(a, b){ return (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating); });
    } else if(state.sortMode === "updated"){
      list.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }
    // "manual" mode (default): no sort — order follows state.entries, which drag-and-drop mutates directly
    return list;
  }

  function progressHtml(entry){
    var color = "var(--" + entry.status + ")";
    var agg = aggregateProgress(entry);
    if(!agg.anyUnknown && agg.totalKnown > 0){
      var pct = Math.min(100, Math.round((agg.watchedCount / agg.totalKnown) * 100));
      return '<div class="sprockets"></div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
        '<div class="sprockets"></div>';
    }
    return '<div class="sprockets"></div>' +
      '<div class="progress-track"><div class="progress-indeterminate" style="--bar-color:' + color + ';"></div></div>' +
      '<div class="sprockets"></div>';
  }

  function episodesHtml(entry){
    var total = entry.total;
    var length = entry.length || (total || 12);
    var cells = "";
    for(var i = 1; i <= length; i++){
      var watched = entry.watched.indexOf(i) !== -1;
      var justToggled = state.lastToggledEps && state.lastToggledEps.entryId === entry.id && state.lastToggledEps.eps.indexOf(i) !== -1;
      cells += '<button type="button" class="ep-cell' + (watched ? " watched" : "") + (justToggled ? " ep-pop" : "") + '" data-action="ep-toggle"' +
        ' data-ep="' + i + '" aria-pressed="' + watched + '" title="Episode ' + i + (watched ? " — watched" : " — not watched yet") + '">' + i + "</button>";
    }
    if(!total){
      cells += '<button type="button" class="ep-cell add-ep" data-action="ep-extend" title="Add another episode slot" aria-label="Add episode slot">+</button>';
    }
    var totalLabel = total ? total : "?";
    var aniLink = entry.apiId
      ? '<a class="season-ani-link" href="https://anilist.co/anime/' + encodeURIComponent(entry.apiId) + '" target="_blank" rel="noopener" title="View on AniList">↗</a>'
      : "";
    var titleAttr = entry.sourceTitle ? (' title="' + escapeHtml(entry.sourceTitle) + '"') : "";

    return (
      '<div class="season">' +
        '<div class="season-head">' +
          '<input class="season-label-input" data-action="season-label" value="' + escapeHtml(entry.seasonLabel) + '"' + titleAttr + ' aria-label="Season label">' +
          '<input class="season-total-input" data-action="season-total" type="number" min="0" value="' + (total != null ? total : "") + '" placeholder="eps" aria-label="Total episodes">' +
          aniLink +
        "</div>" +
        '<div class="ep-grid">' + cells + "</div>" +
        '<div class="season-actions">' +
          '<span class="season-progress">' + entry.watched.length + " / " + totalLabel + " watched</span>" +
          '<span class="season-actions-buttons">' +
            '<button type="button" class="btn-link" data-action="season-mark-all">Mark all watched</button>' +
            '<button type="button" class="btn-link" data-action="season-clear-all">Clear all</button>' +
          "</span>" +
        "</div>" +
      "</div>"
    );
  }

  function relevantApiId(entry){
    return entry.apiId || null;
  }

  function formatCountdown(airingAtSeconds){
    var diffMs = airingAtSeconds * 1000 - Date.now();
    if(diffMs <= 0) return null;
    var mins = Math.floor(diffMs / 60000);
    if(mins < 60) return mins + "m";
    var hours = Math.floor(mins / 60);
    var remM = mins % 60;
    if(hours < 24) return hours + "h" + (remM ? " " + remM + "m" : "");
    var days = Math.floor(hours / 24);
    var remH = hours % 24;
    return days + "d" + (remH ? " " + remH + "h" : "");
  }

  function airingChipHtml(entry){
    var id = relevantApiId(entry);
    var info = id != null ? state.airingInfo[id] : null;
    if(!info) return "";
    var countdown = formatCountdown(info.airingAt);
    if(!countdown) return "";
    return '<span class="chip chip-airing">Ep ' + info.episode + " in " + countdown + "</span>";
  }

  var DESC_TRUNCATE = 150;

  function descriptionZoneHtml(entry){
    var chips = airingChipHtml(entry);
    (entry.genres || []).slice(0, 4).forEach(function(g){
      chips += '<span class="chip">' + escapeHtml(g) + "</span>";
    });
    if(entry.communityScore != null){
      chips += '<span class="chip chip-score">AniList ' + entry.communityScore + "%</span>";
    }

    var hasDesc = !!entry.description;
    var text = hasDesc ? entry.description : "No synopsis available yet.";
    var isLong = hasDesc && entry.description.length > DESC_TRUNCATE;

    return (
      '<div class="description-zone">' +
        '<div class="chip-row">' + chips + "</div>" +
        '<div class="description-wrap">' +
          '<p class="description-text' + (hasDesc ? "" : " placeholder") + '">' + escapeHtml(text) + "</p>" +
        "</div>" +
        '<button type="button" class="btn-link desc-toggle" data-action="toggle-description"' +
          (isLong ? "" : ' style="visibility:hidden" tabindex="-1"') + ">Show more</button>" +
      "</div>"
    );
  }

  function cardHtml(entry){
    var isNew = !state.knownCardIds[entry.id];
    state.knownCardIds[entry.id] = true;
    var pulse = (state.lastTouchedEntryId === entry.id) ? " card-pulse" : "";
    var enter = isNew ? " card-enter" : "";

    var bannerStyle = entry.banner ? (' style="background-image:url(\'' + escapeHtml(entry.banner) + '\');"') : "";

    var posterHtml = entry.image
      ? '<img class="poster" src="' + escapeHtml(entry.image) + '" alt="" loading="lazy">'
      : '<div class="poster-fallback" aria-hidden="true">🎬</div>';

    var titleInner = entry.apiId
      ? '<a href="https://anilist.co/anime/' + encodeURIComponent(entry.apiId) + '" target="_blank" rel="noopener">' + escapeHtml(entry.title) + "</a>"
      : escapeHtml(entry.title);

    var statusOptions = statusOrder.map(function(k){
      var sel = entry.status === k ? " selected" : "";
      return '<option value="' + k + '"' + sel + ">" + statusMeta[k].label + "</option>";
    }).join("");

    var ratingBars = "";
    for(var i = 1; i <= 10; i++){
      var filled = entry.rating != null && i <= entry.rating;
      ratingBars += '<button type="button" class="rating-bar' + (filled ? " filled" : "") + '" data-action="rating-bar" data-value="' + i +
        '" aria-label="Rate ' + i + ' out of 10" title="Rate ' + i + "/10\"></button>";
    }
    var ratingText = entry.rating != null ? (entry.rating + "/10") : "Not rated";

    var discoveringHtml = entry.discovering
      ? '<p class="discovering-note">Fetching details…</p>'
      : "";

    var malLink = entry.apiId
      ? '<a class="mal-link" href="https://anilist.co/anime/' + encodeURIComponent(entry.apiId) + '" target="_blank" rel="noopener">View on AniList ↗</a>'
      : "<span></span>";

    var isOpen = !entry.collapsed;

    var nextEp = (entry.status === "dropped") ? null : nextUnwatchedEpisode(entry);
    var quickBumpHtml = nextEp
      ? '<div class="quick-bump">' +
          '<span class="quick-bump-label">Next: Ep ' + nextEp.ep + "</span>" +
          '<button type="button" class="quick-bump-btn" data-action="quick-bump" data-ep="' + nextEp.ep + '">+ Mark watched</button>' +
        "</div>"
      : (entry.status !== "dropped" ? '<div class="quick-bump quick-bump-done"><span class="quick-bump-label">All caught up ✓</span></div>' : "");

    return (
      '<article class="card' + pulse + enter + '" draggable="true" data-id="' + entry.id + '" data-status="' + entry.status + '">' +
        '<div class="card-banner"' + bannerStyle + '>' +
          '<span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span>' +
        "</div>" +
        '<div class="card-top">' +
          posterHtml +
          '<div class="card-meta">' +
            '<h3 class="card-title">' + titleInner + "</h3>" +
            '<div class="card-meta-row">' +
              '<select class="status-select" data-action="status" data-status="' + entry.status + '">' + statusOptions + "</select>" +
              '<div class="rating">' +
                '<div class="rating-bars">' + ratingBars + "</div>" +
                '<span class="rating-text">' + ratingText + "</span>" +
              "</div>" +
            "</div>" +
          "</div>" +
        "</div>" +
        progressHtml(entry) +
        quickBumpHtml +
        '<div class="card-body">' +
          descriptionZoneHtml(entry) +
          discoveringHtml +
          '<div class="body-spacer"></div>' +
          '<button type="button" class="details-toggle" data-action="toggle-collapse" aria-expanded="' + isOpen + '">' +
            '<span class="details-toggle-label">' + (isOpen ? "Hide episodes" : "Show episodes") + "</span>" +
            '<span class="chevron">▾</span>' +
          "</button>" +
          '<div class="card-collapsible' + (isOpen ? " open" : "") + '">' +
            '<div class="collapsible-inner">' +
              '<div class="section-label">Episodes</div>' +
              episodesHtml(entry) +
              '<div class="notes-zone">' +
                '<div class="section-label">Your notes</div>' +
                '<textarea class="notes-input" data-action="notes" placeholder="Thoughts, rewatch plans, where you left off…">' + escapeHtml(entry.notes) + "</textarea>" +
              "</div>" +
              '<div class="tags-zone">' +
                '<div class="section-label">Tags</div>' +
                '<div class="tag-chip-row">' +
                  (entry.tags || []).map(function(t){
                    return '<span class="chip tag-chip">' + escapeHtml(t) +
                      '<button type="button" class="tag-remove" data-action="remove-tag" data-tag="' + escapeHtml(t) + '" aria-label="Remove tag">&times;</button></span>';
                  }).join("") +
                "</div>" +
                '<input type="text" class="tag-input" data-action="tag-input" placeholder="Add a tag, press Enter">' +
              "</div>" +
              '<div class="card-footer">' +
                malLink +
                '<button type="button" class="remove-btn" data-action="remove-anime">Remove</button>' +
              "</div>" +
            "</div>" +
          "</div>" +
        "</div>" +
      "</article>"
    );
  }

  function renderGrid(){
    var grid = document.getElementById("grid");
    if(!grid) return;
    var list = visibleEntries();

    if(state.entries.length === 0){
      grid.innerHTML =
        '<div class="empty-state">' +
          '<div class="big">Your log is empty</div>' +
          "<p>Search for the first anime you've watched and start tracking your progress.</p>" +
          '<button class="btn btn-primary" id="emptyAddBtn">+ Add Anime</button>' +
        "</div>";
      var btn = document.getElementById("emptyAddBtn");
      if(btn) btn.addEventListener("click", openModal);
      state.lastTouchedEntryId = null;
      state.lastToggledEps = null;
      return;
    }

    if(list.length === 0){
      grid.innerHTML = '<div class="empty-state"><div class="big">No matches</div><p>Try a different filter or search term.</p></div>';
      state.lastTouchedEntryId = null;
      state.lastToggledEps = null;
      return;
    }

    grid.innerHTML = list.map(cardHtml).join("");
    // one-shot animation flags consumed — clear so they don't replay on unrelated re-renders
    state.lastTouchedEntryId = null;
    state.lastToggledEps = null;
  }

  function render(){
    renderStats();
    renderTabs();
    renderGrid();
    refreshFilterOptions();
  }

  function refreshFilterOptions(){
    var genreSel = document.getElementById("genreFilterSelect");
    var tagSel = document.getElementById("tagFilterSelect");
    if(!genreSel || !tagSel) return;

    var genreSet = {}, tagSet = {};
    state.entries.forEach(function(e){
      (e.genres || []).forEach(function(g){ genreSet[g] = true; });
      (e.tags || []).forEach(function(t){ tagSet[t] = true; });
    });
    var genres = Object.keys(genreSet).sort(function(a, b){ return a.localeCompare(b); });
    var tags = Object.keys(tagSet).sort(function(a, b){ return a.localeCompare(b); });

    var keepGenre = genres.indexOf(state.genreFilter) !== -1 ? state.genreFilter : "";
    genreSel.innerHTML = '<option value="">All genres</option>' +
      genres.map(function(g){ return '<option value="' + escapeHtml(g) + '"' + (g === keepGenre ? " selected" : "") + ">" + escapeHtml(g) + "</option>"; }).join("");
    state.genreFilter = keepGenre;

    var keepTag = tags.indexOf(state.tagFilter) !== -1 ? state.tagFilter : "";
    tagSel.innerHTML = '<option value="">All tags</option>' +
      tags.map(function(t){ return '<option value="' + escapeHtml(t) + '"' + (t === keepTag ? " selected" : "") + ">" + escapeHtml(t) + "</option>"; }).join("");
    state.tagFilter = keepTag;
  }


  // ---------- entry mutations ----------
  function findEntry(id){
    return state.entries.find(function(e){ return e.id === id; });
  }

  function addEntry(data){
    var entry = {
      id: uid(),
      apiId: data.apiId || null,
      title: data.title,
      image: data.image || "",
      banner: "",
      description: "",
      genres: [],
      communityScore: null,
      status: "plan",
      rating: null,
      collapsed: true,
      notes: "",
      tags: [],
      seasonLabel: (data.seasonLabel && data.seasonLabel.trim()) || defaultSeasonLabel(data.format),
      sourceTitle: "",
      total: data.episodes || null,
      watched: [],
      length: null,
      duration: (typeof data.duration === "number" && data.duration > 0) ? data.duration : null,
      discovering: !!data.apiId,
      updatedAt: Date.now()
    };
    recomputeLength(entry);
    state.entries.push(entry);
    saveEntries();
    render();
    if(data.apiId){ runDiscovery(entry.id, data.apiId); }
    return entry;
  }

  function removeEntry(id){
    var entry = findEntry(id);
    if(!entry) return;
    var idx = state.entries.indexOf(entry);
    state.entries.splice(idx, 1);
    delete state.knownCardIds[id];
    saveEntries();
    render();
    showToast('Removed "' + entry.title + '".', {
      actionLabel: "Undo",
      duration: 5000,
      onAction: function(){
        state.entries.splice(idx, 0, entry);
        state.knownCardIds[id] = true; // skip the entrance animation on restore
        saveEntries();
        render();
      }
    });
  }

  // Moves draggedId next to targetId in the master array. Works regardless of any active
  // filter/search, since those only ever render a sub-view of state.entries' own order.
  function reorderEntries(draggedId, targetId, insertAfter){
    if(draggedId === targetId) return;
    var fromIdx = state.entries.findIndex(function(e){ return e.id === draggedId; });
    if(fromIdx === -1) return;
    var item = state.entries.splice(fromIdx, 1)[0];
    var toIdx = state.entries.findIndex(function(e){ return e.id === targetId; });
    if(toIdx === -1){ state.entries.splice(fromIdx, 0, item); return; } // target vanished — put it back
    var insertIdx = insertAfter ? toIdx + 1 : toIdx;
    state.entries.splice(insertIdx, 0, item);
    saveEntries();
    render();
  }

  // ---------- AniList detail + relation-chain discovery ----------
  function fetchMediaDetail(id){
    var gql =
      "query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } " +
      "description(asHtml: true) coverImage { large medium } bannerImage episodes duration format seasonYear genres averageScore } }";

    return fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: gql, variables: { id: id } })
    }).then(function(res){
      if(!res.ok){ throw new Error("bad-response"); }
      return res.json();
    }).then(function(json){
      if(json.errors || !json.data || !json.data.Media){ throw new Error("api-error"); }
      return json.data.Media;
    });
  }

  // Fills in description/genres/cover/episode-count for the one show that was added.
  // Deliberately does NOT walk AniList's prequel/sequel chain or create extra seasons —
  // if you want a different season of a show tracked, search for it and add it as its
  // own entry (with its own season label), rather than having it auto-merged in here.
  function runDiscovery(entryId, apiId){
    fetchMediaDetail(apiId).then(function(root){
      var entry = findEntry(entryId);
      if(!entry) return; // removed while we were looking it up

      entry.description = stripHtml(root.description || "");
      entry.genres = root.genres || [];
      entry.communityScore = (typeof root.averageScore === "number") ? root.averageScore : null;
      entry.banner = root.bannerImage || "";
      if(!entry.image && root.coverImage){ entry.image = root.coverImage.large || root.coverImage.medium || ""; }
      if(!entry.total && root.episodes){ entry.total = root.episodes; recomputeLength(entry); }
      if(!entry.duration && root.duration){ entry.duration = root.duration; }
      entry.sourceTitle = pickTitle(root.title);

      entry.discovering = false;
      entry.updatedAt = Date.now();
      autoStatus(entry);
      saveEntries();
      render();
    }).catch(function(){
      var entry = findEntry(entryId);
      if(entry){
        entry.discovering = false;
        saveEntries();
        render();
      }
    });
  }

  // ---------- grid: click delegation ----------
  // Everything from here through the end of the toolbar/filter listeners only applies
  // to the main list page — pages without a #grid (Stats/Schedule/Discover/Settings) skip it entirely.
  if(document.getElementById("grid")){
  document.getElementById("grid").addEventListener("click", function(ev){
    // description expand/collapse is purely local UI state — no re-render needed
    var descToggle = ev.target.closest('[data-action="toggle-description"]');
    if(descToggle){
      var zone = descToggle.closest(".description-zone");
      var wrap = zone.querySelector(".description-wrap");
      var expanded = wrap.classList.toggle("expanded");
      descToggle.textContent = expanded ? "Show less" : "Show more";
      return;
    }

    // seasons/episodes collapse toggle — also a local DOM toggle, so the open/close animates smoothly
    var collapseToggle = ev.target.closest('[data-action="toggle-collapse"]');
    if(collapseToggle){
      var cardEl = collapseToggle.closest(".card");
      var collapsible = cardEl.querySelector(".card-collapsible");
      var isOpen = collapsible.classList.toggle("open");
      collapseToggle.setAttribute("aria-expanded", String(isOpen));
      var label = collapseToggle.querySelector(".details-toggle-label");
      if(label) label.textContent = isOpen ? "Hide episodes" : "Show episodes";
      var entryForCollapse = findEntry(cardEl.getAttribute("data-id"));
      if(entryForCollapse){
        entryForCollapse.collapsed = !isOpen;
        saveEntries(); // persist the preference without triggering a full re-render
      }
      return;
    }

    var actionEl = ev.target.closest("[data-action]");
    if(!actionEl) return;
    var card = ev.target.closest(".card");
    if(!card) return;
    var entry = findEntry(card.getAttribute("data-id"));
    if(!entry) return;

    var action = actionEl.getAttribute("data-action");

    if(action === "remove-anime"){
      removeEntry(entry.id);

    } else if(action === "quick-bump"){
      var bumpEp = parseInt(actionEl.getAttribute("data-ep"), 10);
      if(!entry.total && bumpEp > (entry.length || 0)){ entry.length = bumpEp; } // make room in the grid if needed
      if(entry.watched.indexOf(bumpEp) === -1){ entry.watched.push(bumpEp); }
      entry.watched.sort(function(a, b){ return a - b; });
      autoStatus(entry);
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      state.lastToggledEps = { entryId: entry.id, eps: [bumpEp] };
      saveEntries(); render();

    } else if(action === "rating-bar"){
      var val = parseInt(actionEl.getAttribute("data-value"), 10);
      entry.rating = (entry.rating === val) ? null : val;
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "ep-toggle"){
      var ep = parseInt(actionEl.getAttribute("data-ep"), 10);
      var idx = entry.watched.indexOf(ep);
      if(idx === -1){
        // marking watched — fill in any earlier gaps too, so progress reads as "watched through ep N"
        var newlyFilled = [];
        for(var fillEp = 1; fillEp <= ep; fillEp++){
          if(entry.watched.indexOf(fillEp) === -1){ entry.watched.push(fillEp); newlyFilled.push(fillEp); }
        }
        state.lastToggledEps = { entryId: entry.id, eps: newlyFilled };
      } else {
        entry.watched.splice(idx, 1);
        state.lastToggledEps = null;
      }
      entry.watched.sort(function(a, b){ return a - b; });
      autoStatus(entry);
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "ep-extend"){
      entry.length = (entry.length || 12) + 1;
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "season-mark-all"){
      var len = entry.total || entry.length || 12;
      var arr = [];
      for(var i = 1; i <= len; i++){ arr.push(i); }
      entry.watched = arr;
      autoStatus(entry);
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "season-clear-all"){
      entry.watched = [];
      autoStatus(entry);
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "remove-tag"){
      var tagToRemove = actionEl.getAttribute("data-tag");
      entry.tags = (entry.tags || []).filter(function(t){ return t !== tagToRemove; });
      entry.updatedAt = Date.now();
      saveEntries(); render();
    }
  });

  document.getElementById("grid").addEventListener("keydown", function(ev){
    if(!ev.target.classList || !ev.target.classList.contains("tag-input")) return;
    if(ev.key !== "Enter") return;
    ev.preventDefault();
    var card = ev.target.closest(".card");
    if(!card) return;
    var entry = findEntry(card.getAttribute("data-id"));
    if(!entry) return;
    var val = ev.target.value.trim();
    if(!val) return;
    entry.tags = entry.tags || [];
    if(entry.tags.indexOf(val) === -1){ entry.tags.push(val); }
    entry.updatedAt = Date.now();
    state.lastTouchedEntryId = entry.id;
    saveEntries(); render();
  });

  // ---------- grid: change delegation (text/number/select inputs) ----------
  document.getElementById("grid").addEventListener("change", function(ev){
    var card = ev.target.closest(".card");
    if(!card) return;
    var entry = findEntry(card.getAttribute("data-id"));
    if(!entry) return;

    var action = ev.target.getAttribute("data-action");

    if(action === "status"){
      entry.status = ev.target.value;
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "notes"){
      entry.notes = ev.target.value;
      entry.updatedAt = Date.now();
      saveEntries(); render();

    } else if(action === "season-label"){
      entry.seasonLabel = ev.target.value.trim() || entry.seasonLabel;
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();

    } else if(action === "season-total"){
      var v = ev.target.value;
      entry.total = v ? Math.max(0, parseInt(v, 10)) : null;
      recomputeLength(entry);
      autoStatus(entry);
      entry.updatedAt = Date.now();
      state.lastTouchedEntryId = entry.id;
      saveEntries(); render();
    }
  });

  // ---------- drag-and-drop reordering ----------
  // Drag is only allowed to start from the grip handle — dragstart is cancelled otherwise,
  // so buttons, inputs, and links inside the card keep working normally.
  var grid = document.getElementById("grid");

  grid.addEventListener("dragstart", function(ev){
    var card = ev.target.closest(".card");
    if(!card) return;
    var handle = ev.target.closest(".drag-handle");
    if(!handle){ ev.preventDefault(); return; }
    if(state.sortMode !== "manual"){
      ev.preventDefault();
      showToast('Switch to "Manual order" to drag and reorder.');
      return;
    }
    state.draggedId = card.getAttribute("data-id");
    card.classList.add("dragging");
    ev.dataTransfer.effectAllowed = "move";
    try{ ev.dataTransfer.setData("text/plain", state.draggedId); }catch(e){ /* some browsers are picky here — harmless */ }
  });

  grid.addEventListener("dragover", function(ev){
    if(!state.draggedId) return;
    var targetCard = ev.target.closest(".card");
    if(!targetCard) return;
    ev.preventDefault(); // required to allow dropping
    Array.prototype.forEach.call(grid.querySelectorAll(".drag-over-top, .drag-over-bottom"), function(c){
      c.classList.remove("drag-over-top", "drag-over-bottom");
    });
    if(targetCard.getAttribute("data-id") === state.draggedId) return;
    var rect = targetCard.getBoundingClientRect();
    var after = (ev.clientY - rect.top) > rect.height / 2;
    targetCard.classList.add(after ? "drag-over-bottom" : "drag-over-top");
  });

  grid.addEventListener("drop", function(ev){
    if(!state.draggedId) return;
    var targetCard = ev.target.closest(".card");
    if(!targetCard) return;
    ev.preventDefault();
    var targetId = targetCard.getAttribute("data-id");
    var rect = targetCard.getBoundingClientRect();
    var after = (ev.clientY - rect.top) > rect.height / 2;
    reorderEntries(state.draggedId, targetId, after);
    state.draggedId = null;
  });

  grid.addEventListener("dragend", function(){
    Array.prototype.forEach.call(grid.querySelectorAll(".dragging"), function(c){ c.classList.remove("dragging"); });
    Array.prototype.forEach.call(grid.querySelectorAll(".drag-over-top, .drag-over-bottom"), function(c){
      c.classList.remove("drag-over-top", "drag-over-bottom");
    });
    state.draggedId = null;
  });


  document.getElementById("tabs").addEventListener("click", function(ev){
    var btn = ev.target.closest(".tab");
    if(!btn) return;
    state.filterStatus = btn.getAttribute("data-filter");
    renderTabs();
    renderGrid();
  });

  document.getElementById("searchMine").addEventListener("input", function(ev){
    state.searchQuery = ev.target.value.trim();
    renderGrid();
  });

  document.getElementById("sortSelect").addEventListener("change", function(ev){
    state.sortMode = ev.target.value;
    renderGrid();
  });

  document.getElementById("genreFilterSelect").addEventListener("change", function(ev){
    state.genreFilter = ev.target.value;
    renderGrid();
  });

  document.getElementById("tagFilterSelect").addEventListener("change", function(ev){
    state.tagFilter = ev.target.value;
    renderGrid();
  });

  document.getElementById("randomPickBtn").addEventListener("click", function(){
    if(state.entries.length === 0){
      showToast("Add something to your log first!");
      return;
    }
    var pool = state.entries.filter(function(e){ return e.status === "plan"; });
    if(pool.length === 0){ pool = state.entries.filter(function(e){ return e.status === "watching"; }); }
    if(pool.length === 0){ pool = state.entries.slice(); }
    var pick = pool[Math.floor(Math.random() * pool.length)];

    state.filterStatus = "all";
    state.searchQuery = "";
    document.getElementById("searchMine").value = "";
    renderTabs();
    renderGrid();

    var el = document.querySelector('.card[data-id="' + pick.id + '"]');
    if(el){
      if(typeof el.scrollIntoView === "function"){ el.scrollIntoView({ behavior: "smooth", block: "center" }); }
      el.classList.add("pick-highlight");
      setTimeout(function(){ el.classList.remove("pick-highlight"); }, 1800);
    }
    showToast('How about "' + pick.title + '"?');
  });
  } // end grid/toolbar guard

  // ---------- modal: add anime ----------
  var modalBackdrop = document.getElementById("modalBackdrop");
  var searchInput = document.getElementById("searchInput");
  var resultsList = document.getElementById("resultsList");
  var searchStatus = document.getElementById("searchStatus");

  function openModal(){
    modalBackdrop.classList.add("open");
    state.addedApiIds = {};
    resultsList.innerHTML = "";
    searchStatus.textContent = "";
    searchInput.value = "";
    document.getElementById("manualForm").classList.remove("open");
    document.getElementById("manualTitle").value = "";
    document.getElementById("manualTotal").value = "";
    document.getElementById("manualImage").value = "";
    document.getElementById("bulkForm").classList.remove("open");
    document.getElementById("bulkTitlesInput").value = "";
    document.getElementById("bulkStatus").textContent = "";
    setTimeout(function(){ searchInput.focus(); }, 30);
  }
  function closeModal(){
    modalBackdrop.classList.remove("open");
  }

  // Global keyboard shortcuts/Escape handling — runs on every page, but most branches
  // are no-ops (via the element-existence checks) on pages without these controls.
  document.addEventListener("keydown", function(ev){
    if(ev.key === "Escape"){
      if(modalBackdrop && modalBackdrop.classList.contains("open")) closeModal();
      if(importModalBackdrop && importModalBackdrop.classList.contains("open")) closeImportModal();
      return;
    }

    var tag = document.activeElement ? document.activeElement.tagName : "";
    var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      (document.activeElement && document.activeElement.isContentEditable);
    if(typing) return;
    if((modalBackdrop && modalBackdrop.classList.contains("open")) || (importModalBackdrop && importModalBackdrop.classList.contains("open"))) return;

    if(ev.key === "/"){
      var searchEl = document.getElementById("searchMine");
      if(searchEl){ ev.preventDefault(); searchEl.focus(); }
    } else if(ev.key === "n" || ev.key === "N"){
      if(document.getElementById("modalBackdrop")){ ev.preventDefault(); openModal(); }
    } else if(ev.key === "r" || ev.key === "R"){
      var randomBtn = document.getElementById("randomPickBtn");
      if(randomBtn){ ev.preventDefault(); randomBtn.click(); }
    }
  });

  // The rest of the Add Anime modal (buttons, manual-add form, live search) only exists on index.html.
  if(modalBackdrop){
  document.getElementById("openAddBtn").addEventListener("click", openModal);
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", function(ev){
    if(ev.target === modalBackdrop) closeModal();
  });

  document.getElementById("manualToggle").addEventListener("click", function(ev){
    ev.preventDefault();
    document.getElementById("manualForm").classList.toggle("open");
  });

  document.getElementById("manualAddBtn").addEventListener("click", function(){
    var title = document.getElementById("manualTitle").value.trim();
    if(!title){
      showToast("Give it a title first.");
      return;
    }
    var totalRaw = document.getElementById("manualTotal").value;
    var image = document.getElementById("manualImage").value.trim();
    var seasonLabelEl = document.getElementById("addSeasonLabel");
    addEntry({
      title: title,
      episodes: totalRaw ? Math.max(0, parseInt(totalRaw, 10)) : null,
      image: image,
      format: "",
      seasonLabel: seasonLabelEl ? seasonLabelEl.value.trim() : ""
    });
    showToast('Added "' + title + '" to your log.');
    document.getElementById("manualTitle").value = "";
    document.getElementById("manualTotal").value = "";
    document.getElementById("manualImage").value = "";
    if(seasonLabelEl){ seasonLabelEl.value = ""; }
  });

  document.getElementById("bulkToggle").addEventListener("click", function(ev){
    ev.preventDefault();
    document.getElementById("bulkForm").classList.toggle("open");
  });

  // Same AniList search as the live box above, but perPage:1 — bulk add takes the single best match
  // per line rather than making the user pick, since picking 20 times would defeat the point.
  function searchAniListTopMatch(query){
    var gql =
      "query ($s: String) { Page(perPage: 1) { media(search: $s, type: ANIME, sort: SEARCH_MATCH) { " +
      "id title { romaji english } coverImage { large medium } episodes duration format seasonYear } } }";

    return fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: gql, variables: { s: query } })
    })
      .then(function(res){
        if(res.status === 429){ throw new Error("rate-limited"); }
        if(!res.ok){ throw new Error("bad-response"); }
        return res.json();
      })
      .then(function(json){
        if(json.errors){ throw new Error("api-error"); }
        var m = json.data && json.data.Page && json.data.Page.media && json.data.Page.media[0];
        if(!m) return null;
        return {
          apiId: m.id,
          title: pickTitle(m.title),
          image: m.coverImage ? (m.coverImage.large || m.coverImage.medium || "") : "",
          episodes: m.episodes || null,
          duration: m.duration || null,
          format: m.format || "",
          year: m.seasonYear || null
        };
      });
  }

  document.getElementById("bulkAddBtn").addEventListener("click", function(){
    var bulkBtn = document.getElementById("bulkAddBtn");
    var statusEl = document.getElementById("bulkStatus");
    var titles = document.getElementById("bulkTitlesInput").value
      .split("\n")
      .map(function(s){ return s.trim(); })
      .filter(Boolean);

    if(titles.length === 0){
      statusEl.textContent = "Paste at least one title first, one per line.";
      return;
    }

    bulkBtn.disabled = true;
    var added = [], skipped = [], notFound = [];
    var i = 0;

    function finish(){
      bulkBtn.disabled = false;
      bulkBtn.textContent = "Search & add all";
      var parts = [];
      if(added.length) parts.push(added.length + " added");
      if(skipped.length) parts.push(skipped.length + " already in your log");
      if(notFound.length) parts.push(notFound.length + " not found (" + notFound.join(", ") + ")");
      statusEl.textContent = parts.join(" · ");
      if(added.length) showToast("Bulk-added " + added.length + " title" + (added.length === 1 ? "" : "s") + " — fetching details…");
    }

    function next(){
      if(i >= titles.length){ finish(); return; }
      var title = titles[i];
      bulkBtn.textContent = "Adding " + (i + 1) + "/" + titles.length + "…";
      statusEl.textContent = 'Searching "' + title + '"…';
      searchAniListTopMatch(title)
        .then(function(item){
          if(!item){
            notFound.push(title);
          } else if(state.entries.some(function(e){ return e.apiId === item.apiId; })){
            skipped.push(title);
          } else {
            addEntry(item);
            added.push(item.title);
          }
        })
        .catch(function(){ notFound.push(title); })
        .then(function(){
          i++;
          // AniList's public API rate-limits fairly aggressively — a short gap between
          // requests keeps a long paste from tripping a 429 partway through.
          setTimeout(next, 400);
        });
    }
    next();
  });

  function resultRowHtml(item, index){
    var img = item.image
      ? '<img src="' + escapeHtml(item.image) + '" alt="">'
      : '<div class="poster-fallback" aria-hidden="true">🎬</div>';
    var sub = [item.format, item.year, item.episodes ? (item.episodes + " ep") : "ongoing/unknown"]
      .filter(Boolean).join(" · ");
    var already = state.entries.some(function(e){ return e.apiId === item.apiId; }) || state.addedApiIds[item.apiId];
    return (
      '<div class="result-row" style="animation-delay:' + Math.min(index * 40, 280) + 'ms">' +
        img +
        '<div class="result-info">' +
          '<div class="result-title">' + escapeHtml(item.title) + "</div>" +
          '<div class="result-sub">' + escapeHtml(sub) + "</div>" +
        "</div>" +
        '<button type="button" class="result-add-btn" data-apiid="' + item.apiId + '"' + (already ? " disabled" : "") + ">" +
          (already ? "Added ✓" : "Add") +
        "</button>" +
      "</div>"
    );
  }

  var lastResults = [];
  function renderResults(items){
    lastResults = items;
    if(items.length === 0){
      resultsList.innerHTML = "";
      searchStatus.textContent = "No matches. Try a different spelling, or add it manually below.";
      return;
    }
    searchStatus.textContent = "";
    resultsList.innerHTML = items.map(resultRowHtml).join("");
  }

  resultsList.addEventListener("click", function(ev){
    var btn = ev.target.closest(".result-add-btn");
    if(!btn || btn.disabled) return;
    var apiId = btn.getAttribute("data-apiid");
    var item = lastResults.find(function(r){ return String(r.apiId) === String(apiId); });
    if(!item) return;
    var seasonLabelEl = document.getElementById("addSeasonLabel");
    if(seasonLabelEl && seasonLabelEl.value.trim()){ item = Object.assign({}, item, { seasonLabel: seasonLabelEl.value.trim() }); }
    addEntry(item);
    state.addedApiIds[item.apiId] = true;
    btn.disabled = true;
    btn.textContent = "Added ✓";
    showToast('Added "' + item.title + '" to your log — fetching details…');
    if(seasonLabelEl){ seasonLabelEl.value = ""; }
  });

  // AniList GraphQL search — public, CORS-enabled, no API key required.
  function searchAniList(query){
    searchStatus.textContent = "Searching…";
    resultsList.innerHTML = "";

    var gql =
      "query ($s: String) { Page(perPage: 8) { media(search: $s, type: ANIME, sort: SEARCH_MATCH) { " +
      "id title { romaji english } coverImage { large medium } episodes duration format seasonYear } } }";

    fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: gql, variables: { s: query } })
    })
      .then(function(res){
        if(res.status === 429){ throw new Error("rate-limited"); }
        if(!res.ok){ throw new Error("bad-response"); }
        return res.json();
      })
      .then(function(json){
        if(json.errors){ throw new Error("api-error"); }
        var media = (json.data && json.data.Page && json.data.Page.media) || [];
        var items = media.map(function(m){
          return {
            apiId: m.id,
            title: pickTitle(m.title),
            image: m.coverImage ? (m.coverImage.large || m.coverImage.medium || "") : "",
            episodes: m.episodes || null,
            duration: m.duration || null,
            format: m.format || "",
            year: m.seasonYear || null
          };
        });
        renderResults(items);
      })
      .catch(function(err){
        if(err.message === "rate-limited"){
          searchStatus.textContent = "Searching too fast — wait a second and try again.";
        } else {
          searchStatus.textContent = "Couldn't reach the anime database right now. You can add it manually below.";
        }
      });
  }

  searchInput.addEventListener("input", function(){
    var q = searchInput.value.trim();
    clearTimeout(state.searchTimer);
    if(q.length < 2){
      resultsList.innerHTML = "";
      searchStatus.textContent = "";
      return;
    }
    state.searchTimer = setTimeout(function(){ searchAniList(q); }, 450);
  });
  } // end Add Anime modal guard

  // ---------- stats dashboard ----------
  function statBarRow(label, count, max){
    var pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return (
      '<div class="stat-bar-row">' +
        '<span class="stat-bar-label">' + escapeHtml(label) + "</span>" +
        '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="stat-bar-count">' + count + "</span>" +
      "</div>"
    );
  }

  function renderStatsPage(){
    var body = document.getElementById("statsPageBody");
    if(!body) return;
    if(state.entries.length === 0){
      body.innerHTML = '<p class="search-status">Add a few titles first, then come back here.</p>';
      return;
    }

    var statusCounts = { watching: 0, completed: 0, plan: 0, dropped: 0 };
    var genreCounts = {};
    var ratingCounts = {};
    var ratedCount = 0, ratingSum = 0;
    var totalEpisodes = 0, totalMinutes = 0;

    state.entries.forEach(function(e){
      statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
      (e.genres || []).forEach(function(g){ genreCounts[g] = (genreCounts[g] || 0) + 1; });
      if(e.rating != null){ ratedCount++; ratingSum += e.rating; ratingCounts[e.rating] = (ratingCounts[e.rating] || 0) + 1; }
      totalEpisodes += e.watched.length;
      totalMinutes += e.watched.length * (e.duration || FALLBACK_EP_MINUTES);
    });

    var statusMax = Math.max.apply(null, statusOrder.map(function(k){ return statusCounts[k] || 0; }).concat([1]));
    var statusHtml = statusOrder.map(function(k){ return statBarRow(statusMeta[k].label, statusCounts[k] || 0, statusMax); }).join("");

    var genreEntries = Object.keys(genreCounts).map(function(g){ return { name: g, count: genreCounts[g] }; })
      .sort(function(a, b){ return b.count - a.count; }).slice(0, 8);
    var genreMax = genreEntries.length ? genreEntries[0].count : 1;
    var genreHtml = genreEntries.length
      ? genreEntries.map(function(g){ return statBarRow(g.name, g.count, genreMax); }).join("")
      : '<p class="search-status">No genre data yet — genres fill in automatically when you add titles via search.</p>';

    var ratingMax = Math.max.apply(null, [1].concat(Object.keys(ratingCounts).map(function(k){ return ratingCounts[k]; })));
    var ratingHtml = "";
    for(var r = 10; r >= 1; r--){
      ratingHtml += statBarRow(r + "/10", ratingCounts[r] || 0, ratingMax);
    }

    var avgRating = ratedCount > 0 ? (ratingSum / ratedCount).toFixed(1) : "—";
    var topGenre = genreEntries.length ? genreEntries[0].name : "—";

    body.innerHTML =
      '<div class="stats-highlights">' +
        '<div class="stat-highlight"><span class="stat-highlight-num">' + state.entries.length + '</span><span>titles</span></div>' +
        '<div class="stat-highlight"><span class="stat-highlight-num">' + totalEpisodes + '</span><span>episodes</span></div>' +
        '<div class="stat-highlight"><span class="stat-highlight-num">' + formatWatchTime(totalMinutes) + '</span><span>watch time</span></div>' +
        '<div class="stat-highlight"><span class="stat-highlight-num">' + avgRating + '</span><span>avg rating</span></div>' +
        '<div class="stat-highlight"><span class="stat-highlight-num">' + escapeHtml(topGenre) + '</span><span>top genre</span></div>' +
      "</div>" +
      '<div class="section-label">By status</div>' + statusHtml +
      '<div class="section-label">Top genres</div>' + genreHtml +
      '<div class="section-label">Your ratings</div>' + ratingHtml;
  }
  renderStatsPage();


  // ---------- import from AniList (index.html only) ----------
  // declared here (unconditionally) since the Escape-key handler above needs to reach it
  // regardless of strict-mode block-scoping for function declarations inside `if(){}`
  var importModalBackdrop = document.getElementById("importModalBackdrop");
  function closeImportModal(){
    if(importModalBackdrop){ importModalBackdrop.classList.remove("open"); }
  }

  if(document.getElementById("importModalBackdrop")){
  var importUsernameInput = document.getElementById("importUsernameInput");
  var importStatusEl = document.getElementById("importStatus");
  var importPreviewEl = document.getElementById("importPreview");
  var pendingImportItems = [];

  var IMPORT_STATUS_MAP = {
    CURRENT: "watching", REPEATING: "watching", PLANNING: "plan",
    COMPLETED: "completed", DROPPED: "dropped", PAUSED: "watching"
  };

  function normalizeImportScore(score){
    if(!score) return null;
    var n = score <= 10 ? Math.round(score) : Math.round(score / 10);
    return Math.max(0, Math.min(10, n)) || null;
  }

  function openImportModal(){
    importModalBackdrop.classList.add("open");
    importUsernameInput.value = "";
    importStatusEl.textContent = "";
    importPreviewEl.innerHTML = "";
    pendingImportItems = [];
    setTimeout(function(){ importUsernameInput.focus(); }, 30);
  }

  document.getElementById("importAniListBtn").addEventListener("click", openImportModal);
  document.getElementById("closeImportModalBtn").addEventListener("click", closeImportModal);
  importModalBackdrop.addEventListener("click", function(ev){
    if(ev.target === importModalBackdrop) closeImportModal();
  });
  importUsernameInput.addEventListener("keydown", function(ev){
    if(ev.key === "Enter"){ ev.preventDefault(); document.getElementById("importFetchBtn").click(); }
  });

  function renderImportPreview(flatEntries){
    var existingIds = {};
    state.entries.forEach(function(e){ if(e.apiId != null){ existingIds[e.apiId] = true; } });

    var fresh = flatEntries.filter(function(e){ return !existingIds[e.media.id]; });
    var skipped = flatEntries.length - fresh.length;
    pendingImportItems = fresh;

    importStatusEl.textContent = "";
    var summary = '<p class="import-summary">Found ' + flatEntries.length + " title" + (flatEntries.length === 1 ? "" : "s") + ". " +
      fresh.length + " new, " + skipped + " already in your log.</p>";

    if(fresh.length === 0){
      importPreviewEl.innerHTML = summary + '<p class="search-status">Nothing new to import.</p>';
      return;
    }

    var rows = fresh.slice(0, 30).map(function(e){
      var label = statusMeta[IMPORT_STATUS_MAP[e.status] || "plan"].label;
      return '<div class="import-list-row"><span>' + escapeHtml(pickTitle(e.media.title)) + "</span><span>" + label + "</span></div>";
    }).join("");
    var more = fresh.length > 30 ? '<div class="import-list-row skip">…and ' + (fresh.length - 30) + " more</div>" : "";

    importPreviewEl.innerHTML = summary +
      '<div class="import-list">' + rows + more + "</div>" +
      '<button type="button" class="btn btn-primary btn-small" id="confirmImportBtn">Import ' + fresh.length + " title" + (fresh.length === 1 ? "" : "s") + "</button>";

    document.getElementById("confirmImportBtn").addEventListener("click", function(){
      runImport(pendingImportItems);
    });
  }

  function runImport(items){
    items.forEach(function(e){
      var m = e.media;
      var status = IMPORT_STATUS_MAP[e.status] || "plan";
      var progress = Number(e.progress) || 0;
      var watchedArr = [];
      for(var i = 1; i <= progress; i++){ watchedArr.push(i); }

      var entry = {
        id: uid(),
        apiId: m.id,
        title: pickTitle(m.title),
        image: m.coverImage ? (m.coverImage.large || m.coverImage.medium || "") : "",
        banner: m.bannerImage || "",
        description: stripHtml(m.description || ""),
        genres: m.genres || [],
        communityScore: (typeof m.averageScore === "number") ? m.averageScore : null,
        status: status,
        rating: normalizeImportScore(e.score),
        collapsed: true,
        notes: "",
        tags: [],
        seasonLabel: defaultSeasonLabel(m.format),
        sourceTitle: "",
        total: m.episodes || null,
        watched: watchedArr,
        length: null,
        duration: (typeof m.duration === "number" && m.duration > 0) ? m.duration : null,
        discovering: false,
        updatedAt: Date.now()
      };
      recomputeLength(entry);
      state.entries.push(entry);
    });
    saveEntries();
    render();
    closeImportModal();
    showToast("Imported " + items.length + " title" + (items.length === 1 ? "" : "s") + ".");
  }

  function fetchAniListImport(username){
    importStatusEl.textContent = "Fetching " + username + "'s list…";
    importPreviewEl.innerHTML = "";

    var gql =
      "query ($name: String) { MediaListCollection(userName: $name, type: ANIME) { lists { entries { status progress score " +
      "media { id title { romaji english } coverImage { large medium } bannerImage episodes duration format genres averageScore description(asHtml: true) } } } } }";

    fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: gql, variables: { name: username } })
    }).then(function(res){
      if(!res.ok){ throw new Error("bad-response"); }
      return res.json();
    }).then(function(json){
      if(json.errors || !json.data || !json.data.MediaListCollection){ throw new Error("not-found"); }
      var lists = json.data.MediaListCollection.lists || [];
      var flat = [];
      lists.forEach(function(l){ (l.entries || []).forEach(function(e){ flat.push(e); }); });
      if(flat.length === 0){
        importStatusEl.textContent = "No anime found on that list (or the profile/list is private).";
        return;
      }
      renderImportPreview(flat);
    }).catch(function(){
      importStatusEl.textContent = "Couldn't find that user, or their list is private.";
    });
  }

  document.getElementById("importFetchBtn").addEventListener("click", function(){
    var name = importUsernameInput.value.trim();
    if(!name){ showToast("Enter a username first."); return; }
    fetchAniListImport(name);
  });
  } // end AniList import guard

  // ---------- discover / recommendations (own page) ----------
  if(document.getElementById("discoverPageBody")){
  var discoverPageBody = document.getElementById("discoverPageBody");
  var lastRecommendations = [];

  function fetchRecommendationsFor(apiId){
    var gql = "query ($id: Int) { Media(id: $id, type: ANIME) { recommendations(perPage: 6, sort: RATING_DESC) { nodes { mediaRecommendation { id title { romaji english } coverImage { large medium } episodes format seasonYear } } } } }";
    return fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: gql, variables: { id: apiId } })
    }).then(function(res){
      if(!res.ok){ throw new Error("bad-response"); }
      return res.json();
    }).then(function(json){
      if(json.errors || !json.data || !json.data.Media) return [];
      var nodes = json.data.Media.recommendations ? json.data.Media.recommendations.nodes : [];
      return nodes.map(function(n){ return n.mediaRecommendation; }).filter(Boolean);
    }).catch(function(){ return []; });
  }

  function runDiscover(){
    var seeds = state.entries
      .filter(function(e){ return e.rating != null && e.rating >= 8 && e.apiId; })
      .sort(function(a, b){ return (b.rating || 0) - (a.rating || 0); })
      .slice(0, 3);

    if(seeds.length === 0){
      discoverPageBody.innerHTML = '<p class="search-status">Rate a few titles 8/10 or higher first — recommendations are based on what you already love.</p>';
      return;
    }

    discoverPageBody.innerHTML = '<p class="search-status">Looking for shows similar to ' + seeds.map(function(s){ return escapeHtml(s.title); }).join(", ") + "…</p>";

    Promise.all(seeds.map(function(s){ return fetchRecommendationsFor(s.apiId); })).then(function(results){
      var existingIds = {};
      state.entries.forEach(function(e){ if(e.apiId != null){ existingIds[e.apiId] = true; } });

      var seen = {};
      var combined = [];
      results.forEach(function(list){
        list.forEach(function(m){
          if(existingIds[m.id] || seen[m.id]) return;
          seen[m.id] = true;
          combined.push(m);
        });
      });
      combined = combined.slice(0, 8);

      if(combined.length === 0){
        discoverPageBody.innerHTML = '<p class="search-status">No new recommendations found right now — try rating a few more titles.</p>';
        return;
      }

      lastRecommendations = combined.map(function(m){
        return {
          apiId: m.id,
          title: pickTitle(m.title),
          image: m.coverImage ? (m.coverImage.large || m.coverImage.medium || "") : "",
          episodes: m.episodes || null,
          format: m.format || "",
          year: m.seasonYear || null
        };
      });

      discoverPageBody.innerHTML =
        '<p class="search-hint">Based on your highly-rated titles:</p>' +
        '<div class="results-list">' + lastRecommendations.map(function(item, i){
          var img = item.image ? '<img src="' + escapeHtml(item.image) + '" alt="">' : '<div class="poster-fallback" aria-hidden="true">🎬</div>';
          var sub = [item.format, item.year, item.episodes ? (item.episodes + " ep") : "ongoing/unknown"].filter(Boolean).join(" · ");
          return '<div class="result-row" style="animation-delay:' + Math.min(i * 40, 280) + 'ms">' + img +
            '<div class="result-info"><div class="result-title">' + escapeHtml(item.title) + '</div><div class="result-sub">' + escapeHtml(sub) + "</div></div>" +
            '<button type="button" class="result-add-btn" data-rec-index="' + i + '">Add</button>' +
          "</div>";
        }).join("") + "</div>";
    });
  }

  discoverPageBody.addEventListener("click", function(ev){
    var btn = ev.target.closest(".result-add-btn");
    if(!btn || btn.disabled) return;
    var idx = parseInt(btn.getAttribute("data-rec-index"), 10);
    var item = lastRecommendations[idx];
    if(!item) return;
    addEntry(item);
    btn.disabled = true;
    btn.textContent = "Added ✓";
    showToast('Added "' + item.title + '" to your log.');
  });

  runDiscover();
  } // end discover guard

  // ---------- share image ----------
  function drawRoundedRect(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function buildShareImage(){
    var canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 500;
    var ctx = canvas.getContext && canvas.getContext("2d");
    if(!ctx) return null; // some environments don't support canvas — caller handles this gracefully

    var totalEpisodes = 0, totalMinutes = 0;
    var ratedCount = 0, ratingSum = 0;
    var genreCounts = {};
    state.entries.forEach(function(e){
      totalEpisodes += e.watched.length;
      totalMinutes += e.watched.length * (e.duration || FALLBACK_EP_MINUTES);
      if(e.rating != null){ ratedCount++; ratingSum += e.rating; }
      (e.genres || []).forEach(function(g){ genreCounts[g] = (genreCounts[g] || 0) + 1; });
    });
    var topGenres = Object.keys(genreCounts).sort(function(a, b){ return genreCounts[b] - genreCounts[a]; }).slice(0, 3);
    var avgRating = ratedCount > 0 ? (ratingSum / ratedCount).toFixed(1) : null;

    var topRated = state.entries
      .filter(function(e){ return e.rating != null; })
      .sort(function(a, b){ return b.rating - a.rating; })
      .slice(0, 5);

    // background
    var grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, "#161320");
    grad.addColorStop(1, "#0c0b11");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f2a154";

    // header
    ctx.fillStyle = "#f1ece2";
    ctx.font = "700 38px 'Work Sans', sans-serif";
    ctx.fillText("WATCH LOG", 40, 64);
    ctx.fillStyle = "#aea5b9";
    ctx.font = "400 16px 'Work Sans', sans-serif";
    ctx.fillText("My anime watch stats", 40, 90);

    // highlight tiles
    var tiles = [
      { label: "TITLES", value: String(state.entries.length) },
      { label: "EPISODES", value: String(totalEpisodes) },
      { label: "WATCH TIME", value: formatWatchTime(totalMinutes) },
      { label: "AVG RATING", value: avgRating || "—" }
    ];
    var tileW = 170, tileGap = 16, startX = 40, tileY = 120, tileH = 80;
    tiles.forEach(function(t, i){
      var x = startX + i * (tileW + tileGap);
      drawRoundedRect(ctx, x, tileY, tileW, tileH, 10);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.font = "700 28px 'Work Sans', sans-serif";
      ctx.fillText(t.value, x + 16, tileY + 38);
      ctx.fillStyle = "#756d83";
      ctx.font = "600 11px 'Work Sans', sans-serif";
      ctx.fillText(t.label, x + 16, tileY + 60);
    });

    // top genres
    var listY = 245;
    ctx.fillStyle = "#756d83";
    ctx.font = "600 12px 'Work Sans', sans-serif";
    ctx.fillText("TOP GENRES", 40, listY);
    ctx.fillStyle = "#f1ece2";
    ctx.font = "400 16px 'Work Sans', sans-serif";
    ctx.fillText(topGenres.length ? topGenres.join("   ·   ") : "—", 40, listY + 24);

    // top rated list
    var ratedY = listY + 60;
    ctx.fillStyle = "#756d83";
    ctx.font = "600 12px 'Work Sans', sans-serif";
    ctx.fillText("TOP RATED", 40, ratedY);
    if(topRated.length === 0){
      ctx.fillStyle = "#aea5b9";
      ctx.font = "400 15px 'Work Sans', sans-serif";
      ctx.fillText("Rate a few titles to see them here.", 40, ratedY + 26);
    } else {
      topRated.forEach(function(e, i){
        var y = ratedY + 30 + i * 28;
        ctx.fillStyle = accent;
        ctx.font = "700 14px 'JetBrains Mono', monospace";
        ctx.fillText(e.rating + "/10", 40, y);
        ctx.fillStyle = "#f1ece2";
        ctx.font = "400 15px 'Work Sans', sans-serif";
        var title = e.title.length > 50 ? e.title.slice(0, 50) + "…" : e.title;
        ctx.fillText(title, 105, y);
      });
    }

    ctx.fillStyle = "#48414f";
    ctx.font = "400 12px 'Work Sans', sans-serif";
    ctx.fillText("Made with Watch Log", 40, canvas.height - 24);

    return canvas;
  }

  if(document.getElementById("shareBtn")){
  document.getElementById("shareBtn").addEventListener("click", function(){
    if(state.entries.length === 0){
      showToast("Add a few titles first, then come back and share!");
      return;
    }
    var canvas = buildShareImage();
    if(!canvas){
      showToast("Your browser doesn't support generating images here.");
      return;
    }
    canvas.toBlob(function(blob){
      if(!blob){ showToast("Couldn't generate the image."); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "watch-log-stats.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("Image downloaded!");
    });
  });
  } // end share guard

  // ---------- export / import JSON (settings.html) ----------
  if(document.getElementById("exportBtn")){
  document.getElementById("exportBtn").addEventListener("click", function(){
    var blob = new Blob([JSON.stringify(state.entries, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "watch-log-" + date + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Backup downloaded.");
  });
  }

  // CSV export — a flattened, read-only summary (one row per title) for spreadsheets.
  // Unlike JSON, this can't be re-imported: CSV has no good way to represent nested
  // seasons/episode lists, so it's a one-way "view your data elsewhere" export only.
  function csvEscape(val){
    var s = String(val == null ? "" : val);
    if(/[",\n]/.test(s)){ s = '"' + s.replace(/"/g, '""') + '"'; }
    return s;
  }
  if(document.getElementById("exportCsvBtn")){
  document.getElementById("exportCsvBtn").addEventListener("click", function(){
    if(state.entries.length === 0){
      showToast("Your log is empty — nothing to export yet.");
      return;
    }
    var headers = ["Title", "Season", "Status", "Rating", "Episodes Watched", "Genres", "Tags", "AniList URL"];
    var rows = state.entries.map(function(e){
      var episodesWatched = e.watched.length;
      var anilistUrl = e.apiId ? ("https://anilist.co/anime/" + e.apiId) : "";
      return [
        e.title,
        e.seasonLabel,
        statusMeta[e.status] ? statusMeta[e.status].label : e.status,
        e.rating != null ? e.rating : "",
        episodesWatched,
        (e.genres || []).join("; "),
        (e.tags || []).join("; "),
        anilistUrl
      ].map(csvEscape).join(",");
    });
    var csv = headers.join(",") + "\n" + rows.join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "watch-log-" + date + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("CSV downloaded.");
  });
  }

  if(document.getElementById("importBtn")){
  var importFile = document.getElementById("importFile");
  document.getElementById("importBtn").addEventListener("click", function(){
    importFile.value = "";
    importFile.click();
  });
  importFile.addEventListener("change", function(){
    var file = importFile.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      try{
        var parsed = JSON.parse(reader.result);
        if(!Array.isArray(parsed)) throw new Error("not-array");
        var ok = confirm("Import " + parsed.length + " title(s)? This replaces your current log of " + state.entries.length + " title(s).");
        if(!ok) return;
        var restored = [];
        parsed.forEach(function(r){ normalizeEntry(r).forEach(function(e){ restored.push(e); }); });
        state.entries = restored;
        state.knownCardIds = {};
        saveEntries();
        render();
        showToast("Import complete.");
      }catch(err){
        showToast("That file doesn't look like a valid Watch Log export.");
      }
    };
    reader.readAsText(file);
  });
  } // end import JSON guard

  // ---------- view mode (grid/compact) — index.html only ----------
  var VIEW_MODE_KEY = "watchlog.viewMode";
  function applyViewMode(mode){
    var grid = document.getElementById("grid");
    var btn = document.getElementById("viewModeBtn");
    if(!grid || !btn) return;
    if(mode === "compact"){
      grid.classList.add("compact-view");
      btn.textContent = "☰ Grid";
    } else {
      grid.classList.remove("compact-view");
      btn.textContent = "☷ Compact";
    }
  }
  if(document.getElementById("viewModeBtn")){
  document.getElementById("viewModeBtn").addEventListener("click", function(){
    var isCompact = document.getElementById("grid").classList.contains("compact-view");
    var next = isCompact ? "grid" : "compact";
    applyViewMode(next);
    try{ localStorage.setItem(VIEW_MODE_KEY, next); }catch(e){}
  });
  }
  (function initViewMode(){
    var saved = null;
    try{ saved = localStorage.getItem(VIEW_MODE_KEY); }catch(e){}
    if(saved === "compact"){ applyViewMode("compact"); }
  })();

  // ---------- accent color — applied on every page, picker UI lives on settings.html ----------
  var ACCENT_KEY = "watchlog.accentColor";
  function hexToRgba(hex, alpha){
    var h = hex.replace("#", "");
    if(h.length === 3){ h = h.split("").map(function(c){ return c + c; }).join(""); }
    var r = parseInt(h.substring(0, 2), 16);
    var g = parseInt(h.substring(2, 4), 16);
    var b = parseInt(h.substring(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }
  function applyAccentColor(hex){
    document.documentElement.style.setProperty("--accent", hex);
    document.documentElement.style.setProperty("--accent-soft", hexToRgba(hex, 0.14));
  }
  (function initAccent(){
    var saved = null;
    try{ saved = localStorage.getItem(ACCENT_KEY); }catch(e){}
    if(saved){
      applyAccentColor(saved);
      var picker = document.getElementById("accentPicker");
      if(picker){ picker.value = saved; }
    }
  })();
  if(document.getElementById("accentPicker")){
  var accentRaf = null;
  var pendingAccentVal = null;
  document.getElementById("accentPicker").addEventListener("input", function(ev){
    pendingAccentVal = ev.target.value;
    if(accentRaf) return; // a frame is already scheduled — it'll pick up the latest value
    accentRaf = requestAnimationFrame(function(){
      applyAccentColor(pendingAccentVal);
      accentRaf = null;
    });
  });
  document.getElementById("accentPicker").addEventListener("change", function(ev){
    try{ localStorage.setItem(ACCENT_KEY, ev.target.value); }catch(e){}
  });
  }

  // ---------- theme toggle — picker UI lives on settings.html ----------
  var THEME_KEY = "watchlog.theme";
  function applyThemeButtonLabel(){
    var btn = document.getElementById("themeToggle");
    if(!btn) return;
    var isLight = document.documentElement.getAttribute("data-theme") === "light";
    btn.textContent = isLight ? "☀️" : "🌙";
  }
  if(document.getElementById("themeToggle")){
  document.getElementById("themeToggle").addEventListener("click", function(){
    var isLight = document.documentElement.getAttribute("data-theme") === "light";
    if(isLight){
      document.documentElement.removeAttribute("data-theme");
      try{ localStorage.setItem(THEME_KEY, "dark"); }catch(e){}
    } else {
      document.documentElement.setAttribute("data-theme", "light");
      try{ localStorage.setItem(THEME_KEY, "light"); }catch(e){}
    }
    applyThemeButtonLabel();
  });
  }
  applyThemeButtonLabel();

  // ---------- air-date countdown ----------
  function fetchAiringInfo(){
    var ids = [];
    state.entries.forEach(function(e){
      if(e.status === "watching"){
        var id = relevantApiId(e);
        if(id != null && ids.indexOf(id) === -1){ ids.push(id); }
      }
    });
    if(ids.length === 0) return Promise.resolve();
    ids = ids.slice(0, 50); // AniList Page perPage cap — plenty for any realistic "currently watching" count

    var gql = "query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id status nextAiringEpisode { episode airingAt } } } }";
    return fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: gql, variables: { ids: ids } })
    }).then(function(res){
      if(!res.ok){ throw new Error("bad-response"); }
      return res.json();
    }).then(function(json){
      if(json.errors){ throw new Error("api-error"); }
      var list = (json.data && json.data.Page && json.data.Page.media) || [];
      list.forEach(function(m){
        if(m.nextAiringEpisode){
          state.airingInfo[m.id] = { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt };
        }
      });
      renderGrid();
    }).catch(function(){ /* non-critical — countdown just won't show this session */ });
  }

  var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function renderSchedulePage(){
    var body = document.getElementById("schedulePageBody");
    if(!body) return;
    var watchingEntries = state.entries.filter(function(e){ return e.status === "watching"; });

    if(watchingEntries.length === 0){
      body.innerHTML = '<p class="search-status">Mark something as "Watching" to see its airing schedule here.</p>';
      return;
    }

    var buckets = [[], [], [], [], [], [], []]; // Sun..Sat
    var anyData = false;
    watchingEntries.forEach(function(e){
      var id = relevantApiId(e);
      var info = id != null ? state.airingInfo[id] : null;
      if(!info) return;
      var countdown = formatCountdown(info.airingAt);
      if(!countdown) return;
      anyData = true;
      var day = new Date(info.airingAt * 1000).getDay();
      buckets[day].push({ title: e.title, episode: info.episode, countdown: countdown, airingAt: info.airingAt });
    });

    if(!anyData){
      body.innerHTML = '<p class="search-status">No upcoming air dates found yet for your watching list. This refreshes each time you load the page.</p>';
      return;
    }

    var todayIdx = new Date().getDay();
    var cols = "";
    for(var offset = 0; offset < 7; offset++){
      var dayIdx = (todayIdx + offset) % 7;
      var items = buckets[dayIdx].slice().sort(function(a, b){ return a.airingAt - b.airingAt; });
      var rows = items.length
        ? items.map(function(it){
            return '<div class="schedule-item"><span class="schedule-item-title">' + escapeHtml(it.title) + '</span>' +
              '<span class="schedule-item-meta">Ep ' + it.episode + " · " + it.countdown + "</span></div>";
          }).join("")
        : '<p class="schedule-empty">—</p>';
      cols += '<div class="schedule-day' + (offset === 0 ? " today" : "") + '">' +
        '<div class="schedule-day-label">' + (offset === 0 ? "Today" : WEEKDAY_NAMES[dayIdx]) + "</div>" +
        rows +
      "</div>";
    }
    body.innerHTML = '<div class="schedule-grid">' + cols + "</div>";
  }

  if(document.getElementById("schedulePageBody")){
    document.getElementById("schedulePageBody").innerHTML = '<p class="search-status">Loading schedule…</p>';
    fetchAiringInfo().then(renderSchedulePage);
  }

  // ---------- PWA: service worker registration ----------
  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("service-worker.js").catch(function(){
        // Non-critical — the site still works fully online without it.
      });
    });
  }

  // ---------- init ----------
  render();
  // schedule.html already fetches airing info itself (see the guard above) — avoid firing it twice
  if(!document.getElementById("schedulePageBody")){
    fetchAiringInfo();
  }
})();
