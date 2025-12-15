import asyncio
import io
import math
import subprocess
import os
import tempfile
import hashlib
import logging
import edge_tts

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Simple in-memory cache for generated audio
_audio_cache = {}
MAX_CACHE_SIZE = 100


class EdgeTTSEngine:
    def __init__(self, voice: str = "vi-VN-HoaiMyNeural"):
        self.voice = voice
        logger.info(f"🎤 TTS Engine initialized with voice: {self.voice}")

    def _get_cache_key(self, text: str, rate: str) -> str:
        """Generate cache key for audio"""
        return hashlib.md5(f"{self.voice}:{rate}:{text}".encode()).hexdigest()

    async def generate_audio(self, text: str, start_time: float, end_time: float) -> bytes:
        """
        Generates audio for the given text, fitting it within (end_time - start_time).
        Returns raw MP3 bytes.
        """
        duration_srt = end_time - start_time
        if duration_srt <= 0:
            return await self._synthesize(text, rate="+0%")

        # 1. Generate temp audio
        original_audio = await self._synthesize(text, rate="+0%")
        
        if not original_audio:
            logger.error(f"Failed to synthesize audio for: {text[:30]}...")
            return b""
        
        # Use temp file for ffmpeg processing
        tmp_path = None
        output_path = None
        
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                tmp.write(original_audio)
                tmp_path = tmp.name

            # Measure duration using ffprobe
            duration_audio = self._get_duration(tmp_path)
            
            if duration_audio <= 0:
                logger.warning("Could not measure audio duration, returning original")
                return original_audio

            # 2. Dynamic Rate Logic
            if duration_audio > duration_srt:
                # Case A: Speed up - audio is longer than allowed time
                ratio = duration_audio / duration_srt
                # Add 10% buffer for safety
                safe_ratio = min(ratio * 1.10, 2.0)  # Cap at 2x speed
                percentage = int((safe_ratio - 1) * 100)
                rate_str = f"+{percentage}%"
                
                logger.debug(f"Speeding up: {duration_audio:.2f}s -> {duration_srt:.2f}s (rate: {rate_str})")
                
                # Re-synthesize with faster rate
                final_audio = await self._synthesize(text, rate=rate_str)
                return final_audio if final_audio else original_audio

            else:
                # Case B: Audio is shorter than slot - add silence padding
                output_path = tmp_path.replace(".mp3", "_padded.mp3")
                
                cmd = [
                    "ffmpeg", "-y", "-i", tmp_path,
                    "-af", f"apad=whole_dur={duration_srt}",
                    "-f", "mp3", output_path
                ]
                
                result = subprocess.run(
                    cmd, 
                    stdout=subprocess.DEVNULL, 
                    stderr=subprocess.PIPE, 
                    timeout=30
                )
                
                if result.returncode != 0:
                    logger.warning(f"FFmpeg padding failed: {result.stderr.decode()[:100]}")
                    return original_audio
                
                with open(output_path, "rb") as f:
                    final_audio = f.read()
                    
                return final_audio

        except subprocess.TimeoutExpired:
            logger.error("FFmpeg timeout")
            return original_audio
        except FileNotFoundError:
            logger.error("FFmpeg not found - install FFmpeg and add to PATH")
            return original_audio
        except Exception as e:
            logger.error(f"Error in TTS processing: {e}")
            return original_audio
            
        finally:
            # Cleanup temp files
            for path in [tmp_path, output_path]:
                if path and os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception:
                        pass

    async def _synthesize(self, text: str, rate: str) -> bytes:
        """Synthesize text to audio using Edge TTS"""
        # Check cache first
        cache_key = self._get_cache_key(text, rate)
        if cache_key in _audio_cache:
            logger.debug(f"Cache hit for: {text[:20]}...")
            return _audio_cache[cache_key]
        
        try:
            communicate = edge_tts.Communicate(text, self.voice, rate=rate)
            audio_data = b""
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_data += chunk["data"]
            
            # Cache the result (with size limit)
            if len(_audio_cache) >= MAX_CACHE_SIZE:
                # Remove oldest entry
                oldest_key = next(iter(_audio_cache))
                del _audio_cache[oldest_key]
            _audio_cache[cache_key] = audio_data
            
            return audio_data
            
        except Exception as e:
            logger.error(f"Edge TTS error: {e}")
            return b""

    def _get_duration(self, file_path: str) -> float:
        """Get audio duration in seconds using ffprobe"""
        try:
            cmd = [
                "ffprobe", "-v", "error", 
                "-show_entries", "format=duration", 
                "-of", "default=noprint_wrappers=1:nokey=1", 
                file_path
            ]
            result = subprocess.run(
                cmd, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE, 
                text=True,
                timeout=10
            )
            if result.returncode == 0 and result.stdout.strip():
                return float(result.stdout.strip())
            return 0.0
        except subprocess.TimeoutExpired:
            logger.warning("ffprobe timeout")
            return 0.0
        except Exception as e:
            logger.warning(f"ffprobe error: {e}")
            return 0.0


def clear_audio_cache():
    """Clear the audio cache"""
    global _audio_cache
    _audio_cache.clear()
    logger.info("Audio cache cleared")
