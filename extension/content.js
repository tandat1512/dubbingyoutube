class DubbingManager {
    constructor() {
        this.audioQueue = []; // Array of {id, blobUrl, startTime, endTime}
        this.isPlaying = false;
        this.video = null;
        this.subtitles = [];
        this.isBuffering = false;
        this.currentAudioPlayer = null; // HTMLAudioElement
        this.processedIds = new Set();
        this.SERVER_URL_BASE = "http://localhost:8000";
        this.BUFFER_THRESHOLD_SEC = 30; // 30 seconds for initial batch
        this.MIN_BUFFER_SEC = 15; // 15 seconds safe buffer
        this.nextFetchIndex = 0;

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
                this.setupListeners();
                console.log("Video found");
            }
        }, 1000);
    }

    setupListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === "start_dubbing") {
                this.startProcess();
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
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 8px 12px;
            border-radius: 8px;
            font-family: Roboto, Arial, sans-serif;
            font-size: 14px;
            z-index: 9999;
            backdrop-filter: blur(5px);
            border: 1px solid rgba(255,255,255,0.2);
            display: none; /* Hidden by default */
            pointer-events: none;
        `;
        overlay.innerText = "Dubbing Ready";

        // Try appending to video container first, else body
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
        this.updateOverlay("Initializing Engine...", "#FF9500");
        this.video.pause();

        // Get Video ID from URL
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v');

        if (!videoId) {
            alert("Could not detect Video ID");
            return;
        }

        // Step 2: Fetch Subtitles from Backend
        this.updateOverlay("Fetching Subtitles...");
        this.subtitles = await this.fetchSubtitles(videoId);

        if (!this.subtitles || this.subtitles.length === 0) {
            alert("No subtitles found (Backend returned empty)!");
            return;
        }

        console.log(`Loaded ${this.subtitles.length} subtitle lines via Server.`);

        // Step 3: Initial Batch Processing
        await this.bufferUntilSafe(0);

        // Step 5: Play Video triggers automatically when buffer is sufficient
    }

    async fetchSubtitles(videoId) {
        console.log(`Fetching subtitles for ${videoId} from server...`);
        try {
            const resp = await fetch(`${this.SERVER_URL_BASE}/subtitles?video_id=${videoId}&lang=vi`);
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
            // Format check: server returns {start, end, text}
            // We ensure we send start_time/end_time
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
            this.video.play();
        }
    }

    async sendBatchToServer(batch) {
        try {
            const resp = await fetch(`${this.SERVER_URL_BASE}/synthesize`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subtitles: batch })
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

        // Background Fetch Logic
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
        // Critical Section: Prevent Overlap
        if (this.currentAudioPlayer && !this.currentAudioPlayer.paused && !this.currentAudioPlayer.ended) {
            console.log("Audio overlap detected. Pausing video to wait for current audio to finish.");
            this.updateOverlay("Syncing Audio...", "#FF3B30");
            this.video.pause();

            // Wait for current audio to end
            await new Promise(resolve => {
                this.currentAudioPlayer.onended = resolve;
                // Backup safety timeout
                setTimeout(resolve, (this.currentAudioPlayer.duration - this.currentAudioPlayer.currentTime + 0.5) * 1000);
            });
            console.log("Previous audio finished. Resuming flow.");
        }

        const audio = new Audio(audioData.url);
        this.currentAudioPlayer = audio;

        // When this new audio finishes, if we paused the video, we should resume it?
        // Actually, logic is: Video drives playback. 
        // If we paused video, we must resume it now that we are playing the next chunk.
        // UNLESS the next chunk is also starting "late" relative to video?
        // Let's just play audio and Ensure video is playing.

        await audio.play().catch(e => console.error("Audio play error", e));

        if (this.video.paused) {
            console.log("Resuming video sync...");
            this.video.play();
            this.updateOverlay("Synced Playing", "#34C759");
        }
    }

    onSeek() {
        console.log("User seeked. Resetting...");
        this.video.pause();
        this.audioQueue = []; // Clear current queue

        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
        }

        const currentTime = this.video.currentTime;
        let newIndex = this.subtitles.findIndex(s => s.end > currentTime);

        if (newIndex === -1) {
            if (currentTime < (this.subtitles[0]?.start || 0)) newIndex = 0;
            else return; // End of video
        }

        this.nextFetchIndex = newIndex;
        // We should allow re-fetching even if processedIds has it?
        // Simpler: Just re-buffer. The check !processedIds.has(i) prevents re-fetch.
        // If we want to support seeking BACK, we must clear processedIds for future segments?
        // Yes, let's clear processedIds which act as a "in-session cache".
        // BUT, ideally we cache audio for performance. 
        // For now, let's just clear processedIds for items *after* newIndex to be safe.
        // Or simpler: just clear set? 
        // Clearing set forces re-synthesize. Expensive but Safe.
        // Let's iterate and remove only those > newIndex? No, Set order is insertion order usually but indices are reliable.

        // Strategy: Clear processedIds for everything >= newIndex.
        // Or simplified: Clear all processedIds and let server cache or browser cache?
        // Let's clear `processedIds` to force re-fetch for simplicity in this prototype.
        this.processedIds.clear();
        // Wait, if we clear all, we re-synthesize 0 to batch? No, we start from newIndex.

        this.bufferUntilSafe(newIndex);
    }
}

new DubbingManager();
