"""Opt-in Web Push from desktop notifications and recognised client message tones."""
import asyncio
import base64
import hashlib
import html
import json
import queue
import re
import secrets
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit
from client_adapter import get_client
from notification_audio import AudioNotifications
from notification_preview import MessagePreview


def public_origin(value):
    if not isinstance(value, str):
        raise ValueError('推送需要公网 HTTPS 域名')
    url = urlsplit(value)
    host = url.hostname or ''
    if (url.scheme != 'https' or not host or url.username or url.password or url.port not in (None, 443)
            or url.path not in ('', '/') or url.query or url.fragment or '.' not in host
            or re.fullmatch(r'[0-9.]+', host) or host.endswith(('.local', '.localhost'))):
        raise ValueError('推送需要公网 HTTPS 域名')
    return 'https://' + host.encode('idna').decode().lower()


def subscription_info(value):
    if not isinstance(value, dict):
        raise ValueError('推送订阅无效')
    endpoint = value.get('endpoint', '')
    if not isinstance(endpoint, str) or len(endpoint) > 4096:
        raise ValueError('推送地址无效')
    url = urlsplit(endpoint)
    host = (url.hostname or '').lower()
    allowed = (host.endswith('.push.apple.com') or host == 'fcm.googleapis.com'
               or host in ('updates.push.services.mozilla.com', 'push.services.mozilla.com'))
    if not allowed or url.scheme != 'https' or url.port not in (None, 443) or url.username or url.password or url.fragment:
        raise ValueError('不支持这个浏览器的推送服务')
    keys = value.get('keys')
    if not isinstance(keys, dict):
        raise ValueError('推送密钥无效')
    result = {}
    for name, size in (('p256dh', 65), ('auth', 16)):
        encoded = keys.get(name, '')
        if not isinstance(encoded, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}={0,2}', encoded):
            raise ValueError('推送密钥无效')
        raw = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
        if len(raw) != size or (name == 'p256dh' and raw[0] != 4):
            raise ValueError('推送密钥无效')
        result[name] = encoded
    from cryptography.hazmat.primitives.asymmetric import ec
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.urlsafe_b64decode(result['p256dh'] + '=' * (-len(result['p256dh']) % 4)))
    return {'endpoint': endpoint, 'keys': result}


def plain_text(value, limit):
    if not isinstance(value, str):
        return ''
    return html.unescape(re.sub(r'<[^>]*>', '', value))[:limit].strip()


class PushService:
    def __init__(self, root, origin=None, sender=None, clock=time.time, client=None):
        self.client = client or get_client()
        self.root, self.clock = Path(root) / 'push', clock
        self.lock = threading.RLock()
        self.queue = queue.Queue(maxsize=64)
        self.records, self.seen, self.test_times, self.test_reports = {}, {}, {}, {}
        self.origin, self.public_key, self.sender = None, None, sender
        self.source, self.last_event, self.last_delivery, self.last_error = 'disabled', 0, 0, ''
        self.audio = None
        self.preview_reader = None
        self.last_content = 0
        self.last_content_source = 'none'
        self.preview_wait = .65
        self.recent_sources = deque(maxlen=64)
        try:
            if origin is None:
                settings = json.loads((self.root / 'settings.json').read_text())
                if not isinstance(settings, dict):
                    raise ValueError('Invalid push settings')
                origin = settings.get('origin')
            self.origin = public_origin(origin or '')
            if self.sender is None:
                from pywebpush import webpush
                self.sender = webpush
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.root.chmod(0o700)
            self.keyfile = self.root / 'vapid.key'
            if not self.keyfile.exists():
                key = ec.generate_private_key(ec.SECP256R1())
                self.keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
                self.keyfile.chmod(0o600)
            key = serialization.load_pem_private_key(self.keyfile.read_bytes(), password=None)
            self.keyfile.chmod(0o600)
            self.public_key = base64.urlsafe_b64encode(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).decode().rstrip('=')
            try:
                records = json.loads((self.root / 'subscriptions.json').read_text())
                if not isinstance(records, dict):
                    raise ValueError('Invalid subscriptions')
                for identity, item in records.items():
                    if len(self.records) >= 32:
                        break
                    if isinstance(item, dict) and isinstance(item.get('owner'), str) and item.get('expires', 0) > self.clock():
                        item['subscription'] = subscription_info(item['subscription'])
                        if identity == self.identity(item['subscription']['endpoint']):
                            self.records[identity] = item
            except (OSError, ValueError, TypeError, KeyError):
                pass
            self.source = 'starting'
        except (OSError, ValueError, TypeError, ImportError):
            self.origin, self.public_key = None, None

    @property
    def enabled(self):
        return bool(self.origin and self.public_key)

    @staticmethod
    def identity(endpoint):
        return hashlib.sha256(endpoint.encode()).hexdigest()

    def accepts(self, headers):
        return self.enabled and headers.get('Host', '').lower() == urlsplit(self.origin).netloc and headers.get('Origin', self.origin) == self.origin

    def save(self):
        temporary = self.root / 'subscriptions.tmp'
        temporary.write_text(json.dumps(self.records), encoding='utf-8')
        temporary.chmod(0o600)
        temporary.replace(self.root / 'subscriptions.json')

    def status(self, owner):
        with self.lock:
            audio = self.audio.state if self.audio else 'disabled'
            return {'available': self.enabled, 'publicKey': self.public_key,
                    'source': 'connected' if audio == 'connected' else self.source,
                    'sources': {'desktop': self.source, 'audio': audio},
                    'contentSource': self.preview_reader.state if self.preview_reader else 'unavailable',
                    'contentResult': self.preview_reader.last_result if self.preview_reader else 'unavailable',
                    'lastContent': self.last_content,
                    'lastContentSource': self.last_content_source,
                    'lastEvent': self.last_event, 'lastDelivery': self.last_delivery,
                    'deliveryError': self.last_error,
                    'subscriptions': [{'id': identity, 'preview': bool(item.get('preview')), 'test': self.test_reports.get(identity)}
                                      for identity, item in self.records.items() if item['owner'] == owner and item['expires'] > self.clock()]}

    def subscribe(self, owner, expires, subscription, preview=False):
        if not self.enabled:
            raise ValueError('服务器尚未启用推送')
        info = subscription_info(subscription)
        identity = self.identity(info['endpoint'])
        with self.lock:
            self.records = {key: item for key, item in self.records.items() if item['expires'] > self.clock()}
            self.test_reports = {key: report for key, report in self.test_reports.items() if key in self.records}
            if identity not in self.records and len(self.records) >= 32:
                raise ValueError('推送设备过多，请先关闭旧设备推送')
            self.records[identity] = {'owner': owner, 'expires': expires, 'subscription': info, 'preview': preview is True}
            self.save()
        return identity

    def unsubscribe(self, owner, identity=None):
        with self.lock:
            self.records = {key: item for key, item in self.records.items()
                            if not (item['owner'] == owner and (identity is None or key == identity))}
            self.test_reports = {key: report for key, report in self.test_reports.items() if key in self.records}
            if self.enabled:
                self.save()

    def revoke_all(self):
        with self.lock:
            self.records.clear()
            self.test_reports.clear()
            if self.enabled:
                self.save()

    def enqueue(self, identity, item, summary='', body='', test=False, ticket=None, event=None):
        preview = bool(item.get('preview')) and not test
        payload = {'title': plain_text(summary, 100) if preview else ('推送测试' if test else '聊天 · 新消息'),
                   'body': plain_text(body, 400) if preview else ('通知已开启，可以关闭页面测试接收。' if test else '你有新的聊天消息，点击查看。'),
                   'url': '/mobile/?notifications=1', 'tag': 'nas-chat-test' if test else 'nas-chat-new-message'}
        payload['_content_source'] = 'desktop' if preview and event and event['source'] == 'desktop' else 'generic'
        if preview and event and event['source'] == 'audio':
            payload['_event'] = event
        try:
            self.queue.put_nowait((identity, item['owner'], self.clock(), payload, ticket))
            return True
        except queue.Full:
            return False

    def notify(self, summary, body, event_id, source='desktop'):
        with self.lock:
            now = self.clock()
            self.seen = {key: stamp for key, stamp in self.seen.items() if now - stamp < 60}
            if event_id in self.seen:
                return
            self.seen[event_id] = now
            if len(self.seen) > 512:
                self.seen.pop(next(iter(self.seen)))
            # Some client versions emit both signals for the same incoming
            # message. Coalesce only across sources, never distinct D-Bus IDs.
            self.recent_sources = deque((event for event in self.recent_sources if now-event['created'] < 1.2), maxlen=64)
            other = next((event for event in reversed(self.recent_sources) if event['source'] != source and not event['paired']), None)
            if other:
                other['paired'] = True
                if source == 'desktop':
                    other['rich'] = (summary, body)
                    other['ready'].set()
                return
            event = {'source':source, 'created':now, 'stamp':time.monotonic(), 'paired':False,
                     'rich':(summary,body) if source == 'desktop' else None, 'ready':threading.Event()}
            self.recent_sources.append(event)
            self.last_event = now
            for identity, item in self.records.items():
                if item['expires'] > now:
                    self.enqueue(identity, item, summary, body, event=event)

    def test(self, owner, identity):
        if not isinstance(identity, str):
            raise ValueError('推送订阅无效')
        with self.lock:
            item = self.records.get(identity)
            if not item or item['owner'] != owner or item['expires'] <= self.clock():
                raise ValueError('请先开启这台设备的推送')
            if self.clock() - self.test_times.get(owner, 0) < 10:
                raise ValueError('请稍等几秒再测试')
            self.test_times[owner] = self.clock()
            ticket = secrets.token_hex(8)
            self.test_reports[identity] = {'id': ticket, 'state': 'queued'}
            if not self.enqueue(identity, item, test=True, ticket=ticket):
                raise ValueError('通知队列繁忙，请稍后重试')
            return ticket

    def test_report(self, identity, owner, ticket, state, error=''):
        if ticket:
            with self.lock:
                if self.records.get(identity, {}).get('owner') == owner and self.test_reports.get(identity, {}).get('id') == ticket:
                    self.test_reports[identity] = {'id': ticket, 'state': state, 'error': error}

    def deliver(self, job):
        identity, owner, created, payload, ticket = job
        payload = dict(payload)
        event = payload.pop('_event', None)
        content_source = payload.pop('_content_source', 'generic')
        with self.lock:
            item = self.records.get(identity)
            if not item or item['owner'] != owner or item['expires'] <= self.clock() or self.clock() - created > 120:
                return
            info = item['subscription']
            preview = bool(item.get('preview'))
        if event and preview:
            event['ready'].wait(self.preview_wait)
            content = event['rich']
            if not content and self.preview_reader:
                try: content = self.preview_reader.resolve(event['stamp'])
                except Exception: content = None
            content_source = 'desktop' if event['rich'] else 'screen-preview' if content else 'generic'
            content = event['rich'] or content
            if content:
                payload.update(title=plain_text(content[0],100), body=plain_text(content[1],400))
        # OCR can take time. Recheck revocation and the content switch before
        # handing anything to a push provider; internal metadata never leaves.
        with self.lock:
            item = self.records.get(identity)
            if not item or item['owner'] != owner or item['expires'] <= self.clock() or self.clock()-created > 120:
                return
            if payload['tag'] == 'nas-chat-new-message' and not item.get('preview'):
                payload = dict(payload, title='聊天 · 新消息', body='你有新的聊天消息，点击查看。')
                content_source = 'generic'
        try:
            response = self.sender(subscription_info=info, data=json.dumps(payload, ensure_ascii=False),
                        vapid_private_key=str(self.keyfile), vapid_claims={'sub': self.origin},
                        ttl=120, timeout=8, headers={'Urgency': 'high'})
            if response is not None and not 200 <= response.status_code < 300:
                raise RuntimeError('Push service rejected delivery')
            self.last_delivery, self.last_error = self.clock(), ''
            if payload['tag'] == 'nas-chat-new-message':
                self.last_content_source = content_source
            if payload['tag'] == 'nas-chat-new-message' and payload['title'] != '聊天 · 新消息':
                self.last_content = self.clock()
            self.test_report(identity, owner, ticket, 'accepted')
        except Exception as error:
            response = getattr(error, 'response', None)
            status = getattr(response, 'status_code', None)
            self.last_error = ('订阅已失效，请重新开启' if status in (404, 410) else
                               '推送服务拒绝投递（HTTP '+str(status)+'），请关闭后重新开启' if status else '推送服务暂时不可达')
            self.test_report(identity, owner, ticket, 'error', self.last_error)
            if status in (404, 410):
                with self.lock:
                    if self.records.get(identity, {}).get('owner') == owner:
                        self.records.pop(identity, None)
                        self.save()

    def worker(self):
        while True:
            job = self.queue.get()
            try:
                self.deliver(job)
            except Exception:
                self.last_error = '推送暂时失败'
            finally:
                self.queue.task_done()

    def start(self, snapshot=None):
        if not self.enabled:
            return
        if snapshot:
            self.preview_reader = MessagePreview(snapshot, self.has_preview_subscribers)
            self.preview_reader.start()
        for _ in range(2):
            threading.Thread(target=self.worker, daemon=True).start()
        threading.Thread(target=self.watch, daemon=True).start()
        self.audio = AudioNotifications(self.client,
            lambda: self.notify('聊天 · 新消息', '你有新的聊天消息，点击查看。',
                                ('audio', time.monotonic_ns()), source='audio'),
            self.has_subscribers)
        self.audio.start()

    def has_subscribers(self):
        with self.lock:
            return any(item['expires'] > self.clock() for item in self.records.values())

    def has_preview_subscribers(self):
        with self.lock:
            return any(item.get('preview') and item['expires'] > self.clock() for item in self.records.values())

    def accepts_notification(self, app):
        return str(app).casefold() in self.client.notification_apps

    def session_bus(self):
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                name = (process / 'cmdline').read_bytes().split(b'\0')[0].decode()
                if Path(name).name.casefold() not in self.client.process_names:
                    continue
                environment = (process / 'environ').read_bytes().split(b'\0')
                for value in environment:
                    if value.startswith(b'DBUS_SESSION_BUS_ADDRESS='):
                        return value.split(b'=', 1)[1].decode()
            except (OSError, UnicodeError):
                pass
        return None

    async def monitor(self, address):
        from dbus_next.aio import MessageBus
        from dbus_next import Message, MessageType
        bus = await MessageBus(bus_address=address).connect()
        try:
            def received(message):
                if message.message_type != MessageType.METHOD_CALL or message.interface != 'org.freedesktop.Notifications' or message.member != 'Notify':
                    return
                values = message.body
                if len(values) >= 5 and self.accepts_notification(values[0]):
                    self.notify(values[3], values[4], (message.sender, message.serial))
                # A monitor must never reply to another connection's method call.
                return True
            bus.add_message_handler(received)
            match = "type='method_call',interface='org.freedesktop.Notifications',member='Notify',path='/org/freedesktop/Notifications'"
            response = await bus.call(Message(destination='org.freedesktop.DBus', path='/org/freedesktop/DBus',
                                              interface='org.freedesktop.DBus.Monitoring', member='BecomeMonitor',
                                              signature='asu', body=[[match], 0]))
            if response.message_type == MessageType.ERROR:
                raise RuntimeError('Notification monitor unavailable')
            self.source = 'connected'
            await bus.wait_for_disconnect()
        finally:
            bus.disconnect()

    def watch(self):
        while True:
            try:
                address = self.session_bus()
                if address:
                    asyncio.run(self.monitor(address))
                self.source = 'waiting'
            except Exception:
                self.source = 'unavailable'
            time.sleep(8)
