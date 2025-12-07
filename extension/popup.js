document.addEventListener('DOMContentLoaded', async () => {
    const btnDub = document.getElementById('btn-dub');
    const serverDot = document.getElementById('server-dot');
    const serverStatus = document.getElementById('server-status');
    const btnText = btnDub.querySelector('.btn-text');

    // 1. Check Server Connection
    try {
        const resp = await fetch('http://localhost:8000/docs', { method: 'HEAD' });
        if (resp.ok) {
            serverDot.classList.add('connected');
            serverStatus.textContent = "Online";
        } else {
            serverStatus.textContent = "Error";
        }
    } catch (e) {
        serverStatus.textContent = "Offline";
    }

    // 2. Handle Click
    btnDub.addEventListener('click', () => {
        // Send message to content script
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (!tabs[0].id) return;

            // Visual feedback
            btnDub.classList.add('active');
            btnText.textContent = "DUBBING STARTED";

            chrome.tabs.sendMessage(tabs[0].id, { action: "start_dubbing" }, function (response) {
                // Optional: Handle response
            });

            // Revert visual after delay if needed, or keep it stateful?
            // For now, simple trigger.
            setTimeout(() => {
                btnDub.classList.remove('active');
                btnText.textContent = "START DUBBING";
            }, 2000);
        });
    });
});
