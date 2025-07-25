// ==UserScript==
// @name         Lightship Submission Helper
// @author       Xelminoe
// @version      1.1.02
// @description  Export Lightship nominations to Google Sheet (Wayfarer Exporter style)
// @match        https://lightship.dev/account/geospatial-browser/*
// @grant        none
// ==/UserScript==

(function () {
    // consts
    "use strict";
    const TILE_SIZE = 512;
    const STORAGE_KEY = "lightshipexporter-candidates";

    // utility functions
    function getDistance(p1, p2) {
        const rad = (x) => (x * Math.PI) / 180;
        const R = 6378137; // Earth radius in meters
        const dLat = rad(p2.lat - p1.lat);
        const dLng = rad(p2.lng - p1.lng);
        const a =
              Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function lngLatToWorld(lng, lat) {
        const sinY = Math.sin((lat * Math.PI) / 180);
        const x = (lng + 180) / 360;
        const y = 0.5 - Math.log((1 + sinY) / (1 - sinY)) / (4 * Math.PI);
        return { x, y };
    }

    function worldToLngLat(x, y) {
        const lng = x * 360 - 180;
        const n = Math.PI - 2 * Math.PI * y;
        const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        return { lng, lat };
    }

    function formatTimestamp(msString) {
        if (!msString) return "";
        const date = new Date(parseInt(msString, 10));
        return date.toISOString().split("T")[0];
    }

    function projectLngLatToScreen(lng, lat, center, zoom, width, height) {
        const worldSize = TILE_SIZE * Math.pow(2, zoom);
        const centerWorld = lngLatToWorld(center.lng, center.lat);
        const pointWorld = lngLatToWorld(lng, lat);

        const dx = (pointWorld.x - centerWorld.x) * worldSize;
        const dy = (pointWorld.y - centerWorld.y) * worldSize;

        return {
            x: width / 2 + dx,
            y: height / 2 + dy
        };
    }

    function findNearbyCandidates(lat, lng) {
        const all = loadStoredCandidates();
        const matches = [];

        for (const candidate of Object.values(all)) {
            if (candidate.status !== "potential") continue;

            const latDiff = Math.abs(candidate.lat - lat);
            const lngDiff = Math.abs(candidate.lng - lng);

            if (latDiff <= 0.001 && lngDiff <= 0.001) {
                matches.push(candidate);
            }
        }

        return matches;
    }

    // extract info from page or storage functions
    function getMapBoundsFromUrl() {
        const view = getMapCenterZoomFromUrl();
        if (!view) return null;

        const { lat, lng, zoom } = view;
        const worldSize = TILE_SIZE * Math.pow(2, zoom);

        const centerWorld = lngLatToWorld(lng, lat);
        const canvas = document.querySelector('canvas.mapboxgl-canvas');
        const width = canvas?.clientWidth || window.innerWidth;
        const height = canvas?.clientHeight || window.innerHeight;

        const metersPerPixel = 1 / worldSize;

        const xMin = centerWorld.x - (width / 2) * metersPerPixel;
        const xMax = centerWorld.x + (width / 2) * metersPerPixel;
        const yMin = centerWorld.y - (height / 2) * metersPerPixel;
        const yMax = centerWorld.y + (height / 2) * metersPerPixel;

        const sw = worldToLngLat(xMin, yMax);
        const ne = worldToLngLat(xMax, yMin);

        return { sw, ne, center: { lat, lng }, zoom, width, height };
    }

    function getMapCenterZoomFromUrl() {
        const match = location.pathname.match(/\/(\-?\d+\.?\d*),(\-?\d+\.?\d*),(\d+\.?\d*)/);
        if (!match) return null;
        const [, lat, lng, zoom] = match.map(Number);
        return { lat, lng, zoom };
    }

    function getUserEmail() {
        const btn = document.querySelector('button.account-menu-dropdown');
        if (!btn) return "";
        return btn.textContent.trim();
    }

    function extractNominationsFromFiber() {
        const table = document.querySelector("table");
        if (!table) return [];

        let fiberNode = null;

        // Locate the internal React fiber object attached to the DOM element
        for (const key in table) {
            if (key.startsWith("__reactFiber$")) {
                fiberNode = table[key];
                break;
            }
        }

        if (!fiberNode) return [];

        let cursor = fiberNode;

        // Traverse fiber tree upwards to find props or state containing nominations
        while (cursor) {
            const props = cursor.memoizedProps;
            const state = cursor.memoizedState;

            if (props?.submissionPois && Array.isArray(props.submissionPois)) {
                return props.submissionPois;
            }
            if (state?.baseState && Array.isArray(state.baseState)) {
                return state.baseState;
            }

            cursor = cursor.return;
        }

        return [];
    }

    function loadStoredCandidates() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    function getCurrentNominatedCoordinates() {
        const card = document.querySelector("div[class*='card']");
        if (!card) return null;

        const candidateDivs = card.querySelectorAll("div");
        for (const div of candidateDivs) {
            const text = div.textContent.trim();
            if (/^-?\d{1,3}\.\d{3,},\s*-?\d{1,3}\.\d{3,}$/.test(text)) {
                const [latStr, lngStr] = text.split(',').map(s => s.trim());
                const lat = parseFloat(latStr);
                const lng = parseFloat(lngStr);
                if (isFinite(lat) && isFinite(lng)) {
                    return { lat, lng };
                }
            }
        }

        return null;
    }

    function observeModalFormPanel() {
        console.log("🛰️ Started persistent modal observation");

        const body = document.body;
        let lastModalRef = null;

        const observer = new MutationObserver(() => {
            const modal = document.querySelector('body > div.ui.page.modals.dimmer.transition.visible.active > div');

            // Modal disappeared
            if (!modal && lastModalRef) {
                console.log("🧹 Modal closed");
                lastModalRef = null;
                return;
            }

            // Modal appeared but already processed
            if (modal === lastModalRef) return;

            // New modal appeared
            //const heading = modal?.querySelector('div.basicModalContent-0-2-288 > h3');
            //const headingText = heading?.textContent?.trim();

            //if (headingText === "Add Location Information") {
            //  console.log("✅ Detected new nomination modal with form");
            //  lastModalRef = modal;
            //  handleNominationModalOpen(modal);
            //}

            const heading = modal?.querySelector('h2, h3');
            const headingText = heading?.textContent?.trim();

            if (headingText === "Add Location Information" || headingText === "Create Public Location") {
                console.log("✅ Detected new nomination modal with form");
                lastModalRef = modal;
                handleNominationModalOpen(modal);
            }

        });

        observer.observe(body, {
            childList: true,
            subtree: true
        });
    }

    // UI changing functions
    function autoFillNominationFormStable({ title, description, category }) {
        const fillByLabel = (labelText, value) => {
            const labels = document.querySelectorAll("label");
            for (const label of labels) {
                if (label.textContent.trim() === labelText) {
                    const field = label.closest(".field");
                    const input = field?.querySelector("input, textarea");
                    if (input) {
                        input.focus();
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                        nativeSetter?.call(input, value);
                        input.dispatchEvent(new Event("input", { bubbles: true }));
                        //console.log(`✅ Filled "${labelText}" with "${value}"`);
                        return;
                    }
                }
            }
            console.warn(`❌ Could not find input for label: "${labelText}"`);
        };

        const tryFillTextFields = () => {
            fillByLabel("Title", title || "Autofilled Title");
            fillByLabel("Description", description || "Autofilled description.");
        };

        const dropdown = document.querySelector('.ui.selection.dropdown');
        if (!dropdown || !category) {
            console.warn("⚠️ Skipping category selection (dropdown not found or no category specified)");
            tryFillTextFields();
            return;
        }

        dropdown.click();

        setTimeout(() => {
            const items = dropdown.querySelectorAll('.item');
            const match = Array.from(items).find(
                el => el.textContent.trim().toLowerCase() === category.toLowerCase()
            );

            if (!match) {
                console.warn(`⚠️ Category "${category}" not found — skipping category selection`);
                tryFillTextFields();
                return;
            }

            match.click();
            console.log(`✅ Selected category: ${match.textContent.trim()}`);

            dropdown.classList.remove('visible', 'active');
            dropdown.querySelector('.menu')?.classList.remove('visible');
            console.log("✅ Dropdown force-closed");

            setTimeout(() => {
                tryFillTextFields();
            }, 300);
        }, 200);
    }

    async function showPotentialMatchUI(potentialMatches, nominations) {
        return new Promise((resolve) => {
            const panel = document.createElement('div');
            panel.style.position = 'fixed';
            panel.style.top = '10%';
            panel.style.left = '10%';
            panel.style.width = '80%';
            panel.style.height = '70%';
            panel.style.backgroundColor = '#fff';
            panel.style.border = '2px solid #888';
            panel.style.padding = '10px';
            panel.style.overflow = 'auto';
            panel.style.zIndex = 10000;

            panel.innerHTML = `<h3>🔍 Potential Matches Found</h3>`;

            const confirmed = [];

            for (const newId of Object.keys(potentialMatches)) {
                const nom = nominations.find(n => n.id === newId);
                panel.innerHTML += `<hr><b>New Nomination:</b> ${nom.title}<ul>`;
                potentialMatches[newId].forEach((pot, idx) => {
                    const inputId = `match_${newId}_${pot.id}`;
                    const groupName = `group_${newId}`;
                    const lat = Number(pot.lat);
                    const lng = Number(pot.lng);
                    const latStr = isFinite(lat) ? lat.toFixed(5) : "N/A";
                    const lngStr = isFinite(lng) ? lng.toFixed(5) : "N/A";

                    panel.innerHTML += `
                            <li>
                                <label>
                                    <input type="radio" name="${groupName}" id="${inputId}" ${idx === 0 ? "checked" : ""} />
                                    Potential: ${pot.title} (${latStr}, ${lngStr})
                                </label>
                            </li>`;
                });
                panel.innerHTML += `</ul>`;
            }

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = '✅ Confirm Selected Matches';
            confirmBtn.onclick = () => {
                for (const newId of Object.keys(potentialMatches)) {
                    potentialMatches[newId].forEach((pot) => {
                        const checkboxId = `match_${newId}_${pot.id}`;
                        const checkbox = document.getElementById(checkboxId);
                        const selected = potentialMatches[newId].find((pot) => {
                            const inputId = `match_${newId}_${pot.id}`;
                            const radio = document.getElementById(inputId);
                            return radio && radio.checked;
                        });
                        if (selected) {
                            confirmed.push({ newNominationId: newId, potentialId: selected.id });
                        }
                    });
                }
                document.body.removeChild(panel);
                resolve(confirmed);
            };

            panel.appendChild(confirmBtn);
            document.body.appendChild(panel);
        });
    }

    function ensurePoiMarkerContainer() {
        if (document.getElementById("poi-marker-layer")) return;

        const canvas = document.querySelector("canvas.mapboxgl-canvas");
        const container = canvas?.parentElement;
        if (!canvas || !container) {
            console.warn("⚠️ Map canvas or parent container not found.");
            return;
        }

        const layer = document.createElement("div");
        layer.id = "poi-marker-layer";
        layer.style.position = "absolute";
        layer.style.top = "0";
        layer.style.left = "0";
        layer.style.width = "100%";
        layer.style.height = "100%";
        layer.style.pointerEvents = "none";
        layer.style.zIndex = "299";

        container.appendChild(layer);
    }

    function renderVisiblePoiMarkers() {
        const container = document.getElementById("poi-marker-layer");
        if (!container) return;

        container.innerHTML = "";

        const bounds = getMapBoundsFromUrl();
        if (!bounds) return;
        console.log(bounds);

        const allCandidates = loadStoredCandidates();
        const candidatesInBounds = Object.values(allCandidates).filter(c =>
                                                                       c.status === "potential" &&
                                                                       c.lat >= bounds.sw.lat && c.lat <= bounds.ne.lat &&
                                                                       c.lng >= bounds.sw.lng && c.lng <= bounds.ne.lng
                                                                      );

        const markersWithScreen = candidatesInBounds.map(c => ({
            candidate: c,
            screen: projectLngLatToScreen(c.lng, c.lat, bounds.center, bounds.zoom, bounds.width, bounds.height)
        }));

        markersWithScreen.sort((a, b) => a.screen.y - b.screen.y);

        for (const { candidate: c, screen } of markersWithScreen) {
            const img = document.createElement("img");
            img.src = "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-grey.png";
            //img.style.width = "24px";
            //img.style.height = "24px";
            img.style.transform = "translate(-50%, -100%)";
            img.style.pointerEvents = "auto";
            img.style.cursor = "pointer";
            img.title = c.title;

            // 将 img 包装在定位 div 中
            const wrapper = document.createElement("div");
            wrapper.className = "poi-marker";
            wrapper.style.position = "absolute";
            wrapper.style.left = `${screen.x}px`;
            wrapper.style.top = `${screen.y}px`;
            wrapper.appendChild(img);

            wrapper.appendChild(img);
            container.appendChild(wrapper);
        }

        updateNominationStatus(`${candidatesInBounds.length} potential POIs in bounds.`);
    }

    function startPoiMarkerRenderingLoop() {
        ensurePoiMarkerContainer();

        let lastBoundsKey = "";

        const observer = new ResizeObserver(() => {
            renderVisiblePoiMarkers();
        });

        const canvas = document.querySelector("canvas.mapboxgl-canvas");
        if (canvas) observer.observe(canvas);

        setInterval(() => {
            const bounds = getMapBoundsFromUrl();
            if (!bounds) return;

            const key = [
                bounds.center.lat.toFixed(5),
                bounds.center.lng.toFixed(5),
                bounds.zoom.toFixed(2),
                bounds.width,
                bounds.height
            ].join("|");

            if (key !== lastBoundsKey) {
                lastBoundsKey = key;
                renderVisiblePoiMarkers();
            }
        }, 500);
    }

    function injectMatchSelectorUI(modal, matches) {
        const container = document.createElement("div");
        container.style.marginTop = "20px";
        container.style.padding = "10px";
        container.style.background = "#f8f8f8";
        container.style.border = "1px solid #ccc";
        container.style.borderRadius = "8px";

        const title = document.createElement("div");
        title.textContent = `Found ${matches.length} nearby candidate(s):`;
        title.style.marginBottom = "6px";
        title.style.fontWeight = "bold";

        const dropdown = document.createElement("select");
        dropdown.style.width = "100%";
        dropdown.style.padding = "4px";

        matches.forEach((c, idx) => {
            const opt = document.createElement("option");
            opt.value = idx;
            opt.textContent = `${c.title} (${c.lat.toFixed(5)}, ${c.lng.toFixed(5)})`;
            dropdown.appendChild(opt);
        });

        const button = document.createElement("button");
        button.textContent = "✅ Autofill with selected POI";
        button.style.marginTop = "10px";
        button.style.padding = "6px 10px";
        button.style.background = "#4CAF50";
        button.style.color = "white";
        button.style.border = "none";
        button.style.borderRadius = "5px";
        button.style.cursor = "pointer";

        button.onclick = () => {
            const selected = matches[dropdown.value];
            if (!selected) return;

            console.log("✍️ Autofilling form with:", selected);

            autoFillNominationFormStable({
                title: selected.title,
                description: selected.description,
                category: "Other"
            });

            button.textContent = "✅ Filled!";
            button.disabled = true;
        };

        container.appendChild(title);
        container.appendChild(dropdown);
        container.appendChild(button);

        // 插入 modal 的底部
        modal.appendChild(container);
    }

    function handleNominationModalOpen(modal) {
        const coords = getCurrentNominatedCoordinates();
        if (!coords) {
            console.warn("❌ No nominated coordinates available");
            return;
        }
        const { lat, lng } = coords;

        if (!lat || !lng) {
            console.warn("❌ No nominated coordinates — skipping autofill");
            return;
        }

        const matches = findNearbyCandidates(lat, lng);
        if (matches.length === 0) {
            console.log("ℹ️ No matching POIs nearby.");
            return;
        }
        console.log("Matching Candidates found. Injecting UI.");

        injectMatchSelectorUI(modal, matches);
    }

    function updateSyncStatus(msg) {
        const el = document.querySelector('#sync-status-msg');
        if (el) el.textContent = msg;
    }

    function updateNominationStatus(msg) {
        const el = document.querySelector('#nomination-status-msg');
        if (el) el.textContent = msg;
    }

    function createFloatingSyncPanel(onSyncClick) {
        if (document.querySelector('#lightship-sync-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'lightship-sync-panel';
        panel.style.position = 'fixed';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.style.zIndex = '9999';
        panel.style.backgroundColor = '#fff';
        panel.style.border = '1px solid #ccc';
        panel.style.borderRadius = '12px';
        panel.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
        panel.style.padding = '10px';
        panel.style.width = '260px';
        panel.style.maxWidth = '90vw';
        panel.style.fontFamily = 'sans-serif';

        panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong id="sync-panel-title">Lightship Submission Helper</strong>
            <button id="toggle-sync-panel" style="border:none;background:none;font-size:16px;cursor:pointer;">−</button>
        </div>
        <div id="sync-panel-body">
            <div style="margin-top: 10px;">
                <label>App Script URL:</label><br/>
                <input id="script-url-input" type="text" placeholder="Paste script URL..." style="width: 100%; margin-top: 5px;" />
            </div>
            <div id="sync-status-msg" style="margin: 8px 0; color: gray;">🔄 Waiting for Submissions tab…</div>
            <button id="start-sync-btn"
                        title="Upload all new or changed nominations to Google Sheet"
                        style="width: 100%; padding: 8px; background-color: #4CAF50; color: white; border: none; border-radius: 5px; margin-top: 5px;"
                        disabled>📤 Sync Submissions</button>
            <button id="preview-upload-btn"
                        title="Preview the nominations that will be uploaded (if ready)"
                        style="width: 100%; padding: 8px; margin-top: 5px;">🔍 Preview Uploads</button>
            <div id="nomination-status-msg" style="margin: 8px 0; color: gray;">🔄 Press button to enter Nomination Mode…</div>
            <button id="load-candidates-btn"
                        title="Download potential POIs for nomination assistance"
                        style="width: 100%; padding: 8px; margin-top: 5px;">🌐 Nomination Mode</button>
        </div>
        `;

        document.body.appendChild(panel);

        // Toggle panel visibility
        document.querySelector('#toggle-sync-panel').onclick = () => {
            const body = document.querySelector('#sync-panel-body');
            const panel = document.querySelector('#lightship-sync-panel');
            const toggle = document.querySelector('#toggle-sync-panel');
            const title = document.querySelector('#sync-panel-title');

            const isCollapsed = body.style.display === 'none';

            if (isCollapsed) {
                // expand
                body.style.display = 'block';
                title.style.display = 'inline';
                panel.style.width = '260px';
                panel.style.padding = '10px';
                toggle.textContent = '−';
            } else {
                // collapse
                body.style.display = 'none';
                title.style.display = 'none';
                panel.style.width = '32px';
                panel.style.padding = '5px';
                toggle.textContent = '+';
            }
        };


        // Load & Save Script URL
        const urlInput = panel.querySelector('#script-url-input');
        const savedUrl = localStorage.getItem("lightshipexporter-script-url");
        if (savedUrl) urlInput.value = savedUrl;

        urlInput.addEventListener('change', () => {
            localStorage.setItem("lightshipexporter-script-url", urlInput.value.trim());
        });

        // Sync button click
        const syncBtn = document.querySelector('#start-sync-btn');
        syncBtn.onclick = async () => {
            if (syncBtn.disabled) return;

            const url = urlInput.value.trim();
            if (!url) return alert("❗ Please fill the Script URL");
            localStorage.setItem("lightshipexporter-script-url", url);

            updateSyncStatus("🔄 Downloading latest candidates from script...");
            const scriptCandidates = await fetchCandidatesFromScript(url);
            if (!scriptCandidates) return; // Halt if fail to download

            await syncNewNominations(url);
        };

        // Preview button click
        const previewBtn = panel.querySelector('#preview-upload-btn');
        previewBtn.onclick = () => {
            const list = window.pendingNominationsToUpload || [];
            const confirmedMatches = window.confirmedPotentialMatches || [];

            if (list.length === 0) {
                alert("No nominations pending upload.");
                return;
            }

            const lines = list.map((n, i) => {
                const match = confirmedMatches.find(m => m.newNominationId === n.id);
                const replaced = match ? `, replaces potential: ${match.potentialId}` : "";
                const statusChange = (n.reason === "status changed" && n.oldStatus && n.newStatus)
                ? `: ${n.oldStatus} → ${n.newStatus}`
                : "";
                return `${i + 1}. ${n.title} (${n.reason}${statusChange}${replaced})`;
            });

            alert(`Nominations to be uploaded:\n\n${lines.join("\n")}`);
        };

        // Load candidates button click
        const loadBtn = document.querySelector('#load-candidates-btn');
        loadBtn.onclick = async () => {
            const url = urlInput.value.trim();
            if (!url) return alert("❗ Please fill the Script URL");

            localStorage.setItem("lightshipexporter-script-url", url);

            updateNominationStatus("🌐 Downloading potential POIs...");
            const scriptCandidates = await fetchCandidatesFromScript(url);
            if (!scriptCandidates) return; // Halt if fail to download

            updateNominationStatus("✅ Loaded potential POIs.");

            startPoiMarkerRenderingLoop();

            observeModalFormPanel();
        };


        return {
            setStatus: (text, enabled) => {
                panel.querySelector('#sync-status-msg').textContent = text;
                syncBtn.disabled = !enabled;
            }
        };
    }

    // web functions
    async function fetchCandidatesFromScript(scriptUrl) {
        try {
            const response = await fetch(scriptUrl);
            const data = await response.json();

            const allowedStatuses = ["lightship-live", "provisional", "retired","potential"];

            const mapped = {};
            for (const c of data) {
                if (!allowedStatuses.includes(c.status)) continue;

                let mappedStatus = c.status === "lightship-live" ? "live" : c.status;

                mapped[c.id] = {
                    title: c.title,
                    description: c.description,
                    lat: Number(c.lat),
                    lng: Number(c.lng),
                    status: mappedStatus,
                };
            }

            localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped));

            updateSyncStatus(`✅ Downloaded ${Object.keys(mapped).length} candidates from script.`);
            return mapped;
        } catch (e) {
            console.error("❌ Failed to load candidates from script:", e);
            updateSyncStatus("❌ Failed to load candidates from script.");
            return null;
        }
    }

    function uploadNomination(nomination, scriptUrl) {
        const formData = new FormData();
        let rawStatus = (nomination.state || "").toLowerCase();
        let mappedStatus = rawStatus === "live" ? "lightship-live" : rawStatus;

        formData.append("id", nomination.id);
        formData.append("title", nomination.title || "");
        formData.append("description", nomination.description || "");
        formData.append("lat", nomination.lat);
        formData.append("lng", nomination.lng);
        formData.append("status", mappedStatus);
        formData.append("candidateimageurl", nomination.images?.[0]?.url || "");
        formData.append("nickname", getUserEmail() || "lightship");
        formData.append("submitteddate", formatTimestamp(nomination.discoveredTimestampMs));

        return fetch(scriptUrl, {
            method: "POST",
            body: formData,
        });
    }

    async function syncNewNominations(scriptUrl) {
        const stored = loadStoredCandidates();
        const nominations = extractNominationsFromFiber();
        const potentialMatches = {}; // newNomination.id → array of matched potentials

        if (!nominations || nominations.length === 0) {
            alert("⚠️ No nominations found to upload.");
            return;
        }

        const nominationsToUpload = [];
        const pendingNominations = []; // Used for preview display
        window.pendingNominationsToUpload = pendingNominations;

        for (const n of nominations) {
            const prev = stored[n.id];
            const currentStatus = (n.state || "").toLowerCase();
            const reason = !prev ? "new" : (prev.status !== currentStatus ? "status changed" : null);

            if (reason) {
                nominationsToUpload.push(n);
                const record = { id: n.id, title: n.title, reason };
                if (reason === "status changed") {
                    record.oldStatus = prev.status;
                    record.newStatus = currentStatus;
                }
                pendingNominations.push(record);
            }

            if (!prev) {
                const matches = [];
                for (const [id, candidate] of Object.entries(stored)) {
                    if (candidate.status === "potential") {
                        const distance = getDistance(candidate, n);
                        if (distance <= 10) {
                            matches.push({ id, ...candidate });
                        }
                    }
                }
                if (matches.length > 0) {
                    potentialMatches[n.id] = matches;
                }
            }
        }

        let confirmedMatches = [];
        if (Object.keys(potentialMatches).length > 0) {
            confirmedMatches = await showPotentialMatchUI(potentialMatches, nominations);
            window.confirmedPotentialMatches = confirmedMatches;
        }

        let synced = 0;
        const batchSize = 5;

        for (let i = 0; i < nominationsToUpload.length; i += batchSize) {
            const batch = nominationsToUpload.slice(i, i + batchSize);

            await Promise.all(batch.map(async (n, index) => {
                const currentStatus = (n.state || "").toLowerCase();
                try {
                    updateSyncStatus(`📤 Uploading ${i + index + 1} / ${nominationsToUpload.length}: ${n.title}`);
                    await uploadNomination(n, scriptUrl);

                    if (confirmedMatches.length > 0) {
                        const relatedDeletes = confirmedMatches.filter(m => m.newNominationId === n.id);
                        for (const match of relatedDeletes) {
                            delete stored[match.potentialId];
                            sendDeleteToWeb(match.potentialId);
                        }
                    }

                    synced++;
                } catch (e) {
                    console.error(`❌ Failed to upload: ${n.title}`, e);
                }
            }));
        }

        updateSyncStatus(`✅ Upload complete. ${synced} nomination(s) uploaded.`);
        setTimeout(() => updateSyncStatus("Ready."), 3000);
    }

    function sendDeleteToWeb(potentialId) {
        const formData = new FormData();
        formData.append("status", "delete");
        formData.append("id", potentialId);

        const scriptUrl = localStorage.getItem("lightshipexporter-script-url");
        if (scriptUrl) {
            fetch(scriptUrl, {
                method: "POST",
                body: formData,
            }).catch((e) => console.error("Failed to send delete", e));
        }
    }

    // Initialization watcher for when the submissions tab becomes active
    function waitForSubmissionsTabActivationThenInsertButton() {
        const tryAttach = () => {
            const tab = document.querySelector('#tab-submissions');
            if (!tab) {
                console.warn("Waiting for submissions tab...");
                setTimeout(tryAttach, 1000);
                return;
            }

            const uiPanel = createFloatingSyncPanel();
            const observer = new MutationObserver(() => {
                try {
                    const isActive = tab.getAttribute('aria-selected') === 'true';
                    uiPanel.setStatus(
                        isActive ? "✅ Submissions tab is active." : "📄 Switch to Submissions tab to enable sync.",
                        isActive
                    );
                } catch (e) {
                    console.error("Mutation observer error:", e);
                }
            });

            observer.observe(tab, {
                attributes: true,
                attributeFilter: ['aria-selected'],
            });

            const isActive = tab.getAttribute('aria-selected') === 'true';
            uiPanel.setStatus(
                isActive ? "✅ Submissions tab is active." : "📄 Switch to Submissions tab to enable sync.",
                isActive
            );
        };

        setTimeout(tryAttach, 1000);
    }

    waitForSubmissionsTabActivationThenInsertButton();
})();
