from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
import base64
import asyncio
from tts_engine import EdgeTTSEngine
from youtube_transcript_api import YouTubeTranscriptApi
from deep_translator import GoogleTranslator

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

tts_engine = EdgeTTSEngine()
translator = GoogleTranslator(source='auto', target='vi')

class SubtitleItem(BaseModel):
    id: str 
    text: str
    start_time: float 
    end_time: float

class TTSRequest(BaseModel):
    subtitles: List[SubtitleItem]

class AudioResponseItem(BaseModel):
    id: str
    audio_base64: str
    start_time: float
    end_time: float

@app.get("/subtitles")
async def get_subtitles(video_id: str, lang: str = "vi"):
    try:
        print(f"Fetching subs for {video_id} (Instance API)")
        yt = YouTubeTranscriptApi()
        
        # Strategy:
        # 1. Try to get official 'vi' subtitles first (Human translated)
        # 2. If valid 'vi' not found, get 'en' and translate manually using deep-translator
        #    (Use deep-translator instead of YouTube's auto-translate for "more natural" results)
        
        transcript_list = yt.list(video_id)
        
        chosen_transcript = None
        needs_translation = False
        
        # Check for manual VI
        try:
             chosen_transcript = transcript_list.find_transcript(['vi'])
             if chosen_transcript.is_generated:
                 # If it's auto-generated VI, maybe we prefer translating EN manually?
                 # But let's trust manual VI if available.
                 pass
        except:
            chosen_transcript = None
            
        if not chosen_transcript:
            print("No manual VI subs found. Falling back to EN -> VI translation.")
            try:
                chosen_transcript = transcript_list.find_transcript(['en'])
                needs_translation = True
            except:
                # Fallback to any available
                try:
                    chosen_transcript = transcript_list.find_transcript(['en-US', 'en-GB'])
                    needs_translation = True
                except:
                     # Just get the first one
                     chosen_transcript = next(iter(transcript_list))
                     needs_translation = True

        print(f"Source Transcript: {chosen_transcript.language_code} (Generated: {chosen_transcript.is_generated})")
        
        data = chosen_transcript.fetch()
        
        result = []
        for item in data:
            if hasattr(item, 'text'):
                text = item.text
                start = item.start
                duration = item.duration
            else:
                text = item['text']
                start = item['start']
                duration = item['duration']
            
            # Translate if needed
            if needs_translation:
                # We can batch translate logic efficiently if needed, but for simplicity:
                # (Actually, batch translation is better for API limits but GoogleTranslator handles single well enough for small scale)
                # However, iterating and translating line by line is slow. 
                # Let's collect texts.
                pass 
                
            result.append({
                "start": start,
                "end": start + duration,
                "text": text
            })
            
        if needs_translation:
            print("Translating lines to Vietnamese...")
            # Extract all texts
            texts = [item['text'] for item in result]
            
            # Batch translate might fail if too large. Batching in chunks of 50.
            translated_texts = []
            chunk_size = 50
            for i in range(0, len(texts), chunk_size):
                chunk = texts[i:i+chunk_size]
                try:
                    # GoogleTranslator.translate_batch might not exist in all versions?
                    # Check docs? deep_translator has translate_batch.
                    translated_chunk = GoogleTranslator(source='auto', target='vi').translate_batch(chunk)
                    translated_texts.extend(translated_chunk)
                except Exception as e:
                    print(f"Translation chunk failed: {e}. Fallback to originals.")
                    translated_texts.extend(chunk)
            
            # Assign back
            for i, translated in enumerate(translated_texts):
                result[i]['text'] = translated
            
        return result

    except Exception as e:
        print(f"Error fetching subs: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/synthesize")
async def synthesize_batch(request: TTSRequest):
    print(f"Synthesizing batch of {len(request.subtitles)} items...")
    
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

    # Run all tasks in parallel
    tasks = [process_item(item) for item in request.subtitles]
    results = await asyncio.gather(*tasks)
    
    # Filter out failures
    valid_results = [r for r in results if r is not None]
    
    print(f"Batch complete. Valid: {len(valid_results)}/{len(request.subtitles)}")
    return {"results": valid_results}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
