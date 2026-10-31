"""Best-effort local OCR of fresh, unread conversation summaries. No chat DB/API."""
import csv
import hashlib
import io
import os
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from PIL import Image, ImageOps


def ink_hash(image, threshold):
    mask = image.convert('L').point(lambda value: 255 if value < threshold else 0)
    bounds = mask.getbbox()
    if not bounds:
        return b''
    mask = mask.crop(bounds)
    return hashlib.sha256(str(mask.size).encode() + mask.tobytes()).digest()


def list_rows(image, profile):
    unit, client = profile['unit'], profile['client']
    w, h = round(image.width/unit), round(image.height/unit)
    if not 180 <= w <= 1000 or not 80 <= h <= 2400:
        return []
    logical = image.resize((w, h), Image.Resampling.BOX)
    left, right = (76, w-86) if client == 'qq' else (100, w-120)
    if right <= left+30:
        return []
    row_height = 80 if client == 'qq' else 114
    selected_rows = set()
    for y in range(h):
        r,g,b = logical.getpixel((4,y))
        if client == 'wechat' and g > 110 and g-r > 60 and g-b > 15:
            selected_rows.add(y)
            band = logical.crop((left,y,w,y+1)).getchannel('G').point(lambda value: 0 if value > 200 else 255).convert('RGB')
            logical.paste(band,(left,y))
        elif client == 'qq' and 175 <= min(r,g,b) <= max(r,g,b) <= 225 and max(r,g,b)-min(r,g,b) < 8:
            selected_rows.add(y)
    names = logical.crop((left, 0, right, h)).convert('L').point(lambda v: 255 if v < 100 else 0)
    projection = names.resize((1, h), Image.Resampling.BOX).tobytes()
    bands, first, last = [], None, None
    for y, ink in enumerate(projection + b'\0\0\0'):
        if ink > 3:
            if first is None: first = y
            last = y
        elif first is not None and y-last > 2:
            if first >= 3 and 4 <= last-first <= 34 and (not bands or first-bands[-1][0] > row_height*.55):
                bands.append((first, last+1))
            first = last = None
    rows = []
    for top, bottom in bands[:20]:
        end = min(h, top+(60 if client == 'qq' else 77))
        preview_right = w-(36 if client == 'qq' else 18)
        # The last visible row can contain a name without its message line.
        # Skip that partial row instead of invalidating the whole snapshot.
        if bottom+4 >= end:
            continue
        name = logical.crop((left, top-2, right, bottom+2))
        preview = logical.crop((left, bottom+4, preview_right, end))
        # Ignore flat row backgrounds, including selection and hover colours.
        background = logical.getpixel((4, min(h-1, bottom+10)))[0]
        if client == 'wechat' and top in selected_rows: background = 255
        threshold = min(200, background-25)
        key, fingerprint = ink_hash(name, 100), ink_hash(preview, threshold)
        badge = (w-29, max(0, top-12), w-4, min(h, top+58)) if client == 'qq' else (58, max(0, top-20), 96, min(h, top+12))
        colours = logical.crop(badge).convert('RGB').tobytes()
        red = sum(colours[i] > 210 and colours[i]-colours[i+1] > 100 and colours[i]-colours[i+2] > 100 for i in range(0,len(colours),3))
        if key and fingerprint:
            # OCR uses the original native pixels, not the logical hash sample.
            sx, sy = image.width/w, image.height/h
            crop = lambda rect: image.crop(tuple(round(v*(sx if i%2 == 0 else sy)) for i,v in enumerate(rect)))
            rows.append({'key':key, 'fingerprint':fingerprint, 'unread':red >= 6,'selected':top in selected_rows,
                         'name':crop((left,top-3,right,bottom+3)),
                         'preview':crop((left,bottom+4,preview_right,end)),
                         # A fixed-width crop can end halfway through a long
                         # name. Never present that fragment as the sender.
                         'name_truncated': logical.crop((right,top,w-18,bottom)).convert('L').getextrema()[0] < 100})
    return rows


def changed_unread(previous, rows):
    old = {row['key']:row['fingerprint'] for row in previous}
    candidates = [row for row in rows if (row['unread'] or row.get('selected')) and old.get(row['key']) != row['fingerprint']]
    # Never guess a sender when several conversations changed together.
    return candidates[0] if len(candidates) == 1 else None


def ocr_line(image, min_confidence=65, mode='7', trim=True, min_word_confidence=0):
    r,g,b = image.convert('RGB').getpixel((0,0))
    if g > 110 and g-r > 60 and g-b > 15:
        grey = image.convert('RGB').getchannel('G').point(lambda value: 0 if value > 200 else 255)
    else:
        grey = ImageOps.autocontrast(ImageOps.grayscale(image))
    bounds = grey.point(lambda value: 255 if value < 215 else 0).getbbox()
    if not bounds: return ''
    if trim: grey = grey.crop(bounds)
    if grey.height < 46:
        grey = grey.resize((grey.width*2, grey.height*2), Image.Resampling.LANCZOS)
    grey = ImageOps.expand(grey, border=12, fill=255)
    stream = io.BytesIO(); grey.save(stream, format='PNG')
    result = subprocess.run(['tesseract','stdin','stdout','-l','chi_sim+eng','--psm',mode,'tsv'],
        input=stream.getvalue(), capture_output=True, timeout=1.8,
        env=dict(os.environ, OMP_THREAD_LIMIT='1'))
    if result.returncode or len(result.stdout) > 65536:
        return ''
    words = []
    for row in csv.DictReader(io.StringIO(result.stdout.decode('utf-8', errors='replace')), delimiter='\t'):
        text = row.get('text','').strip()
        try: confidence = float(row.get('conf', '-1'))
        except ValueError: continue
        if text: words.append((text, confidence))
    if (not words or any(confidence < min_word_confidence for _, confidence in words)
            or sum(len(text)*confidence for text,confidence in words)/sum(len(text) for text,_ in words) < min_confidence):
        return ''
    text = ' '.join(word for word,_ in words)
    text = re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])', '', text)
    text = re.sub(r'\s*([：，。！？])\s*', r'\1', text).strip()
    punctuation = re.fullmatch(r'[,.!?，。！？…]{1,6}',text) and all(confidence >= 85 for _,confidence in words)
    return text[:300] if any(char.isalnum() for char in text) or punctuation else ''


def verified_line(image, name=False):
    """Accept screen text only when two segmentation modes agree confidently.

    This is still a list preview, not the underlying message. Ambiguous names,
    emoji and unreadable snippets must fall back to the ordinary notification.
    Never repair or infer words from context.
    """
    minimum = 88 if name else 82
    token_minimum = 70 if name else 65
    first = ocr_line(image, min_confidence=minimum, mode='7',
                     min_word_confidence=token_minimum)
    if not first:
        return ''
    second = ocr_line(image, min_confidence=minimum, mode='6',
                      min_word_confidence=token_minimum)
    # Spacing between OCR tokens is not semantic. All letters, numbers and
    # punctuation must otherwise match exactly, including case.
    if not second or re.sub(r'\s+', '', first) != re.sub(r'\s+', '', second):
        return ''
    return first


class MessagePreview:
    def __init__(self, snapshot, enabled, clock=time.monotonic, recognizer=None):
        self.snapshot, self.enabled, self.clock, self.recognizer = snapshot, enabled, clock, recognizer
        self.lock, self.resolve_lock = threading.Lock(), threading.Lock()
        self.history = deque(maxlen=6)
        self.state = 'waiting' if shutil.which('tesseract') else 'unavailable'
        self.cache = {}
        self.last_result = 'waiting'

    def capture(self, fresh=False):
        value = self.snapshot(fresh=fresh)
        if value is None:
            return None
        image, profile = value[:2]
        rows = list_rows(image, profile)
        return value[2] if len(value)>2 else self.clock(), profile, rows

    def poll(self):
        if not self.enabled():
            with self.lock: self.history.clear(); self.cache.clear()
            if hasattr(self.snapshot,'clear'): self.snapshot.clear()
            self.state = 'waiting'
            return
        value = self.capture()
        with self.lock:
            if value:
                stamp, profile, rows = value
                self.history.append((stamp, profile, [{k:row[k] for k in ('key','fingerprint','unread')} for row in rows]))
                self.state = 'ready' if len(self.history) >= 2 else 'waiting'
            else:
                self.history.clear(); self.state = 'waiting'

    def resolve(self, stamp):
        if not self.enabled() or not 0 <= self.clock()-stamp <= 5 or not self.resolve_lock.acquire(timeout=.2):
            self.last_result = 'expired-or-busy'
            return None
        try:
            with self.lock:
                if stamp in self.cache: return self.cache[stamp]
                before = [entry for entry in self.history if .6 <= stamp-entry[0] <= 3]
            current = self.capture(fresh=True)
            if not before or not current or before[-1][1] != current[1]:
                self.last_result = 'no-stable-list'
                return None
            row = changed_unread(before[-1][2], current[2])
            if not row or row.get('name_truncated'):
                self.last_result = 'no-unique-unread-change'
                return None
            if self.recognizer:
                title, body = self.recognizer(row['name']), self.recognizer(row['preview'])
            else:
                title = verified_line(row['name'], name=True)
                body = verified_line(row['preview']) if title else ''
            check = self.capture(fresh=True)
            stable = check and check[1] == current[1] and any(
                item['key'] == row['key'] and item['fingerprint'] == row['fingerprint'] and (item['unread'] or item.get('selected')) for item in check[2])
            # A partial OCR result is not a verified notification. Do not publish
            # a guessed sender when the message itself could not be read.
            result = (title[:100], body) if title and body and stable and self.enabled() else None
            self.last_result = 'read' if result else 'unrecognised-or-changed'
            with self.lock:
                self.cache[stamp] = result
                while len(self.cache) > 8: self.cache.pop(next(iter(self.cache)))
            return result
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self.last_result = 'recognition-unavailable'
            return None
        finally:
            self.resolve_lock.release()

    def run(self):
        while True:
            try: self.poll()
            except Exception:
                with self.lock: self.history.clear()
                self.state = 'waiting'
            time.sleep(1)

    def start(self):
        if self.state != 'unavailable': threading.Thread(target=self.run, daemon=True).start()
