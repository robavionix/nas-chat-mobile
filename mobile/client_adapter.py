"""Client identities and UI profiles. Keep desktop accounts in separate containers."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ClientAdapter:
    key: str
    label: str
    window_classes: tuple
    window_names: tuple
    process_names: tuple
    notification_apps: tuple
    phone_layout: bool

    def matches(self, window):
        return (window['class'].casefold() in self.window_classes
                and window['name'] in self.window_names and not window['override'])


CLIENTS = {
    'wechat': ClientAdapter('wechat', '微信', ('wechat',), ('WeChat', 'Weixin', '微信'),
                            ('wechat', 'weixin'),
                            ('wechat', 'weixin', '微信', 'com.tencent.wechat', 'com.tencent.weixin'), True),
    # The QQ desktop has a persistent conversation column. Its geometry is
    # verified from separator pixels before exposing mobile input controls.
    'qq': ClientAdapter('qq', 'QQ', ('qq', 'linuxqq'), ('QQ', '腾讯QQ', 'Linux QQ'),
                        ('qq', 'linuxqq'), ('qq', 'linuxqq', '腾讯qq', 'com.qq.qq', 'com.tencent.qq'), False),
}


def get_client(name=None):
    key = (name if name is not None else os.environ.get('CHAT_CLIENT', 'wechat')).casefold()
    if key not in CLIENTS:
        raise ValueError('CHAT_CLIENT must be wechat or qq')
    return CLIENTS[key]
