# Twitch Auto Redeemer Extension by cyik

A lightweight browser extension that monitors when Twitch channel goes live and instantly redeems channel rewards as soon as they go live.

![image alt](https://github.com/cyik/twitch-channelreward-redeemer/blob/3bf66e03935e614367610afe6e6da381cc1a9725/UI%20example3.png)

## Why I made this extension:
The TwitchAPI (Helix) currently does not support twitch channel redeems actions, because apparently it's "against TOS to automate interactions" (yeah right). So I reverse engineereed the Twitch's Internal GraphQL API to send persisted queries to pretend that I'm a real user sending a channel redemption. This technique allows me to send automated channel redeems, which was not previously available to developers. Smart, I know, I might be the first one to do this. (who knows)

## Features
- **Auto-Detection**: Checks live status of streamer every 60 seconds by default (u can set it to whatever you want later)
- **Auto-Redeem**: Instantly redeems a specific channel point reward as soon as the specified streamer goes live.
- **Redemption history**: Shows all successful twitch channel redeems that were redeemed through the extension (not fully tested yet)


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
