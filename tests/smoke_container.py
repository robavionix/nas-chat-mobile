"""Run inside a disposable, logged-out container as abc. Never use on a live desktop.

docker exec -i -u abc chat-remote /custom-services.d/mobile/python - < tests/smoke_container.py
"""
import ast
import ctypes
import http.client
import io
import json
import os
import platform
import socket
import struct
import subprocess
import sys
from pathlib import Path

assert platform.machine() in ('x86_64', 'aarch64'), platform.machine()
assert sys.maxsize > 2**32
from PIL import Image
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import webpush
from dbus_next import Message
ec.generate_private_key(ec.SECP256R1())

# Load the actual Xlib wrapper, excluding only the module's final server startup.
source = Path('/config/mobile/server.py').read_text()
tree = ast.parse(source)
startup = next(index for index, node in enumerate(tree.body)
               if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
               and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'mkdir'
               and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == 'UPLOADS')
tree.body = tree.body[:startup]
namespace = {'__name__': 'smoke_test'}
sys.path.insert(0, '/config/mobile')
exec(compile(tree, 'server.py', 'exec'), namespace)
assert namespace['layout']()['mainWindow']
with namespace['X']() as display:
    assert display.width >= 760 and display.height >= 640
    picture = display.grab(0, 0, 64, 64)
    assert picture.mode == 'RGB' and picture.size == (64, 64)
    windows = display.windows()
    assert any(w['class'].lower() in ('wechat', 'weixin') for w in windows), windows

    # Verify native Xlib ABI, row stride and BGRX colour order on this architecture.
    library = namespace['_x']
    library.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                          ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    library.XCreateSimpleWindow.restype = ctypes.c_ulong
    library.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    library.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    library.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    identity = library.XCreateSimpleWindow(display.d, display.root, 20, 20, 64, 64, 0, 0, 0x19A3E4)
    try:
        library.XMapRaised(display.d, identity)
        library.XSync(display.d, 0)
        import time
        time.sleep(.5)
        x, y = display.origin(identity)
        assert display.grab(x, y, 64, 64).getpixel((32, 32)) == (0x19, 0xA3, 0xE4)
    finally:
        library.XDestroyWindow(display.d, identity)
        library.XSync(display.d, 0)

# Only our test window receives simulated input; no chat account is signed in.
window = subprocess.Popen(['xmessage', '-name', 'nas-chat-smoke', '-buttons', 'OK:0', '-timeout', '15', 'Container input test'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    identity = subprocess.check_output(['xdotool', 'search', '--sync', '--onlyvisible', '--name', 'nas-chat-smoke'], timeout=10).decode().splitlines()[0]
    subprocess.run(['xdotool', 'windowactivate', '--sync', identity, 'key', 'Tab'], check=True, timeout=5)
    subprocess.run(['xclip', '-selection', 'clipboard'], input='剪贴板 x86/ARM test'.encode(),
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
    assert subprocess.check_output(['xclip', '-o', '-selection', 'clipboard'], timeout=5).decode() == '剪贴板 x86/ARM test'
finally:
    window.terminate()
    window.wait(timeout=5)

connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=5)
connection.request('GET', '/mobile/login')
response = connection.getresponse()
assert response.status == 200 and b'<!doctype html>' in response.read().lower()
connection.request('GET', '/mobile/')
response = connection.getresponse()
assert response.status == 302 and response.getheader('Location').endswith('/mobile/login')
response.read()
connection.request('POST', '/session/login', body=json.dumps({'password': os.environ['PASSWORD']}),
                   headers={'Content-Type': 'application/json', 'X-Mobile-Control': '1', 'Host': 'chat.example.com', 'Origin': 'https://chat.example.com'})
response = connection.getresponse()
assert response.status == 200, response.read()
cookie = response.getheader('Set-Cookie')
assert cookie and 'Secure' in cookie and 'HttpOnly' in cookie
response.read()
connection.request('GET', '/mobile-api/layout', headers={'Cookie': cookie.split(';', 1)[0]})
response = connection.getresponse()
assert response.status == 200 and json.loads(response.read())['layout']['mainWindow']
connection.close()

# Exercise the real nginx Upgrade route and decode the first full-resolution packet.
with socket.create_connection(('127.0.0.1', 3000), timeout=10) as stream:
    stream.sendall(('GET /mobile-api/ws?quality=lossless HTTP/1.1\r\n'
                    'Host: chat.example.com\r\nOrigin: https://chat.example.com\r\n'
                    'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
                    f'Cookie: {cookie.split(";", 1)[0]}\r\n\r\n').encode())
    reader = stream.makefile('rb')
    assert b'101' in reader.readline()
    while True:
        line = reader.readline()
        assert line, 'Connection closed before Upgrade headers completed'
        if line == b'\r\n':
            break
    first, second = reader.read(2)
    assert first == 0x82 and second & 0x80 == 0
    size = second & 0x7F
    if size == 126:
        size = struct.unpack('>H', reader.read(2))[0]
    elif size == 127:
        size = struct.unpack('>Q', reader.read(8))[0]
    assert size < 32 * 1024 * 1024
    packet = reader.read(size)
    assert len(packet) == size
    head_size, blobs_size = struct.unpack('>II', packet[:8])
    metadata = json.loads(packet[8:8 + head_size])
    assert metadata['full'] and metadata['strips']
    assert blobs_size == len(packet) - 8 - head_size
    offset = 8 + head_size
    for top, height, length, left, width, mime in metadata['strips']:
        picture = Image.open(io.BytesIO(packet[offset:offset + length]))
        assert mime == 'image/png' and picture.size == (width, height)
        picture.load()
        offset += length
    assert offset == len(packet)
    # Masked ACK and close frame: no external messages or push requests.
    mask = b'test'
    ack = f'ack {metadata["seq"]}'.encode()
    stream.sendall(bytes([0x81, 0x80 | len(ack)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(ack)))
    stream.sendall(b'\x88\x80' + mask)
    reader.close()
print(f'Smoke test passed: {platform.machine()}, Python {platform.python_version()}, X11 colours/layout, input, clipboard, push crypto, nginx login/API, lossless WebSocket frame.')
