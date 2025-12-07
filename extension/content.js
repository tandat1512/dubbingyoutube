class DubbingManager {
    constructor() {
        this.audioQueue = [];
        this.isPlaying = false;
        this.video = null;
        this.subtitles = [];
        this.isBuffering = false;
        this.currentAudioPlayer = null;
        this.processedIds = new Set();
        this.SERVER_URL_BASE = "http://localhost:8000";
        this.BUFFER_THRESHOLD_SEC = 30;
        this.MIN_BUFFER_SEC = 15;
        this.nextFetchIndex = 0;

        // User settings
        this.selectedVoice = "female";
        this.translateSource = "youtube"; // youtube, google, gemini
        this.muteOriginal = true;
        this.volume = 1.0;
        this.originalVideoVolume = 1.0;
        this.isDubbing = false;

        this.init();
    }

    init() {
        console.log("DubbingManager initialized");
        this.waitForVideo();
    }

    waitForVideo() {
        const check = setInterval(() => {
            const v = document.querySelector('video');
            if (v) {
                clearInterval(check);
                this.video = v;
                this.originalVideoVolume = this.video.volume;
                this.setupListeners();
                console.log("Video found");
            }
        }, 1000);
    }

    setupListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === "start_dubbing") {
                // Apply settings from popup
                this.selectedVoice = request.voice || "female";
                this.translateSource = request.translateSource || "youtube";
                this.muteOriginal = request.muteOriginal !== false;
                this.volume = request.volume || 1.0;
                console.log(`Settings: voice=${this.selectedVoice}, translate=${this.translateSource}, mute=${this.muteOriginal}`);
                this.startProcess();
            }
            if (request.action === "update_volume") {
                this.volume = request.volume;
                if (this.currentAudioPlayer) {
                    this.currentAudioPlayer.volume = Math.min(this.volume, 1.0);
                }
            }
            if (request.action === "toggle_mute") {
                this.muteOriginal = request.mute;
                if (this.video && this.isDubbing) {
                    this.video.muted = this.muteOriginal;
                    console.log(`Video muted: ${this.video.muted}`);
                }
            }
        });

        this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.video.addEventListener('seeking', () => this.onSeek());

        this.createOverlay();
    }

    createOverlay() {
        if (document.getElementById('dubbing-status-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'dubbing-status-overlay';
        overlay.style.cssText = `
            position: absolute;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 14px;
            border-radius: 8px;
            font-family: Roboto, Arial, sans-serif;
            font-size: 13px;
            z-index: 9999;
            backdrop-filter: blur(5px);
            border: 1px solid rgba(255,255,255,0.2);
            display: none;
            pointer-events: none;
        `;
        overlay.innerText = "Dubbing Ready";

        const container = document.querySelector('#movie_player') || document.body;
        container.appendChild(overlay);
        this.overlay = overlay;
    }

    updateOverlay(text, color = 'white') {
        if (!this.overlay) return;
        this.overlay.style.display = 'block';
        this.overlay.innerText = text;
        this.overlay.style.color = color;
        this.overlay.style.borderColor = color === '#34C759' ? '#34C759' : 'rgba(255,255,255,0.2)';
    }

    async startProcess() {
        console.log("Starting dubbing process...");
        this.isDubbing = true;
        this.updateOverlay("Initializing...", "#FF9500");
        this.video.pause();

        // Apply mute setting IMMEDIATELY
        if (this.muteOriginal) {
            this.video.muted = true;
            console.log("Original audio muted = true");
        }

        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v');

        if (!videoId) {
            alert("Could not detect Video ID");
            return;
        }

        this.updateOverlay(`Fetching (${this.translateSource})...`);
        this.subtitles = await this.fetchSubtitles(videoId);

        if (!this.subtitles || this.subtitles.length === 0) {
            alert("No subtitles found!");
            this.isDubbing = false;
            return;
        }

        console.log(`Loaded ${this.subtitles.length} subtitles (source: ${this.translateSource})`);
        const voiceName = this.selectedVoice === 'female' ? 'Hoài My' : 'Nam Minh';
        this.updateOverlay(`Voice: ${voiceName}`, "#FF9500");

        await this.bufferUntilSafe(0);
    }

    async fetchSubtitles(videoId) {
        console.log(`Fetching subtitles: video=${videoId}, source=${this.translateSource}`);
        try {
            const resp = await fetch(`${this.SERVER_URL_BASE}/subtitles?video_id=${videoId}&lang=vi&translate_source=${this.translateSource}`);
            if (!resp.ok) {
                throw new Error("Server error: " + resp.statusText);
            }
            const data = await resp.json();
            return data;
        } catch (e) {
            console.error("Subtitle fetch error:", e);
            alert("Failed to fetch subtitles: " + e.message);
            return [];
        }
    }

    async bufferUntilSafe(startIndex) {
        if (this.isBuffering || startIndex >= this.subtitles.length) return;
        this.isBuffering = true;
        this.updateOverlay(`Buffering (${startIndex}/${this.subtitles.length})...`, "#FF9500");
        console.log(`Buffering from index ${startIndex}...`);

        let durationBuffered = 0;
        let batch = [];
        let i = startIndex;

        while (durationBuffered < this.BUFFER_THRESHOLD_SEC && i < this.subtitles.length) {
            const sub = this.subtitles[i];
            if (!this.processedIds.has(i)) {
                batch.push({
                    id: i.toString(),
                    text: sub.text,
                    start_time: sub.start,
                    end_time: sub.end
                });
                durationBuffered += (sub.end - sub.start);
            }
            i++;
        }

        if (batch.length > 0) {
            await this.sendBatchToServer(batch);
            this.nextFetchIndex = i;
        }

        this.isBuffering = false;

        if (this.video.paused && this.video.readyState >= 3 && this.audioQueue.length > 0) {
            console.log("Buffer sufficient. Playing video.");
            this.updateOverlay("Playing...", "#34C759");
            this.video.play();
        }
    }

    async sendBatchToServer(batch) {
        try {
            const resp = await fetch(`${this.SERVER_URL_BASE}/synthesize`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    subtitles: batch,
                    voice: this.selectedVoice
                })
            });
            const data = await resp.json();

            data.results.forEach(item => {
                const blob = this.base64ToBlob(item.audio_base64, 'audio/mp3');
                const url = URL.createObjectURL(blob);
                this.audioQueue.push({
                    id: item.id,
                    url: url,
                    start: item.start_time,
                    end: item.end_time
                });
                this.processedIds.add(parseInt(item.id));
            });

            this.audioQueue.sort((a, b) => a.start - b.start);
            console.log(`Received ${data.results.length} audio clips.`);

        } catch (e) {
            console.error("Batch fetch failed", e);
        }
    }

    base64ToBlob(base64, type) {
        const binStr = atob(base64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
        }
        return new Blob([arr], { type: type });
    }

    onTimeUpdate() {
        if (!this.video || this.video.paused) return;
        const currentTime = this.video.currentTime;

        if (this.audioQueue.length > 0) {
            const nextAudio = this.audioQueue[0];
            if (currentTime >= nextAudio.start - 0.2 && currentTime < nextAudio.end) {
                this.playAudio(nextAudio);
                this.audioQueue.shift();
            } else if (currentTime > nextAudio.end) {
                console.warn("Skipped audio", nextAudio.id);
                this.audioQueue.shift();
            }
        }

        const lastProcessedIndex = this.nextFetchIndex - 1;
        if (lastProcessedIndex >= 0 && lastProcessedIndex < this.subtitles.length) {
            const lastProcessedEndTime = this.subtitles[lastProcessedIndex].end;
            const bufferHealth = lastProcessedEndTime - currentTime;

            if (bufferHealth < this.MIN_BUFFER_SEC && !this.isBuffering && this.nextFetchIndex < this.subtitles.length) {
                console.log("Buffer low. Fetching more...");
                this.bufferUntilSafe(this.nextFetchIndex);
            }
        }
    }

    async playAudio(audioData) {
        if (this.currentAudioPlayer && !this.currentAudioPlayer.paused && !this.currentAudioPlayer.ended) {
            console.log("Audio overlap detected. Pausing video.");
            this.updateOverlay("Syncing Audio...", "#FF3B30");
            this.video.pause();

            await new Promise(resolve => {
                this.currentAudioPlayer.onended = resolve;
                setTimeout(resolve, (this.currentAudioPlayer.duration - this.currentAudioPlayer.currentTime + 0.5) * 1000);
            });
            console.log("Previous audio finished. Resuming.");
        }

        const audio = new Audio(audioData.url);
        audio.volume = Math.min(this.volume, 1.0);
        this.currentAudioPlayer = audio;

        await audio.play().catch(e => console.error("Audio play error", e));

        if (this.video.paused) {
            console.log("Resuming video sync...");
            this.video.play();
            this.updateOverlay("Playing", "#34C759");
        }
    }

    onSeek() {
        console.log("User seeked. Resetting...");
        this.video.pause();
        this.audioQueue = [];

        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
        }

        const currentTime = this.video.currentTime;
        let newIndex = this.subtitles.findIndex(s => s.end > currentTime);

        if (newIndex === -1) {
            if (currentTime < (this.subtitles[0]?.start || 0)) newIndex = 0;
            else return;
        }

        this.nextFetchIndex = newIndex;
        this.processedIds.clear();

        this.bufferUntilSafe(newIndex);
    }
}

new DubbingManager();
