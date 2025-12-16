document.addEventListener('DOMContentLoaded', async () => {
    const btnDub = document.getElementById('btn-dub');
    const serverDot = document.getElementById('server-dot');
    const serverStatus = document.getElementById('server-status');
    const btnText = btnDub.querySelector('.btn-text');
    const voiceSelect = document.getElementById('voice-select');
    const languageSelect = document.getElementById('language-select');
    const translateSelect = document.getElementById('translate-select');
    const balanceSlider = document.getElementById('balance-slider');
    const balanceOriginal = document.getElementById('balance-original');
    const balanceDub = document.getElementById('balance-dub');
    const volumeSlider = document.getElementById('volume-slider');

    // Load saved settings from localStorage
    const savedSettings = JSON.parse(localStorage.getItem('dubbingSettings') || '{}');
    if (savedSettings.voice) voiceSelect.value = savedSettings.voice;
    if (savedSettings.language) languageSelect.value = savedSettings.language;
    if (savedSettings.translate) translateSelect.value = savedSettings.translate;
    if (savedSettings.balance !== undefined) balanceSlider.value = savedSettings.balance;
    if (savedSettings.volume) volumeSlider.value = savedSettings.volume;

    // Update balance display
    updateBalanceDisplay();

    // Save settings function
    function saveSettings() {
        const settings = {
            voice: voiceSelect.value,
            language: languageSelect.value,
            translate: translateSelect.value,
            balance: balanceSlider.value,
            volume: volumeSlider.value
        };
        localStorage.setItem('dubbingSettings', JSON.stringify(settings));
    }

    function updateBalanceDisplay() {
        const val = parseInt(balanceSlider.value);
        balanceOriginal.textContent = val + '%';
        balanceDub.textContent = (100 - val) + '%';
    }

    // Save on any change
    voiceSelect.addEventListener('change', saveSettings);
    languageSelect.addEventListener('change', saveSettings);
    translateSelect.addEventListener('change', saveSettings);
    balanceSlider.addEventListener('input', () => {
        updateBalanceDisplay();
        saveSettings();
    });
    volumeSlider.addEventListener('input', saveSettings);

    // 1. Check Server Connection
    try {
        const resp = await fetch('http://localhost:8000/health');
        if (resp.ok) {
            const data = await resp.json();
            serverDot.classList.add('connected');
            serverStatus.textContent = data.gemini ? "Online" : "Online";
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

            const balanceVal = parseInt(balanceSlider.value);
            chrome.tabs.sendMessage(tabs[0].id, {
                action: "start_dubbing",
                voice: voiceSelect.value,
                targetLanguage: languageSelect.value,
                translateSource: translateSelect.value,
                originalVolume: balanceVal / 100,  // 0-1 for original video
                dubVolume: volumeSlider.value / 100  // 0-2 for dub audio
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
                    action: "update_dub_volume",
                    volume: value
                });
            }
        });
    });

    // 4. Handle Balance Change (real-time)
    balanceSlider.addEventListener('input', (e) => {
        const value = e.target.value / 100;
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: "update_balance",
                    originalVolume: value
                });
            }
        });
    });
});
