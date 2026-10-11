# Build on the deployment host: the upstream manifest selects amd64 or arm64.
ARG BASE_IMAGE=ghcr.io/linuxserver/weixin@sha256:ef55da929cab5fae1f45b902b94918234604fa1473a7a7322383614a51573059
FROM ${BASE_IMAGE}

# Keep our Python packages separate from Selkies and from persistent /config.
# Native wheels are installed for this image's architecture, never copied from a NAS.
COPY mobile/requirements*.txt /opt/nas-chat-mobile/
RUN apt-get update && \
    apt-get install -y --no-install-recommends libx11-6 xclip xdotool python3-venv && \
    python3 -m venv /opt/nas-chat-mobile/venv && \
    /opt/nas-chat-mobile/venv/bin/python3 -m pip install --no-cache-dir \
        -r /opt/nas-chat-mobile/requirements.txt && \
    rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="nas-chat-mobile"
