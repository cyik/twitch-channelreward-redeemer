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

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['clientId', 'accessToken', 'streamers', 'redirectUrl', 'checkInterval'], async (data) => {
        if (data.clientId) clientIdInput.value = data.clientId;
        if (data.accessToken) manualTokenInput.value = data.accessToken;
        
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
                authStatusEl.textContent = "✓ Connected to Twitch";
                authStatusEl.style.color = "var(--success)";
            } else {
                authStatusEl.textContent = "⚠ Connection Expired - Please Log in again";
                authStatusEl.style.color = "var(--warning)";
                // Don't clear storage automatically to avoid losing settings, 
                // but mark as invalid
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
    if (isNaN(interval) || interval < 5) {
        alert('Too Fast: Please enter 5 seconds or more to avoid being blocked by Twitch.');
        return;
    }

    chrome.storage.local.set({ checkInterval: interval }, () => {
        chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });
        alert(`Success: Check frequency updated to every ${interval} seconds.`);
    });
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
    chrome.storage.local.set({ clientId, accessToken: token, redirectUrl }, () => {
        authStatusEl.textContent = "✓ Connected Manually";
        authStatusEl.style.color = "var(--success)";
        alert('Keys saved! You are now connected.');
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
                chrome.storage.local.set({ accessToken: token }, async () => {
                    const isValid = await validateToken(token, clientId);
                    if (isValid) {
                        authStatusEl.textContent = "✓ Connected to Twitch";
                        authStatusEl.style.color = "var(--success)";
                        alert('Successfully connected to Twitch!');
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
        if (rewards.length === 0) {
            alert('No Rewards Found: This streamer has no custom point rewards available.');
            return;
        }
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
                <p>${s.rewardTitle}</p>
            </div>
            <div class="streamer-actions">
                <button class="btn-small btn-test" data-index="${index}">Test</button>
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
                e.target.textContent = 'Test';
                e.target.disabled = false;
            }
        });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentStreamers.splice(e.target.dataset.index, 1);
            chrome.storage.local.set({ streamers: currentStreamers }, renderStreamerList);
        });
    });
}

function showRewardModal(login, rewards) {
    document.body.classList.add('modal-open');
    rewardListEl.innerHTML = '';
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
                lastLiveStatus: false
            };
            currentStreamers.push(newStreamer);
            chrome.storage.local.set({ streamers: currentStreamers }, () => {
                renderStreamerList();
                rewardModal.classList.add('hidden');
                document.body.classList.remove('modal-open');
                streamerLoginInput.value = '';
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
