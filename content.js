let isAutoClaimEnabled = true;

chrome.storage.local.get(['autoClaimBonus'], (result) => {
    if (result.autoClaimBonus !== undefined) {
        isAutoClaimEnabled = result.autoClaimBonus;
    }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.autoClaimBonus) {
        isAutoClaimEnabled = changes.autoClaimBonus.newValue;
    }
});

setInterval(() => {
    if (!isAutoClaimEnabled) return;
    
    // The "Claim Bonus" button typically has aria-label="Claim Bonus"
    const claimButton = document.querySelector('[aria-label="Claim Bonus"]');
    if (claimButton) {
        claimButton.click();
        console.log("Twitch Auto-Redeemer: Claimed bonus points!");
    }
}, 5000); // Check every 5 seconds
