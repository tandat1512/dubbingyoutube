from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
import base64
import asyncio
import os
from dotenv import load_dotenv
from tts_engine import EdgeTTSEngine
from youtube_transcript_api import YouTubeTranscriptApi
from deep_translator import GoogleTranslator

# Load environment variables
load_dotenv()

# Try to import Gemini
GEMINI_AVAILABLE = False
gemini_model = None
try:
    import google.generativeai as genai
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key and api_key.strip() and api_key != "your_gemini_api_key_here":
        genai.configure(api_key=api_key)
        
        # Try different model names (newest first)
        model_names = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']
        for model_name in model_names:
            try:
                gemini_model = genai.GenerativeModel(model_name)
                # Test with a simple request
                test_response = gemini_model.generate_content("Say 'OK'")
                GEMINI_AVAILABLE = True
                print(f"✅ Gemini AI enabled with model: {model_name}")
                break
            except Exception as e:
                print(f"⚠️ Model {model_name} failed: {str(e)[:50]}")
                continue
        
        if not GEMINI_AVAILABLE:
            print("⚠️ No working Gemini model found")
    else:
        print("⚠️ Gemini API key not set.")
except ImportError:
    print("⚠️ google-generativeai not installed.")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Available Vietnamese voices
AVAILABLE_VOICES = {
    "female": "vi-VN-HoaiMyNeural",
    "male": "vi-VN-NamMinhNeural"
}

class SubtitleItem(BaseModel):
    id: str 
    text: str
    start_time: float 
    end_time: float

class TTSRequest(BaseModel):
    subtitles: List[SubtitleItem]
    voice: Optional[str] = "female"

class AudioResponseItem(BaseModel):
    id: str
    audio_base64: str
    start_time: float
    end_time: float


async def deep_translate_with_gemini(subtitles: list) -> list:
    """
    Deep Translate: Merge short segments and translate for natural flow.
    Returns new subtitle list with merged/rewritten segments.
    """
    if not GEMINI_AVAILABLE or not gemini_model:
        return None
    
    try:
        # Combine all text with timestamps for context
        combined_text = ""
        for i, sub in enumerate(subtitles):
            combined_text += f"[{sub['start']:.1f}s] {sub['text']}\n"
        
        prompt = f"""You are a professional Vietnamese dubbing translator. 

I have English subtitles from a video. Please translate them to Vietnamese following these rules:
1. Merge short, choppy sentences into longer, natural sentences
2. Keep the translation smooth and conversational, suitable for voice-over
3. Maintain the approximate timing - each translated segment should roughly match the original duration
4. Output format: One translated sentence per line, each starting with the timestamp
5. You can combine 2-3 short segments if it makes the flow better
6. The translation should sound natural when spoken aloud in Vietnamese

Original subtitles:
{combined_text}

Output Vietnamese translation (keep [timestamp] format):"""

        response = gemini_model.generate_content(prompt)
        result_text = response.text.strip()
        
        # Parse response
        new_subtitles = []
        lines = result_text.split('\n')
        
        for line in lines:
            line = line.strip()
            if not line or not line.startswith('['):
                continue
            
            # Parse [timestamp] text format
            try:
                bracket_end = line.index(']')
                timestamp_str = line[1:bracket_end].replace('s', '').strip()
                text = line[bracket_end+1:].strip()
                
                if text:
                    start = float(timestamp_str)
                    new_subtitles.append({
                        "start": start,
                        "text": text
                    })
            except:
                continue
        
        if len(new_subtitles) < 3:
            print("Deep translate returned too few segments, falling back")
            return None
            
        # Calculate end times based on next segment
        for i, sub in enumerate(new_subtitles):
            if i < len(new_subtitles) - 1:
                sub['end'] = new_subtitles[i+1]['start']
            else:
                # Last segment - use original end time
                sub['end'] = subtitles[-1].get('end', sub['start'] + 3.0) if subtitles else sub['start'] + 3.0
        
        print(f"✅ Deep Translate: {len(subtitles)} segments → {len(new_subtitles)} merged segments")
        return new_subtitles
            
    except Exception as e:
        print(f"Deep translate error: {e}")
        return None


async def translate_with_gemini(texts: List[str]) -> List[str]:
    """Simple Gemini translation (1:1 mapping)"""
    if not GEMINI_AVAILABLE or not gemini_model:
        return None
    
    try:
        prompt = f"""Translate the following subtitle lines to Vietnamese. 
Keep the translations natural and conversational, suitable for voice dubbing.
Maintain the same number of lines. Only output the translations, one per line.

Lines to translate:
{chr(10).join([f'{i+1}. {t}' for i, t in enumerate(texts)])}"""

        response = gemini_model.generate_content(prompt)
        result_text = response.text.strip()
        
        lines = result_text.split('\n')
        translated = []
        for line in lines:
            clean = line.strip()
            if clean and clean[0].isdigit() and '. ' in clean:
                clean = clean.split('. ', 1)[1]
            if clean:
                translated.append(clean)
        
        if len(translated) >= len(texts):
            return translated[:len(texts)]
        return None
            
    except Exception as e:
        print(f"Gemini translation error: {e}")
        return None


def translate_with_google(texts: List[str]) -> List[str]:
    """Fallback translation using Google Translate"""
    translated_texts = []
    chunk_size = 50
    for i in range(0, len(texts), chunk_size):
        chunk = texts[i:i+chunk_size]
        try:
            translated_chunk = GoogleTranslator(source='auto', target='vi').translate_batch(chunk)
            translated_texts.extend(translated_chunk)
        except Exception as e:
            print(f"Google translation error: {e}")
            translated_texts.extend(chunk)
    return translated_texts


@app.get("/subtitles")
async def get_subtitles(video_id: str, lang: str = "vi", translate_source: str = "youtube"):
    """
    translate_source options:
    - youtube: Use YouTube's Vietnamese subs directly
    - gemini: Translate with Gemini AI (1:1 mapping)
    - deep: Deep Translate - merge segments for natural flow
    """
    try:
        print(f"Fetching subs for {video_id} | Source: {translate_source}")
        yt = YouTubeTranscriptApi()
        transcript_list = yt.list(video_id)
        
        chosen_transcript = None
        
        if translate_source == "youtube":
            # Try Vietnamese first
            try:
                chosen_transcript = transcript_list.find_transcript(['vi'])
                print(f"Found Vietnamese subs")
            except:
                try:
                    chosen_transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB'])
                    print("No VI subs, using EN + Google fallback")
                    translate_source = "google_fallback"
                except:
                    chosen_transcript = next(iter(transcript_list))
                    translate_source = "google_fallback"
        else:
            # Get English for translation
            try:
                chosen_transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB'])
            except:
                chosen_transcript = next(iter(transcript_list))
        
        print(f"Source lang: {chosen_transcript.language_code}")
        
        data = chosen_transcript.fetch()
        
        result = []
        for item in data:
            if hasattr(item, 'text'):
                result.append({"start": item.start, "end": item.start + item.duration, "text": item.text})
            else:
                result.append({"start": item['start'], "end": item['start'] + item['duration'], "text": item['text']})
        
        # Handle translation based on source
        if translate_source == "deep":
            print("🔄 Deep Translating with Gemini...")
            deep_result = await deep_translate_with_gemini(result)
            if deep_result:
                return deep_result
            else:
                print("⚠️ Deep translate failed, using normal Gemini...")
                translate_source = "gemini"
        
        if translate_source == "gemini":
            print("🤖 Translating with Gemini AI...")
            texts = [item['text'] for item in result]
            translated = await translate_with_gemini(texts)
            if translated:
                for i, t in enumerate(translated):
                    result[i]['text'] = t
                print("✅ Gemini translation complete!")
            else:
                print("⚠️ Gemini failed, using Google...")
                translated = translate_with_google(texts)
                for i, t in enumerate(translated):
                    result[i]['text'] = t
        
        elif translate_source == "google_fallback":
            print("📝 Translating with Google Translate...")
            texts = [item['text'] for item in result]
            translated = translate_with_google(texts)
            for i, t in enumerate(translated):
                result[i]['text'] = t
            
        return result

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/synthesize")
async def synthesize_batch(request: TTSRequest):
    voice_id = AVAILABLE_VOICES.get(request.voice, AVAILABLE_VOICES["female"])
    tts_engine = EdgeTTSEngine(voice=voice_id)
    
    print(f"Synthesizing {len(request.subtitles)} items | Voice: {voice_id}")
    
    async def process_item(item):
        try:
            audio_bytes = await tts_engine.generate_audio(
                text=item.text,
                start_time=item.start_time,
                end_time=item.end_time
            )
            b64_audio = base64.b64encode(audio_bytes).decode('utf-8')
            return AudioResponseItem(
                id=item.id,
                audio_base64=b64_audio,
                start_time=item.start_time,
                end_time=item.end_time
            )
        except Exception as e:
            print(f"TTS Error for {item.id}: {e}")
            return None

    tasks = [process_item(item) for item in request.subtitles]
    results = await asyncio.gather(*tasks)
    
    valid_results = [r for r in results if r is not None]
    print(f"Batch complete. Valid: {len(valid_results)}/{len(request.subtitles)}")
    return {"results": valid_results}


@app.get("/voices")
async def get_voices():
    return {
        "voices": [
            {"id": "female", "name": "Hoài My (Nữ)", "code": "vi-VN-HoaiMyNeural"},
            {"id": "male", "name": "Nam Minh (Nam)", "code": "vi-VN-NamMinhNeural"}
        ]
    }


@app.get("/health")
async def health_check():
    return {"status": "ok", "gemini": GEMINI_AVAILABLE}


if __name__ == "__main__":
    print("🚀 Starting Dubbing API Server...")
    uvicorn.run(app, host="0.0.0.0", port=8000)