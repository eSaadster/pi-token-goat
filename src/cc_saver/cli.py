"""Typer CLI with stub subcommands."""
import typer

app = typer.Typer(name="cc-saver", no_args_is_help=True)
hook_app = typer.Typer(name="hook", no_args_is_help=True)
config_app = typer.Typer(name="config", no_args_is_help=True)

app.add_typer(hook_app)
app.add_typer(config_app)


@app.command()
def symbol(name: str, all_projects: bool = typer.Option(False, "--all-projects")):
    """Find symbol definition across codebase."""
    typer.echo("not yet implemented: symbol")


@app.command()
def ref(name: str):
    """Find all references to a symbol."""
    typer.echo("not yet implemented: ref")


@app.command()
def semantic(query: str, k: int = typer.Option(5, "-k")):
    """Semantic search by description."""
    typer.echo("not yet implemented: semantic")


@app.command()
def map(budget: int = typer.Option(4000, "--budget")):
    """Generate repo map (PageRank layout)."""
    typer.echo("not yet implemented: map")


@app.command()
def deps(file: str):
    """Show dependency graph for file."""
    typer.echo("not yet implemented: deps")


@app.command()
def read(target: str):
    """Read file::symbol from index."""
    typer.echo("not yet implemented: read")


@app.command()
def section(target: str):
    """Extract file::heading section."""
    typer.echo("not yet implemented: section")


@app.command()
def session_touched():
    """List touched files in current Claude session."""
    typer.echo("not yet implemented: session-touched")


@app.command()
def session_mark(file: str):
    """Mark file as touched in current session."""
    typer.echo("not yet implemented: session-mark")


@app.command()
def gdrive_fetch(file_id: str):
    """Fetch image from Google Drive by ID."""
    typer.echo("not yet implemented: gdrive-fetch")


@app.command()
def fetch_image(url: str):
    """Cache image from URL locally."""
    typer.echo("not yet implemented: fetch-image")


@app.command()
def caption_instead(path: str):
    """Generate text caption instead of image (v2 feature)."""
    typer.echo("v2 feature, not in v1")


@app.command()
def index(full: bool = typer.Option(False, "--full"), embeddings: bool = typer.Option(False, "--embeddings")):
    """Rebuild project/global indices."""
    typer.echo("not yet implemented: index")


@app.command()
def stats():
    """Show token savings and cache stats."""
    typer.echo("not yet implemented: stats")


@app.command()
def doctor():
    """Diagnose indexing health."""
    typer.echo("not yet implemented: doctor")


@app.command()
def install():
    """Install hook entrypoints and Windows Scheduled Task."""
    typer.echo("not yet implemented: install")


@app.command()
def uninstall(purge: bool = typer.Option(False, "--purge")):
    """Uninstall hook entrypoints and Scheduled Task."""
    typer.echo("not yet implemented: uninstall")


@app.command(hidden=True)
def worker(daemon: bool = typer.Option(False, "--daemon")):
    """Background worker daemon."""
    typer.echo("not yet implemented: worker")


@hook_app.command()
def session_start(input_file: str = typer.Option(None, "--input-file")):
    """Hook: session-start event."""
    typer.echo('{"continue": true}')


@hook_app.command()
def pre_read(input_file: str = typer.Option(None, "--input-file")):
    """Hook: pre-read event."""
    typer.echo('{"continue": true}')


@hook_app.command()
def pre_fetch(input_file: str = typer.Option(None, "--input-file")):
    """Hook: pre-fetch event."""
    typer.echo('{"continue": true}')


@hook_app.command()
def post_edit(input_file: str = typer.Option(None, "--input-file")):
    """Hook: post-edit event."""
    typer.echo('{"continue": true}')


@hook_app.command()
def post_read(input_file: str = typer.Option(None, "--input-file")):
    """Hook: post-read event."""
    typer.echo('{"continue": true}')


@config_app.command()
def get(key: str):
    """Get config value."""
    typer.echo("not yet implemented: config get")


@config_app.command()
def set(key: str, value: str):
    """Set config value."""
    typer.echo("not yet implemented: config set")


if __name__ == "__main__":
    app()
