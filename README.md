# YouTube Dubbing Pro 🎙️

AI-powered Chrome Extension that automatically dubs YouTube videos into Vietnamese with natural-sounding voice synthesis.

![Version](https://img.shields.io/badge/version-1.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎤 **Multiple Voices** | Choose between Hoài My (Female) or Nam Minh (Male) |
| 🔇 **Mute Original** | Auto-mute video audio for clean dubbing experience |
| 🤖 **Gemini AI Translation** | Natural translations using Google Gemini AI |
| ⚡ **Parallel Processing** | Fast batch audio generation with asyncio |
| 🔄 **Smart Sync** | Auto-pauses video if audio needs more time |
| ☁️ **Cloud Ready** | Docker + Railway/Render deployment support |

## 🏗️ Architecture

```
┌─────────────────┐       ┌─────────────────┐
│ Chrome Extension│◄─────►│  FastAPI Server │
│   (content.js)  │ HTTP  │  (server.py)    │
└─────────────────┘       └────────┬────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
            ┌───────────┐  ┌────────────┐  ┌──────────┐
            │ YouTube   │  │ Gemini AI  │  │ Edge-TTS │
            │ Transcript│  │ Translation│  │ + FFmpeg │
            └───────────┘  └────────────┘  └──────────┘
```

## 🚀 Installation

### Prerequisites
- Python 3.8+
- **FFmpeg** installed and in PATH
- Google Chrome
- (Optional) Gemini API Key for AI translation

### 1. Backend Setup
```bash
# Clone repo
git clone https://github.com/tandat1512/dubbingyoutube.git
cd dubbingyoutube

# Install dependencies
pip install -r server/requirements.txt

# Set up Gemini API (optional but recommended)
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# Start server
python server/server.py
```

### 2. Extension Setup
1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → Select the `extension` folder

## 📖 Usage

1. Start the backend server
2. Go to any YouTube video
3. Click extension icon → Select voice → Toggle mute
4. Click **START DUBBING** 🎉

## ☁️ Cloud Deployment

### Railway
```bash
railway up
```

### Render
Connect your GitHub repo and it will auto-deploy using `render.yaml`.

### Docker
```bash
docker build -t dubbing-api .
docker run -p 8000:8000 -e GEMINI_API_KEY=your_key dubbing-api
```

## 🔧 Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key for AI translation | No (falls back to Google Translate) |

## 📦 Tech Stack

- **Backend**: FastAPI, Edge-TTS, FFmpeg, google-generativeai
- **Frontend**: Chrome Extension (Manifest V3), Vanilla JS
- **Deployment**: Docker, Railway, Render

## 📄 License

MIT
