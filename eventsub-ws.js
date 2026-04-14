/**
 * EventSub WebSocket Manager (Experimental)
 * Handles real-time "Stream Online" notifications via Twitch EventSub WebSockets.
 */

let eventSubSocket = null;
let currentSessionId = null;
let reconnectUrl = null;
let keepAliveTimeout = null;

const TWITCH_EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";

async function initEventSub(streamers, accessToken, clientId) {
    if (eventSubSocket) {
        console.log("[EventSub] Closing existing socket...");
        eventSubSocket.close();
    }

    console.log("[EventSub] Connecting to Twitch WebSocket...");
    eventSubSocket = new WebSocket(TWITCH_EVENTSUB_WS_URL);

    eventSubSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const { metadata, payload } = data;
        const messageType = metadata.message_type;

        switch (messageType) {
            case "session_welcome":
                currentSessionId = payload.session.id;
                console.log("[EventSub] Session Welcome! ID:", currentSessionId);
                subscribeToAllStreamers(streamers, accessToken, clientId, currentSessionId);
                break;

            case "session_keepalive":
                // Twitch is just checking if we're still there
                resetKeepAliveTimer();
                break;

            case "notification":
                handleEventSubNotification(payload);
                break;

            case "session_reconnect":
                reconnectUrl = payload.session.reconnect_url;
                console.log("[EventSub] Reconnecting to:", reconnectUrl);
                eventSubSocket.close();
                eventSubSocket = new WebSocket(reconnectUrl);
                break;

            case "revocation":
                console.error("[EventSub] Subscription revoked:", payload.subscription.type);
                break;
        }
    };

    eventSubSocket.onclose = () => {
        console.warn("[EventSub] WebSocket Closed.");
        if (keepAliveTimeout) clearTimeout(keepAliveTimeout);
    };

    eventSubSocket.onerror = (err) => {
        console.error("[EventSub] WebSocket Error:", err);
    };
}

function resetKeepAliveTimer() {
    if (keepAliveTimeout) clearTimeout(keepAliveTimeout);
    // Twitch EventSub sends a keepalive every 10 seconds. 
    // If we don't hear anything for 15 seconds, something is wrong.
    keepAliveTimeout = setTimeout(() => {
        console.warn("[EventSub] Missed keepalive. Reconnecting...");
        chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' }); // Trigger a fresh init
    }, 15000);
}

async function subscribeToAllStreamers(streamers, accessToken, clientId, sessionId) {
    const subscribedLogins = new Set();
    
    for (let streamer of streamers) {
        if (subscribedLogins.has(streamer.login)) continue;
        subscribedLogins.add(streamer.login);
        
        try {
            // We need the numeric User ID, not the login name
            const { userId } = await checkIsLive(streamer.login); 
            if (!userId) {
                console.warn(`[EventSub] Could not get ID for ${streamer.login}, skipping.`);
                continue;
            }

            console.log(`[EventSub] Subscribing to stream.online for ${streamer.login} (${userId})...`);
            
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
                console.error(`[EventSub] Subscription failed for ${streamer.login}:`, err.message);
            } else {
                console.log(`[EventSub] Success! Watching ${streamer.login} in real-time.`);
            }
        } catch (e) {
            console.error(`[EventSub] Error subscribing to ${streamer.login}:`, e);
        }
    }
}

async function handleEventSubNotification(payload) {
    const { subscription, event } = payload;
    const login = event.broadcaster_user_login;
    
    console.log(`[REAL-TIME] Notification: ${login} is now LIVE!`);

    // Trigger the redemption logic in the background script
    if (typeof checkStreamersAndRedeem === "function") {
        // We pass forceRedeem=true because EventSub only triggers when they go live, 
        // and we want to try redeeming immediately.
        checkStreamersAndRedeem(false, login); 
    }
}

function closeEventSub() {
    if (eventSubSocket) {
        eventSubSocket.close();
        eventSubSocket = null;
    }
}
