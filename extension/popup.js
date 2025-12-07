document.addEventListener('DOMContentLoaded', async () => {
    const btnDub = document.getElementById('btn-dub');
    const serverDot = document.getElementById('server-dot');
    const serverStatus = document.getElementById('server-status');
    const btnText = btnDub.querySelector('.btn-text');
    const voiceSelect = document.getElementById('voice-select');
    const translateSelect = document.getElementById('translate-select');
    const muteToggle = document.getElementById('mute-toggle');
    const volumeSlider = document.getElementById('volume-slider');

    // Load saved settings from localStorage
    const savedSettings = JSON.parse(localStorage.getItem('dubbingSettings') || '{}');
    if (savedSettings.voice) voiceSelect.value = savedSettings.voice;
    if (savedSettings.translate) translateSelect.value = savedSettings.translate;
    if (savedSettings.mute !== undefined) muteToggle.checked = savedSettings.mute;
    if (savedSettings.volume) volumeSlider.value = savedSettings.volume;

    // Save settings function
    function saveSettings() {
        const settings = {
            voice: voiceSelect.value,
            translate: translateSelect.value,
            mute: muteToggle.checked,
            volume: volumeSlider.value
        };
        localStorage.setItem('dubbingSettings', JSON.stringify(settings));
    }

    // Save on any change
    voiceSelect.addEventListener('change', saveSettings);
    translateSelect.addEventListener('change', saveSettings);
    muteToggle.addEventListener('change', saveSettings);
    volumeSlider.addEventListener('input', saveSettings);

    // 1. Check Server Connection
    try {
        const resp = await fetch('http://localhost:8000/health');
        if (resp.ok) {
            const data = await resp.json();
            serverDot.classList.add('connected');
            serverStatus.textContent = data.gemini ? "Online (Gemini)" : "Online";
        } else {
            serverStatus.textContent = "Error";
        }
    } catch (e) {
        serverStatus.textContent = "Offline";
    }

    // 2. Handle Start Dubbing Click
    btnDub.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (!tabs[0].id) return;

            btnDub.classList.add('active');
            btnText.textContent = "DUBBING STARTED";

            chrome.tabs.sendMessage(tabs[0].id, {
                action: "start_dubbing",
                voice: voiceSelect.value,
                translateSource: translateSelect.value,
                muteOriginal: muteToggle.checked,
                volume: volumeSlider.value / 100
            });

            setTimeout(() => {
                btnDub.classList.remove('active');
                btnText.textContent = "START DUBBING";
            }, 2000);
        });
    });

    // 3. Handle Volume Change (real-time)
    volumeSlider.addEventListener('input', (e) => {
        const value = e.target.value / 100;
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: "update_volume",
                    volume: value
                });
            }
        });
    });

    // 4. Handle Mute Toggle Change (real-time)
    muteToggle.addEventListener('change', (e) => {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: "toggle_mute",
                    mute: e.target.checked
                });
            }
        });
    });
});
