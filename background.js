importScripts('eventsub-ws.js');

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_HELIX_URL = "https://api.twitch.tv/helix";
const ALARM_NAME = "twitchCheckAlarm";
const KEEP_ALIVE_ALARM = "wsKeepAlive";

// Default settings
let settings = {
    clientId: "",
    accessToken: "",
    checkInterval: 60, 
    streamers: [],
    realTimeMode: false // Experimental EventSub Mode
};

let checkTimeout = null;

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
    const result = await chrome.storage.local.get(["clientId", "accessToken", "checkInterval", "streamers", "realTimeMode"]);
    if (result.clientId) settings.clientId = result.clientId;
    if (result.accessToken) settings.accessToken = result.accessToken;
    settings.checkInterval = result.checkInterval || 60;
    if (result.streamers) settings.streamers = result.streamers;
    settings.realTimeMode = result.realTimeMode || false;

    // Clear any existing schedules/sockets
    if (checkTimeout) clearTimeout(checkTimeout);
    chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.clear(KEEP_ALIVE_ALARM);
    closeEventSub();

    if (settings.realTimeMode) {
        console.log("[Manager] REAL-TIME MODE ACTIVE. Disabling polling.");
        // Create a fast alarm to keep the service worker alive
        chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
        initEventSub(settings.streamers, settings.accessToken, settings.clientId);
        // Check current status immediately because EventSub only triggers on new transitions
        checkStreamersAndRedeem();
    } else {
        console.log("[Manager] POLLING MODE ACTIVE. Scheduled for every:", settings.checkInterval, "sec");
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
        runHighFreqLoop();
    }
}

function runHighFreqLoop() {
    if (checkTimeout) clearTimeout(checkTimeout);
    if (settings.realTimeMode) return; // Don't run loop if in real-time mode
    
    checkStreamersAndRedeem();
    const intervalMs = settings.checkInterval * 1000;
    checkTimeout = setTimeout(runHighFreqLoop, intervalMs);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_ALARM') {
        loadAndSchedule();
        sendResponse({ success: true });
    } else if (message.type === 'CHECK_NOW') {
        checkStreamersAndRedeem(message.forceRedeem, message.streamerLogin);
        sendResponse({ success: true });
    } else if (message.type === 'TEST_WATCH') {
        testWatchStreak(message.streamerLogin).then(() => sendResponse({ success: true }));
    }
    return true;
});

function createAlarm() {
    // Legacy - replaced by loadAndSchedule logic
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    // When the service worker wakes up from sleep, global variables are reset.
    // Fetch critical settings from storage to ensure we take the right action.
    const result = await chrome.storage.local.get(["realTimeMode", "checkInterval"]);
    const isRealTime = result.realTimeMode || false;
    if (result.checkInterval) settings.checkInterval = result.checkInterval;

    if (alarm.name === ALARM_NAME) {
        if (!isRealTime) {
            runHighFreqLoop();
        }
    } else if (alarm.name === KEEP_ALIVE_ALARM) {
        // If we wake up and real-time is on, ensure we are connected
        if (isRealTime && (typeof eventSubSocket === 'undefined' || !eventSubSocket || eventSubSocket.readyState !== WebSocket.OPEN)) {
            console.log("[Manager] Service Worker woke up. Reconnecting EventSub...");
            loadAndSchedule();
        }
    } else if (alarm.name.startsWith('closeWindow_')) {
        const parts = alarm.name.split('_');
        if (parts.length > 1) {
            const windowId = parseInt(parts[1], 10);
            chrome.windows.remove(windowId).catch(err => {
                console.log(`[Watch Streak] Could not remove window ${windowId} (might be already closed):`, err);
            });
            console.log(`[Watch Streak] Finished 15-minute streak watch. Closed window ${windowId}.`);
        }
    }

    // Forcefully keep alive the service worker to prevent it from dropping connections repeatedly
    if (isRealTime || settings.checkInterval < 60) {
        chrome.runtime.getPlatformInfo(() => { /* No-op just to keep SW alive */ });
    }
});

let _checkQueue = Promise.resolve();

function checkStreamersAndRedeem(forceRedeem = false, forceLogin = null) {
    _checkQueue = _checkQueue.then(() => _doCheckStreamersAndRedeem(forceRedeem, forceLogin)).catch(console.error);
    return _checkQueue;
}

async function _doCheckStreamersAndRedeem(forceRedeem, forceLogin) {
    const data = await chrome.storage.local.get(["clientId", "accessToken", "streamers", "redeemHistory", "activityLog"]);
    if (!data.streamers || data.streamers.length === 0) return;

    let history = data.redeemHistory || [];
    let activityLog = data.activityLog || [];


    for (let streamer of data.streamers) {
        if (forceLogin && streamer.login !== forceLogin) continue;

        try {
            const { isLive } = await checkIsLive(streamer.login);
            
            // Trigger if: (Now Live AND Was Offline) OR (ForceRedeem is true)
            if ((isLive && !streamer.lastLiveStatus) || forceRedeem) {
                const action = forceRedeem ? "Manual Test" : "Going LIVE";
                console.log(`${streamer.login} is ${action}!`);
                
                const liveAt = new Date().toLocaleTimeString();
                
                // Track Live Status Event
                activityLog.unshift({
                    type: "LIVE_DETECTED",
                    login: streamer.login,
                    timestamp: liveAt,
                    status: "detected"
                });
                
                if (streamer.enableRedeem !== false && streamer.rewardId) {
                    try {
                        await redeemReward(streamer, data.accessToken);
                        const completedAt = new Date().toLocaleTimeString();
                        
                        history.unshift({
                            login: streamer.login,
                            reward: streamer.rewardTitle,
                            status: "SUCCESS",
                            liveAt,
                            completedAt,
                            type: action
                        });
                        
                        chrome.notifications.create({
                            type: "basic",
                            iconUrl: "icons/icon128.png",
                            title: "Twitch Auto Redeemer SUCCESS",
                            message: `Successfully redeemed "${streamer.rewardTitle}" for ${streamer.login}!`
                        });
                    } catch (redeemErr) {
                        history.unshift({
                            login: streamer.login,
                            reward: streamer.rewardTitle || "Watch Streak Only",
                            status: "FAILED",
                            reason: redeemErr.message,
                            liveAt,
                            completedAt: new Date().toLocaleTimeString(),
                            type: action
                        });

                        chrome.notifications.create({
                            type: "basic",
                            iconUrl: "icons/icon128.png",
                            title: "Twitch Auto Redeemer ERROR",
                            message: `Failed to redeem for ${streamer.login}: ${redeemErr.message}`
                        });
                    }
                }

                if (streamer.enableWatch !== false && !forceRedeem) {
                    try {
                        const url = `https://www.twitch.tv/${streamer.login}`;
                        const win = await chrome.windows.create({ 
                            url: url, 
                            state: "minimized", 
                            focused: false,
                            type: "popup"
                        });
                        // Fallback: If creation didn't minimize it, force it now
                        try {
                            await chrome.windows.update(win.id, { state: "minimized" });
                        } catch (e) {
                            console.log("[Watch Streak] Could not force minimize:", e);
                        }

                        // Track Browser Open Event
                        activityLog.unshift({
                            type: "BROWSER_OPENED",
                            login: streamer.login,
                            timestamp: new Date().toLocaleTimeString(),
                            status: "success",
                            windowId: win.id
                        });

                        console.log(`[Watch Streak] Opened background window for ${streamer.login}. Will close in 15 minutes.`);
                        
                        try {
                            if (win.tabs && win.tabs.length > 0) {
                                await chrome.tabs.update(win.tabs[0].id, { muted: true });
                            }
                        } catch (muteErr) {
                            console.warn(`[Watch Streak] Could not mute window tab:`, muteErr);
                        }
                        
                        // Set alarm to close the window after 15 minutes to secure the streak
                        const alarmName = `closeWindow_${win.id}_${Date.now()}`;
                        chrome.alarms.create(alarmName, { delayInMinutes: 15 });
                    } catch (winErr) {
                        console.error(`[Watch Streak] Failed to open window for ${streamer.login}:`, winErr);
                        activityLog.unshift({
                            type: "BROWSER_OPENED",
                            login: streamer.login,
                            timestamp: new Date().toLocaleTimeString(),
                            status: "failed",
                            error: winErr.message
                        });
                    }
                }
            }

            streamer.lastLiveStatus = isLive;
        } catch (e) {
            console.error(`Error checking/redeeming for ${streamer.login}:`, e);
        }
    }

    // Keep history manageable (last 20 items)
    history = history.slice(0, 20);
    activityLog = activityLog.slice(0, 30); // A bit more for activity log

    await chrome.storage.local.set({ 
        streamers: data.streamers, 
        redeemHistory: history,
        activityLog: activityLog
    });
}

async function checkIsLive(login) {
    const fixedLogin = login.toLowerCase().trim();
    const cookieToken = await getAuthToken();
    
    const query = `query GetStreamerStatus($login: String!) {
        channel(name: $login) {
            id
            stream {
                id
                type
            }
        }
    }`;
    const body = {
        operationName: "GetStreamerStatus",
        variables: { login: fixedLogin },
        query: query
    };

    const headers = {
        "Client-Id": "kimne78kx3ncx6br8ac4hz66l2s7vv", 
        "Content-Type": "application/json"
    };

    if (cookieToken) {
        headers["Authorization"] = `OAuth ${cookieToken}`;
    }

    try {
        const response = await fetch(TWITCH_GQL_URL, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body)
        });

        const json = await response.json();
        
        // Ensure we only mark as live if stream type is 'live'
        const channel = json.data?.channel;
        const isLive = !!channel?.stream && channel.stream.type === 'live';
        
        return {
            isLive: isLive,
            userId: channel?.id
        };
    } catch (e) {
        console.error(`[Fetch Error] ${fixedLogin}:`, e);
        return { isLive: false, userId: null };
    }
}

// Twitch use GQL for redeeming as a viewer
async function getAuthToken() {
    return new Promise((resolve) => {
        chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }, (cookie) => {
            resolve(cookie ? cookie.value : null);
        });
    });
}

async function redeemReward(streamer, backupToken) {
    const cookieToken = await getAuthToken();
    const activeToken = cookieToken || backupToken;
    
    // Fallback if no token at all
    if (!activeToken) {
        throw new Error("You must be logged into Twitch in your browser to redeem rewards.");
    }

    const { userId } = await checkIsLive(streamer.login);
    if (!userId) throw new Error("Could not find channel ID.");

    // Exact reverse-engineered structure from Twitch's own GQL system
    const body = {
        operationName: "RedeemCustomReward",
        variables: {
            input: {
                channelID: userId,
                cost: parseInt(streamer.rewardCost) || 0,
                pricingType: "POINTS",
                prompt: null,
                rewardID: streamer.rewardId,
                title: streamer.rewardTitle,
                transactionID: self.crypto.randomUUID().replace(/-/g, '') // Twitch expects a clean hex UUID
            }
        },
        extensions: {
            persistedQuery: {
                version: 1,
                sha256Hash: "d56249a7adb4978898ea3412e196688d4ac3cea1c0c2dfd65561d229ea5dcc42"
            }
        }
    };

    const response = await fetch(TWITCH_GQL_URL, {
        method: "POST",
        headers: {
            "Client-Id": "kimne78kx3ncx6br8ac4hz66l2s7vv", 
            "Authorization": `OAuth ${activeToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    const json = await response.json();
    const result = json.data?.redeemCustomReward;
    
    // Log the result for debugging
    if (result?.error) {
        const errorMsg = result.error.message || result.error.errorCode || "Unknown Error";
        console.error(`[Redeem Error] ${streamer.login}:`, errorMsg);
        throw new Error(errorMsg);
    } 
    
    if (json.errors && json.errors.length > 0) {
        console.error(`[GQL Error] ${streamer.login}:`, json.errors[0].message);
        throw new Error(json.errors[0].message);
    } 
    
    if (result?.redemption) {
        const status = result.redemption.status;
        console.log(`[Redeem Success] ${streamer.login}:`, status);
        
        // If status is specifically known as failed/canceled/rejected, throw instead of returning success
        if (status && ["CANCELED", "REFUNDED", "REJECTED"].includes(status.toUpperCase())) {
            throw new Error(`Redemption ${status.toLowerCase()} by Twitch server.`);
        }
        
        return result.redemption;
    } 

    // If we're here, it means we don't have a redemption object AND we don't have a known error
    console.warn(`[Redeem Warning] ${streamer.login}: No result found in GQL response.`);
    console.debug(`Full Response:`, JSON.stringify(json));
    
    // Check if the overall response was empty or null
    if (!json.data) {
        throw new Error("Twitch returned an empty response. You might need to refresh your login.");
    }

    throw new Error("Redemption failed: The reward might no longer be available or the limit was reached.");
}

async function testWatchStreak(login) {
    console.log(`[Watch Streak Test] Testing window for ${login}...`);
    try {
        const url = `https://www.twitch.tv/${login}`;
        const win = await chrome.windows.create({ 
            url: url, 
            state: "minimized", 
            focused: false,
            type: "popup"
        });
        
        // Fallback: If creation didn't minimize it, force it now
        try {
            await chrome.windows.update(win.id, { state: "minimized" });
        } catch (e) {
            console.log("[Watch Streak Test] Could not force minimize:", e);
        }

        try {
            if (win.tabs && win.tabs.length > 0) {
                await chrome.tabs.update(win.tabs[0].id, { muted: true });
            }
        } catch (muteErr) {
            console.warn(`[Watch Streak Test] Could not mute window tab:`, muteErr);
        }
        
        // Close after 1 minute for testing purposes
        const alarmName = `closeWindow_${win.id}_${Date.now()}`;
        chrome.alarms.create(alarmName, { delayInMinutes: 1 });
        
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Test Watch Streak",
            message: `Background window opened for ${login}. It is muted and will automatically close in 1 minute.`
        });
    } catch (err) {
        console.error(`[Watch Streak Test] Failed:`, err);
        throw err;
    }
}

