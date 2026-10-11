"""Local readiness: API, X11 and required executables, without contacting a chat peer."""
import ctypes
import os
import shutil
import urllib.error
import urllib.request

for name in ('xdotool', 'xclip'):
    if not shutil.which(name):
        raise SystemExit(f'Missing dependency: {name}')
try:
    urllib.request.urlopen('http://127.0.0.1:8089/auth-check', timeout=3)
except urllib.error.HTTPError as error:
    if error.code != 401:
        raise
with urllib.request.urlopen('http://127.0.0.1:3000/mobile/login', timeout=3) as response:
    if response.status != 200 or b'<!doctype html>' not in response.read(8192).lower():
        raise SystemExit('nginx cannot serve the login page')
library = ctypes.CDLL('libX11.so.6')
library.XOpenDisplay.argtypes = [ctypes.c_char_p]
library.XOpenDisplay.restype = ctypes.c_void_p
library.XCloseDisplay.argtypes = [ctypes.c_void_p]
display = library.XOpenDisplay(os.environ.get('DISPLAY', ':1').encode())
if not display:
    raise SystemExit('X11 display is not ready')
library.XCloseDisplay(display)
