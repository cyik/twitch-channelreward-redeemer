const statusListEl = document.getElementById('statusList');
const activeCountEl = document.getElementById('activeCount');
const refreshBtn = document.getElementById('refreshBtn');

document.addEventListener('DOMContentLoaded', () => {
    updateUI();
    initAccordions();
    refreshBtn.click(); // Auto-refresh on open to ensure newest info visually
});

// Real-time update if background detects a change while menu is open
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.streamers || changes.redeemHistory || changes.activityLog)) {
        updateUI();
    }
});

function initAccordions() {
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const content = header.nextElementSibling;
            const arrow = header.querySelector('.arrow');

            const isActive = content.classList.contains('active');

            // Toggle current
            content.classList.toggle('active');
            arrow.classList.toggle('active');
            arrow.textContent = isActive ? '▶' : '▼';
        });
    });
}

refreshBtn.addEventListener('click', async () => {
    refreshBtn.textContent = 'Checking...';
    refreshBtn.disabled = true;

    await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });

    setTimeout(() => {
        updateUI();
        refreshBtn.textContent = 'Refresh';
        refreshBtn.disabled = false;
    }, 1500);
});

function formatLogDate(dateStr) {
    if (!dateStr) {
        return new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }
    // If it already has a full date format (like "Aug 25, 2026, 9:06:45 PM" or "8/25/2026, 9:06:45 PM")
    if (dateStr.includes('/') || dateStr.includes('-') || dateStr.includes(',')) {
        return dateStr;
    }
    // Legacy time-only entry: attach date
    const today = new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    return `${today}, ${dateStr}`;
}

function updateUI() {
    chrome.storage.local.get(['streamers', 'redeemHistory', 'activityLog', 'watchStreaks'], (data) => {
        const streamers = data.streamers || [];
        const history = data.redeemHistory || [];
        const activity = data.activityLog || [];
        const streaks = data.watchStreaks || {};

        activeCountEl.textContent = `${streamers.length} Tracked`;

        // 1. Update Streamer Status List
        statusListEl.innerHTML = '';
        if (streamers.length === 0) {
            statusListEl.innerHTML = '<p style="text-align: center; color: #666; font-size: 13px; margin: 20px;">No streamers added yet. Go to settings.</p>';
        } else {
            streamers.forEach((s, index) => {
                const div = document.createElement('div');
                div.className = 'streamer-item';
                div.draggable = true;
                div.dataset.index = index;

                const streakData = streaks[s.login.toLowerCase()];
                const streakCount = streakData ? streakData.value : null;

                div.innerHTML = `
                    <div class="drag-handle">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                    <div class="streamer-info">
                        <h4 style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                            <span class="live-indicator ${s.lastLiveStatus ? 'active' : ''}"></span>
                            ${s.login}
                            ${streakCount !== null ? `
                                <span title="Watch Streak" style="font-size: 10px; color: #ff8c00; font-weight: 700; margin-left: 4px; background: rgba(255, 140, 0, 0.15); padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(255, 140, 0, 0.3); display: inline-flex; align-items: center; gap: 2px;">
                                    🔥 ${streakCount}
                                </span>
                            ` : ''}
                        </h4>
                        <p style="font-size: 10px; color: #888;">${s.rewardTitle}</p>
                    </div>
                    <span style="font-size: 11px; color: ${s.lastLiveStatus ? '#ff4a4a' : '#666'};">
                        ${s.lastLiveStatus ? 'Live' : 'Offline'}
                    </span>
                `;
                statusListEl.appendChild(div);

                // Drag Events
                div.addEventListener('dragstart', (e) => {
                    div.classList.add('dragging');
                    e.dataTransfer.setData('text/plain', index);
                    e.dataTransfer.effectAllowed = 'move';
                });

                div.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = div.getBoundingClientRect();
                    const midpoint = rect.top + rect.height / 2;
                    if (e.clientY < midpoint) {
                        div.classList.add('drag-over');
                        div.classList.remove('drag-over-bottom');
                    } else {
                        div.classList.add('drag-over-bottom');
                        div.classList.remove('drag-over');
                    }
                });

                div.addEventListener('dragleave', () => {
                    div.classList.remove('drag-over');
                    div.classList.remove('drag-over-bottom');
                });

                div.addEventListener('drop', (e) => {
                    e.preventDefault();
                    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                    let toIndex = parseInt(div.dataset.index);

                    div.classList.remove('drag-over');
                    div.classList.remove('drag-over-bottom');
                    if (fromIndex === toIndex) return;

                    const rect = div.getBoundingClientRect();
                    const isBottom = e.clientY > (rect.top + rect.height / 2);

                    const [draggedItem] = streamers.splice(fromIndex, 1);
                    if (fromIndex < toIndex) {
                        if (!isBottom) toIndex--;
                    } else {
                        if (isBottom) toIndex++;
                    }
                    streamers.splice(toIndex, 0, draggedItem);

                    chrome.storage.local.set({ streamers: streamers }, () => {
                        chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
                    });
                });

                div.addEventListener('dragend', () => {
                    div.classList.remove('dragging');
                    document.querySelectorAll('.streamer-item').forEach(el => {
                        el.classList.remove('drag-over');
                        el.classList.remove('drag-over-bottom');
                    });
                });
            });
        }

        // 2. Update Redemption History
        const historyListEl = document.getElementById('historyList');
        historyListEl.innerHTML = '';
        if (history.length === 0) {
            historyListEl.innerHTML = '<p style="text-align: center; color: #888; font-size: 11px; padding: 20px;">No recent redemptions.</p>';
        } else {
            history.forEach(item => {
                const div = document.createElement('div');
                div.className = `history-item ${item.status.toLowerCase()}`;
                div.innerHTML = `
                    <div style="display: flex; justify-content: space-between; font-weight: 600;">
                        <span>${item.login}</span>
                        <span style="color: ${item.status === 'SUCCESS' ? 'var(--success)' : '#ff4a4a'}">
                            ${item.status}
                        </span>
                    </div>
                    <div style="color: #bbb; margin-top: 2px;">${item.reward}</div>
                    <div style="color: #666; font-size: 9px; margin-top: 4px;">Recorded at ${formatLogDate(item.completedAt)}</div>
                `;
                historyListEl.appendChild(div);
            });
        }

        // 3. Update Activity Log (Filter out browser open logs, keep only live activity logs)
        const activityListEl = document.getElementById('activityList');
        activityListEl.innerHTML = '';
        const liveActivityOnly = activity.filter(item => item.type !== 'BROWSER_OPENED');
        if (liveActivityOnly.length === 0) {
            activityListEl.innerHTML = '<p style="text-align: center; color: #888; font-size: 11px; padding: 20px;">No recent live activity.</p>';
        } else {
            liveActivityOnly.forEach(item => {
                const div = document.createElement('div');
                div.className = 'activity-item';

                const badgeClass = 'badge-live';
                const label = 'LIVE';
                const description = `Streamer ${item.login} detected online.`;

                div.innerHTML = `
                    <div>
                        <span class="activity-badge ${badgeClass}">${label}</span>
                        <span>${description}</span>
                    </div>
                    <div class="activity-time">${formatLogDate(item.timestamp)}</div>
                `;
                activityListEl.appendChild(div);
            });
        }
    });
}
