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

const autoClaimBonusInput = document.getElementById('autoClaimBonus');

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['clientId', 'accessToken', 'streamers', 'redirectUrl', 'checkInterval', 'realTimeMode', 'autoClaimBonus'], async (data) => {
        if (data.clientId) clientIdInput.value = data.clientId;
        if (data.accessToken) manualTokenInput.value = data.accessToken;

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

            if (data.connectionType === 'manual') {
                // For manual connections, we trust the saved token on startup 
                // because it might be a cookie token that fails OAuth validation.
                authStatusEl.textContent = "✓ Connected Manually (Saved)";
                authStatusEl.style.color = "var(--success)";
                manualTokenInput.placeholder = "Key is saved and active";
            } else {
                // For automatic OAuth connections, we perform a quick validation
                const isValid = await validateToken(accessToken, data.clientId);
                if (isValid) {
                    authStatusEl.textContent = "✓ Connected to Twitch (Saved)";
                    authStatusEl.style.color = "var(--success)";
                    manualTokenInput.placeholder = "Key is saved and active";
                } else {
                    authStatusEl.textContent = "⚠ Connection Expired - Please Log in again";
                    authStatusEl.style.color = "var(--warning)";
                }
            }
        } else {
            authStatusEl.textContent = "✕ Not Connected";
            authStatusEl.style.color = "var(--danger)";
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


autoClaimBonusInput.addEventListener('change', (e) => {
    chrome.storage.local.set({ autoClaimBonus: e.target.checked });
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
    if (!token || !clientId) return false;
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
    const cleanLogin = login.toLowerCase().trim();

    const getTwitchCookie = () => {
        return new Promise((resolve) => {
            chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }, (cookie) => {
                resolve(cookie ? cookie.value : null);
            });
        });
    };

    const cookieToken = await getTwitchCookie();
    const body = {
        operationName: "GetRewards",
        variables: { login: cleanLogin },
        query: `query GetRewards($login: String!) {
            channel(name: $login) {
                id
                communityPointsSettings {
                    customRewards { id title cost prompt isUserInputRequired }
                }
            }
        }`
    };

    const makeRequest = async (authToken) => {
        const headers = {
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            "Content-Type": "application/json"
        };
        if (authToken) {
            headers["Authorization"] = authToken.startsWith("OAuth ") || authToken.startsWith("Bearer ")
                ? authToken
                : `OAuth ${authToken}`;
        }
        return await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body)
        });
    };

    try {
        let response = await makeRequest(cookieToken);

        // If Twitch returned 401 Unauthorized due to an expired/stale cookieToken, retry without it or with accessToken
        if (response.status === 401) {
            console.warn("Cookie token resulted in 401 Unauthorized. Retrying with saved access token / unauthenticated...");
            response = await makeRequest(accessToken || null);
        }

        if (!response.ok) {
            console.warn(`GQL HTTP ${response.status} ${response.statusText}`);
            return [];
        }

        const json = await response.json();
        console.log("[Twitch GQL Response]:", json.data?.channel);
        if (json.errors) {
            console.warn("GQL returned errors:", json.errors);
        }

        const rewards = json.data?.channel?.communityPointsSettings?.customRewards;
        return rewards || [];
    } catch (e) {
        console.warn(`Failed to fetch channel rewards for "${cleanLogin}":`, e);
        return [];
    }
}

function renderStreamerList() {
    chrome.storage.local.get(['watchStreaks'], (data) => {
        _renderStreamerListSync(data.watchStreaks || {});
    });
}

function _renderStreamerListSync(streaks) {
    streamerListEl.innerHTML = '';
    currentStreamers.forEach((s, index) => {
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
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <h4>${s.login}</h4>
                        ${streakCount !== null ? `
                            <span class="streak-badge" title="Watch Streak Count" style="background: rgba(2, 2, 2, 0.15); color: #ff8c00; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; border: 1px solid rgba(255, 140, 0, 0.3); display: inline-flex; align-items: center; gap: 3px;">
                                🔥 ${streakCount} Streak${streakCount === 1 ? '' : 's'}
                            </span>
                        ` : ''}
                    </div>
                    <p>${s.rewardTitle || 'No Reward Selected'}</p>
                ${s.rewardId && s.userInput !== undefined && s.userInput !== null ? `
                    <div class="mt-5">
                        <input type="text" class="edit-user-input" data-index="${index}" value="${s.userInput}" placeholder="Message required..." style="font-size: 11px; padding: 4px 8px; background: rgba(255,255,255,0.05); border-color: var(--border);">
                    </div>
                ` : ''}
                <div class="streamer-toggles" style="display: flex; gap: 18px; margin-top: 10px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <label class="switch" style="transform: scale(0.8); margin: 0; transform-origin: left center;">
                            <input type="checkbox" class="toggle-redeem" data-index="${index}" ${s.enableRedeem !== false && s.rewardId ? 'checked' : ''} ${!s.rewardId ? 'disabled' : ''}>
                            <span class="slider"></span>
                        </label>
                        <span>
                            <p> Auto-Redeem </p>
                        </span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <label class="switch" style="transform: scale(0.8); margin: 0; transform-origin: left center;">
                            <input type="checkbox" class="toggle-watch" data-index="${index}" ${s.enableWatch !== false ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                        <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.5px;">Auto-Watch</span>
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

            // Determine if we should insert before or after based on mouse position
            const rect = div.getBoundingClientRect();
            const isBottom = e.clientY > (rect.top + rect.height / 2);

            // Remove the item from the original list
            const [draggedItem] = currentStreamers.splice(fromIndex, 1);

            // Re-calculate toIndex because the array has shifted
            // If we moved an item from above to below, the target index shifts left by 1
            if (fromIndex < toIndex) {
                // If we drop on the top half of a later item, it should take that item's place (toIndex - 1)
                // If we drop on the bottom half, it should go after it (toIndex)
                if (!isBottom) toIndex--;
            } else {
                // If we move from below to above, and drop on bottom half, it goes after (toIndex + 1)
                if (isBottom) toIndex++;
            }

            // Insert at the corrected position
            currentStreamers.splice(toIndex, 0, draggedItem);

            chrome.storage.local.set({ streamers: currentStreamers }, () => {
                renderStreamerList();
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
                    streamerLogin: s.login,
                    rewardId: s.rewardId,
                    userInput: s.userInput
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

    document.querySelectorAll('.edit-user-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const index = e.target.dataset.index;
            currentStreamers[index].userInput = e.target.value.trim();
            chrome.storage.local.set({ streamers: currentStreamers });
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
        div.innerHTML = `
            <div style="flex: 1; width: 100%;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong>${reward.title}</strong>
                    <span class="cost">${reward.cost} pts</span>
                </div>
                ${reward.isUserInputRequired ? `
                    <div class="mt-10" style="width: 100%;">
                        <input type="text" class="reward-input-field" placeholder="Enter required message..." style="width: 100%;">
                        <div class="validation-error">Message Required: Please enter a message to auto-redeem this.</div>
                        <button class="btn-primary btn-small mt-10 select-reward-btn" style="width: 100%;">Select Reward</button>
                    </div>
                ` : ''}
            </div>
        `;

        // Handle input field focus/click specifically to avoid parent click
        const inputField = div.querySelector('.reward-input-field');
        if (inputField) {
            inputField.addEventListener('click', (e) => e.stopPropagation());
            inputField.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    div.click();
                }
            });
        }

        div.addEventListener('click', () => {
            let userInput = null;
            if (reward.isUserInputRequired) {
                const inputEl = div.querySelector('.reward-input-field');
                const errorEl = div.querySelector('.validation-error');
                userInput = inputEl.value.trim();

                if (!userInput) {
                    // Clear all other active errors first
                    document.querySelectorAll('.validation-error').forEach(el => el.classList.remove('active'));
                    errorEl.classList.add('active');
                    inputEl.focus();
                    return;
                }
            }

            const newStreamer = {
                login,
                rewardId: reward.id,
                rewardTitle: reward.title,
                rewardCost: reward.cost,
                rewardPrompt: reward.prompt || "",
                userInput: userInput,
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
