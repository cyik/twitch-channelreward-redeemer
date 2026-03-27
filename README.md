# Twitch Auto Redeemer Extension

A lightweight browser extension that monitors when Twitch chaannel goes live and instantly redeems channel rewards as soon as they go live.

## Features
- **Auto-Detection**: Periodic checking (default: 5 mins) of streamer live status, can be set to whatever you like.
- **Auto-Redeem**: Instantly triggers a specific channel point reward upon stream start.
- **Smart Tracking**: Remembers the last live status to prevent multiple redemptions within the same session.


## Setup Instructions

1.  **Configure Extension**:
    - Open the extension **Options** (Right-click icon -> Options).
    - Paste your **Twitch Client ID**.
    - Copy the **Redirect URI** shown in the settings (e.g., `https://...chromiumapp.org/`).
    
2.  **Twitch Dashboard Setup**:
    - Go to your [Twitch Developer Console](https://dev.twitch.tv/console).
    - Manage your application and add the **Redirect URI** you just copied to the "OAuth Redirect URLs" list. Save the changes.

3.  **Login**:
    - Go back to the extension settings and click **Login with Twitch**.
    - Authorize the app. Your access token will be filled in automatically!

4.  **Add Streamers**:
    - Enter the username of the streamer you want to track.
    - Click **Add Streamer**.
    - Select the desired reward from the list.

## Development / Installation
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `twitch_auto_redeemer` folder.

---
*Note: This extension uses the unofficial Twitch GQL API for viewer-side redemptions, as the official Helix API only supports broadcaster-side management at this time.*
