// ==UserScript==
// @name         Lightship Exporter
// @version      1.0.0
// @description  Export Lightship nominations to Google Sheet (Wayfarer Exporter style)
// @match        https://lightship.dev/account/geospatial-browser/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";
    const STORAGE_KEY = "lightshipexporter-candidates";

    // Load previously synced nominations from localStorage
    function loadStoredCandidates() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    // Save updated nomination records to localStorage
    function saveStoredCandidates(candidates) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(candidates));
    }

    // Try to extract nomination data from the React Fiber tree
    function extractNominationsFromFiber() {
        const table = document.querySelector("table");
        if (!table) return [];

        let fiberNode = null;

        // Find the React fiber object attached to the table element
        for (const key in table) {
            if (key.startsWith("__reactFiber$")) {
                fiberNode = table[key];
                break;
            }
        }

        if (!fiberNode) return [];

        let cursor = fiberNode;

        // Traverse up the fiber tree to find the component that holds submissionPois
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

    function getUserEmail() {
        const btn = document.querySelector('button.account-menu-dropdown');
        if (!btn) return "";
        return btn.textContent.trim();
    }

    // Send a nomination as a POST request to Google Apps Script
    function uploadNomination(nomination, scriptUrl) {
        const formData = new FormData();
        formData.append("id", nomination.id);
        formData.append("title", nomination.title || "");
        formData.append("description", nomination.description || "");
        formData.append("lat", nomination.lat);
        formData.append("lng", nomination.lng);
        formData.append("status", (nomination.state || "").toLowerCase());
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

        if (!nominations || nominations.length === 0) {
            alert("⚠️ 未找到可上传的提名项！");
            return;
        }

        const nominationsToUpload = [];
        const pendingNominations = [];// 👈 保存详细标注，用于后续展示
        window.pendingNominationsToUpload = pendingNominations;

        for (const n of nominations) {
            const prev = stored[n.id];
            const currentStatus = (n.state || "").toLowerCase();
            const reason = !prev
            ? "new"
            : (prev.status !== currentStatus ? "status changed" : null);

            if (reason) {
                nominationsToUpload.push(n);
                pendingNominations.push({
                    id: n.id,
                    title: n.title,
                    reason: reason,
                });
            }
        }

        let synced = 0;

        // 控制并发批量上传
        const batchSize = 5;

        for (let i = 0; i < nominationsToUpload.length; i += batchSize) {
            const batch = nominationsToUpload.slice(i, i + batchSize);

            await Promise.all(batch.map(async (n, index) => {
                const currentStatus = (n.state || "").toLowerCase();
                try {
                    updateSyncStatus(`📤 Uploading ${i + index + 1} / ${nominationsToUpload.length}: ${n.title}`);
                    await uploadNomination(n, scriptUrl);

                    stored[n.id] = {
                        title: n.title,
                        status: currentStatus,
                    };
                    saveStoredCandidates(stored);
                    synced++;
                } catch (e) {
                    console.error(`❌ Failed to upload: ${n.title}`, e);
                }
            }));
        }

        updateSyncStatus(`✅ Upload complete. ${synced} nomination(s) uploaded.`);
        setTimeout(() => updateSyncStatus("Ready."), 3000);
    }

    function formatTimestamp(msString) {
        if (!msString) return "";
        const date = new Date(parseInt(msString, 10));
        return date.toISOString().split("T")[0]; // → "YYYY-MM-DD"
    }

    function updateSyncStatus(msg) {
        const el = document.querySelector('#sync-status-msg');
        if (el) el.textContent = msg;
    }


    function createFloatingSyncPanel(onSyncClick) {
        // 避免重复添加
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
                        title="Upload all new or changed nominations compared with local cache to Google Sheet"
                        style="width: 100%; padding: 8px; background-color: #4CAF50; color: white; border: none; border-radius: 5px; margin-top: 5px;"
                        disabled>📤 Sync Submissions</button>
                <button id="preview-upload-btn"
                        title="Preview the nominations that will be uploaded (if ready)"
                        style="width: 100%; padding: 8px; margin-top: 5px;">🔍 Preview Uploads</button>
                <button id="clear-cache-btn"
                        title="Clear local upload record; after this, all nominations will be re-uploaded"
                        style="width: 100%; padding: 8px; background-color: #f44336; color: white; border: none; border-radius: 5px; margin-top: 5px;">🧹 Clear Local Cache</button>
                <button id="download-cache-btn"
                        title="Download current local cache as JSON file"
                        style="width: 100%; padding: 8px; margin-top: 5px;">💾 Download Cache</button>
                <input type="file" id="upload-cache-input" style="display: none;" />
                <button id="upload-cache-btn"
                        title="Import JSON cache and replace existing local records"
                        style="width: 100%; padding: 8px; margin-top: 5px;">📥 Import and Replace Current Cache</button>
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
            if (!url) return alert("❗ 请填写 Script URL");
            localStorage.setItem("lightshipexporter-script-url", url);

            await syncNewNominations(url);
        };

        const clearBtn = document.querySelector('#clear-cache-btn');
        clearBtn.onclick = () => {
            if (confirm("Are you sure you want to clear the upload cache?")) {
                localStorage.removeItem(STORAGE_KEY);
                updateSyncStatus("🧹 Cache cleared.");
            }
        };

        // 💾 下载缓存
        const downloadBtn = panel.querySelector('#download-cache-btn');
        downloadBtn.onclick = () => {
            const data = localStorage.getItem(STORAGE_KEY) || "{}";
            const blob = new Blob([data], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "lightship_cache.json";
            a.click();
            URL.revokeObjectURL(url);
        };

        // 📥 上传缓存
        const fileInput = panel.querySelector('#upload-cache-input');
        const uploadBtn = panel.querySelector('#upload-cache-btn');

        uploadBtn.onclick = () => fileInput.click();

        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function (event) {
                try {
                    const parsed = JSON.parse(event.target.result);
                    if (typeof parsed === "object") {
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
                        updateSyncStatus("✅ Cache imported.");
                    } else {
                        throw new Error("Invalid cache format");
                    }
                } catch (err) {
                    console.error("Failed to import cache:", err);
                    alert("❌ Failed to import cache: Invalid JSON.");
                }
            };
            reader.readAsText(file);
        };

        const previewBtn = panel.querySelector('#preview-upload-btn');
        previewBtn.onclick = () => {
            const list = window.pendingNominationsToUpload || [];
            if (list.length === 0) {
                alert("No nominations pending upload.");
                return;
            }

            const message = list.map((n, i) => `${i + 1}. ${n.title} (${n.reason})`).join("\n");
            alert(`Nominations to be uploaded:\n\n${message}`);
        };

        return {
            setStatus: (text, enabled) => {
                panel.querySelector('#sync-status-msg').textContent = text;
                syncBtn.disabled = !enabled;
            }
        };
    }


    function waitForSubmissionsTabActivationThenInsertButton() {
        const tryAttach = () => {
            const tab = document.querySelector('#tab-submissions');
            if (!tab) {
                console.warn("Waiting for submissions tab...");
                setTimeout(tryAttach, 1000); // 延迟重试
                return;
            }

            const uiPanel = createFloatingSyncPanel(); // 插入 UI
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

            // 初始状态检查
            const isActive = tab.getAttribute('aria-selected') === 'true';
            uiPanel.setStatus(
                isActive ? "✅ Submissions tab is active." : "📄 Switch to Submissions tab to enable sync.",
                isActive
            );
        };

        setTimeout(tryAttach, 1000); // 初始延迟，避免干扰首屏渲染
    }

    waitForSubmissionsTabActivationThenInsertButton();
})();
