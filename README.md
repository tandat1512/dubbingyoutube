# YouTube Dubbing Pro

🎙️ **AI-powered Chrome Extension** that automatically dubs YouTube videos into Vietnamese with natural-sounding voice synthesis.

## Features

- ✅ **Real-time Subtitle Fetching** - Grabs subtitles directly from YouTube
- ✅ **AI Translation** - Uses Deep Translator (Google Translate) for natural English→Vietnamese translation
- ✅ **Edge-TTS Voice Synthesis** - High-quality Vietnamese voice (`vi-VN-HoaiMyNeural`)
- ✅ **Smart Audio Sync** - Automatically pauses video if voice needs more time, ensuring no overlap
- ✅ **Parallel Processing** - Fast batch processing using asyncio
- ✅ **Modern UI** - Premium dark-themed popup with status indicators

## Architecture

```
┌─────────────────┐       ┌─────────────────┐
│ Chrome Extension│◄─────►│  FastAPI Server │
│   (content.js)  │ HTTP  │  (server.py)    │
└─────────────────┘       └────────┬────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
            ┌───────────┐  ┌────────────┐  ┌──────────┐
            │ YouTube   │  │ Deep       │  │ Edge-TTS │
            │ Transcript│  │ Translator │  │ + FFmpeg │
            │ API       │  │            │  │          │
            └───────────┘  └────────────┘  └──────────┘
```

## Installation

### Prerequisites
- Python 3.14+ (or 3.8+)
- **FFmpeg** installed and in PATH
- Google Chrome

### 1. Backend Setup
```bash
cd server
pip install -r requirements.txt
python server.py
```

### 2. Extension Setup
1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → Select the `extension` folder


## Usage

1. Start the backend server (`python server/server.py`)
2. Go to any YouTube video
3. Click the extension icon → "START DUBBING"
4. Enjoy the Vietnamese dub! 🎉

## Tech Stack

- **Backend**: FastAPI, Edge-TTS, FFmpeg, deep-translator, youtube-transcript-api
- **Frontend**: Chrome Extension (Manifest V3), Vanilla JS

## License

MIT
