FROM registry.fedoraproject.org/fedora:44 AS build
ARG TMUX_VERSION=3.5a
ARG TMUX_SHA256=16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=039dd995229377caee919898b7bd54484accec3bba49c118e2d5cd6ec51e3650
ARG OMP_VERSION=18.3.2
ARG OMP_SHA256=8cbbcd4bea7a7b86116a13352f31e3778fd4d93df931036bb1771738b0702534
RUN dnf -y install gcc make cmake pkgconf-pkg-config tar gzip curl bison \
    libevent-devel ncurses-devel json-c-devel libwebsockets-devel libuv-devel \
    openssl-devel zlib-devel nodejs npm && dnf clean all
WORKDIR /build
RUN curl -fL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" -o tmux.tar.gz \
    && printf '%s  tmux.tar.gz\n' "$TMUX_SHA256" | sha256sum -c - \
    && tar xzf tmux.tar.gz \
    && cd "tmux-${TMUX_VERSION}" && ./configure --prefix=/usr/local && make -j2 && make install
RUN curl -fL "https://codeload.github.com/tsl0922/ttyd/tar.gz/refs/tags/${TTYD_VERSION}" -o ttyd.tar.gz \
    && printf '%s  ttyd.tar.gz\n' "$TTYD_SHA256" | sha256sum -c - \
    && tar xzf ttyd.tar.gz \
    && cmake -S "ttyd-${TTYD_VERSION}" -B ttyd-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build ttyd-build -j2 && cmake --install ttyd-build
RUN curl -fL "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" -o omp \
    && printf '%s  omp\n' "$OMP_SHA256" | sha256sum -c - \
    && install -m 0755 omp /usr/local/bin/omp
COPY package.json package-lock.json build-web.mjs ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build

FROM registry.fedoraproject.org/fedora:44
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 OMP_WEB_ROOT=/opt/omp-web
ENV OMP_BIND_ADDRESS=0.0.0.0
ENV PATH=/opt/omp-web:/usr/local/bin:/usr/bin:/bin
RUN dnf -y install python3 screen less ncurses caddy git curl systemd \
    libevent json-c libwebsockets libuv openssl-libs zlib && dnf clean all
COPY --from=build /usr/local/bin/tmux /usr/local/bin/ttyd /usr/local/bin/omp /usr/local/bin/
COPY omp-launcher omp-jsonl-view omp-jsonl-pretty omp-web-entry omp-web-launch omp-web-upload omp-web.sh omp-config.yml tmux.conf Caddyfile /opt/omp-web/
COPY web/ /opt/omp-web/web/
COPY --from=build /build/web/vendor/ /opt/omp-web/web/vendor/
RUN chmod 0755 /opt/omp-web/omp-launcher /opt/omp-web/omp-jsonl-view /opt/omp-web/omp-jsonl-pretty \
    /opt/omp-web/omp-web-entry /opt/omp-web/omp-web-launch /opt/omp-web/omp-web-upload
WORKDIR /root
# Writable terminal; only publish loopback or put behind an authenticated proxy.
EXPOSE 8080 7682
ENTRYPOINT ["/opt/omp-web/omp-web-entry"]
