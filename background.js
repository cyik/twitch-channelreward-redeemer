const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_HELIX_URL = "https://api.twitch.tv/helix";
const TWITCH_EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";
const ALARM_NAME = "twitchCheckAlarm";
const KEEP_ALIVE_ALARM = "wsKeepAlive";
const EVENTSUB_RECONNECT_ALARM = "eventSubReconnect";

// Default settings
let settings = {
    clientId: "",
    accessToken: "",
    streamers: [],
    realTimeMode: true
};

let checkTimeout = null;
let eventSubSockets = [];
let keepAliveTimeout = null;
let eventSubGeneration = 0;
let eventSubReconnectDelayMinutes = 0.5;
let loadPromise = null;

// Initialize
chrome.runtime.onInstalled.addListener(() => {
    console.log("Twitch Auto Redeemer installed.");
    loadAndSchedule();
});

chrome.runtime.onStartup.addListener(() => {
    console.log("Twitch Auto Redeemer started with browser.");
    loadAndSchedule();
});

async function loadAndSchedule() {
    if (loadPromise) return loadPromise;
    loadPromise = _loadAndSchedule().finally(() => {
        loadPromise = null;
    });
    return loadPromise;
}

async function _loadAndSchedule() {
    const result = await chrome.storage.local.get(["clientId", "accessToken", "streamers"]);
    if (result.clientId) settings.clientId = result.clientId;
    if (result.accessToken) settings.accessToken = result.accessToken;
    if (result.streamers) settings.streamers = result.streamers;
    settings.realTimeMode = true; // Always true now

    try {
        const streaks = await fetchWatchStreaks();
        if (streaks && Object.keys(streaks).length > 0) {
            await chrome.storage.local.set({ watchStreaks: streaks });
        }
    } catch (e) {
        console.warn("[Watch Streak] Failed initial fetch:", e);
    }

    // Clear any existing schedules/sockets
    chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.clear(KEEP_ALIVE_ALARM);
    chrome.alarms.clear(EVENTSUB_RECONNECT_ALARM);
    closeAllEventSub();

    console.log("[Manager] REAL-TIME MODE ACTIVE.");
    // Create a fast alarm to keep the service worker alive
    chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
    
    // Initialize one WebSocket transport. Twitch limits websocket transports per user,
    // so batching by socket can exhaust the account-level transport cap.
    initAllEventSub(settings.streamers, settings.accessToken, settings.clientId);
    
    // Check current status immediately because EventSub only triggers on new transitions
    checkStreamersAndRedeem();
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_ALARM') {
        loadAndSchedule();
        sendResponse({ success: true });
    } else if (message.type === 'CHECK_NOW') {
        checkStreamersAndRedeem(message.forceRedeem, message.streamerLogin, message.rewardId, message.userInput);
        sendResponse({ success: true });
    } else if (message.type === 'TEST_WATCH') {
        testWatchStreak(message.streamerLogin).then(() => sendResponse({ success: true }));
    }
    return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
        // Ensure we are connected
        const allConnected = eventSubSockets.length > 0 && eventSubSockets.every(s => s.readyState === WebSocket.OPEN);
        const anyConnecting = eventSubSockets.some(s => s.readyState === WebSocket.CONNECTING);
        if (!allConnected) {
            if (!anyConnecting) {
                console.log("[Manager] EventSub is disconnected. Scheduling reconnect...");
                scheduleEventSubReconnect();
                checkStreamersAndRedeem();
            }
        }
    } else if (alarm.name === EVENTSUB_RECONNECT_ALARM) {
        console.log("[Manager] Reconnecting EventSub...");
        chrome.alarms.clear(EVENTSUB_RECONNECT_ALARM);
        loadAndSchedule();
    } else if (alarm.name.startsWith('closeWindow_')) {
        const parts = alarm.name.split('_');
        if (parts.length > 1) {
            const windowId = parseInt(parts[1], 10);
            chrome.windows.remove(windowId).catch(err => {
                console.log(`[Watch Streak] Could not remove window ${windowId} (might be already closed):`, err);
            });
            console.log(`[Watch Streak] Finished streak watch. Closed window ${windowId}.`);
        }
    }

    // Forcefully keep alive the service worker
    chrome.runtime.getPlatformInfo(() => { /* No-op */ });
});

// --- EventSub WebSocket Logic (Merged and Enhanced) ---

function initAllEventSub(streamers, accessToken, clientId) {
    if (!streamers || streamers.length === 0) return;
    if (!accessToken || !clientId) {
        console.warn("[EventSub] Missing access token or client id. Skipping real-time subscriptions.");
        return;
    }

    console.log(`[EventSub] Initializing WebSocket for ${streamers.length} streamer(s)...`);
    createEventSubSocket(streamers, accessToken, clientId, ++eventSubGeneration);
}

function createEventSubSocket(streamers, accessToken, clientId, generation, url = TWITCH_EVENTSUB_WS_URL, shouldSubscribe = true) {
    const socket = new WebSocket(url);
    eventSubSockets.push(socket);

    let currentSessionId = null;
    let expectedKeepAliveSeconds = 10;
    let skipCloseReconnect = false;

    socket.onmessage = (event) => {
        if (generation !== eventSubGeneration) return;
        const data = JSON.parse(event.data);
        const { metadata, payload } = data;
        const messageType = metadata.message_type;
        resetKeepAliveTimer(expectedKeepAliveSeconds);

        switch (messageType) {
            case "session_welcome":
                currentSessionId = payload.session.id;
                expectedKeepAliveSeconds = payload.session.keepalive_timeout_seconds || expectedKeepAliveSeconds;
                eventSubReconnectDelayMinutes = 0.5;
                console.log("[EventSub] Session Welcome! ID:", currentSessionId);
                if (shouldSubscribe) {
                    subscribeToBatch(streamers, accessToken, clientId, currentSessionId);
                }
                break;

            case "session_keepalive":
                resetKeepAliveTimer(expectedKeepAliveSeconds);
                break;

            case "notification":
                handleEventSubNotification(payload);
                break;

            case "session_reconnect":
                const reconnectUrl = payload.session.reconnect_url;
                console.log("[EventSub] Twitch requested WebSocket reconnect.");
                eventSubSockets = eventSubSockets.filter(s => s !== socket);
                createEventSubSocket(streamers, accessToken, clientId, generation, reconnectUrl, false);
                skipCloseReconnect = true;
                socket.close();
                break;
        }
    };

    socket.onclose = () => {
        console.warn("[EventSub] WebSocket Closed.");
        eventSubSockets = eventSubSockets.filter(s => s !== socket);
        if (generation === eventSubGeneration && !skipCloseReconnect) {
            clearKeepAliveTimer();
            scheduleEventSubReconnect();
        }
    };

    socket.onerror = (err) => {
        console.error("[EventSub] WebSocket Error:", err);
    };
}

async function subscribeToBatch(streamers, accessToken, clientId, sessionId) {
    const subscribedUserIds = new Set();
    for (let streamer of streamers) {
        try {
            const { success, userId } = await checkIsLive(streamer.login);
            if (!success || !userId) continue;
            if (subscribedUserIds.has(userId)) continue;
            subscribedUserIds.add(userId);

            console.log(`[EventSub] Subscribing to ${streamer.login} (${userId}) on session ${sessionId}...`);

            const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
                method: "POST",
                headers: {
                    "Client-Id": clientId,
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    type: "stream.online",
                    version: "1",
                    condition: { broadcaster_user_id: userId },
                    transport: {
                        method: "websocket",
                        session_id: sessionId
                    }
                })
            });

            if (!response.ok) {
                const err = await response.json();
                console.error(`[EventSub] Watching failed for ${streamer.login}:`, err.message);
                if (isEventSubTransportLimitError(err.message)) {
                    scheduleEventSubReconnect(true);
                    break;
                }
            }
        } catch (e) {
            console.error(`[EventSub] Error Watching to ${streamer.login}:`, e);
        }
    }
}

function isEventSubTransportLimitError(message = "") {
    return message.includes("websocket transport") || message.includes("websocket transports");
}

function handleEventSubNotification(payload) {
    const { event } = payload;
    const login = event.broadcaster_user_login;
    const userId = event.broadcaster_user_id;

    console.log(`[REAL-TIME] Notification: ${login} is now LIVE!`);
    checkStreamersAndRedeem(false, login, null, null, userId);
}

function resetKeepAliveTimer(expectedKeepAliveSeconds = 10) {
    if (keepAliveTimeout) clearTimeout(keepAliveTimeout);
    keepAliveTimeout = setTimeout(() => {
        console.warn("[EventSub] Missed keepalive. Refreshing all...");
        loadAndSchedule();
    }, (expectedKeepAliveSeconds + 5) * 1000);
}

function clearKeepAliveTimer() {
    if (keepAliveTimeout) {
        clearTimeout(keepAliveTimeout);
        keepAliveTimeout = null;
    }
}

function scheduleEventSubReconnect(useBackoff = false) {
    if (useBackoff) {
        eventSubReconnectDelayMinutes = Math.min(eventSubReconnectDelayMinutes * 2, 5);
    }
    chrome.alarms.get(EVENTSUB_RECONNECT_ALARM, (existingAlarm) => {
        if (existingAlarm) return;
        chrome.alarms.create(EVENTSUB_RECONNECT_ALARM, { delayInMinutes: eventSubReconnectDelayMinutes });
    });
}

function closeAllEventSub() {
    eventSubGeneration++;
    eventSubSockets.forEach(s => s.close());
    eventSubSockets = [];
    clearKeepAliveTimer();
    eventSubReconnectDelayMinutes = 0.5;
}

// --- Redemption and Manager Logic ---

let _checkQueue = Promise.resolve();

function checkStreamersAndRedeem(forceRedeem = false, forceLogin = null, rewardId = null, forceUserInput = null, forceUserId = null) {
    _checkQueue = _checkQueue.then(() => _doCheckStreamersAndRedeem(forceRedeem, forceLogin, rewardId, forceUserInput, forceUserId)).catch(console.error);
    return _checkQueue;
}

async function _doCheckStreamersAndRedeem(forceRedeem, forceLogin, forceRewardId, forceUserInput, forceUserId = null) {
    let streamers = settings.streamers;
    let accessToken = settings.accessToken;

    if (!streamers || streamers.length === 0) {
        const data = await chrome.storage.local.get(["streamers", "accessToken"]);
        streamers = data.streamers || [];
        accessToken = data.accessToken || "";
    }

    if (!streamers || streamers.length === 0) return;

    let history = null;
    let activityLog = null;
    let logsLoaded = false;

    async function ensureLogsLoaded() {
        if (logsLoaded) return;
        const data = await chrome.storage.local.get(["redeemHistory", "activityLog"]);
        history = data.redeemHistory || [];
        activityLog = data.activityLog || [];
        logsLoaded = true;
    }

    for (let streamer of streamers) {
        if (forceLogin && streamer.login !== forceLogin) continue;
        if (forceRewardId && streamer.rewardId !== forceRewardId) continue;

        try {
            let isLive = false;
            let userId = forceUserId;

            if (forceUserId && streamer.login === forceLogin) {
                isLive = true;
            } else {
                const check = await checkIsLive(streamer.login);
                if (!check.success) continue;
                isLive = check.isLive;
                userId = check.userId;
            }

            if ((isLive && !streamer.lastLiveStatus) || forceRedeem) {
                const action = forceRedeem ? "Manual Test" : "Going LIVE";
                console.log(`[Manager] ${streamer.login} is ${action}!`);
                const liveAt = new Date().toLocaleTimeString();

                await ensureLogsLoaded();
                activityLog.unshift({ type: "LIVE_DETECTED", login: streamer.login, timestamp: liveAt, status: "detected" });

                const redemptionData = { ...streamer };
                if (forceRedeem && forceUserInput !== null) redemptionData.userInput = forceUserInput;

                const tasks = [];
                if (streamer.enableRedeem !== false && streamer.rewardId) {
                    tasks.push((async () => {
                        try {
                            await redeemReward(redemptionData, accessToken, userId);
                            await ensureLogsLoaded();
                            history.unshift({ login: streamer.login, reward: streamer.rewardTitle, status: "SUCCESS", liveAt, completedAt: new Date().toLocaleTimeString(), type: action });
                            chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "Twitch Auto Redeemer SUCCESS", message: `Successfully redeemed "${streamer.rewardTitle}" for ${streamer.login}!` });
                        } catch (err) {
                            await ensureLogsLoaded();
                            history.unshift({ login: streamer.login, reward: streamer.rewardTitle || "Watch Streak Only", status: "FAILED", reason: err.message, liveAt, completedAt: new Date().toLocaleTimeString(), type: action });
                            chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "Twitch Auto Redeemer ERROR", message: `Failed to redeem for ${streamer.login}: ${err.message}` });
                        }
                    })());
                }

                if (streamer.enableWatch !== false && !forceRedeem) {
                    tasks.push((async () => {
                        try {
                            const win = await openWatchWindow(streamer.login);
                            await ensureLogsLoaded();
                            activityLog.unshift({ type: "BROWSER_OPENED", login: streamer.login, timestamp: new Date().toLocaleTimeString(), status: "success", windowId: win.id });
                        } catch (err) {
                            await ensureLogsLoaded();
                            activityLog.unshift({ type: "BROWSER_OPENED", login: streamer.login, timestamp: new Date().toLocaleTimeString(), status: "failed", error: err.message });
                        }
                    })());
                }
                if (tasks.length > 0) await Promise.all(tasks);
            }
            streamer.lastLiveStatus = isLive;
        } catch (e) {
            console.error(`Error for ${streamer.login}:`, e);
        }
    }

    if (logsLoaded) {
        history = history.slice(0, 20);
        activityLog = activityLog.slice(0, 30);
        await chrome.storage.local.set({ redeemHistory: history, activityLog: activityLog });
    }
    await chrome.storage.local.set({ streamers: streamers });
}

async function checkIsLive(login) {
    const fixedLogin = login.toLowerCase().trim();
    const cookieToken = await getAuthToken();
    const activeClientId = cookieToken ? "kimne78kx3ncx6brgo4mv6wki5h1ko" : (settings.clientId || "kimne78kx3ncx6brgo4mv6wki5h1ko");

    const headers = { "Client-Id": activeClientId, "Content-Type": "application/json" };
    if (cookieToken) headers["Authorization"] = `OAuth ${cookieToken}`;

    try {
        const response = await fetch(TWITCH_GQL_URL, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                operationName: "GetStreamerStatus",
                variables: { login: fixedLogin },
                query: `query GetStreamerStatus($login: String!) { channel(name: $login) { id stream { id type } } }`
            })
        });
        const json = await response.json();
        const channel = json.data?.channel;
        if (!channel) throw new Error("No channel data found");
        return { success: true, isLive: !!channel?.stream && channel.stream.type === 'live', userId: channel?.id };
    } catch (e) {
        return { success: false, isLive: false, userId: null };
    }
}

async function getAuthToken() {
    return new Promise((resolve) => {
        chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }, (cookie) => {
            resolve(cookie ? cookie.value : null);
        });
    });
}

async function redeemReward(streamer, backupToken, providedUserId = null) {
    const cookieToken = await getAuthToken();
    const activeToken = cookieToken || backupToken;
    if (!activeToken) throw new Error("You must be logged into Twitch in your browser.");

    let userId = providedUserId;
    if (!userId) {
        const check = await checkIsLive(streamer.login);
        if (!check.success || !check.userId) throw new Error("Could not find channel ID.");
        userId = check.userId;
    }

    const body = {
        operationName: "RedeemCustomReward",
        variables: {
            input: {
                channelID: userId,
                cost: parseInt(streamer.rewardCost) || 0,
                pricingType: "POINTS",
                prompt: streamer.rewardPrompt || "",
                rewardID: streamer.rewardId,
                textInput: streamer.userInput || null,
                title: streamer.rewardTitle || "",
                transactionID: self.crypto.randomUUID().replace(/-/g, '')
            }
        },
        extensions: { persistedQuery: { version: 1, sha256Hash: "d56249a7adb4978898ea3412e196688d4ac3cea1c0c2dfd65561d229ea5dcc42" } }
    };

    const response = await fetch(TWITCH_GQL_URL, {
        method: "POST",
        headers: {
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            "Authorization": `OAuth ${activeToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    const json = await response.json();
    if (json.errors) throw new Error(json.errors[0].message);
    if (json.data?.redeemCustomReward?.error) throw new Error(json.data.redeemCustomReward.error.message);
    return json.data?.redeemCustomReward?.redemption || { status: "FULFILLED" };
}

async function fetchWatchStreaks() {
    const cookieToken = await getAuthToken();
    const activeToken = cookieToken || settings.accessToken;
    if (!activeToken) return {};

    try {
        const response = await fetch(TWITCH_GQL_URL, {
            method: "POST",
            headers: {
                "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
                "Authorization": `OAuth ${activeToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                operationName: "BatchGetWatchStreaks",
                variables: {},
                extensions: {
                    persistedQuery: {
                        version: 1,
                        sha256Hash: "9a0e9c40573c4104b073db9261c116dbb1771732140cdde4181002019d41adce"
                    }
                }
            })
        });

        const json = await response.json();
        const streaks = json.data?.batchGetWatchStreaks || [];
        const streakMap = {};
        streaks.forEach(s => {
            const login = s.channel?.owner?.login;
            if (login) {
                streakMap[login.toLowerCase()] = {
                    value: s.value || 0,
                    achievedAt: s.achievedAt || null,
                    state: s.state || "ACTIVE"
                };
            }
        });
        return streakMap;
    } catch (e) {
        console.warn("[Watch Streak] Failed to fetch streaks:", e);
        return {};
    }
}

async function testWatchStreak(login) {
    const win = await openWatchWindow(login);
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "Smart Watch Streak", message: `Monitoring watch streak for ${login}. Window will close automatically when streak increments!` });
}

async function openWatchWindow(login) {
    const cleanLogin = login.toLowerCase().trim();
    const win = await chrome.windows.create({ url: `https://www.twitch.tv/${cleanLogin}`, state: "normal", focused: true, width: 800, height: 400, type: "popup" });
    
    try {
        const currentWin = await chrome.windows.getCurrent();
        if (currentWin) await chrome.windows.update(currentWin.id, { focused: true });
    } catch (e) {}
    try {
        if (win.tabs && win.tabs.length > 0) await chrome.tabs.update(win.tabs[0].id, { muted: true });
    } catch (e) {}

    // Smart Watch Streak Verification Loop
    startSmartStreakMonitor(cleanLogin, win.id);

    return win;
}

async function startSmartStreakMonitor(login, windowId) {
    const initialStreaks = await fetchWatchStreaks();
    const initialData = initialStreaks[login] || { value: 0, achievedAt: null };
    const startTime = Date.now();
    const MAX_WATCH_TIME_MS = 10 * 60 * 1000; // 10 minutes max timeout

    console.log(`[Smart Streak] Started monitoring ${login}. Initial streak: ${initialData.value}, achievedAt: ${initialData.achievedAt}`);

    const intervalId = setInterval(async () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_WATCH_TIME_MS) {
            clearInterval(intervalId);
            console.log(`[Smart Streak] Timeout reached (10 min) for ${login}. Closing window ${windowId}.`);
            chrome.windows.remove(windowId).catch(() => {});
            return;
        }

        const currentStreaks = await fetchWatchStreaks();
        const currentData = currentStreaks[login];

        if (currentData) {
            const valueIncreased = currentData.value > initialData.value;
            const timestampUpdated = currentData.achievedAt && currentData.achievedAt !== initialData.achievedAt;

            if (valueIncreased || timestampUpdated) {
                clearInterval(intervalId);
                console.log(`[Smart Streak] 🎉 Streak verified & updated for ${login}! New streak: ${currentData.value}. Closing window.`);
                
                // Update local storage streaks cache
                chrome.storage.local.set({ watchStreaks: currentStreaks });

                chrome.notifications.create({
                    type: "basic",
                    iconUrl: "icons/icon128.png",
                    title: "🔥 Watch Streak Incremented!",
                    message: `Watch streak for ${login} is now ${currentData.value}! Watch window closed.`
                });

                chrome.windows.remove(windowId).catch(() => {});
            }
        }
    }, 15000); // Check every 15 seconds
}
