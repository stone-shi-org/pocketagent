#!/bin/sh
# PocketAgent container entrypoint (PA-64).
#
# Two jobs, in order:
#
#   1. Make the container's user id match the host user who owns the mounted
#      repositories, because an agent writing into a bind mount writes as
#      whatever uid this process has. A mismatch does not merely leave
#      root-owned files behind — `git` refuses a repository whose owner it
#      cannot match ("detected dubious ownership"), so `git status` and every
#      worktree operation fail too.
#
#   2. Refuse to start, with the fix in the message, when a directory the
#      server must write to is not writable by that user. This is the same
#      posture ConfigError takes for a bad environment: fail loudly at boot
#      rather than half-working.
#
# What it deliberately does NOT do: chown a mounted volume. A mount belongs to
# the operator, and silently rewriting the ownership of a tree of their
# repositories or their agent credentials is not this script's decision to
# make. It chowns only paths that are still part of the image's own filesystem
# — which is what makes `install -d -o pocketagent /data` in the Dockerfile
# meaningful for an empty named volume while leaving a bind mount alone.
set -eu

APP_USER=pocketagent
APP_GROUP=pocketagent

log() { printf 'pocketagent-entrypoint: %s\n' "$*" >&2; }

die() {
    printf '\n' >&2
    log "$*"
    printf '\n' >&2
    # 78 is EX_CONFIG, the same code server.ts uses for a ConfigError, so a
    # supervisor cannot tell a bad mount from a bad environment variable and
    # does not need to.
    exit 78
}

# Is this exact path a mount point? Compared against /proc/self/mountinfo
# rather than `stat`-ing the parent, because a bind mount of a directory onto
# an image directory on the same filesystem shares a device number and would
# not be detected that way.
is_mount_point() {
    awk -v target="$1" '$5 == target { found = 1 } END { exit found ? 0 : 1 }' \
        /proc/self/mountinfo
}

# Writable *by the app user*, which is not the same question as writable by
# whoever is running this script.
writable_by_app_user() {
    if [ "$(id -u)" = '0' ]; then
        gosu "$APP_USER" test -w "$1"
    else
        test -w "$1"
    fi
}

require_writable() {
    path="$1"
    label="$2"
    hint_var="$3"

    if [ ! -d "$path" ]; then
        # Not an error on its own: db/index.ts creates the data root
        # recursively. It only matters whether the *nearest existing* parent
        # can be written, so walk up to it and test that instead.
        parent="$path"
        while [ ! -d "$parent" ] && [ "$parent" != '/' ]; do
            parent=$(dirname "$parent")
        done
        path="$parent"
    fi

    if writable_by_app_user "$path"; then
        return 0
    fi

    owner=$(stat -c '%u:%g' "$path" 2>/dev/null || echo 'unknown')
    die "$label ($path) is not writable by uid $TARGET_UID:$TARGET_GID.

It is owned by $owner inside the container.

If that path is a bind mount, fix it on the *host* — this entrypoint will not
chown a mounted volume:

    sudo chown -R $TARGET_UID:$TARGET_GID <the host directory>

or start the container with PUID/PGID matching the host owner:

    -e PUID=\$(id -u) -e PGID=\$(id -g)

($hint_var selects this path.)"
}

if [ "$(id -u)" = '0' ]; then
    TARGET_UID="${PUID:-1000}"
    TARGET_GID="${PGID:-1000}"

    case "$TARGET_UID" in *[!0-9]*) die "PUID must be a number, got '$TARGET_UID'." ;; esac
    case "$TARGET_GID" in *[!0-9]*) die "PGID must be a number, got '$TARGET_GID'." ;; esac
    [ "$TARGET_UID" = '0' ] && die "PUID=0 would run the agent as root. Use --user 0:0 if you truly mean it."

    CURRENT_UID=$(id -u "$APP_USER")
    CURRENT_GID=$(id -g "$APP_USER")

    if [ "$TARGET_GID" != "$CURRENT_GID" ]; then
        log "remapping group $APP_GROUP: $CURRENT_GID -> $TARGET_GID"
        groupmod --non-unique --gid "$TARGET_GID" "$APP_GROUP"
    fi
    if [ "$TARGET_UID" != "$CURRENT_UID" ]; then
        log "remapping user $APP_USER: $CURRENT_UID -> $TARGET_UID"
        usermod --non-unique --uid "$TARGET_UID" "$APP_USER"
    fi

    # Seed dotfiles from /etc/skel if HOME is missing them (e.g. fresh bind mount or named volume)
    if [ ! -d "$HOME/.oh-my-zsh" ] && [ -d /etc/skel/.oh-my-zsh ]; then
        cp -r /etc/skel/.oh-my-zsh "$HOME/" 2>/dev/null || true
    fi
    if [ ! -f "$HOME/.zshrc" ] && [ -f /etc/skel/.zshrc ]; then
        cp /etc/skel/.zshrc "$HOME/" 2>/dev/null || true
    fi

    # Only ever the image's own directories. $HOME and the data root are the
    # two the remap can strand, and each is skipped the moment it turns out to
    # be a mount — at which point ownership is the operator's to set and
    # require_writable below is what reports it.
    for dir in "$HOME" "${POCKETAGENT_DATA_DIR:-/data}"; do
        [ -d "$dir" ] || continue
        if is_mount_point "$dir"; then
            log "$dir is a mount point; leaving its ownership alone"
            if [ "$dir" = "$HOME" ]; then
                [ -d "$HOME/.oh-my-zsh" ] && chown -R "$TARGET_UID:$TARGET_GID" "$HOME/.oh-my-zsh" 2>/dev/null || true
                [ -f "$HOME/.zshrc" ] && chown "$TARGET_UID:$TARGET_GID" "$HOME/.zshrc" 2>/dev/null || true
            fi
        else
            chown -R "$TARGET_UID:$TARGET_GID" "$dir"
        fi
    done
else
    # `--user` was passed. Nothing to remap (that needs root), and PUID/PGID
    # cannot be honoured, so say so rather than appearing to accept them.
    TARGET_UID=$(id -u)
    TARGET_GID=$(id -g)
    if [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; then
        log "running as uid $TARGET_UID via --user; ignoring PUID/PGID"
    fi
    # os.homedir() reads $HOME before it consults the passwd database, and the
    # image sets $HOME, so this works without a passwd entry for the uid. It is
    # still the second-class option: git and some agent CLIs want a real entry.
    # `id -un` resolves the *name*, which is what needs a passwd entry — `id -u`
    # just echoes the numeric uid and succeeds either way.
    if ! id -un > /dev/null 2>&1; then
        log "warning: uid $TARGET_UID has no passwd entry; git and some agent CLIs want one, so prefer -e PUID/-e PGID over --user"
    fi
fi

require_writable "${POCKETAGENT_DATA_DIR:-/data}" 'The data root' 'POCKETAGENT_DATA_DIR'
require_writable "$HOME" 'HOME' 'HOME'

if [ "$(id -u)" = '0' ]; then
    exec gosu "$APP_USER" "$@"
fi

exec "$@"
