# omp-web — Linux x86-64 appliance: ttyd + tmux + python + omp + web front.
#
# The baked launcher, wrapper and omp run without a home mount. Mounting the
# host home overrides the launcher/wrapper and shares state; mounting a matching
# host tmux socket shares host sessions. The homelab quadlet is host-specific.
#
# omp is the upstream STANDALONE binary (bun-compiled, fully self-contained —
# no bun runtime, no npm cache, no native-addon lookups). Release version and
# SHA256 are pinned together; changing an upstream asset fails the build.
#
# The front page is served by an in-container Caddy on :8080 (/ → wrapper,
# /t/* → local ttyd) so ONE published port is the whole app on foreign hosts.
# The homelab host Caddy keeps proxying /t/* straight to published :7682.

FROM registry.fedoraproject.org/fedora:44

ARG OMP_VERSION=18.3.2
ARG OMP_SHA256=8cbbcd4bea7a7b86116a13352f31e3778fd4d93df931036bb1771738b0702534

# C.UTF-8: tmux decides per-client whether the outer terminal does UTF-8 from
# the attaching client's environment; the POSIX default would make it mark web
# clients non-UTF8 and rewrite the inner apps' unicode box-drawing to ACS
# garbage on output (seen as mangled glyphs like ╰ → _).
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN dnf -y install ttyd screen python3 procps-ng less ncurses caddy git curl libevent libutempter systemd \
    && dnf clean all

# Custom terminfo used by ttyd (-T ttyd-256color) and the launcher's
# set_title trick — must live in a system-wide path because screen is
# setgid and ignores per-user ~/.terminfo.
#   ttyd-256color — kmous-stripped (keeps screen's D_CXT at 0, no title leak)
#   ttyd-256m     — with kmous: tmux enable/parse mouse only with kmous;
#                   the launcher switches to it just for `tmux attach`
COPY ttyd-256color.src ttyd-256m.src /tmp/
RUN tic -x -o /etc/terminfo /tmp/ttyd-256color.src \
    && tic -x -o /etc/terminfo /tmp/ttyd-256m.src \
    && rm /tmp/ttyd-256color.src /tmp/ttyd-256m.src

# Standalone omp from upstream releases, checksum-verified.
RUN cd /tmp \
    && curl -fsSLo omp-linux-x64 \
      "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" \
    && printf '%s  omp-linux-x64\n' "$OMP_SHA256" | sha256sum -c - \
    && install -m 0755 omp-linux-x64 /usr/local/bin/omp \
    && rm omp-linux-x64

# tmux client vendored from the build host — must match the host tmux server
# version (3.5a) for socket attach (tmux is client/server version-strict).
COPY .appliance/tmux /usr/local/bin/tmux

COPY omp-launcher omp-jsonl-view omp-jsonl-pretty /opt/omp-web/
COPY web /opt/omp-web/web
COPY omp-web-entry omp-web-launch /usr/local/bin/
RUN chmod +x /opt/omp-web/* /usr/local/bin/omp-web-*

# Unauthenticated writable terminal: publish only on loopback or behind an
# access-controlled proxy. :8080 includes both the wrapper and terminal.
EXPOSE 8080 7682

ENTRYPOINT ["/usr/local/bin/omp-web-entry"]
