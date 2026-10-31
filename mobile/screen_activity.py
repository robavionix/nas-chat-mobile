"""Cheap X11 damage checks for idle streams, with periodic capture fallback."""
import ctypes
import os
import time


class ScreenActivity:
    def __init__(self, lock, clock=time.monotonic, loader=ctypes.CDLL):
        self.lock, self.clock, self.loader = lock, clock, loader
        self.display = self.damage = None
        self.last_capture = 0

    def __enter__(self):
        try:
            self.x = self.loader('libX11.so.6')
            self.ext = self.loader('libXdamage.so.1')
            pointer, integer, xid = ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong
            self.x.XOpenDisplay.argtypes = [ctypes.c_char_p]
            self.x.XOpenDisplay.restype = pointer
            self.x.XCloseDisplay.argtypes = [pointer]
            self.x.XDefaultRootWindow.argtypes = [pointer]
            self.x.XDefaultRootWindow.restype = xid
            self.x.XPending.argtypes = [pointer]
            self.x.XNextEvent.argtypes = [pointer, pointer]
            self.x.XFlush.argtypes = [pointer]
            self.ext.XDamageQueryExtension.argtypes = [pointer, ctypes.POINTER(integer), ctypes.POINTER(integer)]
            self.ext.XDamageQueryVersion.argtypes = [pointer, ctypes.POINTER(integer), ctypes.POINTER(integer)]
            self.ext.XDamageCreate.argtypes = [pointer, xid, integer]
            self.ext.XDamageCreate.restype = xid
            self.ext.XDamageSubtract.argtypes = [pointer, xid, xid, xid]
            self.ext.XDamageDestroy.argtypes = [pointer, xid]
            with self.lock:
                self.display = self.x.XOpenDisplay(os.environ.get('DISPLAY', ':1').encode())
                if not self.display:
                    return self
                event, error = integer(), integer()
                major, minor = integer(1), integer(1)
                if (not self.ext.XDamageQueryExtension(self.display, ctypes.byref(event), ctypes.byref(error))
                        or not self.ext.XDamageQueryVersion(self.display, ctypes.byref(major), ctypes.byref(minor))):
                    self._close()
                    return self
                self.event_type = event.value
                root = self.x.XDefaultRootWindow(self.display)
                self.damage = self.ext.XDamageCreate(self.display, root, 3)  # ReportNonEmpty, includes inferiors.
                self.x.XFlush(self.display)
        except (OSError, AttributeError):
            with self.lock:
                self._close()
        return self

    def changed(self):
        if not self.damage:
            return True  # Older/minimal X servers retain the existing polling path.
        changed = False
        with self.lock:
            event = (ctypes.c_long * 24)()
            while self.x.XPending(self.display):
                self.x.XNextEvent(self.display, ctypes.byref(event))
                if ctypes.cast(event, ctypes.POINTER(ctypes.c_int))[0] == self.event_type:
                    changed = True
            if changed:
                self.ext.XDamageSubtract(self.display, self.damage, 0, 0)
                self.x.XFlush(self.display)
        # Some direct-rendering clients under-report damage. Never depend on
        # the extension alone for eventual message/image correctness.
        return changed or self.clock() - self.last_capture >= 2

    def captured(self):
        self.last_capture = self.clock()

    def _close(self):
        if self.damage:
            self.ext.XDamageDestroy(self.display, self.damage)
        if self.display:
            self.x.XCloseDisplay(self.display)
        self.display = self.damage = None

    def __exit__(self, *args):
        with self.lock:
            self._close()
