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
        this.BUFFER_THRESHOLD_SEC = 20;  // Buffer 20 seconds ahead
        this.MIN_BUFFER_SEC = 10;         // Fetch more when < 10 seconds left
        this.nextFetchIndex = 0;

        // User settings
        this.selectedVoice = "female";
        this.targetLanguage = "vi";  // Target language: 'vi' or 'en'
        this.translateSource = "youtube";
        this.originalVolume = 0.2;   // Original video volume (0-1) - default 20%
        this.dubVolume = 1.0;        // Dub audio volume (0-2)
        this.savedOriginalVolume = 1.0;  // Save original video volume to restore
        this.isDubbing = false;

        // Smooth playback tracking
        this.lastPlayedIndex = -1;
        this.audioEndTimes = new Map();

        // PERSISTENT AUDIO CACHE - survives seeks but NOT video changes
        this.audioCache = new Map();

        // Track current video to detect navigation
        this.currentVideoId = null;

        this.init();
    }

    init() {
        console.log("DubbingManager v3 initialized - Video Change Detection");
        this.waitForVideo();

        // Watch for URL changes (YouTube SPA navigation)
        this.setupNavigationListener();
    }

    setupNavigationListener() {
        // Check URL every second for video changes
        setInterval(() => {
            const urlParams = new URLSearchParams(window.location.search);
            const videoId = urlParams.get('v');

            if (videoId && this.currentVideoId && videoId !== this.currentVideoId) {
                console.log(`🔄 Video changed: ${this.currentVideoId} → ${videoId}`);
                this.resetForNewVideo();
            }
        }, 1000);
    }

    resetForNewVideo() {
        console.log("🧹 Resetting for new video...");

        // Stop any playing audio
        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
            this.currentAudioPlayer = null;
        }

        // Clear all caches and queues
        this.audioQueue = [];
        this.audioCache.clear();
        this.processedIds.clear();
        this.audioEndTimes.clear();
        this.subtitles = [];
        this.nextFetchIndex = 0;
        this.isDubbing = false;
        this.isBuffering = false;
        this.currentVideoId = null;

        // Unmute original video
        if (this.video) {
            this.video.muted = false;
        }

        // Hide overlay
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }

        console.log("✅ Ready for new video");
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
                this.selectedVoice = request.voice || "female";
                this.targetLanguage = request.targetLanguage || "vi";
                this.translateSource = request.translateSource || "youtube";
                this.originalVolume = request.originalVolume !== undefined ? request.originalVolume : 0.2;
                this.dubVolume = request.dubVolume !== undefined ? request.dubVolume : 1.0;
                console.log(`Settings: voice=${this.selectedVoice}, lang=${this.targetLanguage}, translate=${this.translateSource}, original=${this.originalVolume * 100}%, dub=${this.dubVolume * 100}%`);
                this.startProcess();
            }
            if (request.action === "update_dub_volume") {
                this.dubVolume = request.volume;
                if (this.currentAudioPlayer) {
                    this.currentAudioPlayer.volume = Math.min(this.dubVolume, 1.0);
                }
            }
            if (request.action === "update_balance") {
                this.originalVolume = request.originalVolume;
                if (this.video && this.isDubbing) {
                    this.video.volume = this.originalVolume;
                }
            }
        });

        this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.video.addEventListener('seeking', () => this.onSeek());
        this.video.addEventListener('play', () => this.onVideoPlay());
        this.video.addEventListener('pause', () => this.onVideoPause());

        this.createOverlay();
        this.createFloatingControl();  // Add floating control
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

    createFloatingControl() {
        if (document.getElementById('mario-dubbing-control')) return;

        const control = document.createElement('div');
        control.id = 'mario-dubbing-control';
        control.innerHTML = `
            <div class="mdc-header">
                <span class="mdc-logo">🎙️</span>
                <span class="mdc-title">Mario Dub</span>
                <button class="mdc-close" id="mdc-close">✕</button>
            </div>
            <div class="mdc-body">
                <div class="mdc-row">
                    <span class="mdc-label">Balance</span>
                    <input type="range" min="0" max="100" value="20" class="mdc-slider" id="mdc-balance">
                    <span class="mdc-value" id="mdc-balance-val">20%</span>
                </div>
                <div class="mdc-row">
                    <span class="mdc-label">Dub Vol</span>
                    <input type="range" min="0" max="200" value="100" class="mdc-slider" id="mdc-volume">
                    <span class="mdc-value" id="mdc-volume-val">100%</span>
                </div>
                <div class="mdc-buttons">
                    <button class="mdc-btn mdc-btn-stop" id="mdc-stop">⏹ Stop</button>
                </div>
            </div>
        `;
        control.style.cssText = `
            position: absolute;
            bottom: 70px;
            left: 12px;
            background: rgba(15, 15, 15, 0.95);
            border: 1px solid rgba(255, 59, 48, 0.5);
            border-radius: 12px;
            padding: 0;
            font-family: 'Segoe UI', Roboto, Arial, sans-serif;
            font-size: 12px;
            z-index: 9999;
            min-width: 200px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            display: none;
            overflow: hidden;
        `;

        // Inject styles
        const style = document.createElement('style');
        style.textContent = `
            #mario-dubbing-control .mdc-header {
                background: linear-gradient(90deg, #FF2D55, #FF3B30);
                padding: 8px 12px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #mario-dubbing-control .mdc-logo { font-size: 14px; }
            #mario-dubbing-control .mdc-title { 
                color: white; 
                font-weight: 600; 
                font-size: 13px;
                flex: 1;
            }
            #mario-dubbing-control .mdc-close {
                background: none;
                border: none;
                color: white;
                cursor: pointer;
                font-size: 14px;
                opacity: 0.8;
            }
            #mario-dubbing-control .mdc-close:hover { opacity: 1; }
            #mario-dubbing-control .mdc-body { padding: 12px; }
            #mario-dubbing-control .mdc-row {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 10px;
            }
            #mario-dubbing-control .mdc-label {
                color: #aaa;
                font-size: 11px;
                min-width: 50px;
            }
            #mario-dubbing-control .mdc-slider {
                flex: 1;
                height: 4px;
                background: rgba(255,255,255,0.2);
                border-radius: 2px;
                -webkit-appearance: none;
            }
            #mario-dubbing-control .mdc-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #FF3B30;
                cursor: pointer;
            }
            #mario-dubbing-control .mdc-value {
                color: white;
                font-size: 11px;
                min-width: 35px;
                text-align: right;
            }
            #mario-dubbing-control .mdc-buttons {
                display: flex;
                gap: 8px;
            }
            #mario-dubbing-control .mdc-btn {
                flex: 1;
                padding: 8px;
                border: none;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
            }
            #mario-dubbing-control .mdc-btn-stop {
                background: #444;
                color: white;
            }
            #mario-dubbing-control .mdc-btn-stop:hover {
                background: #FF3B30;
            }
        `;
        document.head.appendChild(style);

        const container = document.querySelector('#movie_player') || document.body;
        container.appendChild(control);
        this.floatingControl = control;

        // Event listeners
        const balanceSlider = control.querySelector('#mdc-balance');
        const volumeSlider = control.querySelector('#mdc-volume');
        const balanceVal = control.querySelector('#mdc-balance-val');
        const volumeVal = control.querySelector('#mdc-volume-val');
        const stopBtn = control.querySelector('#mdc-stop');
        const closeBtn = control.querySelector('#mdc-close');

        balanceSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            balanceVal.textContent = val + '%';
            this.originalVolume = val / 100;
            if (this.video) this.video.volume = this.originalVolume;
        });

        volumeSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            volumeVal.textContent = val + '%';
            this.dubVolume = val / 100;
            if (this.currentAudioPlayer) {
                this.currentAudioPlayer.volume = Math.min(this.dubVolume, 1.0);
            }
        });

        stopBtn.addEventListener('click', () => {
            this.stopDubbing();
        });

        closeBtn.addEventListener('click', () => {
            control.style.display = 'none';
        });
    }

    showFloatingControl() {
        if (this.floatingControl) {
            this.floatingControl.style.display = 'block';
            // Update sliders to current values
            const balanceSlider = this.floatingControl.querySelector('#mdc-balance');
            const volumeSlider = this.floatingControl.querySelector('#mdc-volume');
            if (balanceSlider) balanceSlider.value = Math.round(this.originalVolume * 100);
            if (volumeSlider) volumeSlider.value = Math.round(this.dubVolume * 100);
        }
    }

    stopDubbing() {
        console.log("🛑 Stopping dubbing...");
        this.isDubbing = false;

        // Stop current audio
        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
            this.currentAudioPlayer = null;
        }

        // Restore original volume
        if (this.video) {
            this.video.volume = this.savedOriginalVolume;
        }

        // Hide controls
        if (this.floatingControl) {
            this.floatingControl.style.display = 'none';
        }
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }

        console.log("✅ Dubbing stopped, volume restored");
    }

    async startProcess() {
        console.log("Starting dubbing process...");
        this.isDubbing = true;
        this.updateOverlay("Initializing...", "#FF9500");
        this.video.pause();

        // Apply audio balance: save original volume and set new level
        this.savedOriginalVolume = this.video.volume;
        this.video.volume = this.originalVolume;
        console.log(`Audio balance: Original ${this.originalVolume * 100}%, Dub ${this.dubVolume * 100}%`);

        // Show floating control
        this.showFloatingControl();

        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v');

        if (!videoId) {
            alert("Could not detect Video ID");
            return;
        }

        // Check if this is a different video - clear cache
        if (this.currentVideoId && this.currentVideoId !== videoId) {
            console.log(`🔄 New video detected, clearing cache...`);
            this.audioCache.clear();
            this.processedIds.clear();
            this.audioQueue = [];
        }

        // Save current video ID
        this.currentVideoId = videoId;
        console.log(`📺 Current video: ${videoId}`);

        this.updateOverlay(`Fetching (${this.translateSource})...`);
        this.subtitles = await this.fetchSubtitles(videoId);

        if (!this.subtitles || this.subtitles.length === 0) {
            alert("No subtitles found!");
            this.isDubbing = false;
            return;
        }

        console.log(`Loaded ${this.subtitles.length} subtitles (source: ${this.translateSource})`);
        const voiceName = this.targetLanguage === 'en' ? 'English' : 'Tiếng Việt';

        // PRE-BUFFER: Generate audio for first 30 segments before playing
        const MIN_BUFFER_SEGMENTS = Math.min(30, this.subtitles.length);
        this.updateOverlay(`Preparing ${MIN_BUFFER_SEGMENTS} segments...`, "#FF9500");

        // Buffer in batches until we have enough
        let bufferedCount = 0;
        while (bufferedCount < MIN_BUFFER_SEGMENTS && this.nextFetchIndex < this.subtitles.length) {
            const batchSize = Math.min(10, MIN_BUFFER_SEGMENTS - bufferedCount);
            await this.bufferBatch(this.nextFetchIndex, batchSize);
            bufferedCount = this.audioQueue.length;
            const percent = Math.round((bufferedCount / MIN_BUFFER_SEGMENTS) * 100);
            this.updateOverlay(`Buffering: ${bufferedCount}/${MIN_BUFFER_SEGMENTS} (${percent}%)`, "#FF9500");
        }

        console.log(`✅ Pre-buffered ${this.audioQueue.length} audio clips. Starting playback...`);
        this.updateOverlay(`Voice: ${voiceName} | Ready!`, "#34C759");

        // Start video playback
        this.video.play();

        // Start continuous background buffering
        this.startBackgroundBuffering();
    }

    async bufferBatch(startIndex, count) {
        if (startIndex >= this.subtitles.length) return;

        let batch = [];
        let i = startIndex;

        while (batch.length < count && i < this.subtitles.length) {
            if (!this.processedIds.has(i)) {
                const sub = this.subtitles[i];
                batch.push({
                    id: i.toString(),
                    text: sub.text,
                    start_time: sub.start,
                    end_time: sub.end
                });
            }
            i++;
        }

        if (batch.length > 0) {
            await this.sendBatchToServer(batch);
            this.nextFetchIndex = i;
        }
    }

    startBackgroundBuffering() {
        // Continuously buffer more audio in background
        const bufferInterval = setInterval(async () => {
            if (!this.isDubbing) {
                clearInterval(bufferInterval);
                return;
            }

            // Check if we need more buffer
            const unbufferedCount = this.subtitles.length - this.processedIds.size;

            // Stop if all segments are processed
            if (unbufferedCount <= 0) {
                console.log("✅ All segments buffered. Stopping background buffer.");
                clearInterval(bufferInterval);
                return;
            }

            if (!this.isBuffering) {
                this.isBuffering = true;
                await this.bufferBatch(this.nextFetchIndex, 10);
                this.isBuffering = false;

                const percent = Math.round((this.processedIds.size / this.subtitles.length) * 100);
                console.log(`📦 Background buffer: ${this.processedIds.size}/${this.subtitles.length} (${percent}%)`);
            }
        }, 2000); // Check every 2 seconds
    }

    async fetchSubtitles(videoId) {
        console.log(`Fetching subtitles: video=${videoId}, lang=${this.targetLanguage}, source=${this.translateSource}`);
        try {
            const resp = await fetch(`${this.SERVER_URL_BASE}/subtitles?video_id=${videoId}&target_lang=${this.targetLanguage}&translate_source=${this.translateSource}`);
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

        // LARGER BATCHES for more buffer
        const MAX_BATCH_SIZE = 10;  // Max 10 items per batch
        const MAX_DURATION = 30;    // Max 30 seconds per batch

        while (durationBuffered < MAX_DURATION && batch.length < MAX_BATCH_SIZE && i < this.subtitles.length) {
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
            this.updateOverlay("▶ Playing", "#34C759");
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
                    voice: this.selectedVoice,
                    target_language: this.targetLanguage
                })
            });
            const data = await resp.json();

            data.results.forEach(item => {
                const blob = this.base64ToBlob(item.audio_base64, 'audio/mp3');
                const url = URL.createObjectURL(blob);
                const audioData = {
                    id: item.id,
                    url: url,
                    start: item.start_time,
                    end: item.end_time
                };

                // Add to queue
                this.audioQueue.push(audioData);
                this.processedIds.add(parseInt(item.id));

                // SAVE TO PERSISTENT CACHE for seek support
                this.audioCache.set(item.id, audioData);
            });

            this.audioQueue.sort((a, b) => a.start - b.start);
            console.log(`Received ${data.results.length} audio clips. Queue: ${this.audioQueue.length}`);

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
        if (!this.video || this.video.paused || !this.isDubbing) return;
        const currentTime = this.video.currentTime;

        // Find and play audio that matches current time
        this.playMatchingAudio(currentTime);

        // Check buffer health - only if we haven't processed all segments
        const allProcessed = this.processedIds.size >= this.subtitles.length;
        if (allProcessed) return;  // All segments already buffered

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

    playMatchingAudio(currentTime) {
        // Don't interrupt currently playing audio
        if (this.currentAudioPlayer && !this.currentAudioPlayer.ended && !this.currentAudioPlayer.paused) {
            return;
        }

        // Sort queue by ID (sequential order, not time)
        this.audioQueue.sort((a, b) => parseInt(a.id) - parseInt(b.id));

        if (this.audioQueue.length === 0) return;

        // Get next audio to play (first in queue)
        const nextAudio = this.audioQueue[0];

        // Check if it's time to play this segment
        // Play if: we're within the segment's time window OR we're past it (catch up)
        const shouldPlay = currentTime >= nextAudio.start - 0.3;

        if (shouldPlay) {
            this.audioQueue.shift();

            // Calculate remaining time for this segment
            const remainingTime = Math.max(nextAudio.end - currentTime, 0.5);

            console.log(`▶ Playing segment ${nextAudio.id} | Video: ${currentTime.toFixed(1)}s | Slot: ${nextAudio.start.toFixed(1)}-${nextAudio.end.toFixed(1)}s | Remaining: ${remainingTime.toFixed(1)}s`);

            this.playAudioWithTiming(nextAudio, remainingTime);
        }
    }

    playAudioWithTiming(audioData, maxDuration) {
        // Stop previous audio immediately
        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
            this.currentAudioPlayer = null;
        }

        const audio = new Audio(audioData.url);
        audio.volume = Math.min(this.dubVolume, 1.0);

        // Calculate speed based on available time
        audio.onloadedmetadata = () => {
            if (audio.duration > maxDuration && maxDuration > 0.3) {
                // Speed up to fit in remaining time
                const speedRatio = Math.min(audio.duration / maxDuration, 2.0);
                audio.playbackRate = speedRatio;
                console.log(`🔊 Segment ${audioData.id}: ${audio.duration.toFixed(1)}s audio → ${maxDuration.toFixed(1)}s slot → ${speedRatio.toFixed(2)}x speed`);
            }
        };

        audio.onended = () => {
            console.log(`✅ Audio ${audioData.id} ended`);
            this.currentAudioPlayer = null;
        };

        this.currentAudioPlayer = audio;
        audio.play().catch(e => console.error("Audio play error", e));

        // Update overlay
        this.updateOverlay(`▶ #${audioData.id}`, "#34C759");
    }

    playAudio(audioData) {
        // Stop previous audio immediately
        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
            this.currentAudioPlayer = null;
        }

        const audio = new Audio(audioData.url);
        audio.volume = Math.min(this.dubVolume, 1.0);

        // Speed up if needed to fit in time slot
        const subtitleDuration = audioData.end - audioData.start;
        audio.onloadedmetadata = () => {
            if (audio.duration > subtitleDuration && subtitleDuration > 0.5) {
                // Speed up more aggressively to stay in sync
                const speedRatio = Math.min(audio.duration / subtitleDuration, 1.8);
                audio.playbackRate = speedRatio;
                console.log(`🔊 Segment ${audioData.id}: speed ${speedRatio.toFixed(2)}x`);
            }
        };

        // NO chaining - let timeupdate handle the next segment
        audio.onended = () => {
            console.log(`✅ Audio ${audioData.id} ended`);
            this.currentAudioPlayer = null;
        };

        this.currentAudioPlayer = audio;
        this.audioEndTimes.set(audio, audioData.end);

        audio.play().catch(e => console.error("Audio play error", e));

        // Update overlay
        const shortText = audioData.id ? `#${audioData.id}` : '';
        this.updateOverlay(`▶ ${shortText}`, "#34C759");
    }

    onVideoPlay() {
        if (!this.isDubbing) return;
        // Resume audio if it was paused
        if (this.currentAudioPlayer && this.currentAudioPlayer.paused) {
            this.currentAudioPlayer.play().catch(() => { });
        }
    }

    onVideoPause() {
        if (!this.isDubbing) return;
        // Pause audio when video pauses
        if (this.currentAudioPlayer && !this.currentAudioPlayer.paused) {
            this.currentAudioPlayer.pause();
        }
    }

    onSeek() {
        console.log("User seeked. Checking cache...");

        // Stop current audio
        if (this.currentAudioPlayer) {
            this.currentAudioPlayer.pause();
            this.currentAudioPlayer = null;
        }

        const currentTime = this.video.currentTime;
        let newIndex = this.subtitles.findIndex(s => s.end > currentTime);

        if (newIndex === -1) {
            if (currentTime < (this.subtitles[0]?.start || 0)) newIndex = 0;
            else return;
        }

        // Rebuild queue from cache where possible
        this.audioQueue = [];
        let needsFetch = [];

        for (let i = newIndex; i < Math.min(newIndex + 20, this.subtitles.length); i++) {
            const cachedAudio = this.audioCache.get(i.toString());
            if (cachedAudio) {
                // Use cached audio
                this.audioQueue.push(cachedAudio);
                console.log(`Cache hit for segment ${i}`);
            } else {
                // Need to fetch this one
                needsFetch.push(i);
            }
        }

        this.audioQueue.sort((a, b) => a.start - b.start);
        this.nextFetchIndex = newIndex;
        this.audioEndTimes.clear();

        if (this.audioQueue.length > 0) {
            console.log(`Restored ${this.audioQueue.length} audio clips from cache`);
            this.updateOverlay(`▶ From cache`, "#34C759");
            this.video.play();
        } else {
            this.updateOverlay("Buffering...", "#FF9500");
            this.bufferUntilSafe(newIndex);
        }

        // Fetch missing audio in background if needed
        if (needsFetch.length > 0 && !this.isBuffering) {
            this.bufferUntilSafe(Math.max(...needsFetch));
        }
    }
}

new DubbingManager();
