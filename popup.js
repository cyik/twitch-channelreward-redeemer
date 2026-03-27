const statusListEl = document.getElementById('statusList');
const activeCountEl = document.getElementById('activeCount');
const refreshBtn = document.getElementById('refreshBtn');

document.addEventListener('DOMContentLoaded', updateUI);

refreshBtn.addEventListener('click', async () => {
    refreshBtn.textContent = 'Checking...';
    refreshBtn.disabled = true;

    // Send message to background script to check streams now
    await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
    
    // Refresh UI after a short delay to allow background script time
    setTimeout(() => {
        updateUI();
        refreshBtn.textContent = 'Refresh';
        refreshBtn.disabled = false;
    }, 1500);
});

function updateUI() {
    chrome.storage.local.get(['streamers', 'redeemHistory'], (data) => {
        const streamers = data.streamers || [];
        const history = data.redeemHistory || [];
        
        activeCountEl.textContent = `${streamers.length} Tracked`;
        
        // Update Streamer Status List
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

        // Update History List
        const historyListEl = document.getElementById('historyList');
        historyListEl.innerHTML = '';
        if (history.length === 0) {
            historyListEl.innerHTML = '<p style="text-align: center; color: #888; font-size: 11px; margin-top: 10px;">No recent activity.</p>';
        } else {
            history.forEach(item => {
                const div = document.createElement('div');
                div.className = `history-item ${item.status.toLowerCase()}`;
                div.innerHTML = `
                    <div class="history-main">
                        <strong>${item.login}</strong>: ${item.reward}
                        <span class="history-status ${item.status.toLowerCase()}">${item.status}</span>
                    </div>
                    <div class="history-details">
                        <span>Live: ${item.liveAt}</span> | 
                        <span>Redeemed: ${item.completedAt}</span>
                    </div>
                    ${item.reason ? `<div class="history-error">${item.reason}</div>` : ''}
                `;
                historyListEl.appendChild(div);
            });
        }
    });
}
