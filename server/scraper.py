import requests
import re
import json
import html

def get_transcript_custom(video_id):
    print(f"--- SCRAPER MODULE (HEADERS FIXED) for {video_id} ---")
    url = f"https://www.youtube.com/watch?v={video_id}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }
    
    print(f"Scraping video page: {url}")
    session = requests.Session()
    session.headers.update(headers)
    
    resp = session.get(url)
    resp.raise_for_status()
    page_html = resp.text
    
    match = re.search(r'"captionTracks":\s*(\[.*?\])', page_html)
    if not match:
        raise Exception("Could not find 'captionTracks'.")
        
    try:
        tracks = json.loads(match.group(1))
        print(f"Found {len(tracks)} tracks.")
        
        selected_track = next((t for t in tracks if t['languageCode'] == 'vi'), None)
        if not selected_track:
            selected_track = next((t for t in tracks if t['languageCode'] == 'en'), None)
        if not selected_track:
            selected_track = tracks[0]
            
        print(f"Selected track: {selected_track['name']['simpleText']} ({selected_track['languageCode']})")

        def parse_xml(xml_text):
            print("Parsing XML...")
            local_transcript = []
            matches = re.findall(r'<text start="([\d\.]+)" dur="([\d\.]+)"[^>]*>(.*?)</text>', xml_text)
            for start, dur, content in matches:
                local_transcript.append({
                    "start": float(start),
                    "end": float(start) + float(dur),
                    "text": html.unescape(content)
                })
            return local_transcript

        # Attempt 1: JSON3
        sub_url_json = selected_track['baseUrl'] + "&fmt=json3"
        print(f"Attempt 1 (JSON): {sub_url_json}")
        try:
            r = session.get(sub_url_json)
            print(f"JSON Status: {r.status_code}, Length: {len(r.content)}")
            
            if r.status_code == 200 and r.content:
                try:
                    sub_data = r.json()
                    events = sub_data.get('events', [])
                    transcript = []
                    for ev in events:
                        if 'segs' not in ev: continue
                        text = "".join([s.get('utf8', '') for s in ev['segs']]).replace('\n', ' ')
                        if not text.strip(): continue
                        start = float(ev.get('tStartMs', 0)) / 1000.0
                        duration = float(ev.get('dDurationMs', 0)) / 1000.0
                        transcript.append({
                            "start": start,
                            "end": start + duration,
                            "text": html.unescape(text)
                        })
                    if transcript:
                        return transcript
                except ValueError:
                    print("JSON decode failed, trying XML fallback")
        except Exception as e:
            print(f"JSON fetch error: {e}")
            
        # Attempt 2: XML (Default)
        sub_url_xml = selected_track['baseUrl']
        print(f"Attempt 2 (XML): {sub_url_xml}")
        # IMPORTANT: Use session with headers!
        r = session.get(sub_url_xml)
        
        print(f"XML Status: {r.status_code}, Length: {len(r.content)}")
        # print(f"XML Preview: {r.text[:200]}")

        if r.status_code == 200 and r.content:
            return parse_xml(r.text)
            
        raise Exception(f"Failed to fetch transcript. Status: {r.status_code}")

    except Exception as e:
        print(f"Parsing error: {e}")
        raise e
