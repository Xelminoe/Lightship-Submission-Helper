// ==UserScript==
// @name         Lightship Exporter
// @author       Xelminoe
// @version      1.0.1
// @description  Export Lightship nominations to Google Sheet (Wayfarer Exporter style)
// @match        https://lightship.dev/account/geospatial-browser/*
// @grant        none
// ==/UserScript==

(function () {
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

    "use strict";
    const STORAGE_KEY = "lightshipexporter-candidates";

    // Load nomination upload records from localStorage
    function loadStoredCandidates() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

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
                    lat: c.lat,
                    lng: c.lng,
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

    // Attempt to extract nomination data from the React Fiber tree
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

    // Extract the user's email from the page (used as nickname)
    function getUserEmail() {
        const btn = document.querySelector('button.account-menu-dropdown');
        if (!btn) return "";
        return btn.textContent.trim();
    }

    // Send nomination as a POST request to the Google Apps Script URL
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

    // Synchronize nominations that are either new or have changed status
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
                        if (distance <= 5) {
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

    // Convert millisecond timestamp to YYYY-MM-DD string
    function formatTimestamp(msString) {
        if (!msString) return "";
        const date = new Date(parseInt(msString, 10));
        return date.toISOString().split("T")[0];
    }

    // Update status message in the sync panel UI
    function updateSyncStatus(msg) {
        const el = document.querySelector('#sync-status-msg');
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
            <strong>Lightship Exporter</strong>
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
        </div>
    `;

        document.body.appendChild(panel);

        // Toggle panel visibility
        document.querySelector('#toggle-sync-panel').onclick = () => {
            const body = document.querySelector('#sync-panel-body');
            body.style.display = (body.style.display === 'none') ? 'block' : 'none';
            const toggle = document.querySelector('#toggle-sync-panel');
            toggle.textContent = (body.style.display === 'none') ? '+' : '−';
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

        return {
            setStatus: (text, enabled) => {
                panel.querySelector('#sync-status-msg').textContent = text;
                syncBtn.disabled = !enabled;
            }
        };
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
