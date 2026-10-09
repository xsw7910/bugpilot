"""bugpilot prepare-only workflow prototype."""

# The one version string. pyproject.toml reads it (`[tool.setuptools.dynamic]`), and
# so do `bugpilot --version`, `doctor --json`, the MCP server and the Jira User-Agent.
__version__ = "0.1.2"
