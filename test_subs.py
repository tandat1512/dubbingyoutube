from youtube_transcript_api import YouTubeTranscriptApi
import sys

print("--- TESTING INSTANCE-BASED API (v1.2.3) ---")

video_input = input("Enter YouTube Video ID (or URL): ").strip()

if "v=" in video_input:
    video_id = video_input.split("v=")[1].split("&")[0]
elif "youtu.be/" in video_input:
    video_id = video_input.split("youtu.be/")[1].split("?")[0]
else:
    video_id = video_input

print(f"Target ID: {video_id}")

try:
    yt = YouTubeTranscriptApi()
    
    # 1. List transcripts to debug languages
    print("Listing transcripts...")
    transcripts = yt.list(video_id)
    for t in transcripts:
        print(f" - {t}")

    # 2. Try fetching Vietnamese
    print(f"\nAttempting to fetch 'vi' transcript...")
    # Based on common patterns for this library variant (which might be a wrapper or fork):
    # Try passing language to fetch if possible, or filter the list.
    # Looking at step 266 output, 't' in list was a string representation probably.
    # Let's try to see if 'transcripts' is a list of objects with .fetch()?
    
    # Logic: usually yt.get_transcript(id, languages=[...])
    # Here: yt.fetch(id) worked. Maybe yt.fetch(id, languages=['vi'])?
    
    try:
        data = yt.fetch(video_id, languages=['vi', 'en'])
        print(f"Success! Found {len(data)} lines.")
        print(data[:3])
    except TypeError:
        # Fallback if keyword arg is wrong
        print("Fetch with languages kwarg failed. Fetching default...")
        data = yt.fetch(video_id)
        print(f"Success (Default)! Found {len(data)} lines.")
        print(data[:3])

except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()

input("\nPress Enter to exit...")
