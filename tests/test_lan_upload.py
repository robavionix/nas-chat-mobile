import ast
import hashlib
import hmac
import io
import json
import re
import secrets
import struct
import time
import unittest
from pathlib import Path
from urllib.parse import unquote

SERVER = Path('mobile/server.py').read_text(encoding='utf-8')
TREE = ast.parse(SERVER)


def functions(*names, **extra):
    """Compile selected top-level or method definitions from server.py into a namespace."""
    found = {node.name: node for node in ast.walk(TREE) if isinstance(node, ast.FunctionDef) and node.name in names}
    assert set(found) == set(names), set(names) - set(found)
    ns = {'hmac': hmac, 'hashlib': hashlib, 'secrets': secrets, 'time': time, 're': re, 'json': json,
          'unquote': unquote, 'MAX_UPLOAD': 95 * 1024 * 1024, 'session_key': b'k' * 32,
          'STREAM_TOKEN_SECONDS': 120, 'UPLOAD_TOKEN_SECONDS': 120}
    for node in TREE.body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'CORS_ORIGIN' for t in node.targets):
            exec(compile(ast.Module(body=[node], type_ignores=[]), 'cors', 'exec'), ns)
    ns.update(extra)
    exec(compile(ast.Module(body=[found[n] for n in names], type_ignores=[]), 'server-part', 'exec'), ns)
    return ns


class Request:
    def __init__(self, path='/upload?via=lan', headers=None, body=b''):
        self.path = path
        self.headers = headers or {}
        self.rfile = io.BytesIO(body)
        self.replies, self.sent = [], []

    def reply(self, status, **value):
        self.replies.append((status, value, self.__dict__.pop('cors_origin', None)))
        return status, value

    def send_response(self, status):
        self.sent.append(('status', status))

    def send_header(self, name, value):
        self.sent.append((name, value))

    def end_headers(self):
        self.sent.append(('end', None))


def lan_body(meta, payload=b'x' * 10):
    head = json.dumps(meta).encode()
    return struct.pack('>I', len(head)) + head + payload


class UploadTokenTest(unittest.TestCase):
    def setUp(self):
        self.ns = functions('upload_token', 'upload_token_valid', 'stream_token', 'stream_token_valid')

    def test_tokens_are_signed_short_lived_and_not_interchangeable(self):
        upload, stream = self.ns['upload_token'](), self.ns['stream_token']()
        self.assertTrue(self.ns['upload_token_valid'](upload))
        self.assertFalse(self.ns['upload_token_valid'](stream), 'a picture-stream token cannot upload')
        self.assertFalse(self.ns['stream_token_valid'](upload), 'an upload token cannot open the stream')
        kind, expiry, nonce, signature = upload.split('.')
        self.assertLessEqual(int(expiry) - time.time(), 121)
        self.assertFalse(self.ns['upload_token_valid']('.'.join((kind, expiry, nonce, '0' * 64))))
        self.assertFalse(self.ns['upload_token_valid']('.'.join((kind, str(int(expiry) + 999), nonce, signature))))
        self.assertFalse(self.ns['upload_token_valid'](None))
        old = 'upload.' + str(int(time.time()) - 1) + '.00'
        old += '.' + hmac.new(self.ns['session_key'], old.encode(), hashlib.sha256).hexdigest()
        self.assertFalse(self.ns['upload_token_valid'](old), 'expired tokens are refused')


class LanUploadRequestTest(unittest.TestCase):
    def setUp(self):
        self.tokens = functions('upload_token', 'upload_token_valid')
        self.ns = functions('upload', upload_token_valid=self.tokens['upload_token_valid'])

    def run_upload(self, body, origin='https://chat.example.com'):
        request = Request(headers={'Content-Length': str(len(body)), 'Origin': origin}, body=body)
        status, value = self.ns['upload'](request, lan=True)
        return status, value, request.replies[-1][2]

    def test_bad_token_is_refused_with_a_readable_cors_reply(self):
        status, value, cors = self.run_upload(lan_body({'token': 'upload.1.2.3', 'id': 'r' * 20}))
        self.assertEqual(status, 401)
        self.assertEqual(cors, 'https://chat.example.com', 'the public page can read the refusal and fall back')

    def test_unknown_origins_get_no_cors_header(self):
        *_, cors = self.run_upload(lan_body({'token': 'bad'}), origin='http://evil.example')
        self.assertIsNone(cors)

    def test_malformed_header_is_a_format_error(self):
        self.assertEqual(self.run_upload(b'\x00\x00')[0], 400)
        self.assertEqual(self.run_upload(struct.pack('>I', 99999) + b'{}')[0], 400)

    def test_valid_token_reads_metadata_from_the_body_not_the_address(self):
        meta = {'token': self.tokens['upload_token'](), 'id': 'bad id', 'name': 'a.png', 'window': 7, 'conversation': 'c'}
        status, value, _ = self.run_upload(lan_body(meta))
        self.assertEqual((status, value['error']), (400, '请求格式错误'), 'reaches the request-id check with the body header parsed')
        meta['id'] = 'r' * 20
        body = lan_body(meta, b'')
        request = Request(headers={'Content-Length': str(len(body) + 96 * 1024 * 1024), 'Origin': 'https://chat.example.com'}, body=body)
        self.assertEqual(self.ns['upload'](request, lan=True)[0], 413, 'size limit applies to the file, after the header')


class RoutingTest(unittest.TestCase):
    def test_token_uploads_skip_the_same_origin_header_but_cookie_uploads_need_a_session(self):
        ns = functions('do_POST', authenticated=lambda headers: headers.get('Cookie') == 'ok')
        calls = []

        class Handler(Request):
            def upload(self, lan=False):
                calls.append(lan)
                return 'uploaded'

        self.assertEqual(ns['do_POST'](Handler('/upload?via=lan')), 'uploaded')
        self.assertEqual(calls, [True])
        self.assertEqual(ns['do_POST'](Handler('/upload', {'X-Mobile-Control': '1'}))[0], 401, 'nginx no longer checks the cookie')
        self.assertEqual(ns['do_POST'](Handler('/upload', {'X-Mobile-Control': '1', 'Cookie': 'ok'})), 'uploaded')
        self.assertEqual(ns['do_POST'](Handler('/upload', {'Cookie': 'ok'}))[0], 403, 'cookie uploads still need the page header')

    def test_preflight_allows_only_https_origins_for_the_lan_upload(self):
        ns = functions('do_OPTIONS')
        ok = Request('/upload?via=lan', {'Origin': 'https://chat.example.com'})
        ns['do_OPTIONS'](ok)
        headers = dict(item for item in ok.sent if item[0] not in ('end',))
        self.assertEqual(headers['status'], 204)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://chat.example.com')
        self.assertEqual(headers['Access-Control-Allow-Private-Network'], 'true')
        for path, origin in (('/upload?via=lan', 'http://chat.example.com'), ('/layout', 'https://chat.example.com')):
            bad = Request(path, {'Origin': origin})
            self.assertEqual(ns['do_OPTIONS'](bad)[0], 403)

    def test_upload_token_endpoint_requires_a_session(self):
        self.assertRegex(SERVER, r"if self\.path == '/upload-token':\n\s*if not authenticated\(self\.headers\):")


class GeneratedNginxTest(unittest.TestCase):
    def test_upload_location_is_left_to_the_gateway_on_every_server_block(self):
        script = Path('mobile-init/50-mobile').read_text(encoding='utf-8')
        code = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        state = {'source': 'server {\n  listen 3000;\n  location / { proxy_pass http://upstream; }\n}\n'
                           'server {\n  listen 3001 ssl;\n  location / { proxy_pass http://upstream; }\n}\n'}

        class File:
            def __init__(self, path): pass
            def read_text(self): return state['source']
            def write_text(self, text): state['source'] = text
            def is_dir(self): return False

        tree = ast.parse(code)
        tree.body = [node for node in tree.body if not isinstance(node, ast.ImportFrom)]
        exec(compile(tree, 'nginx', 'exec'), {'Path': File})
        first = state['source']
        exec(compile(tree, 'nginx', 'exec'), {'Path': File})
        self.assertEqual(first, state['source'], 'idempotent')
        blocks = re.findall(r'location = /mobile-api/upload \{(.*?)\}', first, re.S)
        self.assertEqual(len(blocks), 2)
        self.assertTrue(all('auth_request off;' in block and 'client_max_body_size 100m;' in block for block in blocks))
        self.assertEqual(first.count('# mobile-upload-token-v1'), 2)


if __name__ == '__main__':
    unittest.main()
