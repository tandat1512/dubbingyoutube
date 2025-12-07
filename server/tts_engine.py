import asyncio
import io
import math
import subprocess
import os
import tempfile
import edge_tts

class EdgeTTSEngine:
    def __init__(self, voice: str = "vi-VN-HoaiMyNeural"):
        self.voice = voice
        print(f"🎤 TTS Engine initialized with voice: {self.voice}")

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
        
        # Use temp file for ffmpeg processing
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp.write(original_audio)
            tmp_path = tmp.name

        try:
            # Measure duration using ffprobe
            duration_audio = self._get_duration(tmp_path)

            # 2. Dynamic Rate Logic
            if duration_audio > duration_srt:
                # Case A: Speed up
                ratio = duration_audio / duration_srt
                safe_ratio = ratio * 1.10
                percentage = int((safe_ratio - 1) * 100)
                rate_str = f"+{percentage}%"
                
                # Re-synthesize
                final_audio = await self._synthesize(text, rate=rate_str)
                return final_audio

            else:
                # Case B: Add Silence
                # Use ffmpeg apad to pad to specific duration
                # apad=whole_dur=DURATION
                output_path = tmp_path.replace(".mp3", "_padded.mp3")
                
                # ffmpeg requires duration in seconds
                cmd = [
                    "ffmpeg", "-y", "-i", tmp_path,
                    "-af", f"apad=whole_dur={duration_srt}",
                    "-f", "mp3", output_path
                ]
                
                # Suppress output
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                
                with open(output_path, "rb") as f:
                    final_audio = f.read()
                
                # Cleanup output
                if os.path.exists(output_path):
                    os.remove(output_path)
                    
                return final_audio

        except Exception as e:
            print(f"Error in TTS processing: {e}")
            return original_audio
            
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    async def _synthesize(self, text: str, rate: str) -> bytes:
        communicate = edge_tts.Communicate(text, self.voice, rate=rate)
        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]
        return audio_data

    def _get_duration(self, file_path: str) -> float:
        try:
            cmd = [
                "ffprobe", "-v", "error", 
                "-show_entries", "format=duration", 
                "-of", "default=noprint_wrappers=1:nokey=1", 
                file_path
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            return float(result.stdout.strip())
        except Exception:
            return 0.0
