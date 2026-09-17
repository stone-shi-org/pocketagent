# Extending the PocketAgent image with one extra tool.
#
#   docker build -f docker/extend.example.Dockerfile -t pocketagent-server-local .
#
# This image is meant to be extended — an agent is only as useful as the tools
# it can reach, and the base ships the ones the *server* needs rather than the
# ones your repositories need. The volume contract (data root, $HOME, the agent
# prefix, workspace roots) is stable, so adding a layer on top does not have to
# know anything about it.
FROM registry.shifamily.com/homestack/pocketagent-server:latest

# Example: ripgrep, because the planner's grep_files and every coding agent's
# own search are faster with it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Note there is no `USER` instruction here, and adding one would break the
# image. The base sets none on purpose: the container starts as root so the
# entrypoint can remap the `pocketagent` account to PUID/PGID, and only then
# drops privileges with gosu. `USER pocketagent` would take the remap away and
# with it the whole bind-mount ownership story.

# Do not override ENTRYPOINT: it is what remaps the uid, refuses an unwritable
# mount, and drops privileges via gosu. Overriding CMD is fine if you need
# different server arguments.
#
# Two things that look like reasonable additions and are not:
#
#   * Installing an agent CLI here rather than using the `-claude`/`-all` tags.
#     It works, but $HOME/.npm-global/bin precedes /usr/local/bin on PATH, so
#     an operator's on-demand install silently wins over yours. Pin agents in
#     the image only if nothing will ever install into the mounted prefix.
#
#   * Putting application state in a layer. Anything under the data root or
#     $HOME is shadowed by a volume on the first `docker run`.
