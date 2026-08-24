let isAutoClaimEnabled = true;
let claimInterval;
let observer;

function clickClaimButton() {
    if (!isAutoClaimEnabled) return;
    const claimButton = document.querySelector('[aria-label="Claim Bonus"]');
    if (claimButton) {
        claimButton.click();
        console.log("Twitch Auto-Redeemer: Claimed bonus points!");
    }
}

function startAutoClaim() {
    // 1. Initial check
    clickClaimButton();

    // 2. Setup MutationObserver for instant clicks
    if (!observer) {
        observer = new MutationObserver((mutations) => {
            if (!isAutoClaimEnabled) return;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    clickClaimButton();
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 3. Fallback interval just in case
    if (!claimInterval) {
        claimInterval = setInterval(clickClaimButton, 5000);
    }
}

function stopAutoClaim() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (claimInterval) {
        clearInterval(claimInterval);
        claimInterval = null;
    }
}

// Initialize on load
chrome.storage.local.get(['autoClaimBonus'], (result) => {
    if (result.autoClaimBonus !== undefined) {
        isAutoClaimEnabled = result.autoClaimBonus;
    }
    
    if (isAutoClaimEnabled) {
        startAutoClaim();
    }
});

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.autoClaimBonus) {
        isAutoClaimEnabled = changes.autoClaimBonus.newValue;
        if (isAutoClaimEnabled) {
            startAutoClaim();
        } else {
            stopAutoClaim();
        }
    }
});
