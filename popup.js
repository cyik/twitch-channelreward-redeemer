const statusListEl = document.getElementById('statusList');
const activeCountEl = document.getElementById('activeCount');
const refreshBtn = document.getElementById('refreshBtn');

document.addEventListener('DOMContentLoaded', () => {
    updateUI();
    initAccordions();
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

function updateUI() {
    chrome.storage.local.get(['streamers', 'redeemHistory', 'activityLog'], (data) => {
        const streamers = data.streamers || [];
        const history = data.redeemHistory || [];
        const activity = data.activityLog || [];
        
        activeCountEl.textContent = `${streamers.length} Tracked`;
        
        // 1. Update Streamer Status List
        statusListEl.innerHTML = '';
        if (streamers.length === 0) {
            statusListEl.innerHTML = '<p style="text-align: center; color: #666; font-size: 13px; margin: 20px;">No streamers added yet. Go to settings.</p>';
        } else {
            streamers.forEach(s => {
                const div = document.createElement('div');
                div.className = 'streamer-item';
                div.innerHTML = `
                    <div class="streamer-info">
                        <h4><span class="live-indicator ${s.lastLiveStatus ? 'active' : ''}"></span>${s.login}</h4>
                        <p style="font-size: 10px; color: #888;">${s.rewardTitle}</p>
                    </div>
                    <span style="font-size: 11px; color: ${s.lastLiveStatus ? '#ff4a4a' : '#666'};">
                        ${s.lastLiveStatus ? 'Live' : 'Offline'}
                    </span>
                `;
                statusListEl.appendChild(div);
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
                    <div style="color: #666; font-size: 9px; margin-top: 4px;">Recorded at ${item.completedAt}</div>
                `;
                historyListEl.appendChild(div);
            });
        }

        // 3. Update Activity Log
        const activityListEl = document.getElementById('activityList');
        activityListEl.innerHTML = '';
        if (activity.length === 0) {
            activityListEl.innerHTML = '<p style="text-align: center; color: #888; font-size: 11px; padding: 20px;">No recent activity.</p>';
        } else {
            activity.forEach(item => {
                const div = document.createElement('div');
                div.className = 'activity-item';
                
                let badgeClass = 'badge-live';
                let label = 'LIVE';
                let description = `Streamer ${item.login} detected online.`;

                if (item.type === 'BROWSER_OPENED') {
                    badgeClass = 'badge-browser';
                    label = 'BROWSER';
                    description = item.status === 'success' 
                        ? `Opened watch tab for ${item.login}.` 
                        : `Failed to open tab for ${item.login}.`;
                }

                div.innerHTML = `
                    <div>
                        <span class="activity-badge ${badgeClass}">${label}</span>
                        <span>${description}</span>
                    </div>
                    <div class="activity-time">${item.timestamp}</div>
                `;
                activityListEl.appendChild(div);
            });
        }
    });
}
