const clientIdInput = document.getElementById('clientId');
const redirectUrlInput = document.getElementById('redirectUrl');
const useDefaultUrlBtn = document.getElementById('useDefaultUrl');
const loginTwitchBtn = document.getElementById('loginTwitch');
const authStatusEl = document.getElementById('authStatus');

const manualTokenInput = document.getElementById('manualToken');
const saveManualBtn = document.getElementById('saveManual');

const streamerLoginInput = document.getElementById('streamerLogin');
const addStreamerBtn = document.getElementById('addStreamer');
const streamerListEl = document.getElementById('streamerList');

const rewardModal = document.getElementById('rewardModal');
const rewardListEl = document.getElementById('rewardList');
const closeModalBtn = document.getElementById('closeModal');

let currentStreamers = [];
let pendingStreamer = null;
let accessToken = "";

const saveIntervalBtn = document.getElementById('saveInterval');
const checkIntervalInput = document.getElementById('checkInterval');
const realTimeModeInput = document.getElementById('realTimeMode');
const autoClaimBonusInput = document.getElementById('autoClaimBonus');

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['clientId', 'accessToken', 'streamers', 'redirectUrl', 'checkInterval', 'realTimeMode', 'autoClaimBonus'], async (data) => {
        if (data.clientId) clientIdInput.value = data.clientId;
        if (data.accessToken) manualTokenInput.value = data.accessToken;
        if (data.realTimeMode !== undefined) realTimeModeInput.checked = data.realTimeMode;
        
        if (data.autoClaimBonus !== undefined) {
            autoClaimBonusInput.checked = data.autoClaimBonus;
        } else {
            autoClaimBonusInput.checked = true;
        }
        
        let defaultRedirect = "";
        try {
            if (chrome.identity && chrome.identity.getRedirectURL) {
                defaultRedirect = chrome.identity.getRedirectURL();
            }
        } catch (e) {
            console.warn("Could not get default redirect URL:", e);
        }

        if (data.redirectUrl) {
            redirectUrlInput.value = data.redirectUrl;
        } else if (defaultRedirect) {
            redirectUrlInput.value = defaultRedirect;
        }

        if (data.accessToken && data.clientId) {
            accessToken = data.accessToken;
            const isValid = await validateToken(accessToken, data.clientId);
            if (isValid) {
                // Determine the correct connection message
                const msg = data.connectionType === 'manual' ? "✓ Connected Manually (Saved)" : "✓ Connected to Twitch (Saved)";
                authStatusEl.textContent = msg;
                authStatusEl.style.color = "var(--success)";
                
                // Add a permanent 'Saved' indicator to the input field itself for peace of mind
                manualTokenInput.placeholder = "Key is saved and active";
            } else {
                authStatusEl.textContent = "⚠ Connection Expired - Please Log in again";
                authStatusEl.style.color = "var(--warning)";
            }
        } else {
            authStatusEl.textContent = "✕ Not Connected";
            authStatusEl.style.color = "var(--error)";
        }

        if (data.checkInterval) {
            document.getElementById('checkInterval').value = data.checkInterval;
        } else {
            document.getElementById('checkInterval').value = 60;
        }

        if (data.streamers) {
            currentStreamers = data.streamers;
            renderStreamerList();
        }
    });
});

useDefaultUrlBtn.addEventListener('click', () => {
    if (!chrome.identity || !chrome.identity.getRedirectURL) {
        alert('Browser Error: Your browser has disabled the Identity API. If you are using Brave, enable "Google Services" in settings. Otherwise, please use the Manual Connection method.');
        return;
    }
    redirectUrlInput.value = chrome.identity.getRedirectURL();
});

saveIntervalBtn.addEventListener('click', () => {
    const interval = parseInt(checkIntervalInput.value);
    const realTime = realTimeModeInput.checked;
    
    if (isNaN(interval) || interval < 5) {
        alert('Too Fast: Please enter 5 seconds or more for Polling mode.');
        return;
    }

    chrome.storage.local.set({ 
        checkInterval: interval,
        realTimeMode: realTime
    }, () => {
        chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
        alert(`Settings Saved! Mode: ${realTime ? 'Real-time' : 'Polling'}`);
    });
});

realTimeModeInput.addEventListener('change', () => {
    const realTime = realTimeModeInput.checked;
    chrome.storage.local.set({ realTimeMode: realTime }, () => {
        chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
        // Subtle notification check
        console.log("Real-time mode updated to:", realTime);
    });
});

autoClaimBonusInput.addEventListener('change', () => {
    chrome.storage.local.set({ autoClaimBonus: autoClaimBonusInput.checked });
});

saveManualBtn.addEventListener('click', () => {
    const token = manualTokenInput.value.trim();
    const clientId = clientIdInput.value.trim();
    const redirectUrl = redirectUrlInput.value.trim();

    if (!token || !clientId) {
        alert('Missing Info: Please enter your Application ID and Connection Key.');
        return;
    }

    accessToken = token;
    chrome.storage.local.set({ clientId, accessToken: token, redirectUrl, connectionType: 'manual' }, () => {
        authStatusEl.textContent = "✓ Connected Manually (Saved)";
        authStatusEl.style.color = "var(--success)";
        manualTokenInput.placeholder = "Key is saved and active";
        alert('Credentials Saved Permanently! You are now connected and can close this page.');
    });
});

loginTwitchBtn.addEventListener('click', () => {
    const clientId = clientIdInput.value.trim();
    const redirectUrl = redirectUrlInput.value.trim();

    if (!clientId) {
        alert('Missing Application ID: Please paste your Client ID first.');
        return;
    }
    if (!redirectUrl) {
        alert('Missing Security Link: Please enter your Redirect URL.');
        return;
    }

    chrome.storage.local.set({ clientId, redirectUrl });

    const authUrl = `https://id.twitch.tv/oauth2/authorize` +
        `?client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
        `&response_type=token` +
        `&scope=channel:read:redemptions+user:read:broadcast`;

    if (!chrome.identity || !chrome.identity.launchWebAuthFlow) {
        if (window.location.protocol === 'file:') {
            alert('Security Error: You opened the "options.html" file directly from your folder. \n\nYou MUST open it through Chrome: \n1. Go to chrome://extensions \n2. Find "Twitch Auto Redeemer" \n3. Click "Details" -> "Extension options"');
        } else {
            alert('Browser Error: Chrome has disabled the identity feature for this extension. \n\nFIX: Go to chrome://extensions and click the "Reload" (circular arrow) icon on this extension to refresh its permissions.');
        }
        return;
    }

    chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
    }, (redirectResponse) => {
        if (chrome.runtime.lastError) {
            alert('Login Cancelled or Error: ' + chrome.runtime.lastError.message);
            return;
        }

        if (redirectResponse) {
            const params = new URLSearchParams(new URL(redirectResponse).hash.substring(1));
            const token = params.get('access_token');
            if (token) {
                accessToken = token;
                chrome.storage.local.set({ accessToken: token, connectionType: 'automatic' }, async () => {
                    const isValid = await validateToken(token, clientId);
                    if (isValid) {
                        authStatusEl.textContent = "✓ Connected to Twitch (Saved)";
                        authStatusEl.style.color = "var(--success)";
                        alert('Log in successful! Your connection is saved and active.');
                    } else {
                        alert('Security Warning: Login completed, but the token failed verification. Please double check your Client ID.');
                    }
                });
            }
        }
    });
});

async function validateToken(token, clientId) {
    try {
        const response = await fetch("https://id.twitch.tv/oauth2/validate", {
            headers: { "Authorization": `OAuth ${token}` }
        });
        if (!response.ok) return false;
        const json = await response.json();
        return json.client_id === clientId;
    } catch (e) {
        return false;
    }
}

addStreamerBtn.addEventListener('click', async () => {
    const login = streamerLoginInput.value.trim().toLowerCase();
    if (!login) return;
    if (!accessToken) {
        alert('Not Connected: Please login above before adding streamers.');
        return;
    }

    try {
        const rewards = await fetchChannelRewards(login);
        // Do not block if no rewards, they might want to just watch the stream.
        pendingStreamer = { login };
        showRewardModal(login, rewards);
    } catch (e) {
        alert('Connection Problem: ' + e.message);
    }
});

async function fetchChannelRewards(login) {
    // Stage 1: Try to sync with browser login for maximum reliability
    const getTwitchCookie = () => {
        return new Promise((resolve) => {
            chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }, (cookie) => {
                resolve(cookie ? cookie.value : null);
            });
        });
    };

    const cookieToken = await getTwitchCookie();
    const query = `query GetRewards($login: String!) {
        channel(name: $login) {
            id
            communityPointsSettings {
                customRewards { id title cost }
            }
        }
    }`;
    const body = {
        operationName: "GetRewards",
        variables: { login: login.toLowerCase().trim() },
        query: query
    };

    const headers = {
        "Client-Id": "kimne78kx3ncx6br8ac4hz66l2s7vv", 
        "Content-Type": "application/json"
    };

    if (cookieToken) {
        headers["Authorization"] = `OAuth ${cookieToken}`;
    }

    const response = await fetch("https://gql.twitch.tv/gql", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
    });

    const json = await response.json();
    if (json.errors) throw new Error(json.errors[0].message);
    
    const channelData = json.data?.channel;
    if (!channelData) {
        throw new Error(`Data is restricted for "${login}". Make sure you are logged into Twitch in this browser.`);
    }

    return channelData.communityPointsSettings?.customRewards || [];
}

function renderStreamerList() {
    streamerListEl.innerHTML = '';
    currentStreamers.forEach((s, index) => {
        const div = document.createElement('div');
        div.className = 'streamer-item';
        div.innerHTML = `
            <div class="streamer-info">
                <h4>${s.login}</h4>
                <p>${s.rewardTitle || 'No Reward Selected'}</p>
                <div class="streamer-toggles" style="display: flex; gap: 18px; margin-top: 10px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <label class="switch" style="transform: scale(0.8); margin: 0; transform-origin: left center;">
                            <input type="checkbox" class="toggle-redeem" data-index="${index}" ${s.enableRedeem !== false && s.rewardId ? 'checked' : ''} ${!s.rewardId ? 'disabled' : ''}>
                            <span class="slider"></span>
                        </label>
                        <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Auto-Redeem</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <label class="switch" style="transform: scale(0.8); margin: 0; transform-origin: left center;">
                            <input type="checkbox" class="toggle-watch" data-index="${index}" ${s.enableWatch !== false ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                        <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Auto-Watch</span>
                    </div>
                </div>
            </div>
            <div class="streamer-actions" style="display: flex; gap: 8px;">
                <button class="btn-small btn-test" data-index="${index}">Test Redeem</button>
                <button class="btn-small btn-test-watch" data-index="${index}">Test Watch</button>
                <button class="btn-delete" data-index="${index}">Delete</button>
            </div>
        `;
        streamerListEl.appendChild(div);
    });

    document.querySelectorAll('.btn-test').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const index = e.target.dataset.index;
            const s = currentStreamers[index];
            e.target.textContent = 'Testing...';
            e.target.disabled = true;

            try {
                // Send message to background to trigger immediate redemption test
                const response = await chrome.runtime.sendMessage({ 
                    type: 'CHECK_NOW', 
                    forceRedeem: true, 
                    streamerLogin: s.login 
                });
                alert('Test Signal Sent! Check your Chrome notifications to see if it was successful.');
            } catch (err) {
                alert('Test Failed: ' + err.message);
            } finally {
                e.target.textContent = 'Test Redeem';
                e.target.disabled = false;
            }
        });
    });

    document.querySelectorAll('.btn-test-watch').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const index = e.target.dataset.index;
            const s = currentStreamers[index];
            e.target.textContent = 'Opening...';
            e.target.disabled = true;

            try {
                await chrome.runtime.sendMessage({ 
                    type: 'TEST_WATCH', 
                    streamerLogin: s.login 
                });
                // Alert isn't needed here since background script creates a notification
            } catch (err) {
                alert('Test Watch Failed: ' + err.message);
            } finally {
                e.target.textContent = 'Test Watch';
                e.target.disabled = false;
            }
        });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentStreamers.splice(e.target.dataset.index, 1);
            chrome.storage.local.set({ streamers: currentStreamers }, () => {
                renderStreamerList();
                chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
            });
        });
    });

    document.querySelectorAll('.toggle-redeem').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const index = e.target.dataset.index;
            currentStreamers[index].enableRedeem = e.target.checked;
            chrome.storage.local.set({ streamers: currentStreamers }, () => {
                chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
            });
        });
    });

    document.querySelectorAll('.toggle-watch').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const index = e.target.dataset.index;
            currentStreamers[index].enableWatch = e.target.checked;
            chrome.storage.local.set({ streamers: currentStreamers }, () => {
                chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
            });
        });
    });
}

function showRewardModal(login, rewards) {
    document.body.classList.add('modal-open');
    rewardListEl.innerHTML = '';

    const noRewardItem = document.createElement('div');
    noRewardItem.className = 'reward-item';
    noRewardItem.innerHTML = `<span style="font-weight: bold; color: var(--primary);">Watch Streak Only (No Reward)</span><span></span>`;
    noRewardItem.addEventListener('click', () => {
        const newStreamer = {
            login,
            rewardId: null,
            rewardTitle: "Watch Streak Only",
            rewardCost: 0,
            lastLiveStatus: false,
            enableRedeem: false,
            enableWatch: true
        };
        currentStreamers.push(newStreamer);
        chrome.storage.local.set({ streamers: currentStreamers }, () => {
            renderStreamerList();
            rewardModal.classList.add('hidden');
            document.body.classList.remove('modal-open');
            streamerLoginInput.value = '';
            chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
        });
    });
    rewardListEl.appendChild(noRewardItem);

    rewards.forEach(reward => {
        const div = document.createElement('div');
        div.className = 'reward-item';
        div.innerHTML = `<span>${reward.title}</span><span class="cost">${reward.cost} pts</span>`;
        div.addEventListener('click', () => {
            const newStreamer = {
                login,
                rewardId: reward.id,
                rewardTitle: reward.title,
                rewardCost: reward.cost,
                lastLiveStatus: false,
                enableRedeem: true,
                enableWatch: true
            };
            currentStreamers.push(newStreamer);
            chrome.storage.local.set({ streamers: currentStreamers }, () => {
                renderStreamerList();
                rewardModal.classList.add('hidden');
                document.body.classList.remove('modal-open');
                streamerLoginInput.value = '';
                chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
            });
        });
        rewardListEl.appendChild(div);
    });
    rewardModal.classList.remove('hidden');
}

closeModalBtn.addEventListener('click', () => {
    rewardModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
});
