import socket
import sys
import json, os, subprocess, threading, time, secrets, hmac, hashlib, re, ctypes, shutil, struct, zlib, io, base64
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, parse_qs
from http.cookies import SimpleCookie
from collections import deque, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image
from client_adapter import get_client

client = get_client()
QQ_SCALE = int(os.environ.get('QQ_UI_SCALE', '1'))
if QQ_SCALE not in (1, 2, 3):
    raise ValueError('QQ_UI_SCALE must be 1, 2 or 3')
SESSION_COOKIE = '__Host-nas_' + client.key

os.environ.setdefault('DISPLAY', ':1')
os.environ['HOME'] = '/config'
ROOT = Path('/config/mobile')
if os.environ.get('NAS_CHAT_BUNDLED_DEPS') != '1':
    sys.path.insert(0, str(ROOT / 'push-deps'))
from push_service import PushService
push_service = PushService(ROOT)
UPLOADS = ROOT / 'uploads'
lock = threading.Lock()
keyfile = ROOT / 'session.key'
if not keyfile.exists():
    keyfile.write_bytes(secrets.token_bytes(32))
    keyfile.chmod(0o600)
session_key = keyfile.read_bytes()
failed_logins = defaultdict(deque)
SESSION_SECONDS = 30 * 86400
MAX_UPLOAD = 95 * 1024 * 1024
send_results = {}
send_cache = ROOT / 'send-results.json'
try:
    cached = json.loads(send_cache.read_text())
    for key, value in cached.items():
        if isinstance(value, list) and len(value) == 3 and value[1] in ('done', 'uncertain') and 0 <= time.monotonic() - value[0] < 600:
            send_results[key] = tuple(value)
except (OSError, ValueError, TypeError, AttributeError):
    pass


def save_send_results():
    temporary = send_cache.with_suffix('.tmp')
    temporary.write_text(json.dumps(send_results))
    temporary.chmod(0o600); temporary.replace(send_cache)


# ---- X11 access through Xlib, without spawning a process per window ----
_x = ctypes.CDLL('libX11.so.6')
_ul, _vp, _int = ctypes.c_ulong, ctypes.c_void_p, ctypes.c_int


class _Attrs(ctypes.Structure):
    _fields_ = [('x', _int), ('y', _int), ('width', _int), ('height', _int), ('border_width', _int), ('depth', _int),
                ('visual', _vp), ('root', _ul), ('class_', _int), ('bit_gravity', _int), ('win_gravity', _int),
                ('backing_store', _int), ('backing_planes', _ul), ('backing_pixel', _ul), ('save_under', _int),
                ('colormap', _ul), ('map_installed', _int), ('map_state', _int), ('all_event_masks', ctypes.c_long),
                ('your_event_mask', ctypes.c_long), ('do_not_propagate_mask', ctypes.c_long),
                ('override_redirect', _int), ('screen', _vp)]


class _XImage(ctypes.Structure):
    _fields_ = [('width', _int), ('height', _int), ('xoffset', _int), ('format', _int), ('data', _vp),
                ('byte_order', _int), ('bitmap_unit', _int), ('bitmap_bit_order', _int), ('bitmap_pad', _int),
                ('depth', _int), ('bytes_per_line', _int), ('bits_per_pixel', _int)]


class _ClientMessage(ctypes.Structure):
    _fields_ = [('type', _int), ('serial', _ul), ('send_event', _int), ('display', _vp), ('window', _ul),
                ('message_type', _ul), ('format', _int), ('data', ctypes.c_long * 5), ('pad', ctypes.c_long * 12)]


_x.XOpenDisplay.argtypes = [ctypes.c_char_p]; _x.XOpenDisplay.restype = _vp
_x.XCloseDisplay.argtypes = [_vp]
_x.XDefaultRootWindow.argtypes = [_vp]; _x.XDefaultRootWindow.restype = _ul
_x.XDisplayWidth.argtypes = _x.XDisplayHeight.argtypes = [_vp, _int]
_x.XQueryTree.argtypes = [_vp, _ul, ctypes.POINTER(_ul), ctypes.POINTER(_ul), ctypes.POINTER(ctypes.POINTER(_ul)), ctypes.POINTER(ctypes.c_uint)]
_x.XGetWindowAttributes.argtypes = [_vp, _ul, ctypes.POINTER(_Attrs)]
_x.XInternAtom.argtypes = [_vp, ctypes.c_char_p, _int]; _x.XInternAtom.restype = _ul
_x.XGetAtomName.argtypes = [_vp, _ul]; _x.XGetAtomName.restype = _vp
_x.XGetWindowProperty.argtypes = [_vp, _ul, _ul, ctypes.c_long, ctypes.c_long, _int, _ul, ctypes.POINTER(_ul),
                                  ctypes.POINTER(_int), ctypes.POINTER(_ul), ctypes.POINTER(_ul), ctypes.POINTER(_vp)]
_x.XTranslateCoordinates.argtypes = [_vp, _ul, _ul, _int, _int, ctypes.POINTER(_int), ctypes.POINTER(_int), ctypes.POINTER(_ul)]
_x.XGetImage.argtypes = [_vp, _ul, _int, _int, ctypes.c_uint, ctypes.c_uint, _ul, _int]; _x.XGetImage.restype = ctypes.POINTER(_XImage)
_x.XDestroyImage.argtypes = [ctypes.POINTER(_XImage)]
_x.XSendEvent.argtypes = [_vp, _ul, _int, ctypes.c_long, ctypes.POINTER(_ClientMessage)]
_x.XFlush.argtypes = [_vp]
_x.XFree.argtypes = [_vp]
_x.XSetErrorHandler.argtypes = [_vp]
_ignore_errors = ctypes.CFUNCTYPE(_int, _vp, _vp)(lambda display, event: 0)  # windows can vanish between calls
_x.XSetErrorHandler(ctypes.cast(_ignore_errors, _vp))
x_lock = threading.Lock()
IGNORED_TYPES = {'DESKTOP', 'DOCK', 'TOOLTIP', 'NOTIFICATION', 'DND'}


class X:
    def __enter__(self):
        x_lock.acquire()
        self.d = _x.XOpenDisplay(os.environ['DISPLAY'].encode())
        if not self.d:
            x_lock.release()
            raise ValueError('Display unavailable')
        self.root = _x.XDefaultRootWindow(self.d)
        self.width, self.height = _x.XDisplayWidth(self.d, 0), _x.XDisplayHeight(self.d, 0)
        self.atoms = {}
        return self

    def __exit__(self, *args):
        _x.XCloseDisplay(self.d)
        x_lock.release()

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = _x.XInternAtom(self.d, name.encode(), 0)
        return self.atoms[name]

    def atom_name(self, value):
        pointer = _x.XGetAtomName(self.d, value)
        if not pointer:
            return ''
        try:
            return ctypes.string_at(pointer).decode()
        finally:
            _x.XFree(pointer)

    def prop(self, wid, name):
        kind, form, count, rest, data = _ul(), _int(), _ul(), _ul(), _vp()
        if _x.XGetWindowProperty(self.d, wid, self.atom(name), 0, 4096, 0, 0, ctypes.byref(kind), ctypes.byref(form),
                                 ctypes.byref(count), ctypes.byref(rest), ctypes.byref(data)) != 0 or not data.value:
            return None
        try:
            if form.value == 8:
                return ctypes.string_at(data.value, count.value)
            if form.value == 32:
                return list((_ul * count.value).from_address(data.value))
            return None
        finally:
            _x.XFree(data)

    def children(self, wid):
        root, parent, children, count = _ul(), _ul(), ctypes.POINTER(_ul)(), ctypes.c_uint()
        if not _x.XQueryTree(self.d, wid, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
            return []
        try:
            return [children[i] for i in range(count.value)]
        finally:
            if count.value:
                _x.XFree(children)

    def attrs(self, wid):
        value = _Attrs()
        return value if _x.XGetWindowAttributes(self.d, wid, ctypes.byref(value)) else None

    def origin(self, wid):
        x, y, child = _int(), _int(), _ul()
        _x.XTranslateCoordinates(self.d, wid, self.root, 0, 0, ctypes.byref(x), ctypes.byref(y), ctypes.byref(child))
        return x.value, y.value

    def client(self, wid, depth=0):
        if self.prop(wid, 'WM_STATE') is not None:
            return wid
        if depth > 2:
            return None
        for child in self.children(wid):
            found = self.client(child, depth + 1)
            if found:
                return found
        return None

    def name(self, wid):
        value = self.prop(wid, '_NET_WM_NAME') or self.prop(wid, 'WM_NAME') or b''
        try:
            return value.decode()
        except UnicodeDecodeError:
            return value.decode('gb18030', 'replace')

    def windows(self):
        """Mapped top-level windows from bottom to top, with the managed client resolved."""
        result = []
        for top in self.children(self.root):
            outer = self.attrs(top)
            if not outer or outer.map_state != 2 or outer.width < 4 or outer.height < 4:
                continue
            client = self.client(top) or top
            inner = self.attrs(client) or outer
            x, y = self.origin(client)
            wm_class = (self.prop(client, 'WM_CLASS') or b'').split(b'\0')
            types = {self.atom_name(v).replace('_NET_WM_WINDOW_TYPE_', '') for v in (self.prop(client, '_NET_WM_WINDOW_TYPE') or [])}
            result.append({'id': str(client), 'x': x, 'y': y, 'width': inner.width, 'height': inner.height,
                           'name': self.name(client), 'class': wm_class[1].decode(errors='replace') if len(wm_class) > 1 else '',
                           'types': types, 'override': bool(outer.override_redirect)})
        return result

    def raw(self, x, y, width, height):
        """Screen pixels as BGRX bytes with their row stride."""
        x, y = max(0, int(x)), max(0, int(y))
        width, height = int(min(width, self.width - x)), int(min(height, self.height - y))
        if width <= 0 or height <= 0:
            raise ValueError('Empty region')
        image = _x.XGetImage(self.d, self.root, x, y, width, height, ctypes.c_ulong(-1).value, 2)
        if not image:
            raise ValueError('Image unavailable')
        try:
            value = image.contents
            return ctypes.string_at(value.data, value.bytes_per_line * value.height), value.width, value.height, value.bytes_per_line
        finally:
            _x.XDestroyImage(image)

    def grab(self, x, y, width, height):
        data, width, height, stride = self.raw(x, y, width, height)
        return Image.frombuffer('RGB', (width, height), data, 'raw', 'BGRX', stride, 1).copy()

    def close(self, wid):
        event = _ClientMessage(type=33, send_event=1, display=self.d, window=int(wid),
                               message_type=self.atom('WM_PROTOCOLS'), format=32)
        event.data[0] = self.atom('WM_DELETE_WINDOW')
        _x.XSendEvent(self.d, int(wid), 0, 0, ctypes.byref(event))
        _x.XFlush(self.d)

    def unmaximize(self, wid):
        # A saved maximized state makes xdotool windowsize silently ineffective.
        event = _ClientMessage(type=33, send_event=1, display=self.d, window=int(wid),
                               message_type=self.atom('_NET_WM_STATE'), format=32)
        event.data[0] = 0
        event.data[1] = self.atom('_NET_WM_STATE_MAXIMIZED_VERT')
        event.data[2] = self.atom('_NET_WM_STATE_MAXIMIZED_HORZ')
        event.data[3] = 1
        _x.XSendEvent(self.d, self.root, 0, (1 << 20) | (1 << 19), ctypes.byref(event))
        _x.XFlush(self.d)


def popup_kind(window):
    if window['override']:
        return 'menu'
    return 'dialog' if 'DIALOG' in window['types'] else 'window'


def summary(window):
    return {key: window[key] for key in ('id', 'x', 'y', 'width', 'height', 'name')} | {'kind': popup_kind(window)}


# ---- Conversation recognition from a few pixels; message text is never extracted ----
navigation = {'identity': None, 'revision': 0, 'list': True, 'search': None}
known_titles = deque(maxlen=60)
qq_geometry_cache = {}


def title_identity(thumb):
    # Rendering noise must not split one chat into many identities.
    # Short names cover few cells, so any clearly different cell means a different chat.
    for key, previous in known_titles:
        if len(previous) == len(thumb) and sum(abs(a - b) > 28 for a, b in zip(previous, thumb)) <= 2:
            return key
    key = hashlib.sha256(thumb).hexdigest()[:32]
    known_titles.append((key, thumb))
    return key


def inspect_main(x, box, covered):
    if covered and navigation['identity']:
        # A menu or window covers the chat; keep the last known state instead of misreading it.
        is_list, identity = navigation['list'], navigation['identity']
    else:
        column = x.grab(box['x'] + 110, box['y'] + 180, 1, min(300, box['height'] - 181)).convert('L')
        values = sorted(column.getpixel((0, y)) for y in range(0, column.height, 25))
        # Lists and other list-like pages are grey beside the navigation bar; chats are white.
        is_list = values[len(values) // 2] < 245
        if is_list:
            identity = 'list'
        else:
            title = x.grab(box['x'] + 180, box['y'] + 65, max(40, box['width'] - 310), 65).convert('L')
            identity = title_identity(title.resize((max(8, title.width // 6), 8), Image.BOX).tobytes())
    if identity != navigation['identity']:
        navigation.update(identity=identity, revision=navigation['revision'] + 1)
    navigation['list'] = is_list
    return is_list, str(navigation['revision']) + ':' + identity


split_cache = {}


def detect_split(x, box):
    key = (box['id'], box['width'], box['height'])
    cached = split_cache.get(key)
    if cached and time.monotonic() - cached[0] < (15 if cached[1] else .5):
        return cached[1]
    result, best, rows = None, 6, []
    for ratio in (.30, .50, .65):
        row = x.grab(box['x'], box['y'] + int(box['height'] * ratio), box['width'], 1).convert('L')
        rows.append([row.getpixel((i, 0)) for i in range(row.width)])
    for i in range(max(80, int(box['width'] * .1)), int(box['width'] * .82)):
        contrast = min(sum(row[i + 2:i + 10]) / 8 - sum(row[i - 10:i - 2]) / 8 for row in rows)
        if contrast > best and all(sum(row[i + 2:i + 10]) / 8 > 238 for row in rows):
            best, result = contrast, i
    split_cache.clear(); split_cache[key] = (time.monotonic(), result)
    return result


def qq_profile(display, box):
    """Find the QQ column/editor separators, rather than reusing WeChat points."""
    scale = QQ_SCALE
    if box['width'] < 820*scale or box['height'] < 580*scale:
        return None
    if (box['x'] < 0 or box['y'] < 0 or box['x']+box['width'] > box.get('screenWidth',float('inf'))
            or box['y']+box['height'] > box.get('screenHeight',float('inf'))):
        return None
    key = (box['id'], box['x'], box['y'], box['width'], box['height'])
    cached = qq_geometry_cache.get(key)
    if cached and time.monotonic() - cached[0] < 2:
        return cached[1]
    left, right = 200*scale, min(520*scale, box['width'] - 360*scale)
    rows = [display.grab(box['x'] + left, box['y'] + y, right-left, 1).convert('L').tobytes()
            for y in (80*scale, box['height']-120*scale)]
    split, best = None, 4
    for column in range(5, right-left-5):
        contrast = min(min(sum(row[column-5:column-1])/4,
                           sum(row[column+2:column+6])/4)-row[column] for row in rows)
        if contrast > best:
            split, best = left+column, contrast
    result = None
    if split is not None:
        # Group chats keep a member/announcement column beside both the history
        # and editor. Find its divider in the otherwise blank editor rows. A
        # bubble or a member name cannot form the same line in all three rows.
        content_right = box['width']
        sidebar_left = max(split+300*scale, box['width']-280*scale)
        sidebar_right = box['width']-120*scale
        if sidebar_right > sidebar_left+12*scale:
            samples = [display.grab(box['x']+sidebar_left,box['y']+box['height']-y*scale,
                                    sidebar_right-sidebar_left,1).convert('L').tobytes()
                       for y in (80,130,180)]
            divider, contrast = None, 4
            for column in range(5,sidebar_right-sidebar_left-5):
                score = min(min(sum(row[column-5:column-1])/4,
                                sum(row[column+2:column+6])/4)-row[column] for row in samples)
                if score > contrast:
                    divider,contrast = sidebar_left+column,score
            if divider is not None:
                # Verify a full-height sidebar, not a coincident editor icon.
                column = display.grab(box['x']+divider,box['y']+100*scale,1,
                                      box['height']-110*scale).convert('L').tobytes()
                if sum(220 <= value <= 240 for value in column) > len(column)*.95:
                    content_right = divider
        # A newly logged-in QQ has a conversation column but no selected chat,
        # so there is no editor/send button yet. The list must work on its own.
        result = {'list': {'x':box['x']+60*scale,'y':box['y']+40*scale,'width':split-60*scale,'height':box['height']-44*scale,'header':52*scale},
                  'chat': {'x':box['x']+split+2*scale,'y':box['y']+40*scale,'width':content_right-split-6*scale,
                           'height':box['height']-44*scale,'header':56*scale,
                           'headerWidth':450*scale,'headerRight':190*scale if content_right==box['width'] else 0,'fillViewport':True},
                  'sidebarWidth':box['width']-content_right,
                  'editorReady':False,
                  'titleRect':[box['x']+split+18*scale,box['y']+50*scale,min(300*scale,box['width']-split-250*scale),34*scale]}
        start = max(120*scale, box['height']-600*scale)
        width = content_right-split-24*scale
        image = display.grab(box['x']+split+12*scale, box['y']+start, width, box['height']-80*scale-start).convert('L')
        # A divider spans the editor width; message bubbles and toolbar icons do not.
        means = image.resize((1,image.height),Image.BOX).tobytes()
        distance = 2*scale
        candidates = []
        for y in range(distance,image.height-distance):
            # Messages may touch the divider from above. Only the blank editor
            # below it is a stable brightness reference.
            if means[y+distance]-means[y] > 4:
                low,high = image.crop((0,y,width,y+1)).getextrema()
                if high-low < 10:
                    candidates.append(y)
        button = display.grab(box['x']+content_right-64*scale,box['y']+box['height']-32*scale,1,1).getpixel((0,0))
        if candidates and button[2] > 200 and button[1] > 100 and button[2]-button[0] > 25 and button[1]-button[0] > 15:
            editor = start+min(candidates, key=lambda y: abs(start+y-(box['height']-211*scale)))
            if editor <= box['height']-140*scale:
                result['chat']['height'] = editor-40*scale
                result.update(editorReady=True,
                              inputPoint=[box['x']+split+(content_right-split)//2, box['y']+editor+80*scale],
                              sendPoint=[box['x']+content_right-64*scale,box['y']+box['height']-32*scale])
    qq_geometry_cache.clear()
    qq_geometry_cache[key] = (time.monotonic(), result)
    return result


def inspect_qq(display, box, covered):
    if not covered:
        title = display.grab(*box['titleRect']).convert('L')
        thumb = title.resize((max(8,title.width//6),8),Image.BOX).tobytes()
        identity = title_identity(thumb) if max(thumb)-min(thumb) > 40 else None
        if identity != navigation['identity']:
            navigation.update(identity=identity,revision=navigation['revision']+1)
    is_list = navigation['list'] or not navigation['identity']
    return is_list, str(navigation['revision'])+':'+('list' if is_list else navigation['identity'])


def qq_selected_row(display, current, y):
    """Recognize QQ's selected row, excluding the lighter hover background."""
    region = pane_region(current, 'list')
    scale = current.get('uiScale',1)
    colors = [display.grab(x,y-scale,2*scale,2*scale).resize((1,1),Image.BOX).getpixel((0,0))
              for x in (region['x']+4*scale,region['x']+region['width']-10*scale)]
    return (all(175 <= min(color) <= max(color) <= 225 and max(color)-min(color) < 6 for color in colors)
            and max(abs(a-b) for a,b in zip(*colors)) < 10)


def qq_search_active(display, current):
    """Recover unknown search state after a service restart without reading text."""
    region = pane_region(current,'list')
    scale = current.get('uiScale',1)
    width = region['width']-95*scale
    if width <= 0:
        return True
    # The empty search placeholder and magnifier are grey. Typed queries are
    # dark; exclude the plus/clear controls at the right of the field.
    pixels = display.grab(region['x']+40*scale,region['y']+12*scale,
                          width,28*scale).convert('L').tobytes()
    return sum(value < 100 for value in pixels) > 2*scale*scale


def pane_region(current, view=None):
    view = view or ('list' if current['compactList'] else 'chat')
    if current.get('panes'):
        return current['panes'][view]
    split = current['split'] or 104
    return {'x':current['x']+split+2,'y':current['y']+48,'width':current['width']-split-2,
            'height':current['height']-48-(4 if view=='list' else 258),'header':90}


def send_point(current):
    return current.get('sendPoint') or [current['x']+current['width']-65,current['y']+current['height']-58]


def layout():
    with X() as x:
        windows = [w for w in x.windows() if w['class'] != 'Selkies-desktop' and not (w['types'] & IGNORED_TYPES)]
        main = [w for w in windows if client.matches(w)]
        if not main:
            raise ValueError(client.label + ' window unavailable')
        selected = max(main, key=lambda w: w['width'] * w['height'])
        index = windows.index(selected)
        useful = lambda w: w['width'] >= 40 and w['height'] >= 24
        # Corner notifications do not cover the chat; menus, dialogs and viewers do.
        covers = lambda w: (w['x'] < selected['x'] + selected['width'] and selected['x'] < w['x'] + w['width']
                            and w['y'] < selected['y'] + selected['height'] and selected['y'] < w['y'] + w['height']) or w['width'] * w['height'] >= 200 * 200
        popups = [summary(w) for w in reversed(windows[index + 1:]) if useful(w) and covers(w)]
        behind = [summary(w) for w in reversed(windows[:index]) if useful(w) and not w['override']]
        box = {key: selected[key] for key in ('x', 'y', 'width', 'height', 'id')}
        box.update(mainWindow=True, screenWidth=x.width, screenHeight=x.height, popups=popups, windows=behind)
        box.update(client=client.key, clientLabel=client.label)
        box['chatReady'] = client.phone_layout and box['width'] > 500 and box['height'] > 600
        box['setupRequired'] = not client.phone_layout and box['width'] > 600
        box['compact'] = box['chatReady'] and box['width'] < 1000
        box['compactList'], box['conversation'], box['split'] = False, None, None
        if client.key == 'qq':
            profile = qq_profile(x, box)
            if profile:
                box.update(panes={key:profile[key] for key in ('list','chat')},
                           **{key:profile.get(key) for key in ('inputPoint','sendPoint','titleRect','editorReady')})
                box.update(chatReady=True,setupRequired=False,compact=True,uiScale=QQ_SCALE,
                           selectFromY=profile['list']['y']+profile['list']['header'],
                           split=profile['chat']['x']-box['x']-2*QQ_SCALE)
                box['compactList'],box['conversation'] = inspect_qq(x,box,bool(popups))
                # QQ's empty landing page does not reflow its column correctly
                # until a chat is selected. Keep that first list at its saved
                # size; fit the real chat before returning the navigation reply.
                # A slightly wider column reduces the phone UI scale. The tall
                # QQ desktop leaves history outside the local viewport so a
                # drag can use cached pixels while remote scrolling catches up.
                box['preferredWidth'] = 1250*QQ_SCALE+profile['sidebarWidth'] if profile['editorReady'] else box['width']
        elif box['compact']:
            box['compactList'], box['conversation'] = inspect_main(x, box, bool(popups))
            box['split'] = 104
        elif box['chatReady'] and not popups:
            try:
                box['split'] = detect_split(x, box)
            except Exception:
                pass
        return box


def wait_layout(done, timeout, step=.12, fresh=False):
    """Poll until WeChat finished reacting, so replies describe the real state."""
    deadline = time.monotonic() + timeout
    while True:
        if fresh and client.key == 'qq':
            qq_geometry_cache.clear()
        current = layout()
        if done(current) or time.monotonic() > deadline:
            return current
        time.sleep(step)


def fit_qq(current):
    """Fit before replying to navigation, so the phone never sees a late reflow."""
    width = min(current['screenWidth'], current['preferredWidth'])
    height = max(640, current['screenHeight']-60)
    if (current['width'],current['height'],current['x'],current['y']) != (width,height,0,0):
        with X() as display:
            display.unmaximize(current['id'])
        time.sleep(.06)
        run('xdotool','windowsize',current['id'],str(width),str(height))
        run('xdotool','windowmove',current['id'],'0','0')
        time.sleep(.15)
        current = wait_layout(lambda now: now['width']==width and now['height']==height, .6, .06, fresh=True)
    return current


def run(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=4, check=True).stdout.decode().strip()


last_click = {'time': 0, 'x': -99, 'y': -99}


def native_click(current, x, y, button=1, activate=True, guard=False):
    if activate:
        run('xdotool', 'windowactivate', '--sync', current['id'])
    if guard and button == 1:
        # Two quick taps on a chat would be a double-click, which pops the chat out into its own window.
        elapsed = time.monotonic() - last_click['time']
        if elapsed < .6 and abs(x - last_click['x']) < 30 and abs(y - last_click['y']) < 30:
            time.sleep(.6 - elapsed)
    run('xdotool', 'mousemove', str(int(x)), str(int(y)), 'mousedown', str(button))
    time.sleep(.045)
    run('xdotool', 'mouseup', str(button))
    last_click.update(time=time.monotonic(), x=x, y=y)


def input_point(current):
    return current.get('inputPoint') or [current['x'] + current['width'] * .65, current['y'] + current['height'] - 165]


def set_clipboard(content, kind=None):
    # xclip forks to retain clipboard ownership; its output must not be captured.
    command = ['xclip', '-selection', 'clipboard'] + (['-t', kind] if kind else [])
    subprocess.run(command, input=content.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4, check=True)


def clipboard_text():
    try:
        result = subprocess.run(['xclip', '-o', '-selection', 'clipboard'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
    except subprocess.TimeoutExpired:
        return None
    return result.stdout.decode(errors='replace') if result.returncode == 0 else None


def input_content(current):
    """Return the text in WeChat's input box, '' when empty, or None when it holds something that is not text."""
    probe = 'NAS_INPUT_CHECK_' + secrets.token_hex(12)
    set_clipboard(probe)
    native_click(current, *input_point(current))
    run('xdotool', 'key', '--clearmodifiers', 'ctrl+a', 'ctrl+c')
    time.sleep(.12)
    value = clipboard_text()
    return '' if value == probe else value


def scroll_to_latest(current):
    region = pane_region(current, 'chat')
    x, y = region['x']+region['width']//2, region['y']+region['header']+(region['height']-region['header'])//2
    run('xdotool', 'mousemove', str(x), str(y), 'click', '--repeat', '25', '--delay', '6', '5')


def validated_chat(current, payload):
    return (current['mainWindow'] and current['chatReady'] and not current['compactList'] and not current['popups']
            and current.get('editorReady',True)
            and str(payload.get('window')) == current['id'] and payload.get('conversation') == current.get('conversation'))


def row_signature(x, current, y):
    scale = current.get('uiScale',1)
    left = pane_region(current, 'list')['x']+8*scale
    image = x.grab(left, y-30*scale, 90*scale, 60*scale).convert('L').resize((6, 6), Image.BOX)
    return list(image.tobytes())


def pane_header(current):
    with X() as x:
        region = pane_region(current,'chat')
        return x.grab(region['x'],region['y'],region['width'],region['header']).convert('L').resize((32,4),Image.BOX).tobytes()


def header_changed(current, before):
    try:
        return sum(abs(a - b) > 20 for a, b in zip(pane_header(current), before)) >= 4
    except ValueError:
        return False


def session_cookie():
    token = str(int(time.time()) + SESSION_SECONDS) + '.' + secrets.token_hex(16)
    token += '.' + hmac.new(session_key, token.encode(), hashlib.sha256).hexdigest()
    return SESSION_COOKIE + '=' + token + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + str(SESSION_SECONDS)


def authenticated(headers):
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get('Cookie', ''))
        expiry, nonce, signature = cookie[SESSION_COOKIE].value.split('.')
        expected = hmac.new(session_key, (expiry + '.' + nonce).encode(), hashlib.sha256).hexdigest()
        return int(expiry) > time.time() and hmac.compare_digest(expected, signature)
    except (KeyError, ValueError):
        return False


def push_owner(headers):
    cookie = SimpleCookie()
    cookie.load(headers.get('Cookie', ''))
    value = cookie[SESSION_COOKIE].value
    return hashlib.sha256(value.encode()).hexdigest(), int(value.split('.')[0])


def clean_uploads():
    while True:
        cutoff = time.time() - 7200
        for folder in UPLOADS.glob('*'):
            try:
                if folder.stat().st_mtime < cutoff:
                    shutil.rmtree(folder) if folder.is_dir() else folder.unlink()
            except OSError:
                pass
        time.sleep(600)


DEBUG = ROOT / 'debug'


def debug(event, **data):
    # Diagnostics for touch problems on real phones, only while debug/enabled exists; message text is never logged.
    if not (DEBUG / 'enabled').exists():
        return
    try:
        DEBUG.mkdir(mode=0o700, exist_ok=True)
        path = DEBUG / 'events.log'
        if path.exists() and path.stat().st_size > 2_000_000:
            path.unlink()
        with open(path, 'a', encoding='utf-8') as output:
            output.write(json.dumps({'time': time.strftime('%H:%M:%S') + '.%03d' % (time.time() % 1 * 1000), 'event': event} | data, ensure_ascii=False, default=str) + '\n')
    except OSError:
        pass


def debug_picture(name, region):
    try:
        with X() as x:
            image = x.grab(*region).convert('L')
        image.thumbnail((380, 380))
        image.save(DEBUG / (time.strftime('%H%M%S-') + name + '.png'))
        for old in sorted(DEBUG.glob('*.png'))[:-30]:
            old.unlink()
    except Exception:
        pass


def brief(current):
    return {'list': current.get('compactList'), 'conversation': current.get('conversation'),
            'popups': [(p['kind'], p['name'], p['x'], p['y'], p['width'], p['height']) for p in current.get('popups', [])]}


def probe_region(current):
    region = pane_region(current)
    return [region['x'],region['y'],region['width'],min(1400,region['height'])]


# ---- Phone picture: the server sends changed strips of WeChat's window as JPEG ----
# Phones draw these strips directly, so no browser video decoder can hold back the last frame.
BAND = 64
EDGE = 20
mirrors = {}
mirror_lock = threading.Lock()


def target_rect(current, target):
    if target == 'popup':
        if not current['popups']:
            return None
        popup = current['popups'][0]
        x, y = max(0, popup['x']), max(0, popup['y'])
        return [x, y, min(popup['width'], current['screenWidth'] - x), min(popup['height'], current['screenHeight'] - y)], 'popup:' + popup['id']
    if current['popups']:
        return None
    if not current['chatReady']:
        left,top=max(0,current['x']),max(0,current['y'])
        right=min(current['x']+current['width'],current['screenWidth'])
        bottom=min(current['y']+current['height'],current['screenHeight'])
        return [left,top,max(0,right-left),max(0,bottom-top)], 'window:' + current['id']
    region = pane_region(current)
    suffix = (':list' if current['compactList'] else ':chat') if current.get('panes') else ''
    return [region['x'],region['y'],region['width'],region['height']], 'main:'+current['id']+suffix


def mirror_state(key, crcs):
    with mirror_lock:
        state = mirrors.get(key)
        if state is None or len(state['crc']) != len(crcs):
            counter = max([s['counter'] for s in mirrors.values()] + [0]) + 1
            state = mirrors[key] = {'crc': list(crcs), 'version': [counter] * len(crcs), 'counter': counter, 'used': time.monotonic()}
            for old in sorted(mirrors, key=lambda k: mirrors[k]['used'])[:-6]:
                del mirrors[old]
        else:
            for i, value in enumerate(crcs):
                if value != state['crc'][i]:
                    state['counter'] += 1
                    state['crc'][i], state['version'][i] = value, state['counter']
        state['used'] = time.monotonic()
        return state['counter'], list(state['version'])


def jpeg(image, motion=False, slow=False):
    output = io.BytesIO()
    if motion:
        # While content moves, small frames keep the phone fluid; sharp strips follow once it settles.
        scale = min(1, (360 if slow else 480) / image.width)
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.BILINEAR)
        image.save(output, 'JPEG', quality=50 if slow else 60, subsampling=2)
    else:
        image.save(output, 'JPEG', quality=94, subsampling=0)
    return output.getvalue()


def encode_strip(image, motion=False, slow=False, quality='clear'):
    if quality == 'lossless' and not motion:
        output = io.BytesIO()
        image.save(output, 'PNG', compress_level=2)
        return output.getvalue(), 'image/png'
    return jpeg(image, motion if quality == 'adaptive' else False, slow), 'image/jpeg'


def picture_quality(query):
    quality = query.get('quality', ['clear'])[0]
    return quality if quality in ('lossless', 'clear', 'adaptive') else 'clear'


class PhonePicture:
    """What one phone currently holds: a hash, a quality flag and a time for every pixel row."""

    def __init__(self, height):
        self.rows, self.low, self.stamp = [None] * height, [False] * height, [0.0] * height
        # The right edge holds WeChat's overlay scrollbar, which does not move with the content.
        self.edge = [None] * height

    def find_moves(self, rows):
        """Find runs of rows that moved unchanged, as [distance, start, end] segments.

        Scrolling moves rows; a distinctive row found elsewhere tells how far it moved, and the run
        grows while following rows match at the same distance. WeChat rounds each item to whole
        pixels, so neighbouring items of one scroll can move one pixel apart; each gets its own run.
        """
        old, height = self.rows, len(rows)
        positions = {}
        for j, value in enumerate(old):
            positions[value] = -1 if value in positions else j
        moves, run = [], None
        for i in range(height):
            if run and 0 <= i - run[0] < height and rows[i] == old[i - run[0]]:
                run[2] = i + 1
                continue
            if run and run[2] - run[1] >= 8:
                moves.append(run)
            run = None
            if rows[i] != old[i]:
                j = positions.get(rows[i], -1)
                if j >= 0 and j != i:
                    run = [i - j, i, i + 1]
        if run and run[2] - run[1] >= 8:
            moves.append(run)
        return moves[:32]

    def move(self, moves):
        # The phone copies every segment from its previous picture at once; mirror that here.
        for values in (self.rows, self.low, self.stamp):
            previous = values[:]
            for distance, start, end in moves:
                values[start:end] = previous[start - distance:end - distance]


WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def websocket_frame(payload, opcode=2):
    size = len(payload)
    if size < 126:
        head = struct.pack('>BB', 0x80 | opcode, size)
    elif size < 65536:
        head = struct.pack('>BBH', 0x80 | opcode, 126, size)
    else:
        head = struct.pack('>BBQ', 0x80 | opcode, 127, size)
    return head + payload


def websocket_read(stream):
    """Read a complete masked, unfragmented browser control frame with bounded memory."""
    def exact(size):
        chunks, left = [], size
        while left:
            part = stream.read(left)
            if not part:
                raise EOFError
            chunks.append(part)
            left -= len(part)
        return b''.join(chunks)
    try:
        head = exact(2)
        opcode, size = head[0] & 15, head[1] & 127
        if head[0] & 0x70 or not head[0] & 0x80 or not head[1] & 0x80:
            return None
        if size == 126:
            size = struct.unpack('>H', exact(2))[0]
        elif size == 127:
            size = struct.unpack('>Q', exact(8))[0]
        if size > 4096 or opcode not in (1, 8, 9, 10) or opcode >= 8 and size > 125:
            return None
        mask, data = exact(4), exact(size)
        return opcode, bytes(byte ^ mask[i % 4] for i, byte in enumerate(data))
    except (EOFError, OSError, struct.error):
        return None


def strip_runs(indexes, height, max_rows=0):
    runs = []
    for i in sorted(indexes):
        if runs and runs[-1][0] + runs[-1][1] == i * BAND and (not max_rows or runs[-1][1] + BAND <= max_rows):
            runs[-1][1] = min(height, (i + 1) * BAND) - runs[-1][0]
        else:
            runs.append([i * BAND, min(height, (i + 1) * BAND) - i * BAND])
    return runs


def remember(request_id, state, fingerprint):
    send_results[request_id] = (time.monotonic(), state, fingerprint)
    while len(send_results) > 128:
        del send_results[next(iter(send_results))]
    save_send_results()


def check_request(request_id, fingerprint):
    for key in list(send_results):
        if time.monotonic() - send_results[key][0] > 600:
            del send_results[key]
    if request_id in send_results:
        _, state, previous = send_results[request_id]
        if previous != fingerprint:
            return 409, '发送请求已变化，请重新操作'
        if state == 'done':
            return 200, None
        return 409, '上次发送结果不确定，请先检查聊天客户端画面，避免重复发送'
    return None, None


def confirm_sent(current):
    # WeChat clears its input box once the message is accepted.
    deadline = time.monotonic() + 3.5
    while True:
        if not validated_chat(layout(), {'window': current['id'], 'conversation': current['conversation']}):
            return False
        if input_content(current) == '':
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(.06)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, cookie=None, **value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def client_address_key(self):
        # Cloudflare forwards the visitor address; everything else arrives from the local tunnel.
        return (self.headers.get('CF-Connecting-IP') or self.headers.get('X-Forwarded-For', '').split(',')[0].strip() or 'local')[:64]

    def frame(self, query):
        target = query.get('target', ['main'])[0]
        quality = picture_quality(query)
        try:
            since = int(query.get('since', ['-1'])[0])
        except ValueError:
            since = -1
        known = query.get('key', [''])[0]
        deadline = time.monotonic() + 8
        current, checked = layout(), time.monotonic()
        while True:
            found = target_rect(current, target)
            if not found or found[0][2] <= 0 or found[0][3] <= 0:
                return self.binary({'key': None, 'rect': None, 'version': 0, 'strips': [], 'layout': current}, [])
            rect, name = found
            key = name + ':' + ','.join(map(str, rect))
            with X() as x:
                data, width, height, stride = x.raw(*rect)
            # Compare raw strips; only changed strips are converted and encoded.
            crcs = [zlib.crc32(data[i:i + BAND * stride]) for i in range(0, len(data), BAND * stride)]
            counter, versions = mirror_state(key, crcs)
            full = key != known or since < 0
            changed = [i for i, version in enumerate(versions) if full or version > since]
            if changed or time.monotonic() > deadline:
                image = Image.frombuffer('RGB', (width, height), data, 'raw', 'BGRX', stride, 1)
                strips, blobs, types = [], [], []
                strips = strip_runs(changed,image.height,256 if current.get('client') == 'qq' and QQ_SCALE > 1 else 0)
                for top, height in strips:
                    blob, mime = encode_strip(image.crop((0, top, image.width, top + height)), quality=quality)
                    blobs.append(blob); types.append(mime)
                return self.binary({'key': key, 'rect': rect, 'version': counter, 'full': full,
                                    'strips': [s + [len(b), 0, image.width, mime] for s, b, mime in zip(strips, blobs, types)], 'layout': current}, blobs)
            time.sleep(.12)
            if time.monotonic() - checked > .4:
                current, checked = layout(), time.monotonic()

    def websocket(self):
        # nginx authenticates the handshake; recheck cookies so session revocation also closes streams.
        key = self.headers.get('Sec-WebSocket-Key', '')
        origin = urlsplit(self.headers.get('Origin', '')).netloc
        try:
            valid_key = len(base64.b64decode(key, validate=True)) == 16
        except ValueError:
            valid_key = False
        if not authenticated(self.headers):
            return self.reply(401, error='请重新登录')
        if (self.headers.get('Upgrade', '').lower() != 'websocket' or not valid_key
                or origin != self.headers.get('Host') or self.headers.get('Sec-WebSocket-Version') != '13'):
            return self.reply(400, error='请从手机界面连接')
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.connection.settimeout(35)
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode()).digest()).decode())
        self.end_headers()
        self.close_connection = True
        state = {'open': True, 'acked': 0, 'sent': 0, 'heard': time.monotonic(), 'sent_at': 0, 'latency': .1}
        write_lock = threading.Lock()

        def write(payload, opcode=2):
            with write_lock:
                self.wfile.write(websocket_frame(payload, opcode))
                self.wfile.flush()

        def listen():
            try:
                while state['open']:
                    frame = websocket_read(self.rfile)
                    if not frame or frame[0] == 8:
                        break
                    state['heard'] = time.monotonic()
                    if frame[0] == 1 and re.fullmatch(rb'ack [0-9]{1,12}', frame[1]):
                        ack = int(frame[1][4:])
                        if state['acked'] < ack == state['sent']:
                            elapsed = time.monotonic() - state['sent_at']
                            state['latency'] = .75 * state['latency'] + .25 * elapsed
                            state['acked'] = ack
                    elif frame[0] == 9:
                        write(frame[1], 10)
            except OSError:
                pass
            finally:
                state['open'] = False

        threading.Thread(target=listen, daemon=True).start()

        def send(message):
            state['sent'] += 1
            state['sent_at'] = time.monotonic()
            write(message)

        def ready():
            if not state['open'] or time.monotonic() - state['heard'] > 25 or not authenticated(self.headers):
                raise BrokenPipeError
            # At most one picture in flight. Intermediate desktop states are never queued.
            return state['sent'] == state['acked']

        try:
            self.push_frames(send, ready, lambda: state['sent'] + 1, lambda: state['latency'], picture_quality(parse_qs(urlsplit(self.path).query)))
        finally:
            state['open'] = False
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def push_frames(self, send, ready, sequence, latency=lambda: .1, quality='clear'):
        picture_profile = quality
        key, phone = None, None
        current, checked, shown_layout, shown_conversation = None, 0, None, None
        last_change, last_send, previous_changed = 0, 0, False
        while True:
            now = time.monotonic()
            try:
                if not ready():
                    # The phone is still drawing; changes made meanwhile merge into the next message.
                    time.sleep(.02)
                    continue
                if now - checked > .3 or current is None:
                    current, checked = layout(), now
                found = target_rect(current, 'popup' if current['popups'] else 'main')
                snapshot = json.dumps(current, sort_keys=True)
                header, blobs = {}, []
                if snapshot != shown_layout:
                    header['layout'] = current
                if not found:
                    key = None
                    if header or now - last_send > 5:
                        header.update(key=None, strips=[])
                else:
                    rect, name = found
                    with X() as x:
                        data, width, height, stride = x.raw(*rect)
                    pixels, body = memoryview(data), max(1, width - EDGE) * 4
                    rows = [zlib.crc32(pixels[i * stride:i * stride + body]) for i in range(height)]
                    edges = [zlib.crc32(pixels[i * stride + body:i * stride + width * 4]) for i in range(height)]
                    new_key = name + ':' + ','.join(map(str, rect))
                    full = new_key != key or current['conversation'] != shown_conversation
                    if full:
                        key, phone = new_key, PhonePicture(height)
                    changed = [i for i in range(height) if rows[i] != phone.rows[i]]
                    moves = []
                    if len(changed) >= 16 and not full:
                        # Scrolled content is moved on the phone instead of being sent again.
                        moves = phone.find_moves(rows)
                        if moves:
                            phone.move(moves)
                            changed = [i for i in range(height) if rows[i] != phone.rows[i]]
                    count = (height + BAND - 1) // BAND
                    changed_strips = sorted({i // BAND for i in changed})
                    changed_set = set(changed_strips)
                    refine = [s for s in range(count) if s not in changed_set and any(phone.low[s * BAND:(s + 1) * BAND])
                              and now - max(phone.stamp[s * BAND:(s + 1) * BAND]) > max(.3, min(1.2, latency()))]
                    # Sustained or widespread change is motion: scrolling, animations, list reshuffles.
                    moving = bool(changed_strips or moves) and not full
                    # A new screen arrives at native resolution; adaptive motion applies to later updates.
                    motion = not full and moving and (previous_changed or bool(moves) or len(changed_strips) * 3 > count)
                    main = max(1, width - EDGE)
                    edge_strips = [] if full else sorted({i // BAND for i in range(height) if edges[i] != phone.edge[i]})
                    if moving or edge_strips:
                        last_change = now
                    previous_changed = moving
                    for s in changed_strips:
                        for i in range(s * BAND, min(height, (s + 1) * BAND)):
                            phone.rows[i], phone.low[i], phone.stamp[i] = rows[i], motion, now
                    for s in refine:
                        for i in range(s * BAND, min(height, (s + 1) * BAND)):
                            phone.low[i] = False
                    if full:
                        phone.edge = edges[:]
                    for s in edge_strips:
                        for i in range(s * BAND, min(height, (s + 1) * BAND)):
                            phone.edge[i] = edges[i]
                    if changed_strips or refine or moves or edge_strips or header or now - last_send > 5:
                        image = Image.frombuffer('RGB', (width, height), data, 'raw', 'BGRX', stride, 1)
                        strips, span = [], width if full else main
                        max_rows = 256 if current.get('client') == 'qq' and QQ_SCALE > 1 else 0
                        for group, quality in ((changed_strips, motion), (refine, False)):
                            for top, size in strip_runs(group, height, max_rows):
                                blob, mime = encode_strip(image.crop((0, top, span, top + size)), quality, latency() > .4, picture_profile)
                                strips.append([top, size, len(blob), 0, span, mime])
                                blobs.append(blob)
                        for top, size in strip_runs(edge_strips, height):
                            blob, mime = encode_strip(image.crop((main, top, width, top + size)), quality=picture_profile)
                            strips.append([top, size, len(blob), main, width - main, mime])
                            blobs.append(blob)
                        header.update(key=key, rect=rect, full=full, strips=strips, moves=moves, span=main)
                if header:
                    header['seq'] = sequence()
                    head = json.dumps(header, ensure_ascii=False).encode()
                    send(struct.pack('>II', len(head), sum(map(len, blobs))) + head + b''.join(blobs))
                    last_send, shown_layout, shown_conversation = now, snapshot, current['conversation']
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            except Exception:
                time.sleep(.5)
                # Capture/encoding may have changed the delta baseline before failing.
                # Resend a complete picture rather than depending on an unsent change.
                current, key, phone, shown_layout, shown_conversation = None, None, None, None, None
                continue
            time.sleep(max(.04, min(.15, latency() * .2)) if now - last_change < 1.5 else .25)

    def binary(self, header, blobs):
        head = json.dumps(header, ensure_ascii=False).encode()
        body = struct.pack('>I', len(head)) + head + b''.join(blobs)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == '/push/status':
            if not authenticated(self.headers):
                return self.reply(401, error='请重新登录')
            if not push_service.accepts(self.headers):
                return self.reply(200, ok=True, available=False, reason='推送只在已配置的外网入口提供')
            owner, _ = push_owner(self.headers)
            return self.reply(200, ok=True, **push_service.status(owner))
        if url.path == '/ws':
            return self.websocket()
        if url.path == '/frame':
            try:
                return self.frame(parse_qs(url.query))
            except Exception:
                return self.reply(503, error='聊天客户端窗口尚未就绪')
        if self.path == '/auth-check':
            valid = authenticated(self.headers)
            self.reply(200 if valid else 401, ok=valid)
        elif self.path == '/layout':
            try:
                self.reply(200, ok=True, layout=layout())
            except Exception:
                self.reply(503, error='聊天客户端窗口尚未就绪')
        elif self.path == '/health':
            self.reply(200, ok=True)
        elif self.path == '/probe':
            # A coarse picture of the chat pane lets the phone notice a frozen stream.
            try:
                current = layout()
                if current['popups'] or not current['chatReady']:
                    return self.reply(200, ok=True, region=None)
                region = probe_region(current)
                with X() as x:
                    image = x.grab(*region).convert('L').resize((8, 24), Image.BOX)
                self.reply(200, ok=True, region=region, signature=list(image.tobytes()), conversation=current['conversation'])
            except Exception:
                self.reply(503, error='聊天客户端窗口尚未就绪')
        else:
            self.reply(404, error='不存在的操作')

    def do_POST(self):
        if self.headers.get('X-Mobile-Control') != '1':
            return self.reply(403, error='请从手机界面操作')
        if self.path == '/upload':
            return self.upload()
        if self.headers.get('Content-Type') != 'application/json':
            return self.reply(403, error='请从手机界面操作')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32768:
                return self.reply(413, error='单次内容过长')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                return self.reply(400, error='请求格式错误')
            if self.path == '/login':
                return self.login(payload)
            if self.path.startswith('/push/'):
                if not authenticated(self.headers):
                    return self.reply(401, error='请重新登录')
                if not push_service.accepts(self.headers):
                    return self.reply(403, error='请从外网入口设置消息推送')
                owner, expiry = push_owner(self.headers)
                try:
                    if self.path == '/push/subscribe':
                        identity = push_service.subscribe(owner, expiry, payload.get('subscription'), payload.get('preview'))
                        return self.reply(200, ok=True, id=identity)
                    if self.path == '/push/unsubscribe':
                        identity = payload.get('id')
                        if not isinstance(identity, str):
                            raise ValueError('推送订阅无效')
                        push_service.unsubscribe(owner, identity)
                        return self.reply(200, ok=True)
                    if self.path == '/push/test':
                        ticket = push_service.test(owner, payload.get('id'))
                        return self.reply(200, ok=True, testId=ticket)
                    return self.reply(404, error='不存在的推送操作')
                except ValueError as error:
                    return self.reply(400, error=str(error))
            if self.path == '/debug':
                debug('phone', agent=self.headers.get('User-Agent', '')[:160], data=payload)
                return self.reply(200, ok=True)
            if self.path == '/logout':
                if authenticated(self.headers):
                    push_service.unsubscribe(push_owner(self.headers)[0])
                return self.reply(200, cookie=SESSION_COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0', ok=True)
            if self.path == '/logout-all':
                global session_key
                push_service.revoke_all()
                session_key = secrets.token_bytes(32)
                temporary = keyfile.with_suffix('.tmp'); temporary.write_bytes(session_key); temporary.chmod(0o600); temporary.replace(keyfile)
                return self.reply(200, cookie=SESSION_COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0', ok=True)
            actions = {'/send': self.send, '/tap': self.tap, '/view': self.view, '/prepare': self.prepare, '/window': self.window, '/scroll': self.scroll, '/search': self.search}
            if self.path not in actions:
                return self.reply(404, error='不存在的操作')
            with lock:
                return actions[self.path](payload)
        except (ValueError, KeyError, TypeError):
            self.reply(400, error='请求格式错误')
        except Exception:
            self.reply(503, error='桌面暂时不可操作，请稍后重试')

    def login(self, payload):
        with lock:
            now, address = time.monotonic(), self.client_address_key()
            for key in list(failed_logins):
                attempts = failed_logins[key]
                while attempts and attempts[0] < now - 60:
                    attempts.popleft()
                if not attempts:
                    del failed_logins[key]
            if len(failed_logins.get(address, ())) >= 8 or sum(map(len, failed_logins.values())) >= 60:
                return self.reply(429, error='尝试次数过多，请一分钟后再试')
            password = payload.get('password', '')
            if not isinstance(password, str) or not os.getenv('PASSWORD') or not hmac.compare_digest(password.encode(), os.environ['PASSWORD'].encode()):
                failed_logins[address].append(now)
                return self.reply(401, error='密码不正确，请使用聊天客户端网页密码')
            return self.reply(200, cookie=session_cookie(), ok=True)

    def send(self, payload):
        content, mode, request_id = payload.get('text'), payload.get('mode', 'enter'), payload.get('requestId')
        if not isinstance(content, str) or not content.strip() or len(content) > 8000:
            return self.reply(400, error='请输入 1–8000 字的内容')
        if mode not in ('enter', 'ctrl-enter') or not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{12,64}', request_id):
            return self.reply(400, error='请求格式错误')
        fingerprint = hashlib.sha256((str(payload.get('window')) + '\0' + str(payload.get('conversation')) + '\0' + mode + '\0' + content).encode()).hexdigest()
        status, error = check_request(request_id, fingerprint)
        if status == 200:
            return self.reply(200, ok=True, duplicate=True)
        if status:
            return self.reply(status, error=error)
        current = layout()
        if current['popups']:
            return self.reply(409, error='聊天客户端里有弹出窗口，请先处理再发送', layout=current)
        if not validated_chat(current, payload):
            return self.reply(409, error='聊天窗口已变化，请先选择并核对聊天对象', layout=current)
        native_click(current, *input_point(current))
        if run('xdotool', 'getwindowfocus') != current['id']:
            return self.reply(409, error='聊天客户端焦点已变化，请重试')
        set_clipboard(content)
        run('xdotool', 'key', '--clearmodifiers', 'ctrl+a', 'ctrl+v')
        if input_content(current) != content:
            return self.reply(409, error='聊天客户端输入未完成，内容已保留，请再点发送')
        if not validated_chat(layout(), payload):
            return self.reply(409, error='聊天对象已变化，未发送，请重新选择会话')
        remember(request_id, 'uncertain', fingerprint)
        # Click the verified client's send button, independent of Enter settings.
        run('xdotool', 'key', '--clearmodifiers', 'Right')
        native_click(current, *send_point(current))
        if not confirm_sent(current):
            return self.reply(409, error='发送尚未确认，请检查聊天画面；输入内容已保留')
        remember(request_id, 'done', fingerprint)
        scroll_to_latest(current)
        return self.reply(200, ok=True, confirmed=True, layout=layout())

    def upload(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            name = unquote(self.headers.get('X-File-Name', ''))
            request_id = self.headers.get('X-Request-Id', '')
            payload = {'window': self.headers.get('X-Window'), 'conversation': unquote(self.headers.get('X-Conversation', ''))}
        except ValueError:
            return self.reply(400, error='请求格式错误')
        if not 0 < length <= MAX_UPLOAD:
            return self.reply(413, error='单个文件不能超过 95MB')
        if not re.fullmatch(r'[A-Za-z0-9-]{12,64}', request_id):
            return self.reply(400, error='请求格式错误')
        name = re.sub(r'[\x00-\x1f/\\:*?"<>|]', '_', name).strip(' .')[:120] or 'file'
        folder = UPLOADS / secrets.token_hex(8)
        folder.mkdir(parents=True, mode=0o700)
        path = folder / name
        digest, remaining = hashlib.sha256(), length
        with open(path, 'wb') as output:
            while remaining:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    shutil.rmtree(folder, ignore_errors=True)
                    return self.reply(400, error='上传中断，请重试')
                digest.update(chunk); output.write(chunk); remaining -= len(chunk)
        fingerprint = hashlib.sha256((str(payload['window']) + '\0' + payload['conversation'] + '\0' + name + '\0' + digest.hexdigest()).encode()).hexdigest()
        try:
            with lock:
                status, error = check_request(request_id, fingerprint)
                if status == 200:
                    return self.reply(200, ok=True, duplicate=True)
                if status:
                    return self.reply(status, error=error)
                current = layout()
                if current['popups']:
                    return self.reply(409, error='聊天客户端里有弹出窗口，请先处理再发送', layout=current)
                if not validated_chat(current, payload):
                    return self.reply(409, error='聊天窗口已变化，请先选择并核对聊天对象', layout=current)
                if input_content(current) != '':
                    run('xdotool', 'key', '--clearmodifiers', 'ctrl+a', 'BackSpace')
                # WeChat accepts file URIs from the clipboard and shows pictures inline.
                set_clipboard('file://' + quote(str(path)) + '\r\n', 'text/uri-list')
                native_click(current, *input_point(current))
                run('xdotool', 'key', '--clearmodifiers', 'ctrl+v')
                attached = False
                for pause in (.4, .6, 1.0):
                    time.sleep(pause)
                    if input_content(current) != '':
                        attached = True
                        break
                if not attached:
                    return self.reply(409, error='聊天客户端没有接收这个文件，请重试')
                if not validated_chat(layout(), payload):
                    run('xdotool', 'key', '--clearmodifiers', 'ctrl+a', 'BackSpace')
                    return self.reply(409, error='聊天对象已变化，未发送，请重新选择会话')
                remember(request_id, 'uncertain', fingerprint)
                native_click(current, *send_point(current))
                if not confirm_sent(current):
                    return self.reply(409, error='发送尚未确认，请检查聊天画面')
                remember(request_id, 'done', fingerprint)
                scroll_to_latest(current)
                return self.reply(200, ok=True, confirmed=True, layout=layout())
        except Exception:
            return self.reply(503, error='桌面暂时不可操作，请稍后重试')

    def search(self, payload):
        query = payload.get('query')
        if not isinstance(query,str) or len(query)>100 or any(ord(c)<32 for c in query):
            return self.reply(400,error='请输入最多 100 字的搜索内容')
        current = layout()
        if (client.key!='qq' or not current['chatReady'] or not current['compactList'] or current['popups']
                or str(payload.get('window'))!=current['id'] or payload.get('conversation')!=current['conversation']):
            return self.reply(409,error='请先返回 QQ 会话列表再搜索',layout=current)
        region = pane_region(current,'list')
        native_click(current,region['x']+90*QQ_SCALE,region['y']+26*QQ_SCALE)
        run('xdotool','key','--clearmodifiers','ctrl+a')
        if query:
            set_clipboard(query)
            run('xdotool','key','--clearmodifiers','ctrl+v')
        else:
            run('xdotool','key','--clearmodifiers','BackSpace','Escape')
        time.sleep(.2)
        navigation['search'] = bool(query)
        qq_geometry_cache.clear()
        return self.reply(200,ok=True,layout=layout())

    def tap(self, payload):
        x, y, button = payload.get('x'), payload.get('y'), payload.get('button', 1)
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in (x, y)) or button not in (1, 3):
            return self.reply(400, error='触摸位置无效')
        started, current = time.monotonic(), layout()
        debug('tap', target=payload.get('target'), x=x, y=y, button=button, sent=payload.get('conversation'), before=brief(current),
              signature=isinstance(payload.get('signature'), list))
        if payload.get('target') == 'popup':
            popup = next((p for p in current['popups'] if p['id'] == str(payload.get('window'))), None)
            if not popup or popup is not current['popups'][0]:
                debug('tap-rejected', reason='popup changed')
                return self.reply(409, error='弹出窗口已变化，请重新点选', layout=current)
            if not (popup['x'] <= x < popup['x'] + popup['width'] and popup['y'] <= y < popup['y'] + popup['height']):
                return self.reply(400, error='请点选弹出窗口里的内容')
            before = clipboard_text() if popup['kind'] == 'menu' else None
            if popup['kind'] != 'menu':
                run('xdotool', 'windowactivate', popup['id'])
            native_click(current, x, y, button, activate=False, guard=True)
            ids = [p['id'] for p in current['popups']]
            result = wait_layout(lambda now: [p['id'] for p in now['popups']] != ids, .9 if popup['kind'] == 'menu' else .5)
            copied = None
            if popup['kind'] == 'menu' and button == 1:
                time.sleep(.15)
                after = clipboard_text()
                if after and after != before and not after.startswith('NAS_INPUT_CHECK_') and len(after) <= 20000:
                    copied = after
            debug('tap-result', popup=popup['kind'], after=brief(result), copied=bool(copied), seconds=round(time.monotonic() - started, 2))
            return self.reply(200, ok=True, layout=result, copied=copied)
        if current['popups']:
            debug('tap-rejected', reason='popup open')
            return self.reply(409, error='聊天客户端里有弹出窗口', layout=current)
        if not current['chatReady']:
            # Login and startup screens: any point inside the window may be tapped.
            if not (current['x'] <= x < current['x'] + current['width'] and current['y'] <= y < current['y'] + current['height']):
                return self.reply(400, error='请点选聊天客户端窗口里的内容')
            native_click(current, x, y, button, guard=True)
            return self.reply(200, ok=True, layout=wait_layout(lambda now: now['chatReady'] or bool(now['popups']), .8))
        if not current['mainWindow'] or str(payload.get('window')) != current['id']:
            debug('tap-rejected', reason='window changed')
            return self.reply(409, error='画面已更新，请稍后重新点选', layout=current)
        if payload.get('conversation') != current['conversation'] and not (current['compactList'] and str(payload.get('conversation')).endswith(':list')):
            debug('tap-rejected', reason='conversation changed')
            return self.reply(409, error='画面已更新，请稍后重新点选', layout=current)
        region = pane_region(current)
        inside = (region['x'] <= x < region['x']+region['width']
                  and region['y'] <= y < region['y']+region['height'])
        if not inside:
            debug('tap-rejected', reason='outside')
            return self.reply(400, error='请点选可见的聊天客户端内容')
        selecting = current['compactList'] and y > current.get('selectFromY',current['y']+160) and button == 1
        signature = payload.get('signature')
        if selecting and isinstance(signature, list) and len(signature) == 36:
            with X() as display:
                actual = row_signature(display, current, y)
            difference = sum(abs(a - b) for a, b in zip(actual, signature)) / 36
            debug('tap-signature', difference=round(difference, 1))
            if difference > 10:
                return self.reply(409, error='列表刚刚更新，请看清后再点', layout=current, changed=True)
        already_selected = False
        if selecting and current.get('client') == 'qq':
            with X() as display:
                actual = row_signature(display,current,y)
                # Search suggestions overlay the selected row. Its outer edge
                # pixels can still belong to a different chat underneath.
                searching = navigation.get('search')
                if searching is None:
                    searching = qq_search_active(display,current)
                already_selected = not searching and bool(navigation['identity']) and qq_selected_row(display,current,y)
            if max(actual)-min(actual) < 25:
                return self.reply(409,error='这里没有可选会话，请点选联系人或群聊',layout=current)
        before_identity = navigation['identity']
        if already_selected:
            navigation.update(list=False,revision=navigation['revision']+1)
            result = fit_qq(layout())
            return self.reply(200,ok=True,layout=result,navigation=True)
        native_click(current, x, y, button, guard=True)
        if button == 3:
            result = wait_layout(lambda now: bool(now['popups']), 1.0)
            debug('tap-result', after=brief(result), seconds=round(time.monotonic() - started, 2))
            return self.reply(200, ok=True, layout=result)
        if selecting and current.get('client') == 'qq':
            # QQ keeps both desktop panes visible. Mobile back/forward changes
            # only the crop, avoiding remote resize/reflow during the animation.
            result = wait_layout(lambda now: bool(navigation['identity']) and navigation['identity'] != before_identity or bool(now['popups']), 2.5, .06, fresh=True)
            selected_after = False
            if not result['popups'] and navigation['identity'] == before_identity:
                with X() as display:
                    selected_after = qq_selected_row(display,result,y)
            if not result['popups'] and navigation['identity'] and (navigation['identity'] != before_identity or selected_after):
                navigation.update(list=False,search=False,revision=navigation['revision']+1)
                result = fit_qq(layout())
        elif selecting:
            # Chats turn the pane white; official accounts and similar pages only change the header.
            # A header change alone ends the wait after a pause, because chats change the header first too.
            header, deadline, header_time = pane_header(current), time.monotonic() + 2.5, None
            while True:
                result = layout()
                now = time.monotonic()
                if not result['compactList'] or result['popups'] or now > deadline:
                    break
                if header_time is None and header_changed(result, header):
                    header_time = now
                if header_time is not None and now - header_time > .8:
                    break
                time.sleep(.1)
            if not result['compactList']:
                # WeChat caches the list's height when switching panes.
                run('xdotool', 'windowsize', current['id'], str(current['width']), str(current['height'] - 1))
                time.sleep(.06)
                run('xdotool', 'windowsize', current['id'], str(current['width']), str(current['height']))
                result = wait_layout(lambda now: True, 0)
        else:
            result = wait_layout(lambda now: now['conversation'] != current['conversation'] or bool(now['popups']), .45)
        debug('tap-result', selecting=selecting, after=brief(result), seconds=round(time.monotonic() - started, 2))
        if selecting and result['compactList']:
            # Record what WeChat shows a moment later when the tap did not open a chat.
            threading.Timer(1.5, lambda: debug('tap-later', after=brief(layout()))).start()
        return self.reply(200, ok=True, layout=result, navigation=result['conversation'] != current['conversation'])

    def scroll(self, payload):
        x, y, amount = payload.get('x'), payload.get('y'), payload.get('amount')
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in (x, y, amount)) or not 0 < abs(amount) <= 30:
            return self.reply(400, error='请求格式错误')
        current = layout()
        expected = payload.get('conversation')
        popup = current['popups'][0]['id'] if current['popups'] else None
        if expected is not None and (expected != current['conversation'] or payload.get('popup') != popup):
            return self.reply(409, error='画面已变化，请重新滑动', layout=current)
        area = current['popups'][0] if current['popups'] else current
        if not (area['x'] <= x < area['x'] + area['width'] and area['y'] <= y < area['y'] + area['height']):
            return self.reply(400, error='滚动位置无效')
        # Positive amounts reveal content further down, like a finger moving up.
        run('xdotool', 'mousemove', str(x), str(y), 'click', '--repeat', str(abs(amount)), '--delay', '8', '5' if amount > 0 else '4')
        return self.reply(200, ok=True)

    def view(self, payload):
        current = layout()
        if current.get('client') == 'qq' and current['chatReady'] and not current['popups']:
            if payload.get('view') == 'list' and not navigation['list']:
                navigation.update(list=True,revision=navigation['revision']+1)
            return self.reply(200,ok=True,layout=fit_qq(layout()))
        if payload.get('view') == 'list' and current['compact'] and not current['popups']:
            if not current['compactList']:
                native_click(current, current['x'] + 160, current['y'] + 100)
                current = wait_layout(lambda now: now['compactList'], 2.0)
            # WeChat caches the compact-list widget's old height when returning.
            run('xdotool', 'windowsize', current['id'], str(current['width']), str(current['height'] - 1))
            time.sleep(.06)
            run('xdotool', 'windowsize', current['id'], str(current['width']), str(current['height']))
            time.sleep(.12)
        result = layout()
        debug('view', view=payload.get('view'), after=brief(result))
        return self.reply(200, ok=True, layout=result)

    def prepare(self, payload):
        current = layout()
        # Old, disconnected pages must not keep resizing the shared desktop.
        if payload.get('stable') is not True or current['popups']:
            return self.reply(200, ok=True, layout=current)
        if current.get('client') == 'qq' and (current['x'] < 0 or current['y'] < 0
                or current['x']+current['width'] > current['screenWidth'] or current['y']+current['height'] > current['screenHeight']):
            # A saved login/main window can grow off screen when its native DPI
            # changes. Restore it before trying to inspect its separator pixels.
            with X() as display:
                display.unmaximize(current['id'])
            time.sleep(.06)
            run('xdotool','windowsize',current['id'],str(min(current['width'],current['screenWidth'])),str(min(current['height'],current['screenHeight'])))
            run('xdotool','windowmove',current['id'],'0','0')
            time.sleep(.15)
            current = layout()
        if current.get('client') == 'qq' and current['chatReady']:
            return self.reply(200,ok=True,layout=fit_qq(current))
        if current['chatReady']:
            width = min(current['screenWidth'], current.get('preferredWidth',760))
            height = max(640, current['screenHeight'] - 60)
            if current['width'] != width or current['height'] != height or current['x'] != 0 or current['y'] != 0:
                if current.get('client') == 'qq':
                    with X() as display:
                        display.unmaximize(current['id'])
                    time.sleep(.06)
                run('xdotool', 'windowsize', current['id'], str(width), str(height))
                run('xdotool', 'windowmove', current['id'], '0', '0')
                run('xdotool', 'windowactivate', '--sync', current['id'])
                time.sleep(.15)
            elif payload.get('reflow') is True and current.get('client') != 'qq':
                run('xdotool', 'windowsize', current['id'], str(width), str(height - 1))
                time.sleep(.06)
                run('xdotool', 'windowsize', current['id'], str(width), str(height))
                time.sleep(.12)
        return self.reply(200, ok=True, layout=layout())

    def window(self, payload):
        current, action, wid = layout(), payload.get('action'), str(payload.get('window'))
        target = next((w for w in current['popups'] + current['windows'] if w['id'] == wid), None)
        if action not in ('close', 'escape', 'lower', 'raise', 'fit') or not target or wid == current['id']:
            return self.reply(409, error='窗口已变化', layout=current)
        if action == 'escape' or (action == 'close' and target['kind'] == 'menu'):
            run('xdotool', 'key', '--clearmodifiers', 'Escape')
        elif action == 'close':
            with X() as x:
                x.close(wid)
        elif action == 'lower':
            run('xdotool', 'windowactivate', '--sync', current['id'])
        elif action == 'raise':
            run('xdotool', 'windowactivate', '--sync', wid)
        elif action == 'fit' and target['kind'] == 'window':
            aspect = payload.get('aspect')
            if not isinstance(aspect, (int, float)) or not .5 <= aspect <= 3:
                return self.reply(400, error='请求格式错误')
            scale = QQ_SCALE if current.get('client') == 'qq' else 1
            width = min(current['screenWidth'], 760*scale)
            height = min(current['screenHeight'] - 60, max(480*scale, int(width * aspect)))
            if current.get('client') == 'qq':
                with X() as display:
                    display.unmaximize(wid)
                time.sleep(.06)
            run('xdotool', 'windowsize', wid, str(width), str(height))
            run('xdotool', 'windowmove', wid, '0', '0')
        ids = [w['id'] for w in current['popups']]
        result = wait_layout(lambda now: [w['id'] for w in now['popups']] != ids, 1.2 if action in ('close', 'escape', 'lower', 'raise') else .3)
        debug('window', action=action, target=(target['kind'], target['name']), after=brief(result))
        return self.reply(200, ok=True, layout=result)


UPLOADS.mkdir(mode=0o700, exist_ok=True)
threading.Thread(target=clean_uploads, daemon=True).start()
push_service.start()
ThreadingHTTPServer(('127.0.0.1', 8089), Handler).serve_forever()
