from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
import base64
import asyncio
import os
import subprocess
import logging
from dotenv import load_dotenv
from tts_engine import EdgeTTSEngine
from youtube_transcript_api import YouTubeTranscriptApi
from deep_translator import GoogleTranslator

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# Try to import scraper as fallback
try:
    from scraper import get_transcript_custom
    SCRAPER_AVAILABLE = True
    logger.info("✅ Scraper module loaded as fallback")
except ImportError:
    SCRAPER_AVAILABLE = False
    logger.warning("⚠️ Scraper module not available")

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
                logger.info(f"✅ Gemini AI enabled with model: {model_name}")
                break
            except Exception as e:
                logger.warning(f"⚠️ Model {model_name} failed: {str(e)[:50]}")
                continue
        
        if not GEMINI_AVAILABLE:
            logger.warning("⚠️ No working Gemini model found")
    else:
        logger.warning("⚠️ Gemini API key not set.")
except ImportError:
    logger.warning("⚠️ google-generativeai not installed.")


def check_ffmpeg_installed() -> bool:
    """Check if FFmpeg is installed and accessible"""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


FFMPEG_AVAILABLE = check_ffmpeg_installed()
if FFMPEG_AVAILABLE:
    logger.info("✅ FFmpeg is installed")
else:
    logger.warning("⚠️ FFmpeg not found - audio timing adjustment may not work")


app = FastAPI(
    title="YouTube Dubbing API",
    description="AI-powered dubbing for YouTube videos",
    version="1.2"
)

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

class SingleTTSRequest(BaseModel):
    text: str
    voice: Optional[str] = "female"


async def deep_translate_with_gemini(subtitles: list) -> list:
    """
    Deep Translate: Sử dụng Gemini để dịch và tái cấu trúc lại câu (Redesign Flow)
    nhằm khắc phục lỗi ngắt từ vô lý khi chạy TTS.
    """
    if not GEMINI_AVAILABLE or not gemini_model:
        return None
    
    try:
        # 1. Tiền xử lý: Gộp các mảnh vụn quá nhỏ trước khi gửi đi
        merged_subtitles = smart_merge_subtitles(subtitles)
        
        logger.info(f"📊 Smart merge: {len(subtitles)} → {len(merged_subtitles)} segments")
        
        # DEBUG: Show merged segments
        logger.info("=" * 60)
        logger.info("📝 MERGED SEGMENTS (Before Translation):")
        for idx, sub in enumerate(merged_subtitles[:10]):  # Show first 10
            logger.info(f"  [{idx}] [{sub['start']:.1f}s-{sub.get('end', 0):.1f}s] {sub['text'][:80]}...")
        if len(merged_subtitles) > 10:
            logger.info(f"  ... và {len(merged_subtitles) - 10} segments nữa")
        logger.info("=" * 60)
        
        # 2. Tạo text đầu vào kèm timestamp
        combined_text = ""
        for i, sub in enumerate(merged_subtitles):
            combined_text += f"[{sub['start']:.1f}s] {sub['text']}\n"
        
        # 3. Prompt "Redesign Flow" - Trọng tâm của giải pháp
        prompt = f"""Bạn là Chuyên gia Biên tập Lồng tiếng (Dubbing Editor) chuyên nghiệp.

NHIỆM VỤ:
Dịch phụ đề tiếng Anh sang tiếng Việt để chạy AI Voice (TTS).
Bạn phải xử lý lỗi "Gãy âm" (Unnatural Segmentation) do bản gốc tiếng Anh bị ngắt dòng giữa chừng.

QUY TẮC BẤT DI BẤT DỊCH (Cho Code xử lý):
1. Input có {len(merged_subtitles)} dòng -> Output PHẢI CÓ ĐÚNG {len(merged_subtitles)} DÒNG.
2. Giữ nguyên chính xác [TIMESTAMP] ở đầu mỗi dòng.
3. Không thêm lời dẫn, không Markdown, chỉ trả về văn bản.

KỸ THUẬT "DỊCH CHUYỂN TỪ" (WORD SHIFTING) - ĐỂ SỬA LỖI NGẮT GIỌNG:
Bản gốc tiếng Anh thường ngắt tính từ/danh từ ghép ra 2 dòng. Tiếng Việt KHÔNG ĐƯỢC làm thế.
Bạn được phép di chuyển từ ngữ lên dòng trên hoặc xuống dòng dưới (trong phạm vi lân cận) để câu trọn nghĩa.

VÍ DỤ CỤ THỂ (Học từ lỗi này):
--- Trường hợp Lỗi (CẤM LÀM):
Input:
[05.2s] but it is not
[07.1s] clear enough to see.
Output Sai (Dịch Word-by-word):
[05.2s] nhưng nó không
[07.1s] rõ ràng để nhìn thấy. (TTS sẽ đọc: "không... ngưng... rõ ràng" -> Rất tệ)

--- Trường hợp ĐÚNG (Kỹ thuật Word Shifting):
Output Tốt:
[05.2s] nhưng nó không đủ rõ ràng (Kéo chữ "rõ ràng" lên trên cho trọn cụm)
[07.1s] để có thể nhìn thấy được. (Thêm từ đệm cho khớp thời gian còn lại)

QUY TẮC CẤM KỴ TRONG TIẾNG VIỆT:
- TUYỆT ĐỐI KHÔNG kết thúc dòng bằng hư từ lửng lơ: "là", "của", "từ", "một", "những", "cái".
- Nếu gặp hư từ ở cuối dòng: Hãy đẩy nó xuống đầu dòng tiếp theo.

DỮ LIỆU CẦN XỬ LÝ:
{combined_text}

KẾT QUẢ BIÊN TẬP ({len(merged_subtitles)} dòng):"""

        # 4. Gọi Gemini
        response = gemini_model.generate_content(prompt)
        result_text = response.text.strip()
        
        # 5. Phân tích kết quả trả về (Parsing)
        new_subtitles = []
        lines = result_text.split('\n')
        
        for line in lines:
            line = line.strip()
            # Bỏ qua dòng trống hoặc không đúng định dạng
            if not line or not line.startswith('['):
                continue
            
            try:
                # Tìm vị trí đóng ngoặc ]
                bracket_end = line.index(']')
                timestamp_str = line[1:bracket_end].replace('s', '').strip()
                text = line[bracket_end+1:].strip()
                
                # Làm sạch text lần cuối để tránh lỗi TTS
                text = text.replace('"', '').replace('*', '').strip()
                
                if text:
                    start = float(timestamp_str)
                    new_subtitles.append({
                        "start": start,
                        "text": text
                    })
            except Exception as parse_error:
                logger.warning(f"⚠️ Lỗi parse dòng: {line} -> {parse_error}")
                continue
        
        # Kiểm tra an toàn: Nếu mất quá nhiều dòng thì hủy bỏ
        if len(new_subtitles) < len(merged_subtitles) * 0.8:
            logger.warning(f"⚠️ Cảnh báo: Gemini trả về thiếu dòng ({len(new_subtitles)}/{len(merged_subtitles)}).")
            # Tùy chọn: Vẫn trả về những gì đã dịch được hoặc return None để fallback
            # return None 
            
        # 6. Tính toán lại End Time
        for i, sub in enumerate(new_subtitles):
            if i < len(new_subtitles) - 1:
                # Kết thúc của câu này là bắt đầu của câu sau
                sub['end'] = new_subtitles[i+1]['start']
            else:
                # Câu cuối cùng
                original_end = merged_subtitles[-1].get('end', sub['start'] + 3.0)
                sub['end'] = original_end
        
        logger.info(f"✅ Deep Translate & Redesign hoàn tất: {len(new_subtitles)} dòng.")
        
        # DEBUG: Show translated segments
        logger.info("=" * 60)
        logger.info("🎯 TRANSLATED SEGMENTS (After Gemini):")
        for idx, sub in enumerate(new_subtitles[:10]):  # Show first 10
            logger.info(f"  [{idx}] [{sub['start']:.1f}s-{sub.get('end', 0):.1f}s] {sub['text'][:80]}...")
        if len(new_subtitles) > 10:
            logger.info(f"  ... và {len(new_subtitles) - 10} segments nữa")
        logger.info("=" * 60)
        
        return new_subtitles
            
    except Exception as e:
        logger.error(f"Deep translate error: {e}")
        return None


def smart_merge_subtitles(subtitles: list) -> list:
    """
    Smart sentence-based merge: Create complete, natural sentences.
    
    Strategy:
    1. Merge short segments (< 5 words) with the next one
    2. Keep merging until we have a complete sentence (ends with .!?)
    3. Or until we hit word limit (20 words max)
    4. ALWAYS preserve: start time from first segment, end time from last segment
    
    This creates longer, more natural-sounding sentences for TTS.
    """
    if not subtitles:
        return subtitles
    
    def is_complete_sentence(text: str) -> bool:
        """Check if text is a complete sentence"""
        text = text.strip()
        if not text:
            return False
        # Ends with sentence punctuation
        if text[-1] in '.!?':
            return True
        # Ends with quotes after punctuation
        if len(text) > 1 and text[-1] in '"\'' and text[-2] in '.!?':
            return True
        return False
    
    def needs_merging(text: str, duration: float) -> bool:
        """Check if this segment is too short and needs merging"""
        text = text.strip()
        words = len(text.split())
        # Merge if:
        # - Very short (< 5 words) AND doesn't end with punctuation
        # - Or just 1-2 words (always merge these)
        # - Or duration too short (< 1.5s)
        if words <= 2:
            return True
        if (words < 5 and not is_complete_sentence(text)) or duration < 1.5:
            return True
        return False
    
    result = []
    i = 0
    
    while i < len(subtitles):
        current = subtitles[i].copy()
        # CLEAN: Remove newlines and extra whitespace
        current_text = ' '.join(current['text'].split())
        current_duration = current.get('end', current['start'] + 2) - current['start']
        
        # Check if this segment needs merging
        if not needs_merging(current_text, current_duration) and is_complete_sentence(current_text):
            # Complete sentence, keep as-is
            current['text'] = current_text
            result.append(current)
            i += 1
            continue
        
        # This segment needs merging - accumulate until we have a good sentence
        accumulated_text = current_text
        start_time = current['start']
        end_time = current.get('end', current['start'] + 2)
        segments_merged = 1
        
        MAX_WORDS = 15  # Don't make sentences too long
        MAX_SEGMENTS = 3  # Don't merge too many segments
        
        j = i + 1
        while j < len(subtitles) and segments_merged < MAX_SEGMENTS:
            # Check if we already have a good sentence
            if len(accumulated_text.split()) >= 8 and is_complete_sentence(accumulated_text):
                break
            
            # Check word limit
            next_sub = subtitles[j]
            # CLEAN: Remove newlines
            next_text = ' '.join(next_sub['text'].split())
            combined_words = len(accumulated_text.split()) + len(next_text.split())
            
            if combined_words > MAX_WORDS:
                break
            
            # Merge this segment
            accumulated_text = accumulated_text.rstrip()
            if accumulated_text and accumulated_text[-1] not in '.,!?:;':
                accumulated_text += ' '
            else:
                accumulated_text += ' '
            accumulated_text += next_text
            
            end_time = next_sub.get('end', next_sub['start'] + 2)
            segments_merged += 1
            j += 1
            
            # Stop if we now have a complete sentence with good length
            if is_complete_sentence(accumulated_text) and len(accumulated_text.split()) >= 5:
                break
        
        # Create the merged segment with correct timing
        merged_segment = {
            'text': accumulated_text.strip(),
            'start': start_time,
            'end': end_time
        }
        result.append(merged_segment)
        i = j  # Skip to next unprocessed segment
    
    return result


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
        logger.error(f"Gemini translation error: {e}")
        return None


def translate_with_google(texts: List[str]) -> List[str]:
    """Fallback translation using Google Translate with optimized batching"""
    import concurrent.futures
    
    total = len(texts)
    logger.info(f"📝 Translating {total} segments with Google Translate...")
    
    translated_texts = [None] * total  # Pre-allocate for order preservation
    chunk_size = 100  # Larger chunks for fewer API calls
    
    def translate_chunk(chunk_data):
        start_idx, chunk = chunk_data
        try:
            translator = GoogleTranslator(source='auto', target='vi')
            result = translator.translate_batch(chunk)
            return start_idx, result
        except Exception as e:
            logger.error(f"Google translation error: {e}")
            return start_idx, chunk  # Return original on error
    
    # Create chunks with their starting indices
    chunks = []
    for i in range(0, total, chunk_size):
        chunk = texts[i:i+chunk_size]
        chunks.append((i, chunk))
    
    # Process chunks in parallel
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(translate_chunk, chunk_data) for chunk_data in chunks]
        
        completed = 0
        for future in concurrent.futures.as_completed(futures):
            start_idx, result = future.result()
            for j, text in enumerate(result):
                translated_texts[start_idx + j] = text
            completed += len(result)
            logger.info(f"📝 Progress: {completed}/{total} segments translated")
    
    return translated_texts


def fetch_subtitles_with_api(video_id: str):
    """Fetch subtitles using youtube-transcript-api"""
    yt = YouTubeTranscriptApi()
    transcript_list = yt.list(video_id)
    return transcript_list


def fetch_subtitles_with_scraper(video_id: str):
    """Fetch subtitles using custom scraper as fallback"""
    if not SCRAPER_AVAILABLE:
        raise Exception("Scraper not available")
    return get_transcript_custom(video_id)


@app.get("/subtitles")
async def get_subtitles(video_id: str, lang: str = "vi", translate_source: str = "youtube"):
    """
    translate_source options:
    - youtube: Use YouTube's Vietnamese subs directly
    - gemini: Translate with Gemini AI (1:1 mapping)
    - deep: Deep Translate - merge segments for natural flow
    - google: Force Google Translate
    """
    try:
        logger.info(f"📥 Fetching subs for {video_id} | Source: {translate_source}")
        
        result = []
        source_lang = "unknown"
        use_translation = False
        
        # Try youtube-transcript-api first
        try:
            transcript_list = fetch_subtitles_with_api(video_id)
            chosen_transcript = None
            
            if translate_source == "youtube":
                # Try Vietnamese first
                try:
                    chosen_transcript = transcript_list.find_transcript(['vi'])
                    logger.info("Found Vietnamese subs")
                except:
                    try:
                        chosen_transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB'])
                        logger.info("No VI subs, using EN + Google fallback")
                        use_translation = True
                    except:
                        chosen_transcript = next(iter(transcript_list))
                        use_translation = True
            else:
                # Get English for translation
                try:
                    chosen_transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB'])
                except:
                    chosen_transcript = next(iter(transcript_list))
            
            source_lang = chosen_transcript.language_code
            logger.info(f"Source lang: {source_lang}")
            
            data = chosen_transcript.fetch()
            
            for item in data:
                if hasattr(item, 'text'):
                    result.append({"start": item.start, "end": item.start + item.duration, "text": item.text})
                else:
                    result.append({"start": item['start'], "end": item['start'] + item['duration'], "text": item['text']})
                    
        except Exception as api_error:
            logger.warning(f"⚠️ youtube-transcript-api failed: {api_error}")
            
            # Try scraper fallback
            if SCRAPER_AVAILABLE:
                logger.info("🔄 Trying scraper fallback...")
                result = fetch_subtitles_with_scraper(video_id)
                if result:
                    logger.info(f"✅ Scraper returned {len(result)} subtitles")
                    # Check if Vietnamese or needs translation
                    use_translation = translate_source != "youtube"
                else:
                    raise Exception("Both API and scraper failed")
            else:
                raise api_error
        
        if not result:
            raise HTTPException(status_code=404, detail="No subtitles found")
        
        # Handle translation based on source
        if translate_source == "deep":
            logger.info("🔄 Deep Translating with Gemini...")
            deep_result = await deep_translate_with_gemini(result)
            if deep_result:
                return deep_result
            else:
                logger.warning("⚠️ Deep translate failed, using normal Gemini...")
                translate_source = "gemini"
        
        if translate_source == "gemini":
            logger.info("🤖 Translating with Gemini AI...")
            texts = [item['text'] for item in result]
            translated = await translate_with_gemini(texts)
            if translated:
                for i, t in enumerate(translated):
                    result[i]['text'] = t
                logger.info("✅ Gemini translation complete!")
            else:
                logger.warning("⚠️ Gemini failed, using Google...")
                translated = translate_with_google(texts)
                for i, t in enumerate(translated):
                    result[i]['text'] = t
        
        elif translate_source == "google" or use_translation:
            logger.info("📝 Translating with Google Translate...")
            texts = [item['text'] for item in result]
            translated = translate_with_google(texts)
            for i, t in enumerate(translated):
                result[i]['text'] = t
            
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/synthesize")
async def synthesize_batch(request: TTSRequest):
    voice_id = AVAILABLE_VOICES.get(request.voice, AVAILABLE_VOICES["female"])
    tts_engine = EdgeTTSEngine(voice=voice_id)
    
    logger.info(f"🎤 Synthesizing {len(request.subtitles)} items | Voice: {voice_id}")
    
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
            logger.error(f"TTS Error for {item.id}: {e}")
            return None

    tasks = [process_item(item) for item in request.subtitles]
    results = await asyncio.gather(*tasks)
    
    valid_results = [r for r in results if r is not None]
    logger.info(f"✅ Batch complete. Valid: {len(valid_results)}/{len(request.subtitles)}")
    return {"results": valid_results}


@app.post("/test-tts")
async def test_tts(request: SingleTTSRequest):
    """Test TTS engine with a single text"""
    voice_id = AVAILABLE_VOICES.get(request.voice, AVAILABLE_VOICES["female"])
    tts_engine = EdgeTTSEngine(voice=voice_id)
    
    try:
        audio_bytes = await tts_engine.generate_audio(
            text=request.text,
            start_time=0,
            end_time=5  # Default 5 sec
        )
        b64_audio = base64.b64encode(audio_bytes).decode('utf-8')
        return {
            "success": True,
            "audio_base64": b64_audio,
            "voice": voice_id,
            "text": request.text
        }
    except Exception as e:
        logger.error(f"Test TTS Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
    return {
        "status": "ok", 
        "gemini": GEMINI_AVAILABLE,
        "ffmpeg": FFMPEG_AVAILABLE,
        "scraper": SCRAPER_AVAILABLE,
        "voices": list(AVAILABLE_VOICES.keys())
    }


@app.get("/")
async def root():
    return {
        "name": "YouTube Dubbing API",
        "version": "1.2",
        "endpoints": [
            "/health - Health check",
            "/subtitles - Get/translate subtitles",
            "/synthesize - Batch TTS",
            "/test-tts - Test TTS with single text",
            "/voices - List available voices"
        ]
    }


if __name__ == "__main__":
    logger.info("🚀 Starting Dubbing API Server on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)