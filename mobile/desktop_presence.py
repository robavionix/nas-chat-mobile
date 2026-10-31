"""Keep a mirrored desktop from suppressing notifications after the phone leaves."""
import ctypes
import threading
import time


class _WindowAttributes(ctypes.Structure):
    _fields_ = [('background_pixmap',ctypes.c_ulong),('background_pixel',ctypes.c_ulong),
                ('border_pixmap',ctypes.c_ulong),('border_pixel',ctypes.c_ulong),
                ('bit_gravity',ctypes.c_int),('win_gravity',ctypes.c_int),('backing_store',ctypes.c_int),
                ('backing_planes',ctypes.c_ulong),('backing_pixel',ctypes.c_ulong),('save_under',ctypes.c_int),
                ('event_mask',ctypes.c_long),('do_not_propagate_mask',ctypes.c_long),
                ('override_redirect',ctypes.c_int),('colormap',ctypes.c_ulong),('cursor',ctypes.c_ulong)]


class Presence:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.leases = {}
        self.revisions = {}
        self.pending = True
        self.changed = clock()

    def touch(self, token, lifetime=45):
        with self.lock:
            now = self.clock()
            self.leases = {key: expiry for key, expiry in self.leases.items() if expiry > now}
            if token in self.leases or len(self.leases) < 256:
                self.leases[token] = now + lifetime
            self.pending, self.changed = True, now

    def leave(self, token):
        with self.lock:
            if token in self.leases:
                del self.leases[token]
                self.pending, self.changed = True, self.clock()

    def report(self, token, sequence, visible):
        with self.lock:
            now = self.clock()
            self.revisions = {key: value for key, value in self.revisions.items() if value[1] > now}
            previous = self.revisions.get(token)
            if previous and sequence <= previous[0]:
                return
            if not previous and len(self.revisions) >= 256:
                return
            self.revisions[token] = (sequence, now + 120)
            self.touch(token) if visible else self.leave(token)

    def settle(self, enabled, park):
        with self.lock:
            now = self.clock()
            self.leases = {key: expiry for key, expiry in self.leases.items() if expiry > now}
            if not enabled or self.leases or not self.pending or now - self.changed < 1:
                return False
            # Park once per departure. A subsequent manual desktop click keeps its focus.
            self.pending = False
            return park()

    def idle(self):
        with self.lock:
            now = self.clock()
            return not self.pending and now-self.changed >= 1 and not any(expiry > now for expiry in self.leases.values())

    def start(self, operation_lock, enabled, park):
        def watch():
            while True:
                try:
                    with operation_lock:
                        self.settle(enabled(), park)
                except Exception:
                    # Notification focus handling must never stop chat or sending.
                    pass
                time.sleep(.5)
        threading.Thread(target=watch, daemon=True).start()


class FocusParking:
    """A mapped InputOnly window accepts focus without drawing or covering pixels."""
    def __init__(self, window_classes=('wechat',)):
        self.classes = {name.casefold() for name in window_classes}
        self.display, self.window = None, None
        x = self.x = ctypes.CDLL('libX11.so.6')
        p, u, i = ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int
        x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [ctypes.c_char_p], p
        x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [p], u
        x.XCreateWindow.argtypes = [p,u,i,i,ctypes.c_uint,ctypes.c_uint,ctypes.c_uint,i,ctypes.c_uint,p,u,p]
        x.XCreateWindow.restype = u
        x.XMapWindow.argtypes = [p,u]
        x.XSetInputFocus.argtypes = [p,u,i,u]
        x.XGetInputFocus.argtypes = [p,ctypes.POINTER(u),ctypes.POINTER(i)]
        x.XInternAtom.argtypes, x.XInternAtom.restype = [p,ctypes.c_char_p,i], u
        x.XGetWindowProperty.argtypes = [p,u,u,ctypes.c_long,ctypes.c_long,i,u,ctypes.POINTER(u),ctypes.POINTER(i),ctypes.POINTER(u),ctypes.POINTER(u),ctypes.POINTER(p)]
        x.XFree.argtypes = [p]
        x.XSync.argtypes = [p,i]

    def park(self):
        x = self.x
        if not self.display:
            self.display = x.XOpenDisplay(None)
            if not self.display:
                return False
        d = self.display
        focus, revert = ctypes.c_ulong(), ctypes.c_int()
        x.XGetInputFocus(d, ctypes.byref(focus), ctypes.byref(revert))
        if focus.value in (0, 1, self.window):
            return False
        kind, form, count, rest, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        atom = x.XInternAtom(d, b'WM_CLASS', 0)
        if x.XGetWindowProperty(d, focus.value, atom, 0, 128, 0, 0, ctypes.byref(kind), ctypes.byref(form), ctypes.byref(count), ctypes.byref(rest), ctypes.byref(data)) != 0:
            return False
        try:
            names = ctypes.string_at(data, count.value).decode(errors='replace').casefold().split('\0') if data and form.value == 8 else []
        finally:
            if data:
                x.XFree(data)
        if not self.classes.intersection(names):
            return False
        if not self.window:
            # InputOnly (class=2), CopyFromParent depth/visual. It never appears in captures.
            attributes = _WindowAttributes(override_redirect=1)
            self.window = x.XCreateWindow(d, x.XDefaultRootWindow(d), -1, -1, 1, 1, 0, 0, 2, None, 1 << 9, ctypes.byref(attributes))
            x.XMapWindow(d, self.window)
        x.XSetInputFocus(d, self.window, 2, 0)
        x.XSync(d, 0)
        return True
