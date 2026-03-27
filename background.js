const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_HELIX_URL = "https://api.twitch.tv/helix";
const ALARM_NAME = "twitchCheckAlarm";

// Default settings
let settings = {
    clientId: "",
    accessToken: "",
    checkInterval: 1, // minutes (faster check for sniping rewards)
    streamers: [] // { login, rewardId, rewardTitle, lastLiveStatus: false }
};

let checkTimeout = null;

// Initialize
chrome.runtime.onInstalled.addListener(() => {
    console.log("Twitch Auto Redeemer installed.");
    loadAndSchedule();
});

async function loadAndSchedule() {
    const result = await chrome.storage.local.get(["clientId", "accessToken", "checkInterval", "streamers"]);
    if (result.clientId) settings.clientId = result.clientId;
    if (result.accessToken) settings.accessToken = result.accessToken;
    // Use the new default of 60 seconds if not set, otherwise use stored value
    settings.checkInterval = result.checkInterval || 60;
    if (result.streamers) settings.streamers = result.streamers;

    // Clear any existing schedules
    if (checkTimeout) clearTimeout(checkTimeout);
    chrome.alarms.clearAll();

    // 1. Setup a standard alarm as a failsafe (Chrome requires 1 minute minimum)
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    
    // 2. Start our high-frequency internal loop
    runHighFreqLoop();
}

function runHighFreqLoop() {
    if (checkTimeout) clearTimeout(checkTimeout);
    
    checkStreamersAndRedeem();

    // Schedule next run in seconds
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
    }
    return true;
});

function createAlarm() {
    // Legacy - replaced by loadAndSchedule logic
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
        // If the service worker wakes up from the alarm, ensure loop is running
        runHighFreqLoop();
    }
});

async function checkStreamersAndRedeem(forceRedeem = false, forceLogin = null) {
    const data = await chrome.storage.local.get(["clientId", "accessToken", "streamers", "redeemHistory"]);
    if (!data.streamers || data.streamers.length === 0) return;

    let history = data.redeemHistory || [];

    for (let streamer of data.streamers) {
        if (forceLogin && streamer.login !== forceLogin) continue;

        try {
            const { isLive } = await checkIsLive(streamer.login);
            
            // Trigger if: (Now Live AND Was Offline) OR (ForceRedeem is true)
            if ((isLive && !streamer.lastLiveStatus) || forceRedeem) {
                const action = forceRedeem ? "Manual Test" : "Going LIVE";
                console.log(`${streamer.login} is ${action}! Redeeming: ${streamer.rewardTitle}`);
                
                const liveAt = new Date().toLocaleTimeString();
                
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
                        reward: streamer.rewardTitle,
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

            streamer.lastLiveStatus = isLive;
        } catch (e) {
            console.error(`Error checking/redeeming for ${streamer.login}:`, e);
        }
    }

    // Keep history manageable (last 20 items)
    history = history.slice(0, 20);

    await chrome.storage.local.set({ streamers: data.streamers, redeemHistory: history });
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
        console.error(`[Redeem Error] ${streamer.login}:`, result.error.message);
        throw new Error(result.error.message);
    } else if (json.errors) {
        console.error(`[GQL Error] ${streamer.login}:`, json.errors[0].message);
        throw new Error(json.errors[0].message);
    } else if (result?.redemption) {
        console.log(`[Redeem Success] ${streamer.login}:`, result.redemption.status);
    } else {
        console.warn(`[Redeem Warning] ${streamer.login}: No result found in GQL response.`);
        console.debug(`Full Response:`, JSON.stringify(json));
    }
    
    return result?.redemption;
}

